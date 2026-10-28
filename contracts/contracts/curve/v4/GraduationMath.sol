// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title GraduationMath
 * @notice The small amount of 512-bit math a Uniswap V4 graduation needs.
 *
 * Vendored from Uniswap's MIT-licensed `FullMath` and the well-known
 * Babylonian square root, so the contracts project keeps its zero-dependency
 * rule. Only three operations are needed:
 *
 *   · sqrtPriceX96 from the two seed amounts (the pool's opening price)
 *   · liquidity for a token0-only / token1-only side
 *   · the minimum of the two for a full-range position
 *
 * The pool is a standard constant-product V4 pool with a full-range position;
 * at the graduation line both amounts are real curve reserves, so the price is
 * not an extreme and the Q192 route below always fits.
 */
library GraduationMath {
    uint256 internal constant Q96 = uint256(1) << 96;
    error ZeroAmount();
    error UnsupportedPrice();
    error LiquidityOverflow();

    /** @notice `floor(a * b / denominator)` with a 512-bit intermediate. */
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                require(denominator > 0);
                assembly {
                    result := div(prod0, denominator)
                }
                return result;
            }
            require(denominator > prod1);
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            result = prod0 * inverse;
            return result;
        }
    }

    /** @notice Integer square root (Babylonian). */
    function sqrt(uint256 a) internal pure returns (uint256) {
        if (a == 0) return 0;
        uint256 x = a;
        uint256 y = (x + 1) / 2;
        while (y < x) {
            x = y;
            y = (x + a / x) / 2;
        }
        return x;
    }

    /**
     * @notice `sqrt(amount1 / amount0) * 2^96`, the V4 opening price.
     * @dev Assumes the two amounts are not extreme; both are curve reserves at
     * the graduation line, so the Q192 quotient fits uint256.
     */
    function sqrtPriceX96FromAmounts(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();
        uint256 ratioX192 = mulDiv(amount1, uint256(1) << 192, amount0);
        uint256 root = sqrt(ratioX192);
        if (root == 0 || root > type(uint160).max) revert UnsupportedPrice();
        return uint160(root);
    }

    function liquidityForAmount0(uint160 sqrtA, uint160 sqrtB, uint256 amount0) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 intermediate = mulDiv(sqrtA, sqrtB, Q96);
        return _toLiquidity(mulDiv(amount0, intermediate, uint256(sqrtB) - uint256(sqrtA)));
    }

    function liquidityForAmount1(uint160 sqrtA, uint160 sqrtB, uint256 amount1) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        return _toLiquidity(mulDiv(amount1, Q96, uint256(sqrtB) - uint256(sqrtA)));
    }

    /** @notice Liquidity for a position spanning [sqrtA, sqrtB] at price sqrtP. */
    function liquidityForAmounts(
        uint160 sqrtP,
        uint160 sqrtA,
        uint160 sqrtB,
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        if (sqrtP <= sqrtA) return liquidityForAmount0(sqrtA, sqrtB, amount0);
        if (sqrtP < sqrtB) {
            uint128 l0 = liquidityForAmount0(sqrtP, sqrtB, amount0);
            uint128 l1 = liquidityForAmount1(sqrtA, sqrtP, amount1);
            return l0 < l1 ? l0 : l1;
        }
        return liquidityForAmount1(sqrtA, sqrtB, amount1);
    }

    function _toLiquidity(uint256 value) private pure returns (uint128) {
        if (value > type(uint128).max) revert LiquidityOverflow();
        return uint128(value);
    }
}
