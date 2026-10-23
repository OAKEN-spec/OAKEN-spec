// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title OakenAirdrop
 * @notice Many campaigns in one contract: deposit a list, publish its root, let
 *         people claim their own share.
 *
 * ## The shape of the thing
 *
 * A campaign is a token, a Merkle root, an amount, and a deadline. The root is
 * the commitment — a fingerprint of the whole `(index, address, amount)` list —
 * and the list itself never goes on chain. Whoever claims has to present their
 * own row plus the path that proves it belongs to the root, and the contract
 * checks it in a handful of hashes.
 *
 * That is the difference between this and the "paste 500 addresses into a
 * transaction" approach: the distribution costs one transaction instead of one
 * per recipient, the list can be 50,000 rows without touching the block gas
 * limit, and the cost of claiming falls on the people claiming.
 *
 * ## What the contract can and cannot do
 *
 * It cannot invent a recipient: a claim that does not hash up to the root
 * reverts. It cannot pay twice: each row is marked claimed.
 *
 * The creator keeps exactly two powers, both stated up front and visible to
 * anyone reading the campaign: the tokens are pulled from them at creation (so
 * there is nothing to fund later), and after the deadline they can take back
 * whatever nobody claimed. Until that deadline, the unclaimed remainder sits in
 * this contract and only the list can reach it.
 *
 * The deadline is not a trick: an airdrop that can be emptied at any moment is
 * an airdrop nobody can plan around. Making the date a creation parameter means
 * a claimant can see how long they have before they even connect a wallet.
 *
 * ## The list has to be published somewhere, and this contract does not do it
 *
 * The root commits to a list, but it cannot reproduce it — a hash is a
 * fingerprint, not a dossier. The file that goes with a campaign (the rows, for
 * building a proof) is data the creator publishes next to the campaign, and the
 * claim page **rebuilds the root from that file and refuses to use it if it
 * does not match the chain**. That check is the whole reason the file can live
 * anywhere: a wrong or edited list cannot produce proofs that this contract
 * accepts, so the copy on our site and the copy on theirs are the same thing as
 * long as both hash to the root that is on chain.
 */
