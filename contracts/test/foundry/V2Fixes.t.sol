// Regression tests for the two v2 fixes (v2 is deployed; see contracts/V2.md):
//   SR-01: reentrancy through a token transfer callback is rejected.
//   SR-02: the adapter returns attached ETH instead of retaining it.
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/v2/LockVaultV2.sol";
import "../../contracts/v2/PinkLockAdapterV2.sol";
import "../../contracts/mocks/MockToken.sol";

/// Same attack token as ReentrancyPoC, aimed at the guarded vault.
contract ReentrantTokenV2 {
    string public name = "ReentrantV2";
    string public symbol = "RE2";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    LockVaultV2 public vault;
    bool public armed;
    bool private inHook;
    uint256 public reenterAmount;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function arm(LockVaultV2 v, uint256 amount) external {
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
            vault.createLock(LockVaultV2.CreateParams({
                token: address(this), amount: reenterAmount, beneficiary: address(this), agent: address(0),
                startTime: 1, cliffTime: 1, endTime: 1, initialUnlockBps: 0, steps: 0,
                revocable: false, transferable: true, label: bytes32("inner")
            }));
            inHook = false;
        }
        return true;
    }
}

contract V2Fixes is Test {
    LockVaultV2 vault;
    PinkLockAdapterV2 adapter;
    MockToken token;

    receive() external payable {}

    function setUp() public {
        vault = new LockVaultV2();
        adapter = new PinkLockAdapterV2(vault);
        token = new MockToken("Mock", "MOCK");
        token.mint(address(this), 1_000e18);
        token.approve(address(vault), type(uint256).max);
        token.approve(address(adapter), type(uint256).max);
    }

    function _params(address t, uint256 amount) internal view returns (LockVaultV2.CreateParams memory) {
        return LockVaultV2.CreateParams({
            token: t, amount: amount, beneficiary: address(this), agent: address(0),
            startTime: 1, cliffTime: 1, endTime: 1, initialUnlockBps: 0, steps: 0,
            revocable: false, transferable: true, label: bytes32("v2")
        });
    }

    function test_sr01_reentry_is_rejected() public {
        ReentrantTokenV2 bad = new ReentrantTokenV2();
        bad.mint(address(this), 1_000e18);
        bad.mint(address(bad), 1_000e18);
        bad.approve(address(vault), type(uint256).max);
        bad.arm(vault, 50e18);

        vm.expectRevert();
        vault.createLock(_params(address(bad), 100e18));

        // Nothing was booked: the inner call hit the guard and the whole outer
        // transaction unwound.
        assertEq(vault.nextLockId(), 1, "no lock may be created");
        assertEq(bad.balanceOf(address(vault)), 0, "no tokens may remain in the vault");
    }

    function test_plain_lock_still_works() public {
        vault.createLock(_params(address(token), 100e18));
        LockVaultV2.Lock memory l = vault.getLock(1);
        assertEq(l.amount, 100e18);
        assertEq(token.balanceOf(address(vault)), 100e18);
    }

    function test_adapter_refunds_attached_eth() public {
        vm.deal(address(this), 2 ether);
        uint256 before = address(this).balance;
        /* The call MUST carry value: with value 0 the refund path returns early
           and both assertions below are trivially true (2026-10-23 review). */
        adapter.lock{value: 1 ether}(address(this), address(token), false, 100e18, block.timestamp + 100, "refund");

        assertEq(address(adapter).balance, 0, "adapter must not retain ETH");
        assertEq(address(this).balance, before, "the 1 ETH must be returned");
        assertEq(vault.nextLockId(), 2, "adapter created a lock");
    }
}
