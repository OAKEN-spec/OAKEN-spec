// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PositionLock} from "../../contracts/PositionLock.sol";
import {MockPosition} from "../../contracts/mocks/MockPosition.sol";

/**
 * Fuzz tests for PositionLock.
 *
 * The properties: a position is escrowed exactly once; release is possible only
 * at/after the unlock time and only sends to the stored beneficiary; reclaim is
 * creator-only, revocable-only, and impossible after release; no one can lock a
 * position they do not own; and the receiver refuses positions pushed in without
 * a lock record.
 *
 *   forge test --match-path test/foundry/PositionLockFuzz.t.sol -vvv
 */
contract PositionLockFuzzTest is Test {
    PositionLock internal vault;
    MockPosition internal nft;
    address internal creator = address(0xC0FFEE);
    address internal beneficiary = address(0xB0B);
    address internal stranger = address(0xBAD);
    uint64 internal constant BASE = 1_700_000_000;
    uint256 internal constant TOKEN_ID = 7;

    function setUp() public {
        vm.warp(BASE);
        nft = new MockPosition();
        vault = new PositionLock();
        nft.mint(creator, TOKEN_ID);
        vm.prank(creator);
        nft.approve(address(vault), TOKEN_ID);
    }

    function _lock(uint64 unlockTime, bool revocable, address ben) internal returns (uint256 id) {
        PositionLock.CreateParams memory p = PositionLock.CreateParams({
            nft: address(nft),
            tokenId: TOKEN_ID,
            beneficiary: ben,
            unlockTime: unlockTime,
            revocable: revocable,
            label: bytes32("LP")
        });
        vm.prank(creator);
        id = vault.lockPosition(p);
    }

    /// Release waits for unlock, then sends the position to the stored beneficiary.
    function testFuzz_releaseWaitsAndPaysBeneficiary(
        uint64 unlockSeed,
        uint64 beforeSeed,
        uint64 afterSeed,
        bool revocable
    ) public {
        uint64 unlock = BASE + uint64(bound(unlockSeed, 1, 365 days));
        uint256 id = _lock(unlock, revocable, beneficiary);
        assertEq(nft.ownerOf(TOKEN_ID), address(vault), "escrowed");
        assertEq(vault.getLock(id).beneficiary, beneficiary, "beneficiary stored");

        uint64 before = unlock - 1 - uint64(bound(beforeSeed, 0, unlock - BASE - 1));
        vm.warp(before);
        assertFalse(vault.isReleasable(id), "not releasable before unlock");
        vm.expectRevert();
        vault.release(id);

        vm.warp(unlock + uint64(bound(afterSeed, 0, 365 days)));
        assertTrue(vault.isReleasable(id), "releasable at/after unlock");
        vault.release(id);      // anyone may pay the gas
        assertEq(nft.ownerOf(TOKEN_ID), beneficiary, "position released to beneficiary");
        assertTrue(vault.getLock(id).released, "released flag");
        vm.expectRevert();
        vault.release(id);
    }

    /// Reclaim is creator-only, revocable-only, and impossible after release.
    function testFuzz_reclaimRules(uint64 unlockSeed, bool revocable, uint256 callerSeed) public {
        uint64 unlock = BASE + uint64(bound(unlockSeed, 1, 365 days));
        uint256 id = _lock(unlock, revocable, beneficiary);
        address caller = callerSeed % 2 == 0 ? creator : stranger;

        if (!revocable) {
            vm.expectRevert();
            vm.prank(creator);
            vault.reclaim(id);
            return;
        }
        if (caller != creator) {
            vm.expectRevert();
            vm.prank(caller);
            vault.reclaim(id);
            return;
        }
        vm.prank(creator);
        vault.reclaim(id);
        assertEq(nft.ownerOf(TOKEN_ID), creator, "returned to creator");
        assertTrue(vault.getLock(id).released, "released flag set by reclaim");
        vm.expectRevert();
        vm.prank(creator);
        vault.reclaim(id);
    }

    /// A lock whose unlock is not in the future is rejected.
    function testFuzz_rejectsPastUnlock(uint64 unlockSeed) public {
        uint64 t = BASE + uint64(bound(unlockSeed, 0, 365 days));
        vm.warp(t + 1);
        PositionLock.CreateParams memory p = PositionLock.CreateParams({
            nft: address(nft), tokenId: TOKEN_ID, beneficiary: beneficiary,
            unlockTime: t, revocable: true, label: bytes32("LP")
        });
        vm.expectRevert();
        vm.prank(creator);
        vault.lockPosition(p);
    }

    /// Only the position owner may create the lock.
    function testFuzz_onlyOwnerCanLock(uint64 unlockSeed) public {
        uint64 unlock = BASE + uint64(bound(unlockSeed, 1, 365 days));
        PositionLock.CreateParams memory p = PositionLock.CreateParams({
            nft: address(nft), tokenId: TOKEN_ID, beneficiary: beneficiary,
            unlockTime: unlock, revocable: true, label: bytes32("LP")
        });
        vm.expectRevert();
        vm.prank(stranger);
        vault.lockPosition(p);
    }

    /// Pushed-in positions have no lock record, so the receiver refuses them.
    function testFuzz_receiverRefusesUnexpectedToken(uint256 tokenId) public {
        assertEq(vault.onERC721Received(address(0), address(0), 0, ""), bytes4(0x150b7a02));
        if (tokenId == 0) return;
        vm.expectRevert();
        vault.onERC721Received(address(0), address(0), tokenId, "");
    }
}