contract OakenAirdrop {
    struct Campaign {
        /** Who funded it, and who can sweep the remainder after the deadline. */
        address creator;
        /** The ERC-20 being distributed. */
        address token;
        /** Fingerprint of the `(index, account, amount)` list. */
        bytes32 root;
        /** Claims are open until this moment; the sweep opens after it. */
        uint64 deadline;
        /** Tokens actually received at creation (fee-on-transfer aside, the deposited amount). */
        uint128 total;
        /** Tokens claimed so far, and how many rows that was. */
        uint128 claimed;
        uint128 claimedRows;
        /** Set once the creator takes the remainder back; claims revert after that. */
        bool swept;
    }

    error NoCampaign(uint256 id);
    error NotCreator(uint256 id);
    error EmptyRoot();
    error ZeroAmount();
    error DeadlineNotInFuture(uint64 deadline);
    error AlreadyClaimed(uint256 id, uint256 index);
    error InvalidProof(uint256 id, uint256 index);
    error CampaignSwept(uint256 id);
    error DeadlineNotPassed(uint256 id, uint64 deadline);
    error NothingToSweep(uint256 id);
    error TokenTransferFailed(address token, address to, uint256 amount);

    event CampaignCreated(
        uint256 indexed id,
        address indexed creator,
        address indexed token,
        bytes32 root,
        uint256 amount,
        uint64 deadline
    );
    event Claimed(uint256 indexed id, address indexed account, uint256 amount, uint256 index);
    event Swept(uint256 indexed id, address indexed creator, uint256 amount);

    Campaign[] private _campaigns;
    /** id => leaf index => claimed. The row is the unit, not the address: one address may hold several. */
    mapping(uint256 => mapping(uint256 => bool)) private _claimed;

    function campaignCount() external view returns (uint256) {
        return _campaigns.length;
    }

    function campaign(uint256 id) external view returns (Campaign memory) {
        if (id >= _campaigns.length) revert NoCampaign(id);
        return _campaigns[id];
    }

    /** All campaigns, newest last. The list page reads this straight off the chain. */
    function allCampaigns() external view returns (Campaign[] memory) {
        return _campaigns;
    }

    /**
     * Fund a campaign.
     *
     * The tokens are pulled from the caller immediately — the amount is measured
     * by balance difference, so a fee-on-transfer token credits what actually
     * arrived rather than what was asked for (the same rule `LockVault` uses).
     * The root cannot be changed afterwards: a campaign whose list could be
     * rewritten is not a commitment.
     */
    function createCampaign(
        address token,
        bytes32 root,
        uint256 amount,
        uint64 deadline
    ) external returns (uint256 id) {
        if (root == bytes32(0)) revert EmptyRoot();
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlineNotInFuture(deadline);

        uint256 before = _balanceOf(token, address(this));
        _pullToken(token, msg.sender, amount);
        uint256 received = _balanceOf(token, address(this)) - before;

        id = _campaigns.length;
        _campaigns.push(Campaign({
            creator: msg.sender,
            token: token,
            root: root,
            deadline: deadline,
            total: uint128(received),
            claimed: 0,
            claimedRows: 0,
            swept: false
        }));

        emit CampaignCreated(id, msg.sender, token, root, received, deadline);
    }

    /**
     * Claim one row.
     *
     * Anyone may submit it — the tokens always go to `account`, the address the
     * row names, so a relayer can pay the gas for someone who has none. That is
     * the difference between "claim it yourself" and "get it claimed", and it
     * matters most to exactly the people an airdrop is for.
     */
    function claim(uint256 id, uint256 index, address account, uint256 amount, bytes32[] calldata proof) external {
        if (id >= _campaigns.length) revert NoCampaign(id);
        Campaign storage c = _campaigns[id];
        if (c.swept) revert CampaignSwept(id);
        if (_claimed[id][index]) revert AlreadyClaimed(id, index);

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        if (!_verify(proof, c.root, leaf)) revert InvalidProof(id, index);

        _claimed[id][index] = true;
        c.claimed += uint128(amount);
        c.claimedRows += 1;

        _pushToken(c.token, account, amount);
        emit Claimed(id, account, amount, index);
    }

    /** Take back whatever nobody claimed between the deadline and now. */
    function sweep(uint256 id) external returns (uint256 amount) {
        if (id >= _campaigns.length) revert NoCampaign(id);
        Campaign storage c = _campaigns[id];
        if (msg.sender != c.creator) revert NotCreator(id);
        if (c.swept) revert CampaignSwept(id);
        if (block.timestamp <= c.deadline) revert DeadlineNotPassed(id, c.deadline);

        amount = _balanceOf(c.token, address(this));
        // The contract may hold other campaigns' tokens too, so the sweep is
        // capped at what this campaign brought in and has not paid out. Without
        // this cap, a campaign whose token is shared with another campaign
        // could empty the neighbour.
        uint256 owed = uint256(c.total) - uint256(c.claimed);
        if (owed < amount) amount = owed;
        if (amount == 0) revert NothingToSweep(id);

        c.swept = true;
        _pushToken(c.token, c.creator, amount);
        emit Swept(id, c.creator, amount);
    }

    // ---- internals ---------------------------------------------------------

    /** The OpenZeppelin tree shape: sorted pairs, so a proof cannot be forged by swapping them. */
    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) private pure returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 p = proof[i];
            computed = computed <= p
                ? keccak256(abi.encodePacked(computed, p))
                : keccak256(abi.encodePacked(p, computed));
        }
        return computed == root;
    }

    function _balanceOf(address token, address who) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(IERC20BalanceOf.balanceOf.selector, who));
        if (!ok || data.length < 32) revert TokenTransferFailed(token, who, 0);
        return abi.decode(data, (uint256));
    }

    function _pullToken(address token, address from, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20TransferFrom.transferFrom.selector, from, address(this), amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed(token, from, amount);
    }

    function _pushToken(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Transfer.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed(token, to, amount);
    }
}

interface IERC20Transfer {
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IERC20TransferFrom {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC20BalanceOf {
    function balanceOf(address who) external view returns (uint256);
}
