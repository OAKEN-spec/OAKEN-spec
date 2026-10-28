// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title V4Minimal
 * @notice The slice of the Uniswap V4 ABI and hook interface the graduator uses.
 *
 * Nothing here is a reimplementation: these are the exact canonical struct
 * layouts and function signatures, written out so the contracts project stays
 * dependency-free. The two hook callbacks are the only ones the graduator
 * needs; the address is mined so its low bits carry the corresponding V4
 * permission flags (beforeInitialize | beforeAddLiquidity).
 */

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManager {
    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24 tick);
    function extsload(bytes32 slot) external view returns (bytes32 value);
}

interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IHooks {
    function beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96) external returns (bytes4);
    function beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4);
}

library V4Actions {
    uint256 internal constant MINT_POSITION = 0x02;
    uint256 internal constant SETTLE_PAIR = 0x0d;
    uint256 internal constant SWEEP = 0x14;
}
