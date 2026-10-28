// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title IOakenCurveGraduator
 * @notice What the curve calls once its sellable tokens are exhausted.
 *
 * The curve transfers the reserved tokens to the graduator first, then calls
 * `graduate` with the reserve value attached. A graduator is expected to seed
 * a DEX pool and keep the position forever: the curve has no way to call it
 * again, and the graduator itself must have no function that moves the
 * position out.
 */
interface IOakenCurveGraduator {
    function graduate(address token, uint256 tokenAmount, uint256 quoteAmount) external payable;
}

/**
 * @title IOakenCurvePoolInitializer
 * @notice Optional companion for graduators that use a DEX whose pool can be
 * created before graduation (Uniswap V4).
 *
 * The factory calls this once, in the launch transaction, with the exact
 * amounts the curve will graduate with. Initializing at launch fixes the pool
 * at the graduation price before anyone else can touch it — and, with a hook
 * that restricts pool creation to the graduator, before anyone else can
 * initialize it at all.
 */
interface IOakenCurvePoolInitializer {
    function initializePool(address token, uint256 quoteAmount, uint256 tokenAmount) external;
}
