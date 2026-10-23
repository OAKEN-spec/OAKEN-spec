// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LockVault} from "../../contracts/LockVault.sol";
import {MockToken} from "../../contracts/mocks/MockToken.sol";
import {MockTokenNoReturn} from "../../contracts/mocks/MockTokenNoReturn.sol";

/**
 * Fuzz tests for LockVault.
 *
 * These are not a substitute for a third-party audit. They are the properties
 * the lock product sells, expressed as assertions over random schedules:
 *
 *   · credits the amount that actually arrived, never the amount asked for;
 *   · vested(t) is monotone and never exceeds the credited amount;
 *   · a claim pays only vested-minus-claimed (to the beneficiary, never the caller);
 *   · a revoke splits the credited amount into refund + still-vested, exactly;
 *   · a shrink edit can never go below what was already claimed;
 *   · the staircase never releases more than the continuous curve;
 *   · a plain "lock until T" is the degenerate schedule, not a special case;
 *   · permission checks (creator/beneficiary/agent/stranger) hold.
 *
 *   forge test --match-path test/foundry/LockVaultFuzz.t.sol -vvv
 */
contract LockVaultFuzzTest is Test {
    LockVault internal vault;
    MockToken internal token;
    address internal creator = address(0xC0FFEE);
    address internal beneficiary = address(0xB0B);
    address internal agent = address(0xA6E);
    address internal stranger = address(0xBAD);
    address internal feeSink = address(0xFEE);

    uint64 internal constant BASE = 1_700_000_000;
    uint256 internal constant MAX_AMOUNT = 1e30;
    uint64 internal constant MAX_SPAN = 365 days;

    function setUp() public {
        vm.warp(BASE);
        token = new MockToken("Mock", "MOCK");
        vault = new LockVault();
        token.mint(creator, MAX_AMOUNT);
        vm.prank(creator);
        token.approve(address(vault), type(uint256).max);
    }

    function _params(
        uint128 amount,
        uint64 start,
        uint64 cliff,
        uint64 end,
        uint16 bps,
        uint16 steps,
        bool revocable,
        bool transferable
    ) internal view returns (LockVault.CreateParams memory p) {
        p = LockVault.CreateParams({
            token: address(token),
            amount: amount,
            beneficiary: beneficiary,
            agent: agent,
            startTime: start,
            cliffTime: cliff,
            endTime: end,
            initialUnlockBps: bps,
            steps: steps,
            revocable: revocable,
            transferable: transferable,
            label: bytes32("TEST")
        });
    }

    function _create(
        uint128 amount,
        uint64 start,
        uint64 cliff,
        uint64 end,
        uint16 bps,
        uint16 steps,
        bool revocable,
        bool transferable
    ) internal returns (uint256 id) {
        LockVault.CreateParams memory p = _params(amount, start, cliff, end, bps, steps, revocable, transferable);
        vm.prank(creator);
        id = vault.createLock(p);
    }

    function _schedule(uint256 startSeed, uint256 cliffSeed, uint256 endSeed)
        internal
        pure
        returns (uint64 start, uint64 cliff, uint64 end)
    {
        start = BASE + uint64(bound(startSeed, 0, MAX_SPAN));
        cliff = start + uint64(bound(cliffSeed, 0, MAX_SPAN));
        end = cliff + uint64(bound(endSeed, 0, MAX_SPAN));
    }

    /// Credits the balance delta, so a fee-on-transfer token gets an honest lock.
    function testFuzz_creditsWhatArrived(uint128 amountSeed, uint16 feeSeed) public {
        uint128 amount = uint128(bound(amountSeed, 1, MAX_AMOUNT));
        uint16 feeBps = uint16(bound(feeSeed, 0, 10_000));
        token.setFee(feeBps, feeSink);
        (uint64 s, uint64 c, uint64 e) = _schedule(1, 2, 3);

        if (feeBps == 10_000) {
            LockVault.CreateParams memory p = _params(amount, s, c, e, 0, 0, false, false);
            vm.expectRevert();
            vm.prank(creator);
            vault.createLock(p);
            return;
        }

        uint256 expected = uint256(amount) - (uint256(amount) * feeBps) / 10_000;
        uint256 vaultBefore = token.balanceOf(address(vault));
        uint256 id = _create(amount, s, c, e, 0, 0, false, false);
        LockVault.Lock memory l = vault.getLock(id);

        assertEq(uint256(l.amount), expected, "credited amount");
        assertEq(token.balanceOf(address(vault)) - vaultBefore, expected, "vault balance delta");
        assertLe(uint256(l.amount), uint256(amount), "never credits more than asked");
    }

    /// Monotone, bounded by the credited amount, and exact at both endpoints.
    function testFuzz_vestingMonotonicAndBounded(
        uint128 amountSeed,
        uint256 startSeed,
        uint256 cliffSeed,
        uint256 endSeed,
        uint16 bpsSeed,
        uint16 stepsSeed,
        uint256 t1Seed,
        uint256 t2Seed
    ) public {
        uint128 amount = uint128(bound(amountSeed, 1, MAX_AMOUNT));
        uint16 bps = uint16(bound(bpsSeed, 0, 10_000));
        uint16 maxSteps = uint16(10_000 - bps);
        uint16 steps = uint16(bound(stepsSeed, 0, maxSteps));
        (uint64 s, uint64 c, uint64 e) = _schedule(startSeed, cliffSeed, endSeed);
        uint256 id = _create(amount, s, c, e, bps, steps, false, false);
        LockVault.Lock memory l = vault.getLock(id);
        uint256 credited = l.amount;

        uint256 dur = uint256(e - s);
        uint64 t1 = s + uint64(bound(t1Seed, 0, dur));
        uint64 t2 = s + uint64(bound(t2Seed, 0, dur));
        if (t1 > t2) (t1, t2) = (t2, t1);

        uint256 v1 = vault.vestedAt(id, t1);
        uint256 v2 = vault.vestedAt(id, t2);
        assertLe(v1, v2, "vesting never decreases");
        assertLe(v2, credited, "vesting never exceeds credited");
        if (t1 < s) assertEq(v1, 0, "nothing before start");
        if (t2 >= e) assertEq(v2, credited, "all at end");
    }

    /// Anyone may pay the gas; the beneficiary is the only recipient.
    function testFuzz_claimPaysVestedOnly(
        uint128 amountSeed,
        uint256 startSeed,
        uint256 cliffSeed,
        uint256 endSeed,
        uint16 bpsSeed,
        uint16 stepsSeed,
        uint256 claimSeed,
        uint256 laterSeed
    ) public {
        uint128 amount = uint128(bound(amountSeed, 1, MAX_AMOUNT));
        uint16 bps = uint16(bound(bpsSeed, 0, 10_000));
        uint16 steps = uint16(bound(stepsSeed, 0, uint16(10_000 - bps)));
        (uint64 s, uint64 c, uint64 e) = _schedule(startSeed, cliffSeed, endSeed);
        uint256 id = _create(amount, s, c, e, bps, steps, false, false);

        uint64 claimAt = s + uint64(bound(claimSeed, 0, uint256(e - s)));
        vm.warp(claimAt);
        uint256 claimableBefore = vault.claimable(id);
        if (claimableBefore == 0) {
            vm.expectRevert();
            vault.claim(id);
            return;
        }

        uint256 beneficiaryBefore = token.balanceOf(beneficiary);
        uint256 paid = vault.claim(id);
        LockVault.Lock memory l = vault.getLock(id);

        assertEq(paid, claimableBefore, "pays exactly what was claimable");
        assertEq(token.balanceOf(beneficiary) - beneficiaryBefore, paid, "recipient is the beneficiary");
        assertEq(uint256(l.claimed), paid, "claimed counter");
        assertLe(uint256(l.claimed), uint256(l.amount), "claimed never exceeds amount");
        assertEq(vault.claimable(id), 0, "nothing left at the same timestamp");

        uint64 later = claimAt + uint64(bound(laterSeed, 0, uint256(e - claimAt)));
        vm.warp(later);
        assertLe(vault.claimable(id) + uint256(l.claimed), uint256(l.amount), "vested-at-now still bounded");
    }

    /// Revoke splits the credited amount into refund + vested, exactly, and freezes the schedule.
    function testFuzz_revokeSplitsAtVested(
        uint128 amountSeed,
        uint256 startSeed,
        uint256 cliffSeed,
        uint256 endSeed,
        uint16 bpsSeed,
        uint16 stepsSeed,
        uint256 revokeSeed
    ) public {
        uint128 amount = uint128(bound(amountSeed, 1, MAX_AMOUNT));
        uint16 bps = uint16(bound(bpsSeed, 0, 10_000));
        uint16 steps = uint16(bound(stepsSeed, 0, uint16(10_000 - bps)));
        (uint64 s, uint64 c, uint64 e) = _schedule(startSeed, cliffSeed, endSeed);
        uint256 id = _create(amount, s, c, e, bps, steps, true, false);
        LockVault.Lock memory before = vault.getLock(id);
        uint256 credited = before.amount;

        uint64 revokeAt = s + uint64(bound(revokeSeed, 0, uint256(e - s)));
        uint256 vested = vault.vestedAt(id, revokeAt);
        vm.warp(revokeAt);
        uint256 creatorBefore = token.balanceOf(creator);
        vm.prank(creator);
        vault.revoke(id);

        LockVault.Lock memory afterLock = vault.getLock(id);
        assertEq(uint256(afterLock.amount), vested, "amount collapses to vested");
        assertEq(token.balanceOf(creator) - creatorBefore, credited - vested, "refund is the unvested part");
        assertEq(vault.vestedAt(id, revokeAt), vested, "vested at revoke");
        assertEq(vault.vestedAt(id, revokeAt + 365 days), vested, "no further vesting");
        assertEq(vault.claimable(id), vested, "vested part remains claimable");
        assertTrue(afterLock.revoked, "revoked flag");
    }

    /// Shrinking cannot go below claimed; the difference goes to the beneficiary, never the caller.
    function testFuzz_editShrinkNeverBelowClaimed(
        uint128 amountSeed,
        uint256 startSeed,
        uint256 cliffSeed,
        uint256 endSeed,
        uint16 bpsSeed,
        uint16 stepsSeed,
        uint256 claimSeed,
        uint128 newAmountSeed
    ) public {
        uint128 amount = uint128(bound(amountSeed, 1, MAX_AMOUNT));
        uint16 bps = uint16(bound(bpsSeed, 0, 10_000));
        uint16 steps = uint16(bound(stepsSeed, 0, uint16(10_000 - bps)));
        (uint64 s, uint64 c, uint64 e) = _schedule(startSeed, cliffSeed, endSeed);
        uint256 id = _create(amount, s, c, e, bps, steps, false, false);

        uint64 claimAt = s + uint64(bound(claimSeed, 0, uint256(e - s)));
        vm.warp(claimAt);
        if (vault.claimable(id) != 0) vault.claim(id);
        LockVault.Lock memory l = vault.getLock(id);

        uint128 newAmount = uint128(bound(newAmountSeed, 0, l.amount));
        if (newAmount < l.claimed) {
            vm.expectRevert();
            vm.prank(beneficiary);
            vault.editLock(id, newAmount, l.endTime);
            return;
        }

        uint256 beneficiaryBefore = token.balanceOf(beneficiary);
        vm.prank(beneficiary);
        vault.editLock(id, newAmount, l.endTime);
        LockVault.Lock memory edited = vault.getLock(id);

        assertEq(uint256(edited.amount), newAmount, "new amount recorded");
        assertGe(uint256(edited.amount), uint256(edited.claimed), "never below claimed");
        if (newAmount < l.amount) {
            assertEq(token.balanceOf(beneficiary) - beneficiaryBefore, uint256(l.amount) - newAmount, "shrink pays beneficiary");
        }
    }

    /// The staircase holds each tranche back until its date and never exceeds the continuous curve.
    function testFuzz_stepsStayBelowContinuous(
        uint128 amountSeed,
        uint256 startSeed,
        uint256 spanSeed,
        uint16 bpsSeed,
        uint16 stepsSeed,
        uint256 sampleSeed
    ) public {
        uint128 amount = uint128(bound(amountSeed, 1, MAX_AMOUNT / 2));
        uint16 bps = uint16(bound(bpsSeed, 0, 9_999));
        uint16 maxSteps = uint16(10_000 - bps);
        uint16 steps = uint16(bound(stepsSeed, 1, maxSteps));
        uint64 start = BASE + uint64(bound(startSeed, 0, MAX_SPAN));
        uint64 span = uint64(bound(spanSeed, 1, MAX_SPAN));
        uint64 end = start + span;
        uint64 cliff = start + uint64(bound(sampleSeed, 0, span));

        uint256 continuousId = _create(amount, start, cliff, end, bps, 0, false, false);
        uint256 stagedId = _create(amount, start, cliff, end, bps, steps, false, false);
        uint256 credited = vault.getLock(stagedId).amount;

        uint256 prev = 0;
        for (uint256 k = 0; k <= steps + 1; k++) {
            uint64 t = start + uint64((uint256(span) * k) / (steps + 1));
            uint256 staged = vault.vestedAt(stagedId, t);
            uint256 continuous = vault.vestedAt(continuousId, t);
            assertLe(staged, continuous, "staircase never exceeds continuous");
            assertLe(staged, credited, "staircase never exceeds credited");
            assertGe(staged, prev, "staircase monotone");
            prev = staged;
        }
        assertEq(vault.vestedAt(stagedId, end), credited, "full at end");
        assertEq(vault.vestedAt(continuousId, end), credited, "continuous full at end");
    }

    /// A plain lock is exactly the degenerate schedule: nothing, then everything.
    function testFuzz_plainLockIsAllOrNothing(uint128 amountSeed, uint256 unlockSeed) public {
        uint128 amount = uint128(bound(amountSeed, 1, MAX_AMOUNT));
        uint64 unlock = BASE + uint64(bound(unlockSeed, 1, MAX_SPAN));
        uint256 id = _create(amount, unlock, unlock, unlock, 0, 0, false, false);
        LockVault.Lock memory l = vault.getLock(id);

        assertEq(vault.vestedAt(id, unlock - 1), 0, "nothing before");
        assertEq(vault.vestedAt(id, unlock), l.amount, "everything at unlock");
        assertEq(vault.vestedAt(id, unlock + 1), l.amount, "still everything after");

        vm.warp(unlock - 1);
        vm.expectRevert();
        vault.claim(id);
        vm.warp(unlock);
        assertEq(vault.claim(id), l.amount, "claim pays the whole lock");
    }

    /// Only the beneficiary/agent may transfer/rename/renounce; strangers revert.
    function testFuzz_permissionsAndRenounce(bool useAgent, uint256 amountSeed) public {
        uint128 amount = uint128(bound(amountSeed, 1, MAX_AMOUNT));
        uint64 unlock = BASE + 30 days;
        uint256 id = _create(amount, unlock, unlock, unlock, 0, 0, true, true);
        address caller = useAgent ? agent : beneficiary;

        vm.expectRevert();
        vm.prank(stranger);
        vault.transferLock(id, address(0x1234));

        vm.expectRevert();
        vm.prank(stranger);
        vault.renounce(id);

        vm.prank(caller);
        vault.transferLock(id, address(0x1234));
        assertEq(vault.getLock(id).beneficiary, address(0x1234), "transferred");

        vm.prank(useAgent ? agent : address(0x1234));
        vault.renounce(id);
        assertEq(vault.claimable(id), 0, "renounced has no claimable amount");

        vm.expectRevert();
        vault.claim(id);

        vm.expectRevert();
        vm.prank(creator);
        vault.revoke(id);

        vm.expectRevert();
        vm.prank(address(0x1234));
        vault.editLock(id, amount, unlock + 1);
    }

    /// USDT-style tokens return no data; the vault accepts success and still rejects false.
    function testFuzz_noReturnToken(uint128 amountSeed) public {
        MockTokenNoReturn nr = new MockTokenNoReturn();
        uint128 amount = uint128(bound(amountSeed, 1, MAX_AMOUNT));
        nr.mint(creator, amount);
        vm.prank(creator);
        nr.approve(address(vault), amount);

        uint64 unlock = BASE + 1 days;
        LockVault.CreateParams memory p = LockVault.CreateParams({
            token: address(nr), amount: amount, beneficiary: beneficiary, agent: address(0),
            startTime: unlock, cliffTime: unlock, endTime: unlock,
            initialUnlockBps: 0, steps: 0, revocable: false, transferable: false, label: bytes32("NR")
        });
        vm.prank(creator);
        uint256 id = vault.createLock(p);
        assertEq(uint256(vault.getLock(id).amount), uint256(amount), "no-return token credited");

        vm.warp(unlock);
        uint256 paid = vault.claim(id);
        assertEq(paid, uint256(amount), "no-return token claimed");
        assertEq(nr.balanceOf(beneficiary), uint256(amount), "beneficiary received");
    }
}
