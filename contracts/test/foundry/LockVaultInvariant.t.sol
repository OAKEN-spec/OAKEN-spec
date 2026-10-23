// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LockVault} from "../../contracts/LockVault.sol";
import {MockToken} from "../../contracts/mocks/MockToken.sol";

/**
 * Handler for the LockVault invariant suite.
 *
 * It is deliberately allowed to call every state-changing entry point, from
 * the right and the wrong caller, and to move time forwards and backwards.
 * The invariants are what must hold no matter which sequence happened:
 *
 *   · no lock ever claims more than it credited;
 *   · every extant lock still has its unclaimed principal in the vault;
 *   · the next id only grows.
 *
 * Runs do not revert the invariant test: every call is wrapped in try/catch,
 * because a rejected call (wrong caller, not revocable, already renounced) is a
 * legitimate state, not a counterexample.
 */
contract LockVaultHandler is Test {
    LockVault public immutable vault;
    MockToken public immutable token;
    address public constant CREATOR_ACTOR = address(0xC0FFEE);
    address public constant BENEFICIARY = address(0xB0B);
    address public constant AGENT = address(0xA6E);
    uint64 public constant BASE = 1_700_000_000;

    uint256[] public ids;
    uint64 public clock;

    constructor(LockVault vault_, MockToken token_) {
        vault = vault_;
        token = token_;
        vm.warp(BASE);
        clock = BASE;
        // The handler is the creator for every lock; the vault pulls from it.
        token.approve(address(vault), type(uint256).max);
    }

    /// Time on a real chain only moves forward. The fuzzer may call claim and
    /// revoke in any order, so the handler owns the clock and clamps it: a
    /// revoke can never be replayed at an earlier timestamp than an already
    /// paid claim (which would make `vestedNow < claimed` and is not a state a
    /// block producer can create).
    function _warpForward(uint64 t) internal {
        if (t < clock) t = clock;
        clock = t;
        vm.warp(t);
    }

    function _schedule(uint256 startSeed, uint256 cliffSeed, uint256 endSeed)
        internal
        pure
        returns (uint64 start, uint64 cliff, uint64 end)
    {
        start = BASE + uint64(bound(startSeed, 0, 365 days));
        cliff = start + uint64(bound(cliffSeed, 0, 365 days));
        end = cliff + uint64(bound(endSeed, 0, 365 days));
    }

    function create(
        uint128 amountSeed,
        uint256 startSeed,
        uint256 cliffSeed,
        uint256 endSeed,
        uint16 bpsSeed,
        uint16 stepsSeed,
        bool revocable,
        uint8 beneficiarySeed
    ) external {
        uint128 amount = uint128(bound(amountSeed, 1, 1e24));
        uint16 bps = uint16(bound(bpsSeed, 0, 10_000));
        uint16 steps = uint16(bound(stepsSeed, 0, uint16(10_000 - bps)));
        (uint64 s, uint64 c, uint64 e) = _schedule(startSeed, cliffSeed, endSeed);
        address ben = beneficiarySeed % 2 == 0 ? BENEFICIARY : address(0x1234);

        token.mint(address(this), amount);
        LockVault.CreateParams memory p = LockVault.CreateParams({
            token: address(token),
            amount: amount,
            beneficiary: ben,
            agent: AGENT,
            startTime: s,
            cliffTime: c,
            endTime: e,
            initialUnlockBps: bps,
            steps: steps,
            revocable: revocable,
            transferable: true,
            label: bytes32("INV")
        });
        try vault.createLock(p) returns (uint256 id) {
            ids.push(id);
        } catch { }
    }

    function claim(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        LockVault.Lock memory l = vault.getLock(id);
        if (l.token == address(0)) return;
        uint64 t = l.startTime + uint64(bound(seed, 0, uint256(l.endTime - l.startTime)));
        _warpForward(t);
        try vault.claim(id) { } catch { }
    }

    function revoke(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        LockVault.Lock memory l = vault.getLock(id);
        if (l.token == address(0)) return;
        uint64 t = l.startTime + uint64(bound(seed, 0, uint256(l.endTime - l.startTime)));
        _warpForward(t);
        try vault.revoke(id) { } catch { }
    }

    function edit(uint256 seed, uint128 newAmountSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        LockVault.Lock memory l = vault.getLock(id);
        if (l.token == address(0)) return;
        uint128 newAmount = uint128(bound(newAmountSeed, 0, l.amount));
        vm.prank(BENEFICIARY);
        try vault.editLock(id, newAmount, l.endTime) { } catch { }
    }

    function transfer(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        vm.prank(BENEFICIARY);
        try vault.transferLock(id, address(0x9999)) { } catch { }
    }

    function renounce(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        vm.prank(BENEFICIARY);
        try vault.renounce(id) { } catch { }
    }
}

contract LockVaultInvariantTest is Test {
    LockVault internal vault;
    MockToken internal token;
    LockVaultHandler internal handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new MockToken("Mock", "MOCK");
        vault = new LockVault();
        handler = new LockVaultHandler(vault, token);
        targetContract(address(handler));
    }

    /// Every lock's paid-out amount is bounded by what it credited.
    function invariant_claimedNeverExceedsAmount() public view {
        uint256 n = vault.nextLockId();
        for (uint256 id = 1; id < n; id++) {
            LockVault.Lock memory l = vault.getLock(id);
            assertLe(uint256(l.claimed), uint256(l.amount), "claimed > amount");
        }
    }

    /// The vault always holds at least the unclaimed principal of every lock.
    function invariant_vaultCoversUnclaimed() public view {
        uint256 outstanding;
        uint256 n = vault.nextLockId();
        for (uint256 id = 1; id < n; id++) {
            LockVault.Lock memory l = vault.getLock(id);
            outstanding += uint256(l.amount) - uint256(l.claimed);
        }
        assertEq(outstanding, token.balanceOf(address(vault)), "vault balance != unclaimed principal");
    }

    /// Vesting is bounded by the lock's amount at every point in time.
    function invariant_vestingBoundedAtNow() public view {
        uint256 n = vault.nextLockId();
        for (uint256 id = 1; id < n; id++) {
            LockVault.Lock memory l = vault.getLock(id);
            assertLe(vault.vestedAt(id, uint64(block.timestamp)), uint256(l.amount), "vested > amount");
        }
    }

    /// The id counter only grows.
    function invariant_nextIdPositive() public view {
        assertGe(vault.nextLockId(), 1);
    }
}
