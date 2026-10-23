// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title MultiSender
 * @notice Send one asset to many addresses in a single transaction.
 *
 * The tool every project needs on distribution day: a batch of contributors, a
 * list of giveaway winners, a payroll run. Doing it from a wallet means one
 * transaction per recipient and one signature per transaction; doing it here is
 * one transaction total, and the recipients cannot tell the difference.
 *
 * ## No owner, and no stored state
 *
 * Nothing is kept between calls: no recipient list, no fee, no pause. The
 * contract is a function of its arguments, which is what makes it safe to send
 * a whole batch through in one go — there is nothing to configure, nothing to
 * be granted, and nothing to revoke. Deploy it once and it is the same
 * artifact for everyone.
 *
 * ## Why batches are capped
 *
 * `MAX_RECIPIENTS` exists because a batch that does not fit in a block is a
 * batch that reverts after paying for the gas of everything that came before
 * it. 400 recipients fits comfortably in a 30M-gas block even with a
 * fee-on-transfer token; a list longer than that is split into two calls by the
 * front end, which knows the count before it starts.
 *
 * ## Zero amounts are skipped, zero addresses are not
 *
 * A zero amount transfers nothing and would just burn gas per entry, so it is
 * skipped silently — the recipient list produced by any real export is full of
 * them. A zero **address** is almost always a mistake in the list (a truncated
 * CSV row, an off-by-one column), and tokens sent there are gone; that reverts
 * the whole batch, because "which row was it" is not something the sender can
 * answer after the fact.
 */
contract MultiSender {
    /** Length of a batch, both arrays together. See the header. */
    uint256 public constant MAX_RECIPIENTS = 400;

    error EmptyBatch();
    error BatchTooLarge(uint256 count);
    error LengthMismatch(uint256 recipients, uint256 amounts);
    error ZeroRecipient(uint256 index);
    error ZeroAmount();
    error ValueMismatch(uint256 sent, uint256 required);
    error NativeTransferFailed(address to, uint256 amount);
    error TokenTransferFailed(address token, address to, uint256 amount);

    /**
     * One event for every form of dispersal. `token == address(0)` means native
     * currency — the same convention the rest of the EVM uses, so an indexer
     * does not need a second branch to see the batches that moved ETH/BNB/POL.
     */
    event Dispersed(address indexed sender, address indexed token, uint256 recipients, uint256 total);

    /**
     * Native currency, one amount per recipient.
     *
     * The amounts are sent in order; the sum must equal `msg.value` exactly, so
     * a batch can never leave dust behind in the contract (dust accumulates
     * silently and looks like a bug the first time anyone audits the balance).
     */
    function disperseEther(address[] calldata to, uint256[] calldata amounts) external payable {
        uint256 count = _checkArrays(to, amounts);
        uint256 total = _sum(amounts);
        if (msg.value != total) revert ValueMismatch(msg.value, total);

        for (uint256 i; i < count; ++i) {
            uint256 amount = amounts[i];
            if (amount == 0) continue;
            _sendValue(to[i], amount);
        }
        emit Dispersed(msg.sender, address(0), count, total);
    }

    /** Native currency, the same amount to everyone. The remainder of the division by count is returned. */
    function disperseEtherEqual(address[] calldata to) external payable {
        uint256 count = _checkEqual(to);
        uint256 each = msg.value / count;
        if (each == 0) revert ValueMismatch(msg.value, count);

        for (uint256 i; i < count; ++i) _sendValue(to[i], each);

        emit Dispersed(msg.sender, address(0), count, each * count);
        // Anything left over from the division goes back: this call must not
        // become a place where the sender's change quietly stays behind.
        uint256 dust = msg.value - each * count;
        if (dust > 0) _sendValue(msg.sender, dust);
    }

    /**
     * An ERC-20, one amount per recipient.
     *
     * `transferFrom` per recipient rather than `transfer`: this contract never
     * holds a balance between calls, so there is nothing to drain if it is
     * ever left with an allowance, and every recipient's transfer is a separate
     * call that a fee-on-transfer token can account for correctly.
     */
    function disperseToken(address token, address[] calldata to, uint256[] calldata amounts) external {
        uint256 count = _checkArrays(to, amounts);
        uint256 total;
        for (uint256 i; i < count; ++i) total += amounts[i];

        for (uint256 i; i < count; ++i) {
            uint256 amount = amounts[i];
            if (amount == 0) continue;
            _pullToken(token, to[i], amount);
        }
        emit Dispersed(msg.sender, token, count, total);
    }

    /** An ERC-20, the same amount to everyone. */
    function disperseTokenEqual(address token, address[] calldata to, uint256 amountEach) external {
        uint256 count = _checkEqual(to);
        if (amountEach == 0) revert ZeroAmount();
        for (uint256 i; i < count; ++i) _pullToken(token, to[i], amountEach);
        emit Dispersed(msg.sender, token, count, amountEach * count);
    }

    // ---- internals ---------------------------------------------------------

    function _checkArrays(address[] calldata to, uint256[] calldata amounts) private pure returns (uint256) {
        uint256 count = to.length;
        if (count == 0) revert EmptyBatch();
        if (count > MAX_RECIPIENTS) revert BatchTooLarge(count);
        if (count != amounts.length) revert LengthMismatch(count, amounts.length);
        for (uint256 i; i < count; ++i) if (to[i] == address(0)) revert ZeroRecipient(i);
        return count;
    }

    function _checkEqual(address[] calldata to) private pure returns (uint256) {
        uint256 count = to.length;
        if (count == 0) revert EmptyBatch();
        if (count > MAX_RECIPIENTS) revert BatchTooLarge(count);
        for (uint256 i; i < count; ++i) if (to[i] == address(0)) revert ZeroRecipient(i);
        return count;
    }

    /** Overflow-checked sum: a batch whose amounts overflow is a wrong batch. */
    function _sum(uint256[] calldata amounts) private pure returns (uint256 total) {
        for (uint256 i; i < amounts.length; ++i) total += amounts[i];
    }

    function _sendValue(address to, uint256 amount) private {
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed(to, amount);
    }

    function _pullToken(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20TransferFrom.transferFrom.selector, msg.sender, to, amount)
        );
        // Tokens that return nothing are treated as success; tokens that return
        // `false` are not. Both exist in the wild, and the second one is why
        // this is a low-level call rather than a typed one.
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed(token, to, amount);
        }
    }
}

/** Selectors named rather than typed — same reason as LockVault's two. */
interface IERC20TransferFrom {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
