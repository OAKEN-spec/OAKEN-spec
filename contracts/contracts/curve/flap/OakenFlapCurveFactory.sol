// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {OakenTaxToken} from "../OakenTaxToken.sol";
import {OakenCurve} from "../OakenCurve.sol";

interface IOakenFlapTokenDeployer {
    function deployStandard(bytes32 salt, string calldata name, string calldata symbol, uint256 supply, address curve) external returns (address);
    function deployTax(bytes32 salt, OakenTaxToken.Init calldata init) external returns (address);
}

/**
 * @title OakenFlapCurveFactory
 * @notice The BNB Chain (56) launch factory: Flap's curve shape and tax-token
 * model, with OAKEN's fixed-supply, zero-creator-allocation rules.
 *
 * Two launch kinds share one curve:
 *   · standard — plain fixed-supply token, graduates to a Pancake V3 pool
 *   · tax      — buy/sell tax token, graduates to a Pancake V2 pair
 *
 * The curve parameters come from Flap's latest BSC deployment: r = 6.14 BNB,
 * h = 107,036,752 tokens, graduation at 800,000,000 sold / ~16 BNB reserve.
 * The terms live in `OakenCurve`; this factory only chooses the token kind and
 * the graduator.
 */
contract OakenFlapCurveFactory {
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
    address public immutable standardGraduator;
    address public immutable taxGraduator;
    address public immutable tokenDeployer;
    address public immutable launchFeeRecipient;
    uint256 public immutable launchFee;

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
        address standardGraduator;
        address taxGraduator;
        address tokenDeployer;
        address launchFeeRecipient;
        uint256 launchFee;
    }

    struct TaxParams {
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint64 taxDuration;
        uint16 marketingBps;
        uint16 deflationBps;
        uint16 dividendBps;
        uint16 liquidityBps;
        address marketingWallet;
        address dividendWallet;
        address liquidityWallet;
    }

    struct LaunchParams {
        string name;
        string symbol;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bytes32 salt;
        address[] snipeTaxExempt;
        bool tax;
        TaxParams taxParams;
    }

    /// @dev Name, symbol and fee terms are read from the token and curve; the
    /// event stays small so the launch function's stack stays shallow.
    event LaunchCreated(address indexed token, address indexed curve, address indexed creator, bool tax);

    error LaunchFeeNotPaid();
    error CreatorTaxTooHigh();
    error InvalidName();
    error InvalidSymbol();
    error TooManyExemptions();
    error NotFeeRecipient();
    error NothingToSweep();
    error TransferFailed();
    error ZeroAddress();

    constructor(Config memory c) {
        if (
            c.protocolFeeRecipient == address(0) || c.standardGraduator == address(0)
                || c.taxGraduator == address(0) || c.tokenDeployer == address(0)
                || c.launchFeeRecipient == address(0)
        ) revert ZeroAddress();
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
        standardGraduator = c.standardGraduator;
        taxGraduator = c.taxGraduator;
        tokenDeployer = c.tokenDeployer;
        launchFeeRecipient = c.launchFeeRecipient;
        launchFee = c.launchFee;
    }

    function createLaunch(LaunchParams calldata p) external payable returns (address token, address curve) {
        if (msg.value != launchFee) revert LaunchFeeNotPaid();
        if (p.creatorTaxBps > maxCreatorTaxBps) revert CreatorTaxTooHigh();
        if (bytes(p.name).length == 0 || bytes(p.name).length > MAX_NAME) revert InvalidName();
        if (bytes(p.symbol).length == 0 || bytes(p.symbol).length > MAX_SYMBOL) revert InvalidSymbol();
        if (p.snipeTaxExempt.length + (p.tax ? 3 : 0) > MAX_EXEMPT) revert TooManyExemptions();

        address feeRecipient = p.creatorFeeRecipient == address(0) ? msg.sender : p.creatorFeeRecipient;
        address graduator = p.tax ? taxGraduator : standardGraduator;

        OakenCurve c = _deployCurve(msg.sender, feeRecipient, p.creatorTaxBps, graduator, p.salt);
        address t = p.tax
            ? _deployTaxToken(msg.sender, p, address(c), graduator)
            : _deployToken(p, address(c), p.salt);

        address[] memory exempt = _exemptions(p);
        c.initialize(t, exempt);

        token = t;
        curve = address(c);
        _logLaunch(token, curve, msg.sender, p.tax);
    }

    function sweepLaunchFees() external {
        if (msg.sender != launchFeeRecipient) revert NotFeeRecipient();
        uint256 amount = address(this).balance;
        if (amount == 0) revert NothingToSweep();
        (bool ok,) = payable(launchFeeRecipient).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ── Deployment ────────────────────────────────────────────────────────

    function _deployCurve(
        address creator,
        address feeRecipient,
        uint16 creatorTaxBps,
        address graduator,
        bytes32 salt
    ) private returns (OakenCurve) {
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

    function _deployToken(LaunchParams calldata p, address curve, bytes32 salt) private returns (address) {
        return IOakenFlapTokenDeployer(tokenDeployer).deployStandard(
            _tokenSalt(msg.sender, salt), p.name, p.symbol, supply, curve
        );
    }

    function _deployTaxToken(address creator, LaunchParams calldata p, address curve, address graduator)
        private
        returns (address)
    {
        OakenTaxToken.Init memory init;
        init.name = p.name;
        init.symbol = p.symbol;
        init.supply = supply;
        init.curve = curve;
        init.factory = address(this);
        init.graduator = graduator;
        init.creator = creator;
        init.tax = OakenTaxToken.TaxConfig({
            buyTaxBps: p.taxParams.buyTaxBps,
            sellTaxBps: p.taxParams.sellTaxBps,
            taxDuration: p.taxParams.taxDuration,
            marketingBps: p.taxParams.marketingBps,
            deflationBps: p.taxParams.deflationBps,
            dividendBps: p.taxParams.dividendBps,
            liquidityBps: p.taxParams.liquidityBps,
            marketingWallet: p.taxParams.marketingWallet,
            dividendWallet: p.taxParams.dividendWallet,
            liquidityWallet: p.taxParams.liquidityWallet,
            commissionReceiver: protocolFeeRecipient
        });
        return IOakenFlapTokenDeployer(tokenDeployer).deployTax(_tokenSalt(creator, p.salt), init);
    }

    function _exemptions(LaunchParams calldata p) private pure returns (address[] memory out) {
        uint256 extra = p.tax ? 3 : 0;
        out = new address[](p.snipeTaxExempt.length + extra);
        for (uint256 i = 0; i < p.snipeTaxExempt.length; i++) out[i] = p.snipeTaxExempt[i];
        if (p.tax) {
            out[p.snipeTaxExempt.length] = p.taxParams.marketingWallet;
            out[p.snipeTaxExempt.length + 1] = p.taxParams.dividendWallet;
            out[p.snipeTaxExempt.length + 2] = p.taxParams.liquidityWallet;
        }
    }

    function _logLaunch(address token_, address curve_, address creator_, bool tax_) private {
        emit LaunchCreated(token_, curve_, creator_, tax_);
    }

    function _curveSalt(address creator, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt, "oaken.flap.curve.v1"));
    }

    function _tokenSalt(address creator, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt, "oaken.flap.token.v1"));
    }
}
