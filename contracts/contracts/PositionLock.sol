// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;
pragma abicoder v2;

/**
 * @title PositionLock
 * @notice Escrow for ERC-721 positions — Uniswap V3 and V4 liquidity — until a
 *         timestamp, at one identical address on every EVM chain.
 *
 * Sibling of LockVault, and separate for a reason. An LP position in a V2 pool
 * is an ERC-20 and belongs in the vault; a V3 or V4 position is an NFT and
 * needs an entirely different escrow, a different release rule, and a different
 * set of hazards. Folding both into one contract would put NFT-transfer code
 * into the contract that holds everybody's tokens, for a feature most locks
 * never use. Two contracts, two addresses, one explorer.
 *
 * ## What "locked" means here, and where its limit is
 *
 * The position NFT sits in this contract, so its owner is this contract, and
 * ERC-721's authorisation rules do the work: the single-token approval is
 * cleared by the transfer that brings the position in, and an operator approved
 * through `setApprovalForAll` is approved over the tokens *its approver owns*,
 * not over a token id — so an operator the creator appointed before locking has
 * no standing once this contract is the owner. The creator cannot call
 * `decreaseLiquidity`, `collect`, or transfer the position while it is held
 * here. That is the guarantee, and it is enforced by the token being somewhere
 * else, not by this contract checking anything.
 *
 * The limit: **this contract accepts any ERC-721, so the lock is only as strong
 * as the collection's own transfer semantics.** A collection that keeps a
 * back door — an admin that can move a token, a `transferFrom` that does not
 * check the sender, a balance that can be re-minted — defeats this escrow
 * completely, and nothing on-chain distinguishes it from a real position
 * manager. The defence is off-chain and belongs on the badge: the collection
 * address is part of the lock record and must be shown, and the front end
 * should only make the strong claim ("this LP is locked") for a registry of
 * known position managers — Uniswap V3 and V4, PancakeSwap V3 and their
 * equivalents. Locking any other NFT is supported and is a different, weaker
 * statement.
 *
 * A second, smaller limit: a non-standard collection whose `transferFrom`
 * reverts would trap the position, since there is no rescue function here and
 * never will be. Same registry, same defence.
 *
 * ## Release is a pull, never a push
 *
 * Tokens leave via `transferFrom`, not `safeTransferFrom`. `safeTransferFrom`
 * calls `onERC721Received` on the destination and reverts if the destination is
 * a contract that has not implemented it — which would make the position
 * permanently unrecoverable, because this contract is immutable and has no
 * rescue path. The beneficiary names its own address, so the receiver check
 * protects nobody; it only adds a way to brick the asset. Vault and position
 * both return by pulling.
 *
 * ## Revocable
 *
 * A revocable position lock lets the creator reclaim at any time before the
 * beneficiary releases it. For an indivisible asset there is no "unvested part"
 * to split, so the whole thing goes back — meaning a revocable position lock is
 * a statement that the position is escrowed *right now*, and nothing more. Off
 * by default, surfaced explicitly on the lock page.
 */
