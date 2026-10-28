// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {OakenCurveMath} from "./OakenCurveMath.sol";
import {IOakenCurveGraduator} from "./IOakenCurveGraduator.sol";

/**
 * @title OakenCurve
 * @notice One launch's bonding curve, modelled on Pons V2 on Robinhood Chain.
 *
 * The whole fixed supply is minted to this contract. There is no creator
 * allocation: the creator starts with zero tokens and can only buy from the
 * curve like anyone else. When the sellable allocation is exhausted, the
 * remaining tokens and the real quote reserve are handed to a graduator that
 * seeds a DEX pool and keeps the position forever.
 *
 * Fee policy, all charged on the quote leg:
 *   · `feeBps`        base trade fee, split protocol/creator by `protocolShareBps`
 *   · `creatorTaxBps` optional extra tax chosen at launch, 100% to the creator
 *   · `snipeTaxBps`   starts at `snipeTaxStartBps` and halves 14 times across
 *                     `snipeTaxSeconds`; 100% to the creator; exempt wallets
 *                     (the team declared at launch) pay none
 *
 * Pending fees live in their own balances. The curve's principal is
 * `trackedQuote`; nothing in this contract can move it except a sell or
 * `graduate()`, and there is no owner, no pause and no rescue function.
 */
contract OakenCurve {
    uint256 private constant BPS = 10_000;
    uint256 private constant MAX_TOTAL_TRADE_FEE_BPS = 2_000;
    uint256 private constant SNIPE_HALVINGS = 14;

    // ── Immutable launch terms ────────────────────────────────────────────
    address public immutable factory;
    address public immutable creator;
    address public immutable creatorFeeRecipient;
    address public immutable protocolFeeRecipient;
    address public immutable graduator;
    uint256 public immutable virtualTokens;
    uint256 public immutable phantomQuote;
    uint256 public immutable graduationThreshold;
    uint256 public immutable feeBps;
    uint256 public immutable creatorTaxBps;
    uint256 public immutable protocolShareBps;
    uint256 public immutable snipeTaxStartBps;
    uint256 public immutable snipeTaxSeconds;

    // ── Launch state ──────────────────────────────────────────────────────
    address public token;
    uint256 public launchSupply;
    uint256 public reservedTokens;
    uint256 public trackedQuote;
    uint256 public trackedTokens;
    uint256 public launchedAt;
    bool public initialized;
    bool public graduated;

    // Pending fees, kept apart from `trackedQuote`.
    uint256 public creatorFeeBalance;
    uint256 public protocolFeeBalance;
    uint256 public creatorTaxBalance;
    uint256 public snipeTaxBalance;

    mapping(address account => bool exempt) public snipeTaxExempt;

    uint256 private _locked = 1;

    event LaunchInitialized(
        address indexed token, address indexed creator, uint256 supply, uint256 reservedTokens
    );
    event Bought(
        address indexed payer,
        address indexed recipient,
        uint256 quoteIn,
        uint256 tokensOut,
        uint256 fee,
        uint256 creatorTax,
        uint256 snipeTax
    );
    event Sold(
        address indexed seller,
        address indexed recipient,
        uint256 tokensIn,
        uint256 quoteOut,
        uint256 fee,
        uint256 creatorTax
    );
    event Graduated(address indexed token, uint256 tokensToPool, uint256 quoteToPool);
    event FeesSwept(address indexed recipient, uint256 amount);
    event SnipeTaxExempted(address indexed account);
    event Refunded(address indexed payer, uint256 amount);

    error NotFactory();
    error NotInitialized();
    error AlreadyInitialized();
    error ZeroAddress();
    error ZeroAmount();
    error GraduatedError();
    error CurveComplete();
    error NotReadyToGraduate();
    error SlippageExceeded();
    error InvalidTerms();
    error TransferFailed();
    error NothingToSweep();
    error NotCreatorRecipient();
    error NotProtocolRecipient();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    /// @dev Constructor terms, grouped so the factory's stack stays shallow.
    struct Terms {
        address factory;
        address creator;
        address creatorFeeRecipient;
        address protocolFeeRecipient;
        address graduator;
        uint256 virtualTokens;
        uint256 phantomQuote;
        uint256 graduationThreshold;
        uint256 feeBps;
        uint256 creatorTaxBps;
        uint256 protocolShareBps;
        uint256 snipeTaxStartBps;
        uint256 snipeTaxSeconds;
    }

    constructor(Terms memory t) {
        if (
            t.factory == address(0) || t.creator == address(0) || t.creatorFeeRecipient == address(0)
                || t.protocolFeeRecipient == address(0) || t.graduator == address(0)
        ) revert ZeroAddress();
        if (
            t.phantomQuote == 0 || t.graduationThreshold == 0
                || t.feeBps + t.creatorTaxBps > MAX_TOTAL_TRADE_FEE_BPS
                || t.protocolShareBps > BPS || t.snipeTaxStartBps > BPS
        ) revert InvalidTerms();

        factory = t.factory;
        creator = t.creator;
        creatorFeeRecipient = t.creatorFeeRecipient;
        protocolFeeRecipient = t.protocolFeeRecipient;
        graduator = t.graduator;
        virtualTokens = t.virtualTokens;
        phantomQuote = t.phantomQuote;
        graduationThreshold = t.graduationThreshold;
        feeBps = t.feeBps;
        creatorTaxBps = t.creatorTaxBps;
        protocolShareBps = t.protocolShareBps;
        snipeTaxStartBps = t.snipeTaxStartBps;
        snipeTaxSeconds = t.snipeTaxSeconds;
    }

    /**
     * @notice Binds the token after the factory has deployed it, and snapshots
     * the launch terms. Callable exactly once, by the factory.
     *
     * The token mints its entire supply to this contract in its constructor,
     * so `trackedTokens` starts at the real supply and the reserved slice is
     * derived from the curve's virtual quote reserve and graduation line.
     */
    function initialize(address token_, address[] calldata snipeExempt) external onlyFactory {
        if (initialized) revert AlreadyInitialized();
        if (token_ == address(0)) revert ZeroAddress();

        uint256 supply = IERC20(token_).totalSupply();
        uint256 reserved = ((supply + virtualTokens) * phantomQuote) / (phantomQuote + graduationThreshold)
            - virtualTokens;
        if (supply == 0 || reserved == 0 || reserved >= supply) revert InvalidTerms();

        token = token_;
        launchSupply = supply;
        reservedTokens = reserved;
        trackedTokens = supply;
        launchedAt = block.timestamp;
        initialized = true;

        snipeTaxExempt[creator] = true;
        snipeTaxExempt[creatorFeeRecipient] = true;
        for (uint256 i = 0; i < snipeExempt.length; i++) {
            if (snipeExempt[i] != address(0)) snipeTaxExempt[snipeExempt[i]] = true;
        }

        emit LaunchInitialized(token_, creator, supply, reserved);
    }

    // ── Trading ───────────────────────────────────────────────────────────

    /**
     * @notice Buy tokens with the chain's native coin.
     * @param minTokensOut Slippage floor on the tokens received.
     * @param recipient Token recipient; the snipe tax is judged on this address.
     *
     * If the buy would take more than the remaining sellable allocation, the
     * fill is capped at what is left and the unused native coin is refunded to
     * the payer. `minTokensOut` is checked against the capped fill, so a buyer
     * who wanted more fails instead of silently receiving less.
     */
    struct BuyCalc {
        uint256 spent;
        uint256 net;
        uint256 tokensOut;
        uint256 refund;
        uint256 fee;
        uint256 creatorTax;
        uint256 snipeTax;
    }

    function buy(uint256 minTokensOut, address recipient)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (!initialized) revert NotInitialized();
        if (graduated) revert GraduatedError();
        if (recipient == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();

        BuyCalc memory c;
        c.spent = msg.value;
        uint256 snipeBps = currentSnipeTaxBps(recipient);
        if (snipeBps != 0) {
            // Keep at least 1% of the spend buying tokens; a 99% launch-second
            // take is intentional, a 100% one would divide by zero below.
            uint256 maxSnipe = BPS - feeBps - creatorTaxBps - 100;
            if (snipeBps > maxSnipe) snipeBps = maxSnipe;
        }

        uint256 quoteReserve = phantomQuote + trackedQuote;
        uint256 tokenReserve = trackedTokens + virtualTokens;
        uint256 netBps = BPS - feeBps - creatorTaxBps - snipeBps;
        // Compute the net by subtracting each floored fee leg. Using
        // `spent * netBps / BPS` instead would leave the rounding remainder
        // (0–3 wei) in the contract, outside every balance — the invariant
        // suite caught exactly that.
        c.fee = (c.spent * feeBps) / BPS;
        c.creatorTax = (c.spent * creatorTaxBps) / BPS;
        c.snipeTax = (c.spent * snipeBps) / BPS;
        c.net = c.spent - c.fee - c.creatorTax - c.snipeTax;
        c.tokensOut = OakenCurveMath.getAmountOut(c.net, quoteReserve, tokenReserve);

        // Real tokens the curve may still sell. Graduation consumes the rest.
        uint256 sellable = trackedTokens - reservedTokens;
        if (sellable == 0) revert CurveComplete();
        if (c.tokensOut > sellable) {
            // Price the exact remaining allocation from the token side, then
            // gross the quote leg back up so the same fee percentages apply.
            uint256 netNeeded = OakenCurveMath.getAmountIn(sellable, quoteReserve, tokenReserve);
            uint256 grossNeeded = (netNeeded * BPS + netBps - 1) / netBps;
            if (grossNeeded > c.spent) revert SlippageExceeded();
            c.refund = c.spent - grossNeeded;
            c.spent = grossNeeded;
            c.fee = (c.spent * feeBps) / BPS;
            c.creatorTax = (c.spent * creatorTaxBps) / BPS;
            c.snipeTax = (c.spent * snipeBps) / BPS;
            c.net = c.spent - c.fee - c.creatorTax - c.snipeTax;
            c.tokensOut = sellable;
        }
        if (c.tokensOut < minTokensOut) revert SlippageExceeded();

        trackedQuote += c.net;
        trackedTokens = tokenReserve - c.tokensOut - virtualTokens;
        _accrueFees(c.fee, c.creatorTax, c.snipeTax);

        _safeTransfer(token, recipient, c.tokensOut);
        if (c.refund != 0) {
            (bool ok,) = payable(msg.sender).call{value: c.refund}("");
            if (!ok) revert TransferFailed();
            emit Refunded(msg.sender, c.refund);
        }

        _emitBought(msg.sender, recipient, c);
        return c.tokensOut;
    }

    function _emitBought(address payer, address recipient, BuyCalc memory c) private {
        emit Bought(payer, recipient, c.spent, c.tokensOut, c.fee, c.creatorTax, c.snipeTax);
    }

    /**
     * @notice Sell tokens back into the curve for the native coin.
     *
     * Sells close when the sellable allocation is exhausted: at that point the
     * curve is ready to graduate and the remaining reserve belongs to the
     * pool, not to one more seller.
     */
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        if (!initialized) revert NotInitialized();
        if (graduated || readyToGraduate()) revert GraduatedError();
        if (tokensIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 quoteReserve = phantomQuote + trackedQuote;
        uint256 tokenReserve = trackedTokens + virtualTokens;
        uint256 gross = OakenCurveMath.getAmountOut(tokensIn, tokenReserve, quoteReserve);
        if (gross > trackedQuote) gross = trackedQuote;

        uint256 fee = (gross * feeBps) / BPS;
        uint256 creatorTax = (gross * creatorTaxBps) / BPS;
        quoteOut = gross - fee - creatorTax;
        if (quoteOut < minQuoteOut) revert SlippageExceeded();
        if (quoteOut == 0) revert ZeroAmount();

        trackedQuote -= gross;
        // `tokenReserve` includes `virtualTokens` for pricing; the real
        // reserve only grows by the tokens the seller actually returned.
        trackedTokens += tokensIn;
        _accrueFees(fee, creatorTax, 0);

        _safeTransferFrom(token, msg.sender, address(this), tokensIn);
        (bool ok,) = payable(recipient).call{value: quoteOut}("");
        if (!ok) revert TransferFailed();

        emit Sold(msg.sender, recipient, tokensIn, quoteOut, fee, creatorTax);
    }

    // ── Graduation ────────────────────────────────────────────────────────

    /**
     * @notice Hand the remaining tokens and the real quote reserve to the
     * graduator. Permissionless: anyone can finish a launch that reached its
     * line, and nobody can do it early.
     */
    function graduate() external nonReentrant {
        if (!initialized) revert NotInitialized();
        if (graduated) revert GraduatedError();
        if (!readyToGraduate() || trackedQuote == 0 || trackedTokens == 0) revert NotReadyToGraduate();

        uint256 tokensToPool = trackedTokens;
        uint256 quoteToPool = trackedQuote;
        graduated = true;
        trackedTokens = 0;
        trackedQuote = 0;

        _safeTransfer(token, graduator, tokensToPool);
        IOakenCurveGraduator(graduator).graduate{value: quoteToPool}(token, tokensToPool, quoteToPool);

        emit Graduated(token, tokensToPool, quoteToPool);
    }

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice True when the sellable allocation is gone and graduation can run.
    function readyToGraduate() public view returns (bool) {
        return initialized && !graduated && trackedTokens <= reservedTokens;
    }

    /// @notice Current tradeable reserves, including the virtual quote reserve.
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve) {
        return (phantomQuote + trackedQuote, virtualTokens + trackedTokens);
    }

    /// @notice Tokens the curve may still sell before graduation.
    function sellableTokens() external view returns (uint256) {
        return trackedTokens > reservedTokens ? trackedTokens - reservedTokens : 0;
    }

    /**
     * @notice Snipe tax `recipient` would pay on a buy right now, in bps of
     * the quote leg. Starts at `snipeTaxStartBps` in the launch second and
     * halves fourteen times across `snipeTaxSeconds`, so it reaches zero
     * inside the window instead of stopping at a still-meaningful rate.
     */
    function currentSnipeTaxBps(address recipient) public view returns (uint256) {
        if (snipeTaxExempt[recipient]) return 0;
        uint256 startBps = snipeTaxStartBps;
        uint256 window = snipeTaxSeconds;
        if (startBps == 0 || window == 0) return 0;
        uint256 elapsed = block.timestamp - launchedAt;
        if (elapsed >= window) return 0;
        return startBps >> ((elapsed * SNIPE_HALVINGS) / window);
    }

    function pendingCreatorFees() public view returns (uint256) {
        return creatorFeeBalance + creatorTaxBalance + snipeTaxBalance;
    }

    // ── Fee sweeps ────────────────────────────────────────────────────────

    /// @notice The creator recipient may collect the fees it has earned.
    function sweepCreatorFees() external nonReentrant {
        if (msg.sender != creatorFeeRecipient) revert NotCreatorRecipient();
        uint256 amount = pendingCreatorFees();
        if (amount == 0) revert NothingToSweep();
        creatorFeeBalance = 0;
        creatorTaxBalance = 0;
        snipeTaxBalance = 0;
        (bool ok,) = payable(creatorFeeRecipient).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FeesSwept(creatorFeeRecipient, amount);
    }

    /// @notice The protocol recipient may collect its share of the base fee.
    function sweepProtocolFees() external nonReentrant {
        if (msg.sender != protocolFeeRecipient) revert NotProtocolRecipient();
        uint256 amount = protocolFeeBalance;
        if (amount == 0) revert NothingToSweep();
        protocolFeeBalance = 0;
        (bool ok,) = payable(protocolFeeRecipient).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FeesSwept(protocolFeeRecipient, amount);
    }

    // ── Internal ──────────────────────────────────────────────────────────

    function _accrueFees(uint256 fee, uint256 creatorTax, uint256 snipeTax) private {
        uint256 protocolCut = (fee * protocolShareBps) / BPS;
        if (protocolCut != 0) protocolFeeBalance += protocolCut;
        if (fee > protocolCut) creatorFeeBalance += fee - protocolCut;
        if (creatorTax != 0) creatorTaxBalance += creatorTax;
        if (snipeTax != 0) snipeTaxBalance += snipeTax;
    }

    function _safeTransfer(address token_, address to, uint256 amount) private {
        (bool ok, bytes memory ret) =
            token_.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) {
            revert TransferFailed();
        }
    }

    function _safeTransferFrom(address token_, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) =
            token_.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) {
            revert TransferFailed();
        }
    }
}

/** Minimal ERC-20 surface; OakenToken is the only token the factory emits. */
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
