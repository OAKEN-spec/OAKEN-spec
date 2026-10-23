// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import { OakenToken } from "./OakenToken.sol";

/**
 * @title TokenFactory
 * @notice Deploy a plain fixed-supply ERC-20 in one transaction.
 *
 * A factory rather than "copy this template": the token that comes out here is
 * the same bytecode every time, at an address anyone can verify, created by a
 * contract that has no way to change it afterwards. The alternative — a project
 * deploying its own ERC-20 — means every buyer has to read a fresh contract to
 * find out whether this one has a mint function, and the answer is usually
 * "yes, in a file the project copied from a tutorial".
 *
 * ## What the factory keeps
 *
 * A list of what it has deployed, so the site can show "tokens created here"
 * without running an indexer over every block. The list is append-only and the
 * instances are independent: this contract has no power over a token after it
 * is deployed — it cannot mint, pause, or reach into one. `allTokens()` is a
 * convenience, not an authority.
 *
 * ## Limits, and why they are here rather than in the UI
 *
 * `name`/`symbol` are length-limited, `decimals` is capped at 18, and the
 * supply must be positive. None of those are safety properties — they are the
 * checks that keep a typo in a form from becoming a token that no wallet can
 * display. The limits are enforced on-chain as well because the front end is
 * not the only caller: anyone can call this contract with any arguments, and a
 * factory that only validates in its own UI is validating nothing.
 */
contract TokenFactory {
    /** Longest name/symbol accepted. Long enough for anything real, short enough to render. */
    uint256 public constant MAX_NAME = 64;
    uint256 public constant MAX_SYMBOL = 16;
    /** Wallets, DEXes and our own lock contracts all handle 18; above that is a foot-gun. */
    uint8 public constant MAX_DECIMALS = 18;

    error EmptyName();
    error NameTooLong(uint256 length);
    error SymbolTooLong(uint256 length);
    error DecimalsTooHigh(uint8 decimals);
    error ZeroSupply();

    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint8 decimals,
        uint256 supply
    );

    address[] private _tokens;

    /** Every token this factory has deployed, oldest first. */
    function allTokens() external view returns (address[] memory) {
        return _tokens;
    }

    function tokenCount() external view returns (uint256) {
        return _tokens.length;
    }

    /**
     * Deploy a token whose entire supply goes to the caller.
     *
     * To the caller and not to a parameter: a create-token form that can mint
     * the supply to somebody else is a form that can be used to lose it.
     * Whoever signs is who holds it, and moving it afterwards is a normal
     * transfer (or a lock, which is what the rest of this site is for).
     */
    function createToken(
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint256 supply
    ) external returns (address token) {
        bytes memory nameBytes = bytes(name);
        bytes memory symbolBytes = bytes(symbol);
        if (nameBytes.length == 0) revert EmptyName();
        if (nameBytes.length > MAX_NAME) revert NameTooLong(nameBytes.length);
        if (symbolBytes.length == 0) revert EmptyName();
        if (symbolBytes.length > MAX_SYMBOL) revert SymbolTooLong(symbolBytes.length);
        if (decimals > MAX_DECIMALS) revert DecimalsTooHigh(decimals);
        if (supply == 0) revert ZeroSupply();

        token = address(new OakenToken(name, symbol, decimals, supply, msg.sender));
        _tokens.push(token);

        emit TokenCreated(token, msg.sender, name, symbol, decimals, supply);
    }
}
