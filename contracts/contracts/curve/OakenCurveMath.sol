// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title OakenCurveMath
 * @notice Constant-product math for the OAKEN curve, with virtual reserves.
 *
 * The curve is the same shape Pons V2 uses: a real token reserve sitting next
 * to a *virtual* quote reserve. The virtual reserve is never held; it only
 * moves the price away from zero at the first trade. With `x` tokens and
 * `y = phantom + realQuote`:
 *
 *     amountOut = amountIn * reserveOut / (reserveIn + amountIn)
 *
 * which is the usual constant-product quote with no fee. Fees are charged on
 * the quote leg by the curve contract before/after calling these functions,
 * so the math stays pure and independently testable.
 *
 * Overflow: the largest realistic inputs are ~1e26 wei on the quote leg and
 * ~1e27 base units on the token leg (1e9 tokens, 18 decimals). Their product
 * is ~1e53, comfortably below uint256's ~1.15e77. No mulDiv library is
 * needed, and this file stays dependency-free like the rest of the project.
 */
library OakenCurveMath {
    error InsufficientInput();
    error InsufficientOutput();
    error InsufficientLiquidity();

    /** @notice Quote `amountIn` of the input asset, fee already removed. */
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InsufficientInput();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        amountOut = (amountIn * reserveOut) / (reserveIn + amountIn);
        if (amountOut == 0) revert InsufficientOutput();
    }

    /** @notice Quote the input needed for an exact output, rounded up. */
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256 amountIn)
    {
        if (amountOut == 0) revert InsufficientOutput();
        if (reserveIn == 0 || reserveOut <= amountOut) revert InsufficientLiquidity();
        amountIn = (amountOut * reserveIn) / (reserveOut - amountOut) + 1;
    }

    /**
     * @notice The reserved token allocation at graduation.
     *
     * With `k = supply * phantom`, the curve reaches a real quote reserve of
     * `threshold` exactly when its token reserve falls to
     * `supply * phantom / (phantom + threshold)`. That is the slice the pool
     * receives when the curve graduates; the rest is what the curve sells.
     */
    function reservedTokens(uint256 supply, uint256 phantomQuote, uint256 graduationThreshold)
        internal
        pure
        returns (uint256)
    {
        return (supply * phantomQuote) / (phantomQuote + graduationThreshold);
    }
}
