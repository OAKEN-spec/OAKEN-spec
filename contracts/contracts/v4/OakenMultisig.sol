// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/**
 * @title OakenMultisig
 * @notice A small N-of-M multisig. Deployed as a 2-of-3 with the same three
 *         owners as the existing Safe; it owns the DelayedProxyAdmin.
 *
 * Why not reuse the Safe? The Safe is deployed on Robinhood Chain only. The v4
 * vaults live on four chains, and an admin address must be able to send a
 * transaction on the chain where the upgrade happens. This contract is deployed
 * deterministically on each chain with the same owners and threshold, so the
 * admin story is identical everywhere.
 *
 * A transaction is a `(target, value, data)` triple. The submitter confirms it;
 * one more owner confirms; either owner executes. There is no proposal delay
 * here — the delay lives in DelayedProxyAdmin.
 */
contract OakenMultisig {
    address[] private _owners;
    uint256 public threshold;
    uint256 public transactionCount;

    struct Transaction {
        address target;
        uint256 value;
        bytes data;
        bool executed;
        uint256 confirmations;
    }

    mapping(address => bool) public isOwner;
    mapping(uint256 => Transaction) private _transactions;
    mapping(uint256 => mapping(address => bool)) private _confirmed;

    event Submission(uint256 indexed id, address indexed owner, address indexed target, uint256 value, bytes data);
    event Confirmation(uint256 indexed id, address indexed owner);
    event Revocation(uint256 indexed id, address indexed owner);
    event Execution(uint256 indexed id, address indexed owner, bool success);

    error NotOwner();
    error AlreadyOwner();
    error InvalidThreshold();
    error InvalidOwner();
    error ZeroTarget();
    error UnknownTransaction(uint256 id);
    error AlreadyExecuted(uint256 id);
    error NotConfirmed(uint256 id, address owner);
    error AlreadyConfirmed(uint256 id, address owner);
    error NotEnoughConfirmations(uint256 id, uint256 have, uint256 need);
    error CallFailed(uint256 id);
    error ReentrantCall();

    bool private _entered;

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered) revert ReentrantCall();
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address[] memory owners_, uint256 threshold_) {
        if (owners_.length == 0) revert InvalidOwner();
        if (threshold_ == 0 || threshold_ > owners_.length) revert InvalidThreshold();
        for (uint256 i = 0; i < owners_.length; i++) {
            address o = owners_[i];
            if (o == address(0)) revert InvalidOwner();
            if (isOwner[o]) revert AlreadyOwner();
            isOwner[o] = true;
            _owners.push(o);
        }
        threshold = threshold_;
    }

    receive() external payable {}

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function submit(address target, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (target == address(0)) revert ZeroTarget();
        id = ++transactionCount;
        _transactions[id] = Transaction({
            target: target,
            value: value,
            data: data,
            executed: false,
            confirmations: 0
        });
        emit Submission(id, msg.sender, target, value, data);
        _confirm(id, msg.sender);
    }

    function confirm(uint256 id) external onlyOwner {
        _confirm(id, msg.sender);
    }

    function revoke(uint256 id) external onlyOwner {
        Transaction storage t = _transactions[id];
        if (t.target == address(0)) revert UnknownTransaction(id);
        if (t.executed) revert AlreadyExecuted(id);
        if (!_confirmed[id][msg.sender]) revert NotConfirmed(id, msg.sender);
        _confirmed[id][msg.sender] = false;
        t.confirmations -= 1;
        emit Revocation(id, msg.sender);
    }

    function execute(uint256 id) external onlyOwner nonReentrant {
        Transaction storage t = _transactions[id];
        if (t.target == address(0)) revert UnknownTransaction(id);
        if (t.executed) revert AlreadyExecuted(id);
        if (t.confirmations < threshold) revert NotEnoughConfirmations(id, t.confirmations, threshold);
        /* Effects before interaction. A re-entrant execute for the same id
           sees `executed == true` and reverts. */
        t.executed = true;
        (bool ok,) = t.target.call{ value: t.value }(t.data);
        if (!ok) revert CallFailed(id);
        emit Execution(id, msg.sender, true);
    }

    function getTransaction(uint256 id)
        external
        view
        returns (address target, uint256 value, bytes memory data, bool executed, uint256 confirmations)
    {
        Transaction storage t = _transactions[id];
        if (t.target == address(0)) revert UnknownTransaction(id);
        return (t.target, t.value, t.data, t.executed, t.confirmations);
    }

    function isConfirmed(uint256 id, address owner) external view returns (bool) {
        return _confirmed[id][owner];
    }

    function _confirm(uint256 id, address owner) private {
        Transaction storage t = _transactions[id];
        if (t.target == address(0)) revert UnknownTransaction(id);
        if (t.executed) revert AlreadyExecuted(id);
        if (_confirmed[id][owner]) revert AlreadyConfirmed(id, owner);
        _confirmed[id][owner] = true;
        t.confirmations += 1;
        emit Confirmation(id, owner);
    }
}
