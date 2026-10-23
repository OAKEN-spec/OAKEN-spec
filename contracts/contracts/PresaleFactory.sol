// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import { Presale } from "./Presale.sol";

/**
 * @title PresaleFactory
 * @notice Deploy a sale — and check, before it exists, that it can keep its
 *         promises.
 *
 * ## Why the funding happens here
 *
 * A sale contract that is deployed empty and funded later has a window where it
 * is a promise with nothing behind it. The factory therefore pulls the tokens
 * in the same transaction that creates the sale, and checks what actually
 * arrived: a buyer reading a sale's balance sees the tokens, not an intention.
 *
 * ## The one check that matters
 *
 * `tokensForSale >= hardCap * rate / 1e18`. Everything else here is tidiness
 * (windows in order, caps in order, a rate above zero). This one is the only
 * way a sale can be created that is *arithmetically unable to deliver* — a
 * token with six decimals and a rate written for eighteen, say — and the
 * failure mode without it is the worst kind: a fully subscribed sale where the
 * last buyer to claim finds an empty contract.
 *
 * ## What the factory does not keep
 *
 * No fee, no owner, no ability to touch a sale after creation. It holds no
 * tokens between calls. A sale's parameters are immutable and live on the sale
 * itself, so this contract is a launch mechanism and not a party to anything
 * that happens afterwards.
 */
contract PresaleFactory {
    error TokenMissing();
    error NoTokensOffered();
    error BadWindow(uint64 startTime, uint64 endTime);
    error StartTooFarBack(uint64 startTime);
    error BadCaps(uint128 softCap, uint128 hardCap);
    error BadLimits(uint128 minBuy, uint128 maxBuy);
    error ZeroRate();
    error BadLiquidityShare(uint16 bps);
    error Underfunded(uint256 offered, uint256 required);
    error FundingShortfall(uint256 expected, uint256 received);
    error TokenCallFailed();

    /** The creation parameters, as one struct — the same reason `LockVault` has them. */
    struct NewSale {
        address token;
        uint64 startTime;
        uint64 endTime;
        uint128 softCap;
        uint128 hardCap;
        uint128 minBuy;
        uint128 maxBuy;
        /** Tokens (raw units) per 1 native (1e18 wei). */
        uint256 rate;
        /** Uniswap-V2-style router for the automatic liquidity step, or zero. */
        address router;
        /** Share of the raise that goes into that pool, in basis points. */
        uint16 liquidityBps;
        /** How many tokens the sale is funded with. Must cover `hardCap * rate / 1e18`. */
        uint256 tokensForSale;
    }

    event SaleCreated(address indexed sale, address indexed creator, address indexed token, uint256 tokensForSale);

    address[] private _sales;

    function allSales() external view returns (address[] memory) {
        return _sales;
    }

    function saleCount() external view returns (uint256) {
        return _sales.length;
    }

    /**
     * Create a sale and fund it in one transaction.
     *
     * The tokens come from the caller and are held by the sale, not by this
     * factory — which is what lets the sale's page show the tokens on chain
     * from the moment the sale exists.
     */
    function createSale(NewSale calldata p) external returns (address sale) {
        if (p.token == address(0)) revert TokenMissing();
        if (p.tokensForSale == 0) revert NoTokensOffered();
        if (p.endTime <= p.startTime) revert BadWindow(p.startTime, p.endTime);
        if (p.endTime <= block.timestamp) revert BadWindow(p.startTime, p.endTime);
        // Five minutes of slack: a browser clock a few seconds behind is normal,
        // a sale that started yesterday is a mistake.
        if (p.startTime + 300 < block.timestamp) revert StartTooFarBack(p.startTime);
        if (p.softCap == 0 || p.hardCap < p.softCap) revert BadCaps(p.softCap, p.hardCap);
        if (p.minBuy == 0 || p.maxBuy < p.minBuy) revert BadLimits(p.minBuy, p.maxBuy);
        if (p.rate == 0) revert ZeroRate();
        if (p.liquidityBps > 10_000) revert BadLiquidityShare(p.liquidityBps);

        uint256 required = uint256(p.hardCap) * p.rate / 1e18;
        if (p.tokensForSale < required) revert Underfunded(p.tokensForSale, required);

        Presale created = new Presale(
            p.token,
            msg.sender,
            p.startTime,
            p.endTime,
            p.softCap,
            p.hardCap,
            p.minBuy,
            p.maxBuy,
            p.rate,
            p.router,
            p.liquidityBps
        );
        sale = address(created);

        // Measured, not assumed: a fee-on-transfer token credits what arrived,
        // and a sale funded with less than it promises must not exist.
        uint256 before = _balanceOf(p.token, sale);
        _pullToken(p.token, msg.sender, sale, p.tokensForSale);
        uint256 received = _balanceOf(p.token, sale) - before;
        if (received < required) revert FundingShortfall(required, received);

        _sales.push(sale);
        emit SaleCreated(sale, msg.sender, p.token, received);
    }

    function _balanceOf(address token, address who) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(IERC20BalanceOf.balanceOf.selector, who));
        if (!ok || data.length < 32) revert TokenCallFailed();
        return abi.decode(data, (uint256));
    }

    function _pullToken(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20TransferFrom.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }
}

interface IERC20TransferFrom {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC20BalanceOf {
    function balanceOf(address who) external view returns (uint256);
}
