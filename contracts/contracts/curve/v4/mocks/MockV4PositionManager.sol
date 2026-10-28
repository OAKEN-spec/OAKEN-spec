// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {PoolKey} from "../V4Minimal.sol";

/** Records the graduation mint's unlock data and decodes its fixed shape. */
contract MockV4PositionManager {
    bytes public lastData;
    uint256 public lastDeadline;
    uint256 public lastValue;
    bool public called;

    address public currency0;
    address public currency1;
    uint24 public fee;
    int24 public keyTickSpacing;
    address public hooks;
    int24 public tickLower;
    int24 public tickUpper;
    uint256 public liquidity;
    uint128 public amount0Max;
    uint128 public amount1Max;
    address public recipient;

    function modifyLiquidities(bytes calldata data, uint256 deadline) external payable {
        lastData = data;
        lastDeadline = deadline;
        lastValue = msg.value;
        called = true;

        (bytes memory actions, bytes[] memory params) = abi.decode(data, (bytes, bytes[]));
        require(actions.length == 3, "actions");
        require(uint8(actions[0]) == 0x02 && uint8(actions[1]) == 0x0d && uint8(actions[2]) == 0x14, "action codes");
        (
            PoolKey memory key,
            int24 tl,
            int24 tu,
            uint256 liq,
            uint128 a0,
            uint128 a1,
            address r,
            bytes memory hookData
        ) = abi.decode(params[0], (PoolKey, int24, int24, uint256, uint128, uint128, address, bytes));
        require(hookData.length == 0, "hookData");
        currency0 = key.currency0;
        currency1 = key.currency1;
        fee = key.fee;
        keyTickSpacing = key.tickSpacing;
        hooks = key.hooks;
        tickLower = tl;
        tickUpper = tu;
        liquidity = liq;
        amount0Max = a0;
        amount1Max = a1;
        recipient = r;
    }
}
