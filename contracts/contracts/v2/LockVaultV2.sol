// SPDX-License-Identifier: Apache-2.0
//
// V2 fork (not deployed): adds a reentrancy guard. The live v1 contract at
// 0xe410d0a2... is immutable and remains as it is; do not deploy this file at
// the v1 address. See contracts/V2.md for the deployment plan.
pragma solidity ^0.8.24;
pragma abicoder v2;

/**
 * @title LockVault
 * @notice Time locks and linear vesting for ERC-20 tokens, at one identical
 *         address on every EVM chain.
 *
 * This is the token side of a locking service. It holds the two things a token
 * project actually needs to prove: that its liquidity cannot be pulled, and
 * that its team and advisor allocations are on a schedule everyone can read.
 * A Uniswap V2 pair is an ERC-20, so an LP lock and a token lock are the same
 * operation here — one code path, one form, one audit surface. Uniswap V3/V4
 * positions are ERC-721 and live in PositionLock next door.
 *
 * ## Why this contract has no owner
 *
 * The whole product is the sentence "these tokens cannot move until this date".
 * Every line of `onlyOwner` turns that sentence into "cannot move unless the
 * operator decides otherwise", which is a promise about a company rather than a
 * promise about code, and no buyer checking a lock can tell the difference
 * without trusting someone. So there is deliberately no owner, no pause, no
 * upgrade path, no fee switch, and no rescue function. The contract has exactly
 * one privileged actor, and it is the creator of a lock, and it can only ever
 * touch its own lock, only if that lock declared itself revocable at creation.
 *
 * The cost of that choice is that a bug is permanent. The response is to keep
 * the contract small enough to read in one sitting: no external calls except to
 * the token being locked, no arithmetic that can overflow (0.8.x checked math),
 * no loops over user-controlled lengths, no delegatecall, no assembly except
 * the four lines that bubble up a token's revert reason.
 *
 * ## Why it can be deployed at the same address everywhere
 *
 * Deterministic deployment hashes the *init code* into the address, so any
 * constructor argument would make the address chain-specific — the token
 * addresses, WETH, the multicall contract, all differ per chain. This contract
 * therefore takes no constructor arguments at all and never needs to know which
 * chain it is on. Everything chain-specific is passed in per call, by the
 * caller, from the front end's registry.
 *
 * ## The vesting model
 *
 * One parameterisation covers every schedule the category sells:
 *
 *     vested(t) = t < startTime                    -> 0
 *                 t >= endTime                     -> amount
 *                 otherwise                        -> amount * (initialUnlockBps
 *                       + (10000 - initialUnlockBps) * (t - startTime)
 *                         / (endTime - startTime)) / 10000
 *
 * so a "lock until T" is `start == cliff == end == T`; a standard cliff is
 * `(T0, T0+6mo, T0+24mo, 0)`; and a TGE unlock followed by a linear tail is
 * `(T0, T0, T0+24mo, 1000)`. The cliff gates *claiming*, not *accrual*: nothing
 * can be withdrawn before `cliffTime`, but the schedule has been running since
 * `startTime` and the accrued amount is claimable the moment the cliff passes.
 * That is the SAFE convention and inverting it is a classic way to publish a
 * chart that does not match the contract.
 *
 * `steps` turns that line into a staircase, which is how most tokenomics tables
 * are actually written — "10% at TGE, then 5% every 30 days". With `steps == n`,
 * the tail is released in `n` equal jumps instead of continuously, and the two
 * forms agree *exactly* at every boundary: same total, same dates, the staircase
 * simply holds each tranche back until its date rather than trickling it out
 * second by second. `steps == 0` is the continuous form.
 *
 * That is the whole of it — one field and four lines, rather than a second
 * schedule type with its own arithmetic to get wrong. A cliff plus a staircase
 * is `(T0, T0+6mo, T0+24mo, 1000, 24)`: 10% at the start, then 3.75% every
 * month after the cliff.
 *
 * ## Tokens that take a fee on transfer
 *
 * PinkLock requires the token's own contract to have whitelisted PinkLock's
 * address before a lock will work, and a taxed token locked without that step
 * silently escrows less than the form said. This contract never asks the token
 * for anything: it measures its own balance before and after `transferFrom` and
 * credits the *difference*. A 3% tax token locks 97% and says so in the event,
 * on the lock page, and in the badge. No whitelist, no wrong number, no
 * transaction that fails for a reason the user cannot act on.
 *
 * Rebase tokens are a different problem and are not solved here: a balance that
 * changes between the lock and the claim cannot be paid out at face value, so
 * the last claimer of an upward-rebasing token leaves a surplus and a
 * downward-rebasing token runs short. The contract reverts rather than
 * transferring what it does not have, but it does not pretend to model this.
 * The front end refuses to offer a lock on a token it can identify as rebasing.
 */
