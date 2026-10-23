// Symbolic checks for LockVault (Halmos). These are **not** a substitute for an
// audit; they prove a few arithmetic properties on one concrete lock.
//
//   halmos --forge-build-out foundry-out --contract LockVaultSymbolic --function check_
//
// Deliberately does not inherit forge-std's Test: Halmos 0.3.3 on this machine
// fails setUp() on the `deployCode(string)` cheat code pulled in by that base
// contract. Plain Solidity + assert() is enough here.
pragma solidity ^0.8.24;

import "../../contracts/LockVault.sol";
import "../../contracts/mocks/MockToken.sol";

contract LockVaultSymbolic {
    LockVault vault;
    MockToken token;
    uint256 lockId;

    address constant BENEFICIARY = address(0xBEEF);
    uint128 constant AMOUNT = 1_000e18;
    uint64 constant START = 1_000;
    uint64 constant CLIFF = 2_000;
    uint64 constant END = 3_000;
    uint16 constant TGE_BPS = 1_000;   // 10%
    uint16 constant STEPS = 10;

    function setUp() public {
        vault = new LockVault();
        token = new MockToken("Mock", "MOCK");
        token.mint(address(this), 2_000e18);
        token.approve(address(vault), type(uint256).max);

        LockVault.CreateParams memory p = LockVault.CreateParams({
            token: address(token),
            amount: AMOUNT,
            beneficiary: BENEFICIARY,
            agent: address(0),
            startTime: START,
            cliffTime: CLIFF,
            endTime: END,
            initialUnlockBps: TGE_BPS,
            steps: STEPS,
            revocable: false,
            transferable: true,
            label: bytes32("symbolic")
        });
        vault.createLock(p);
        lockId = vault.nextLockId() - 1;
    }

    /// Never vested more than was credited, at any timestamp.
    function check_vested_le_amount(uint64 t) public view {
        assert(vault.vestedAt(lockId, t) <= AMOUNT);
    }

    /// Vesting never goes backwards.
    function check_vested_monotonic(uint64 a, uint64 b) public view {
        if (a > b) return;
        assert(vault.vestedAt(lockId, a) <= vault.vestedAt(lockId, b));
    }

    /// At and after the end date the whole credited amount is vested.
    function check_vested_at_end_is_full() public view {
        assert(vault.vestedAt(lockId, END) == AMOUNT);
        assert(vault.vestedAt(lockId, type(uint64).max) == AMOUNT);
    }

    /// Before the start date nothing is vested.
    function check_vested_before_start_is_zero() public view {
        assert(vault.vestedAt(lockId, START - 1) == 0);
    }

    /// Claimed never exceeds the credited amount.
    function check_claimed_le_amount() public view {
        LockVault.Lock memory l = vault.getLock(lockId);
        assert(l.claimed <= l.amount);
    }
}
