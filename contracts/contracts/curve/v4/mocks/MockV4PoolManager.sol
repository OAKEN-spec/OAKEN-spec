// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {PoolKey, ModifyLiquidityParams, IHooks} from "../V4Minimal.sol";

/** Records V4 pool initialization and lets a test drive the hook the way the PoolManager would. */
contract MockV4PoolManager {
    address public lastCurrency0;
    address public lastCurrency1;
    uint24 public lastFee;
    int24 public lastTickSpacing;
    address public lastHooks;
    uint160 public lastSqrtPriceX96;
    bool public initialized;

    mapping(bytes32 slot => uint256 value) public slots;

    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24) {
        lastCurrency0 = key.currency0;
        lastCurrency1 = key.currency1;
        lastFee = key.fee;
        lastTickSpacing = key.tickSpacing;
        lastHooks = key.hooks;
        lastSqrtPriceX96 = sqrtPriceX96;
        initialized = true;
        bytes32 poolId = keccak256(abi.encode(key));
        bytes32 stateSlot = keccak256(abi.encode(poolId, bytes32(uint256(6))));
        slots[stateSlot] = uint256(sqrtPriceX96);
        return 0;
    }

    function extsload(bytes32 slot) external view returns (bytes32) {
        return bytes32(slots[slot]);
    }

    function callBeforeInitialize(address hook, address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        external
        returns (bytes4)
    {
        return IHooks(hook).beforeInitialize(sender, key, sqrtPriceX96);
    }

    function callBeforeAddLiquidity(
        address hook,
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4) {
        return IHooks(hook).beforeAddLiquidity(sender, key, params, hookData);
    }
}