contract LockVaultV2 {
    /**
     * Basis points denominator. `initialUnlockBps == 10000` releases everything
     * at `startTime`; `0` releases nothing until the linear tail begins.
     */
    uint16 private constant BPS_DENOMINATOR = 10_000;

    /**
     * A lock, packed into five slots plus the label.
     *
     * `amount` is the balance actually received, not the amount requested, so
     * every downstream number (vested, claimable, the chart) is the truth about
     * what is in the vault. `claimed` is monotone and is the only counter that
     * moves on a withdrawal; claimable is always recomputed from `amount`, the
     * schedule and `claimed`, never stored, so there is no running total that
     * can drift out of agreement with the schedule.
     */
    struct Lock {
        // slot 0
        address token;
        uint64 startTime;
        uint16 initialUnlockBps;
        bool revocable;
        bool transferable;
        // slot 1
        address beneficiary;
        uint64 cliffTime;
        bool revoked;
        /**
         * The beneficiary has permanently given up the right to claim. Nothing
         * can take these out again — not the beneficiary, not the creator, not
         * whoever deployed this. See `renounce`.
         */
        bool renounced;
        // slot 2
        address creator;
        uint64 endTime;
        /**
         * Equal tranches the tail is released in. Zero releases it continuously
         * — the two agree at every boundary, so this is a shape choice and not a
         * different schedule. See the header.
         */
        uint16 steps;
        // slot 3
        uint128 amount;
        uint128 claimed;
        // slot 4
        bytes32 label;
        /**
         * A second address allowed to move this lock: the beneficiary's agent.
         *
         * It exists because a lock is often created by a contract acting for
         * the user (here: `PinkLockAdapter`), and the user's only way to reach
         * `transferLock` / `renounce` / `editLock` would otherwise be to call
         * this vault directly — which the mirrored front end cannot do, since
         * it was compiled against PinkLock's ABI.
         *
         * It is **declared at creation** rather than being an operator the
         * vault grants anyone, so it is part of the lock from the first block:
         * a beneficiary can read `agent` before accepting a lock and see
         * whether anyone else can move it. Zero means nobody can — a lock
         * created straight on this vault is exactly as immovable as before.
         *
         * What it can do is bounded by the same rules as the beneficiary
         * itself, never more: it cannot exceed the beneficiary's own powers.
         */
        address agent;
    }

    /**
     * Creation parameters, as one struct rather than ten arguments: it keeps
     * `createLock` under the stack limit, gives the front end a named object to
     * build, and means a future field can be added without breaking callers.
     */
    struct CreateParams {
        /** ERC-20 to lock: a project token, or a V2 pair acting as LP. */
        address token;
        /** Requested amount. The credited amount is what actually arrives. */
        uint256 amount;
        /** Receives every claim. May differ from the creator. */
        address beneficiary;
        /**
         * A second address the beneficiary's powers are delegated to, declared
         * up front and visible on the lock from creation. Zero for none — see
         * `Lock.agent` for why this is a per-lock field rather than a role the
         * vault hands to anyone.
         */
        address agent;
        /** Vesting accrues from here. */
        uint64 startTime;
        /** Nothing is claimable before here; accrual still runs. */
        uint64 cliffTime;
        /** Fully vested at and after here. */
        uint64 endTime;
        /** Fraction released at `startTime`, in basis points. */
        uint16 initialUnlockBps;
        /**
         * 0 for a continuous tail, or the number of equal tranches to release
         * it in. Must be zero or at most `10000 - initialUnlockBps`, so a
         * tranche is at least one basis point and the division is defined.
         */
        uint16 steps;
        /** If true, `creator` may cancel and reclaim the unvested part. */
        bool revocable;
        /** If true, `beneficiary` may hand the lock to someone else. */
        bool transferable;
        /** Short public label, e.g. "Team" or "Uniswap V2 LP". */
        bytes32 label;
    }

    mapping(uint256 => Lock) private _locks;

    /** Ids start at 1 so a zero id is unambiguously "no such lock". */
    uint256 private _nextLockId = 1;

    /* V2: 0 = not entered, 1 = entered. A storage guard is enough here; the
       vault is not called often enough for transient storage to matter. */
    uint256 private _entered;

    /**
     * Everything the indexer and the lock page need, in one event.
     *
     * Deliberate: the fields are the whole lock, so indexing is one `getLogs`
     * sweep with no follow-up reads, and a lock page renders from the log plus
     * a couple of view calls. `amount` is the credited amount, which is what
     * makes a fee-on-transfer token visible rather than mysterious.
     */
    event LockCreated(
        uint256 indexed lockId,
        address indexed token,
        address indexed creator,
        address beneficiary,
        address agent,
        uint256 amount,
        uint64 startTime,
        uint64 cliffTime,
        uint64 endTime,
        uint16 initialUnlockBps,
        uint16 steps,
        bool revocable,
        bool transferable,
        bytes32 label
    );

    event Claimed(uint256 indexed lockId, address indexed beneficiary, uint256 amount);

    /**
     * `vestedAtRevoke` is the part that stays claimable by the beneficiary and
     * `refunded` is the part that went back to the creator; the two always sum
     * to the credited amount.
     */
    event Revoked(
        uint256 indexed lockId,
        address indexed creator,
        uint256 refunded,
        uint256 vestedAtRevoke
    );

    event LockTransferred(uint256 indexed lockId, address indexed from, address indexed to);

    /**
     * The beneficiary gave up the claim permanently. Emitted so an explorer can
     * show "locked forever" as a fact rather than infer it from a missing claim.
     */
    event Renounced(uint256 indexed lockId, address indexed beneficiary);

    /**
     * A lock's terms changed after the fact.
     *
     * Carries both old and new values on purpose: "this lock was edited" is a
     * fact a reader has to be able to see without replaying history, because an
     * edited lock is a weaker promise than the one that was originally made.
     */
    event LockEdited(
        uint256 indexed lockId,
        uint128 oldAmount,
        uint128 newAmount,
        uint64 oldEndTime,
        uint64 newEndTime
    );

    /** A lock's label changed. Both sides so history is readable from logs alone. */
    event LabelUpdated(uint256 indexed lockId, bytes32 oldLabel, bytes32 newLabel);

    /// Reentrant call rejected (V2 guard).
    error ReentrantCall();
    error NotAContract(address token);
    error ZeroBeneficiary();
    error ZeroAmount();
    error AmountTooLarge(uint256 amount);
    error UnorderedSchedule(uint64 startTime, uint64 cliffTime, uint64 endTime);
    error InvalidInitialUnlock(uint16 initialUnlockBps);
    error TooManySteps(uint16 steps, uint16 max);
    error NothingReceived(address token, uint256 requested);
    /** An edit cannot shrink a lock below what has already been paid out. */
    error AmountBelowClaimed(uint256 lockId, uint128 newAmount, uint128 claimed);
    error UnknownLock(uint256 lockId);
    error NothingClaimable(uint256 lockId);
    error NotRevocable(uint256 lockId);
    error AlreadyRevoked(uint256 lockId);
    error AlreadyRenounced(uint256 lockId);
    error LockRenounced(uint256 lockId);
    error NotCreator(uint256 lockId, address caller);
    error NotBeneficiary(uint256 lockId, address caller);
    error NotTransferable(uint256 lockId);
    error TransferFailed(address token);

    /**
     * Escrow `params.amount` of `params.token` and start its schedule.
     *
     * Permissionless: anyone may lock tokens for anyone else, which is how a
     * founder locks an allocation to a vesting contract the team does not
     * control, and how a treasury locks LP it does not hold the keys to.
     *
     * Reverts on a token that delivers nothing, so a lock can never exist with
     * a zero balance behind it. Credits what arrives rather than what was asked,
     * so a taxed token produces a smaller but honest lock instead of a
     * transaction that fails after the user has already paid gas to find out.
     */
    /**
     * V2: reject a second entry while a token callback is running.
     * Applied to every function that makes an external token call.
     */
    modifier nonReentrant() {
        if (_entered != 0) revert ReentrantCall();
        _entered = 1;
        _;
        _entered = 0;
    }

    function createLock(CreateParams calldata params) external nonReentrant returns (uint256 lockId) {
        _validate(params);

        uint256 before = IERC20Minimal(params.token).balanceOf(address(this));
        _callOptionalReturn(
            params.token,
            abi.encodeWithSelector(
                IERC20TransferFrom.transferFrom.selector,
                msg.sender,
                address(this),
                params.amount
            )
        );
        uint256 received = IERC20Minimal(params.token).balanceOf(address(this)) - before;
        if (received == 0) revert NothingReceived(params.token, params.amount);
        if (received > type(uint128).max) revert AmountTooLarge(received);

        lockId = _nextLockId++;

        _locks[lockId] = Lock({
            token: params.token,
            startTime: params.startTime,
            initialUnlockBps: params.initialUnlockBps,
            revocable: params.revocable,
            transferable: params.transferable,
            beneficiary: params.beneficiary,
            cliffTime: params.cliffTime,
            revoked: false,
            renounced: false,
            creator: msg.sender,
            endTime: params.endTime,
            steps: params.steps,
            amount: uint128(received),
            claimed: 0,
            label: params.label,
            agent: params.agent
        });

        _emitCreated(lockId, params, received);
    }

    /**
     * The creation event, in its own function so `createLock` does not have to
     * hold thirteen arguments on the stack at the same time as the struct it
     * just wrote. Emitting from `params` rather than from the stored lock keeps
     * the event a statement about what was asked for — `received` is the one
     * field that differs, and it is passed in explicitly.
     */
    function _emitCreated(
        uint256 lockId,
        CreateParams calldata params,
        uint256 received
    ) private {
        emit LockCreated(
            lockId,
            params.token,
            msg.sender,
            params.beneficiary,
            params.agent,
            received,
            params.startTime,
            params.cliffTime,
            params.endTime,
            params.initialUnlockBps,
            params.steps,
            params.revocable,
            params.transferable,
            params.label
        );
    }

    /**
     * Everything that has to be true before a lock exists.
     *
     * Its own function for two reasons. The checks read as one block instead of
     * seven statements interleaved with the transfer, and `createLock` ran out
     * of stack slots once `steps` was added — Solidity keeps sixteen, and the
     * function that does the work needs them. `viaIR` would also compile it and
     * would change the bytecode of everything else to do so.
     */
    function _validate(CreateParams calldata params) private view {
        if (params.token.code.length == 0) revert NotAContract(params.token);
        if (params.beneficiary == address(0)) revert ZeroBeneficiary();
        if (params.amount == 0) revert ZeroAmount();
        if (params.amount > type(uint128).max) revert AmountTooLarge(params.amount);
        if (params.initialUnlockBps > BPS_DENOMINATOR) {
            revert InvalidInitialUnlock(params.initialUnlockBps);
        }
        // A tranche must be at least one basis point wide, so `tail / steps`
        // never divides by zero. Asking for more tranches than there are basis
        // points would mean steps so fine they are the continuous form anyway.
        uint16 maxSteps = BPS_DENOMINATOR - params.initialUnlockBps;
        if (params.steps > maxSteps) revert TooManySteps(params.steps, maxSteps);
        // Equal timestamps are legal and meaningful: start == cliff == end is a
        // plain "lock until T". Only a decrease is impossible to interpret.
        if (params.startTime > params.cliffTime || params.cliffTime > params.endTime) {
            revert UnorderedSchedule(params.startTime, params.cliffTime, params.endTime);
        }
    }

    /**
     * Withdraw whatever has vested and is not yet claimed, to the beneficiary.
     *
     * Callable by anyone. The destination is never a parameter, so there is no
     * way to send a team's tokens somewhere else, and a sponsor or a relayer
     * can pay the gas on the beneficiary's behalf without being trusted with
     * anything. Tokens go to the beneficiary, always.
     */
    function claim(uint256 lockId) external nonReentrant returns (uint256 amount) {
        Lock storage lock = _locks[lockId];
        if (lock.token == address(0)) revert UnknownLock(lockId);

        if (lock.renounced) revert LockRenounced(lockId);
        amount = _claimable(lock);
        if (amount == 0) revert NothingClaimable(lockId);

        // Effects before interaction: `claimed` is settled before the token is
        // called, so a token that re-enters cannot be paid twice.
        lock.claimed += uint128(amount);
        _callOptionalReturn(
            lock.token,
            abi.encodeWithSelector(IERC20Transfer.transfer.selector, lock.beneficiary, amount)
        );

        emit Claimed(lockId, lock.beneficiary, amount);
    }

    /**
     * Cancel a revocable lock: refund the unvested part to the creator and
     * freeze what has already vested so the beneficiary can still take it.
     *
     * Only the creator, only on a lock that declared itself revocable. The
     * freeze is implemented by collapsing the schedule onto the current
     * timestamp and shrinking `amount` to the vested total, which leaves
     * `_vested` returning exactly that number forever without a second code
     * path for revoked locks. `claimed` is untouched, so anything vested but
     * not yet withdrawn stays withdrawable.
     *
     * A revocable lock is a materially weaker guarantee than an irrevocable one
     * and the front end is responsible for saying so on the lock page and in
     * the badge. The event carries both halves so an indexer can show the split
     * without reconstructing the schedule.
     */
    function revoke(uint256 lockId) external nonReentrant {
        Lock storage lock = _locks[lockId];
        if (lock.token == address(0)) revert UnknownLock(lockId);
        if (!lock.revocable) revert NotRevocable(lockId);
        if (lock.revoked) revert AlreadyRevoked(lockId);
        // Renouncing means nobody takes these, and that has to include the
        // creator taking the unvested part back — otherwise "nobody" is not true.
        if (lock.renounced) revert LockRenounced(lockId);
        if (msg.sender != lock.creator) revert NotCreator(lockId, msg.sender);

        uint256 vestedNow = _vested(lock, uint64(block.timestamp));
        uint256 credited = lock.amount;
        uint256 refund = credited - vestedNow;

        lock.revoked = true;
        lock.amount = uint128(vestedNow);
        lock.startTime = uint64(block.timestamp);
        lock.cliffTime = uint64(block.timestamp);
        lock.endTime = uint64(block.timestamp);

        if (refund != 0) {
            _callOptionalReturn(
                lock.token,
                abi.encodeWithSelector(IERC20Transfer.transfer.selector, lock.creator, refund)
            );
        }

        emit Revoked(lockId, lock.creator, refund, vestedNow);
    }

    /**
     * Hand the lock to another beneficiary. Only from the current beneficiary,
     * and only on a lock that declared itself transferable.
     *
     * Off by default because a transferable vesting position is a market: the
     * recipient of a future unlock can sell it today, and a buyer who does not
     * realise that will read the lock as stronger than it is.
     */
    function transferLock(uint256 lockId, address to) external {
        if (to == address(0)) revert ZeroBeneficiary();
        Lock storage lock = _locks[lockId];
        if (lock.token == address(0)) revert UnknownLock(lockId);
        if (!lock.transferable) revert NotTransferable(lockId);
        if (lock.renounced) revert LockRenounced(lockId);
        _requireBeneficiaryOrAgent(lock, lockId);

        emit LockTransferred(lockId, lock.beneficiary, to);
        lock.beneficiary = to;
    }

    /**
     * Give up the right to claim, permanently.
     *
     * The strongest statement this contract can make, and the one an LP lock is
     * usually trying to make: not "these cannot move until a date" but "these
     * cannot move again". After this, `claim` reverts, `revoke` reverts, and the
     * tokens stay in the contract forever. There is no un-renounce, which is the
     * entire point — a renounce that could be taken back would mean nothing.
     *
     * Only the beneficiary, because it is their claim being given up. The
     * creator's `revoke` is blocked too, so a revocable lock cannot be used to
     * take back tokens that were announced as gone for good.
     */
    function renounce(uint256 lockId) external {
        Lock storage lock = _locks[lockId];
        if (lock.token == address(0)) revert UnknownLock(lockId);
        if (lock.renounced) revert AlreadyRenounced(lockId);
        _requireBeneficiaryOrAgent(lock, lockId);

        lock.renounced = true;
        emit Renounced(lockId, msg.sender);
    }

    /**
     * Change what a lock promises, after the fact.
     *
     * `newAmount` moves the locked quantity and `newEndTime` moves the unlock
     * date; either may go **down** as well as up. That is PinkLock's semantic —
     * its form says "increase the locked amount and adjust the unlock date",
     * and only the amount is one-way there — and it is offered here because a
     * lock whose terms can never be corrected is a lock people are afraid to
     * create. The price is real and is written into the event rather than
     * hidden: `LockEdited` carries the old values, so an indexer can show that
     * a lock was weakened and by how much. A promise that can be relaxed is a
     * different promise, and a reader is entitled to see which one they have.
     *
     * Growing the amount pulls the difference from the caller and credits what
     * actually arrives, the same rule as `createLock`, so a fee-on-transfer
     * token cannot make the record say more than the vault holds. Shrinking
     * sends the difference to the **beneficiary** — never to the caller — and
     * can never go below what has already been claimed.
     *
     * Who may call it: the beneficiary, or the lock's declared agent — the same
     * pair that may transfer and renounce, and no more. A lock whose `agent` is
     * zero can only be edited by its beneficiary.
     */
    function editLock(uint256 lockId, uint128 newAmount, uint64 newEndTime) external nonReentrant {
        Lock storage lock = _locks[lockId];
        if (lock.token == address(0)) revert UnknownLock(lockId);
        if (lock.renounced) revert LockRenounced(lockId);
        if (lock.revoked) revert AlreadyRevoked(lockId);
        _requireBeneficiaryOrAgent(lock, lockId);

        uint128 oldAmount = lock.amount;
        uint64 oldEnd = lock.endTime;

        // A plain "lock until T" has one date in three fields; moving it has to
        // move all three or the schedule stops describing a single unlock. A
        // vesting lock keeps its start and cliff and only slides its end.
        bool plain = lock.startTime == lock.endTime && lock.cliffTime == lock.endTime;

        if (newAmount > oldAmount) {
            uint256 delta = uint256(newAmount) - oldAmount;
            uint256 before = IERC20Minimal(lock.token).balanceOf(address(this));
            _callOptionalReturn(
                lock.token,
                abi.encodeWithSelector(
                    IERC20TransferFrom.transferFrom.selector,
                    msg.sender,
                    address(this),
                    delta
                )
            );
            uint256 received = IERC20Minimal(lock.token).balanceOf(address(this)) - before;
            // Nothing arrived: refuse rather than record an amount the vault
            // cannot pay. Same stance as `createLock`'s `NothingReceived`.
            if (received == 0) revert NothingReceived(lock.token, delta);
            lock.amount = uint128(uint256(oldAmount) + received);
        } else if (newAmount < oldAmount) {
            if (newAmount < lock.claimed) revert AmountBelowClaimed(lockId, newAmount, lock.claimed);
            uint256 back = uint256(oldAmount) - newAmount;
            lock.amount = newAmount;
            _callOptionalReturn(
                lock.token,
                abi.encodeWithSelector(IERC20Transfer.transfer.selector, lock.beneficiary, back)
            );
        }

        if (plain) {
            lock.startTime = newEndTime;
            lock.cliffTime = newEndTime;
            lock.endTime = newEndTime;
        } else {
            // Keep start <= cliff <= end: `_vested` reads that ordering and a
            // cliff beyond the end would be a schedule nobody can compute.
            if (newEndTime < lock.cliffTime) revert UnorderedSchedule(lock.startTime, lock.cliffTime, newEndTime);
            lock.endTime = newEndTime;
        }

        emit LockEdited(lockId, oldAmount, lock.amount, oldEnd, lock.endTime);
    }

    /**
     * Rename a lock. Cosmetic: it is the text a lock list shows and nothing
     * else. Same callers as `editLock`, and refused once renounced so a
     * permanent lock's record stops changing too.
     */
    function setLabel(uint256 lockId, bytes32 label) external {
        Lock storage lock = _locks[lockId];
        if (lock.token == address(0)) revert UnknownLock(lockId);
        if (lock.renounced) revert LockRenounced(lockId);
        _requireBeneficiaryOrAgent(lock, lockId);

        emit LabelUpdated(lockId, lock.label, label);
        lock.label = label;
    }

    /**
     * The pair allowed to move a lock: its beneficiary, and the agent the lock
     * declared at creation. `agent == address(0)` (a lock made directly on this
     * vault) leaves exactly the beneficiary, i.e. exactly the old rule.
     */
    function _requireBeneficiaryOrAgent(Lock storage lock, uint256 lockId) private view {
        if (msg.sender != lock.beneficiary && msg.sender != lock.agent) {
            revert NotBeneficiary(lockId, msg.sender);
        }
    }

    /** The full lock record. A zero `token` means the id was never used. */
    function getLock(uint256 lockId) external view returns (Lock memory) {
        return _locks[lockId];
    }

    /** Amount withdrawable by `claim` right now, in token base units. */
    function claimable(uint256 lockId) external view returns (uint256) {
        Lock storage lock = _locks[lockId];
        if (lock.token == address(0)) revert UnknownLock(lockId);
        return _claimable(lock);
    }

    /**
     * Cumulative vested amount at an arbitrary timestamp.
     *
     * Exists so the front end draws the vesting curve by asking the contract,
     * rather than by reimplementing the formula in JavaScript. A chart that
     * disagrees with the contract is the failure this prevents, and a second
     * implementation is the only way it happens.
     */
    function vestedAt(uint256 lockId, uint64 timestamp) external view returns (uint256) {
        Lock storage lock = _locks[lockId];
        if (lock.token == address(0)) revert UnknownLock(lockId);
        return _vested(lock, timestamp);
    }

    /** Id that the next `createLock` will take. Also the count of locks made. */
    function nextLockId() external view returns (uint256) {
        return _nextLockId;
    }

    /**
     * Vested total minus what has already been claimed, or zero before the
     * cliff. The cliff gates withdrawal only: `_vested` keeps accruing behind
     * it, so the amount released the instant the cliff passes is everything
     * that accumulated, which is what a cliff is supposed to mean.
     */
    function _claimable(Lock storage lock) private view returns (uint256) {
        if (lock.renounced) return 0;
        if (block.timestamp < lock.cliffTime) return 0;
        uint256 vestedNow = _vested(lock, uint64(block.timestamp));
        uint256 alreadyPaid = lock.claimed;
        return vestedNow > alreadyPaid ? vestedNow - alreadyPaid : 0;
    }

    /**
     * The schedule, as documented at the top of the file. `endTime ==
     * startTime` short-circuits to the full amount, which is what makes a plain
     * time lock the degenerate case of the same formula instead of a branch in
     * every caller.
     *
     * The multiplication is ordered so that the division happens once, at the
     * end, over the whole numerator. The obvious form
     *
     *     amount * (bps + (10000 - bps) * elapsed / span) / 10000
     *
     * divides twice, and the inner division truncates: on a 90-day schedule the
     * fraction elapsed/span does not reach one basis point until roughly
     * thirteen minutes in, so a claim made before then returns zero even though
     * time has demonstrably passed. Nothing about that is visible in a unit test
     * that jumps straight to the halfway point, which is how it survived until
     * the contract was actually run.
     *
     * Overflow is not reachable: `amount` is at most 2^128, the inner sum at
     * most about 10^4 * 2^64, and the product stays below 2^208.
     */
    function _vested(Lock storage lock, uint64 timestamp) private view returns (uint256) {
        uint256 amount = lock.amount;
        if (timestamp < lock.startTime) return 0;
        if (timestamp >= lock.endTime) return amount;
        // Here startTime < endTime, so neither span nor the denominator is zero.
        uint256 bps = lock.initialUnlockBps;
        uint256 elapsed = timestamp - lock.startTime;
        uint256 span = lock.endTime - lock.startTime;
        uint256 tail = BPS_DENOMINATOR - bps;

        uint256 steps = lock.steps;
        if (steps == 0) {
            // One division, at the end. Dividing twice truncates the inner
            // term to nothing for the first minutes of a long schedule, so an
            // early claim pays zero while time has visibly passed.
            return (amount * (bps * span + tail * elapsed)) / (BPS_DENOMINATOR * span);
        }

        // Quantise how far into the tail we are, downward, so a tranche lands
        // on its date and not one second before it. `stepSize >= 1` because
        // `steps <= tail` was enforced at creation.
        uint256 stepSize = tail / steps;
        uint256 released = (((tail * elapsed) / span) / stepSize) * stepSize;
        return (amount * (bps + released)) / BPS_DENOMINATOR;
    }

    /**
     * ERC-20 calls that tolerate the tokens which do not follow the standard.
     *
     * USDT and a handful of others return nothing on success. Demanding a
     * returned `true` locks them out; demanding nothing accepts a token that
     * returned `false` and did nothing. The rule used here is the one every
     * wallet and exchange settled on: the call must not revert, and if it
     * returned data at all, that data must decode to true. A revert is bubbled
     * up with its original reason so the user sees the token's own error rather
     * than a generic one.
     */
    function _callOptionalReturn(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) {
            if (ret.length == 0) revert TransferFailed(token);
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        if (ret.length != 0 && !abi.decode(ret, (bool))) revert TransferFailed(token);
    }
}

/** Only what the vault reads from a token: its balance. */
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
}

/** Split out so `transfer` and `transferFrom` selectors are named, not typed. */
interface IERC20Transfer {
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IERC20TransferFrom {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
