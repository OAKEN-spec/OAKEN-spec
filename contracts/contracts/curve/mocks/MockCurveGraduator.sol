// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IOakenCurveGraduator, IOakenCurvePoolInitializer} from "../IOakenCurveGraduator.sol";

/**
 * @title MockCurveGraduator
 * @notice Test-only graduator: records what the curve handed over.
 *
 * The production graduator seeds a Uniswap V4 pool and keeps the position.
 * This one only proves the curve called it once, with the exact token and
 * native amounts, and that no further curve call can reach it.
 */
contract MockCurveGraduator is IOakenCurveGraduator, IOakenCurvePoolInitializer {
    address public lastToken;
    uint256 public lastTokenAmount;
    uint256 public lastQuoteAmount;
    uint256 public calls;
    uint256 public initCalls;
    uint256 public initQuoteAmount;
    uint256 public initTokenAmount;

    function initializePool(address, uint256 quoteAmount, uint256 tokenAmount) external override {
        initCalls += 1;
        initQuoteAmount = quoteAmount;
        initTokenAmount = tokenAmount;
    }

    function graduate(address token, uint256 tokenAmount, uint256 quoteAmount) external payable override {
        lastToken = token;
        lastTokenAmount = tokenAmount;
        lastQuoteAmount = quoteAmount;
        calls += 1;
    }

    receive() external payable {}
}
