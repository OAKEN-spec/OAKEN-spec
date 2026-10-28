// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {GraduationMath} from "../GraduationMath.sol";

/** Exposes the pure graduation math to the test suite. */
contract GraduationMathHarness {
    function sqrtPriceX96FromAmounts(uint256 amount0, uint256 amount1) external pure returns (uint160) {
        return GraduationMath.sqrtPriceX96FromAmounts(amount0, amount1);
    }

    function liquidityForAmounts(
        uint160 sqrtP,
        uint160 sqrtA,
        uint160 sqrtB,
        uint256 amount0,
        uint256 amount1
    ) external pure returns (uint128) {
        return GraduationMath.liquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1);
    }
}
