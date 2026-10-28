// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {OakenToken} from "../OakenToken.sol";
import {OakenCurve} from "./OakenCurve.sol";
import {IOakenCurvePoolInitializer} from "./IOakenCurveGraduator.sol";

/**
 * @title OakenCurveFactory
 * @notice Deploys a fixed-supply token and its bonding curve in one call.
 *
 * Every launch gets the same terms from this factory: the supply, the virtual
 * quote reserve, the graduation line, the fee policy and the graduator. Those
 * are constructor immutables, not owner-settable state — changing the model
 * means deploying a new factory, which is visible before anyone launches.
 *
 * Both contracts are deployed with CREATE2 and a salt namespaced by the
 * creator, so an address can be predicted before signing and a pending launch
 * cannot be taken by someone else's transaction landing first. Reusing a salt
 * with identical arguments reverts because the address already exists.
 */
contract OakenCurveFactory {
    uint8 public constant DECIMALS = 18;
    uint256 public constant MAX_NAME = 64;
    uint256 public constant MAX_SYMBOL = 16;
    uint256 public constant MAX_EXEMPT = 32;

    uint256 public immutable supply;
    uint256 public immutable virtualTokens;
    uint256 public immutable phantomQuote;
    uint256 public immutable graduationThreshold;
    uint256 public immutable feeBps;
    uint256 public immutable maxCreatorTaxBps;
    uint256 public immutable protocolShareBps;
    uint256 public immutable snipeTaxStartBps;
    uint256 public immutable snipeTaxSeconds;
    address public immutable protocolFeeRecipient;
    address public immutable graduator;
    address public immutable launchFeeRecipient;
    uint256 public immutable launchFee;

    struct LaunchParams {
        string name;
        string symbol;
        /// @dev Zero means the caller.
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bytes32 salt;
        address[] snipeTaxExempt;
    }

    event LaunchCreated(
        address indexed token,
        address indexed curve,
        address indexed creator,
        string name,
        string symbol,
        address creatorFeeRecipient,
        uint256 creatorTaxBps
    );

    error LaunchFeeNotPaid();
    error CreatorTaxTooHigh();
    error InvalidName();
    error InvalidSymbol();
    error TooManyExemptions();
    error NotFeeRecipient();
    error NothingToSweep();
    error TransferFailed();
    error ZeroAddress();

    /// @dev Grouped so the constructor's 13 terms stay one stack slot wide.
    struct Config {
        uint256 supply;
        uint256 virtualTokens;
        uint256 phantomQuote;
        uint256 graduationThreshold;
        uint256 feeBps;
        uint256 maxCreatorTaxBps;
        uint256 protocolShareBps;
        uint256 snipeTaxStartBps;
        uint256 snipeTaxSeconds;
        address protocolFeeRecipient;
        address graduator;
        address launchFeeRecipient;
        uint256 launchFee;
    }

    constructor(Config memory c) {
        if (c.protocolFeeRecipient == address(0) || c.graduator == address(0) || c.launchFeeRecipient == address(0)) {
            revert ZeroAddress();
        }
        if (c.supply == 0 || c.phantomQuote == 0 || c.graduationThreshold == 0) revert ZeroAddress();
        supply = c.supply;
        virtualTokens = c.virtualTokens;
        phantomQuote = c.phantomQuote;
        graduationThreshold = c.graduationThreshold;
        feeBps = c.feeBps;
        maxCreatorTaxBps = c.maxCreatorTaxBps;
        protocolShareBps = c.protocolShareBps;
        snipeTaxStartBps = c.snipeTaxStartBps;
        snipeTaxSeconds = c.snipeTaxSeconds;
        protocolFeeRecipient = c.protocolFeeRecipient;
        graduator = c.graduator;
        launchFeeRecipient = c.launchFeeRecipient;
        launchFee = c.launchFee;
    }

    /**
     * @notice Create the token and its curve.
     * @dev `msg.value` must equal `launchFee`; it is held here for
     * `launchFeeRecipient`, not forwarded anywhere.
     */
    function createLaunch(LaunchParams calldata p) external payable returns (address token, address curve) {
        if (msg.value != launchFee) revert LaunchFeeNotPaid();
        if (p.creatorTaxBps > maxCreatorTaxBps) revert CreatorTaxTooHigh();
        if (bytes(p.name).length == 0 || bytes(p.name).length > MAX_NAME) revert InvalidName();
        if (bytes(p.symbol).length == 0 || bytes(p.symbol).length > MAX_SYMBOL) revert InvalidSymbol();
        if (p.snipeTaxExempt.length > MAX_EXEMPT) revert TooManyExemptions();

        address feeRecipient = p.creatorFeeRecipient == address(0) ? msg.sender : p.creatorFeeRecipient;
        OakenCurve c = _deployCurve(msg.sender, feeRecipient, p.creatorTaxBps, p.salt);
        OakenToken t = _deployToken(msg.sender, p.name, p.symbol, address(c), p.salt);
        c.initialize(address(t), p.snipeTaxExempt);
        // Fix the graduation pool at the exact price and amounts before the token is tradeable.
        IOakenCurvePoolInitializer(graduator).initializePool(address(t), graduationThreshold, c.reservedTokens());

        token = address(t);
        curve = address(c);
        _logLaunch(token, curve, msg.sender, p.name, p.symbol, feeRecipient, p.creatorTaxBps);
    }

    function _logLaunch(
        address token_,
        address curve_,
        address creator_,
        string calldata name_,
        string calldata symbol_,
        address feeRecipient_,
        uint16 creatorTaxBps_
    ) private {
        emit LaunchCreated(token_, curve_, creator_, name_, symbol_, feeRecipient_, creatorTaxBps_);
    }

    // ── Launch fees ───────────────────────────────────────────────────────

    function sweepLaunchFees() external {
        if (msg.sender != launchFeeRecipient) revert NotFeeRecipient();
        uint256 amount = address(this).balance;
        if (amount == 0) revert NothingToSweep();
        (bool ok,) = payable(launchFeeRecipient).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ── Internal ──────────────────────────────────────────────────────────

    function _deployCurve(address creator, address feeRecipient, uint16 creatorTaxBps, bytes32 salt)
        private
        returns (OakenCurve)
    {
        // Field-by-field rather than one 13-field literal: solc 0.8.24 runs
        // out of stack slots on the literal once the terms are this wide.
        OakenCurve.Terms memory terms;
        terms.factory = address(this);
        terms.creator = creator;
        terms.creatorFeeRecipient = feeRecipient;
        terms.protocolFeeRecipient = protocolFeeRecipient;
        terms.graduator = graduator;
        terms.virtualTokens = virtualTokens;
        terms.phantomQuote = phantomQuote;
        terms.graduationThreshold = graduationThreshold;
        terms.feeBps = feeBps;
        terms.creatorTaxBps = creatorTaxBps;
        terms.protocolShareBps = protocolShareBps;
        terms.snipeTaxStartBps = snipeTaxStartBps;
        terms.snipeTaxSeconds = snipeTaxSeconds;
        return new OakenCurve{salt: _curveSalt(creator, salt)}(terms);
    }

    function _deployToken(address creator, string calldata name, string calldata symbol, address curve, bytes32 salt)
        private
        returns (OakenToken)
    {
        return new OakenToken{salt: _tokenSalt(creator, salt)}(name, symbol, DECIMALS, supply, curve);
    }

    function _curveSalt(address creator, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt, "oaken.curve.v1"));
    }

    function _tokenSalt(address creator, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt, "oaken.curve.token.v1"));
    }

    function _create2(address deployer, bytes32 salt, bytes32 initCodeHash) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