contract PositionLock {
    /**
     * ERC-721 `onERC721Received` return value, per EIP-721. Returned by this
     * contract's receiver so `safeTransferFrom` into the escrow succeeds.
     */
    bytes4 private constant ERC721_RECEIVED = 0x150b7a02;

    struct Lock {
        // slot 0
        address nft;
        uint64 unlockTime;
        bool revocable;
        bool released;
        // slot 1
        address creator;
        uint64 createdAt;
        // slot 2
        address beneficiary;
        // slot 3
        uint256 tokenId;
        // slot 4
        bytes32 label;
    }

    struct CreateParams {
        /** ERC-721 collection: a Uniswap V3/V4 position manager, or anything else. */
        address nft;
        /** The position to escrow. */
        uint256 tokenId;
        /** Receives the position on release. May differ from the creator. */
        address beneficiary;
        /** Earliest timestamp at which `release` succeeds. */
        uint64 unlockTime;
        /** If true, `creator` may reclaim before the beneficiary releases. */
        bool revocable;
        /** Short public label, e.g. "Uniswap V3 LP". */
        bytes32 label;
    }

    mapping(uint256 => Lock) private _locks;

    /** Ids start at 1 so a zero id is unambiguously "no such lock". */
    uint256 private _nextLockId = 1;

    /**
     * `unlockTime` and `revocable` are in the event because they are what a
     * reader is actually checking; `nft` and `tokenId` identify the position;
     * and the indexer gets all of it from one log without a follow-up call.
     */
    event PositionLocked(
        uint256 indexed lockId,
        address indexed nft,
        uint256 indexed tokenId,
        address creator,
        address beneficiary,
        uint64 unlockTime,
        bool revocable,
        bytes32 label
    );

    event PositionReleased(uint256 indexed lockId, address indexed beneficiary, uint256 tokenId);

    event PositionReclaimed(uint256 indexed lockId, address indexed creator, uint256 tokenId);

    error NotAContract(address nft);
    error ZeroBeneficiary();
    error UnlockTimeInPast(uint64 unlockTime, uint256 now_);
    error NotPositionOwner(address nft, uint256 tokenId, address caller);
    error UnknownLock(uint256 lockId);
    error AlreadyReleased(uint256 lockId);
    error StillLocked(uint256 lockId, uint64 unlockTime);
    error NotRevocable(uint256 lockId);
    error NotCreator(uint256 lockId, address caller);
    error NotBeneficiary(uint256 lockId, address caller);
    error UnexpectedToken();

    /**
     * Move `params.tokenId` from the caller into escrow until
     * `params.unlockTime`.
     *
     * The caller must own the position and must have approved this contract,
     * which the front end arranges with a single `approve` on the position
     * manager — no `setApprovalForAll` over the whole collection, since that
     * would hand this contract rights over positions the user never intended to
     * lock and would make the "is everything locked?" question unanswerable.
     *
     * A position whose lock is already in the past is rejected rather than
     * accepted and immediately releasable: a lock that anyone can open the
     * instant it exists is not a lock, and accepting one would let a creator
     * manufacture a badge that says "locked" about something already movable.
     */
    function lockPosition(CreateParams calldata params) external returns (uint256 lockId) {
        if (params.nft.code.length == 0) revert NotAContract(params.nft);
        if (params.beneficiary == address(0)) revert ZeroBeneficiary();
        if (params.unlockTime <= block.timestamp) {
            revert UnlockTimeInPast(params.unlockTime, block.timestamp);
        }
        if (IERC721OwnerOf(params.nft).ownerOf(params.tokenId) != msg.sender) {
            revert NotPositionOwner(params.nft, params.tokenId, msg.sender);
        }

        lockId = _nextLockId++;

        _locks[lockId] = Lock({
            nft: params.nft,
            unlockTime: params.unlockTime,
            revocable: params.revocable,
            released: false,
            creator: msg.sender,
            createdAt: uint64(block.timestamp),
            beneficiary: params.beneficiary,
            tokenId: params.tokenId,
            label: params.label
        });

        // Plain `transferFrom`, not `safeTransferFrom`: this contract
        // implements the receiver interface, so both work on the way in, and
        // `transferFrom` is the one whose behaviour does not depend on the
        // collection's implementation of the receiver check.
        IERC721TransferFrom(params.nft).transferFrom(msg.sender, address(this), params.tokenId);

        emit PositionLocked(
            lockId,
            params.nft,
            params.tokenId,
            msg.sender,
            params.beneficiary,
            params.unlockTime,
            params.revocable,
            params.label
        );
    }

    /**
     * Send the position to the beneficiary, at or after `unlockTime`.
     *
     * Callable by anyone, like `claim` in the vault: the destination is read
     * from storage and is never a parameter. Uses `transferFrom` — see the
     * contract header for why a receiver check here would be a way to lose the
     * position rather than a way to protect it.
     */
    function release(uint256 lockId) external {
        Lock storage lock = _locks[lockId];
        if (lock.nft == address(0)) revert UnknownLock(lockId);
        if (lock.released) revert AlreadyReleased(lockId);
        if (block.timestamp < lock.unlockTime) revert StillLocked(lockId, lock.unlockTime);

        lock.released = true;
        IERC721TransferFrom(lock.nft).transferFrom(address(this), lock.beneficiary, lock.tokenId);

        emit PositionReleased(lockId, lock.beneficiary, lock.tokenId);
    }

    /**
     * Take the position back, before the beneficiary releases it.
     *
     * Only the creator, only on a lock that declared itself revocable, and only
     * while the position is still held — once `release` has run the lock is
     * over and this reverts. Note that it is available *after* `unlockTime` as
     * well: the beneficiary's protection is that it can release at any moment
     * once unlocked, so a creator racing it is a race the creator can lose, and
     * restricting this to before `unlockTime` would only add a second way for
     * the two to disagree.
     */
    function reclaim(uint256 lockId) external {
        Lock storage lock = _locks[lockId];
        if (lock.nft == address(0)) revert UnknownLock(lockId);
        if (lock.released) revert AlreadyReleased(lockId);
        if (!lock.revocable) revert NotRevocable(lockId);
        if (msg.sender != lock.creator) revert NotCreator(lockId, msg.sender);

        lock.released = true;
        IERC721TransferFrom(lock.nft).transferFrom(address(this), lock.creator, lock.tokenId);

        emit PositionReclaimed(lockId, lock.creator, lock.tokenId);
    }

    /**
     * Acceptance hook for `safeTransferFrom`.
     *
     * The escrow is reachable two ways: `lockPosition` pulls with
     * `transferFrom`, and anyone may push a position in with
     * `safeTransferFrom`. A pushed position lands here with no lock record, and
     * since this contract has no rescue function it would be stuck — so the
     * hook accepts only `tokenId == 0`, which no real collection mints, and
     * rejects everything else.
     *
     * That leaves settlement to the front end: `safeTransferFrom` into the
     * escrow followed by a `lockPosition` call is not a path this contract
     * offers. The lock must be created by the owner in one transaction.
     */
    function onERC721Received(
        address,
        address,
        uint256 tokenId,
        bytes calldata
    ) external pure returns (bytes4) {
        if (tokenId != 0) revert UnexpectedToken();
        return ERC721_RECEIVED;
    }

    /** The full lock record. A zero `nft` means the id was never used. */
    function getLock(uint256 lockId) external view returns (Lock memory) {
        return _locks[lockId];
    }

    /**
     * True when `release` would succeed right now: the lock exists, has not
     * been released or reclaimed, and its time has passed. The single question
     * a reader of the badge is asking.
     */
    function isReleasable(uint256 lockId) external view returns (bool) {
        Lock storage lock = _locks[lockId];
        return lock.nft != address(0) && !lock.released && block.timestamp >= lock.unlockTime;
    }

    /** Id that the next `lockPosition` will take. Also the count of locks made. */
    function nextLockId() external view returns (uint256) {
        return _nextLockId;
    }
}

/** Minimal ERC-721 surface. Deliberately not `safeTransferFrom` — see header. */
interface IERC721TransferFrom {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

interface IERC721OwnerOf {
    function ownerOf(uint256 tokenId) external view returns (address);
}
