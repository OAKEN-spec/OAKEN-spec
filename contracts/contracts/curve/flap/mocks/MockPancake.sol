// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/** Minimal PancakeSwap V2 router/factory used by the Flap-model tests. */
contract MockPancakeRouter {
    address public factory;
    address public lastToken;
    uint256 public lastTokenDesired;
    uint256 public lastEthDesired;
    uint256 public lastValue;
    address public lastTo;
    bool public called;

    constructor(address factory_) {
        factory = factory_;
    }

    function setFactory(address factory_) external {
        factory = factory_;
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256,
        uint256,
        address to,
        uint256
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        lastToken = token;
        lastTokenDesired = amountTokenDesired;
        lastEthDesired = msg.value;
        lastValue = msg.value;
        lastTo = to;
        called = true;
        return (amountTokenDesired, msg.value, 1);
    }
}

contract MockPancakeFactory {
    address public pair;

    constructor(address pair_) {
        pair = pair_;
    }

    function getPair(address, address) external view returns (address) {
        return pair;
    }
}

/** Minimal PancakeSwap V3 NonfungiblePositionManager used by the tests. */
contract MockPancakeV3PositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    address public token0;
    address public token1;
    uint24 public fee;
    int24 public tickLower;
    int24 public tickUpper;
    uint256 public amount0Desired;
    uint256 public amount1Desired;
    address public recipient;
    uint256 public lastValue;
    bool public called;

    address public initToken0;
    address public initToken1;
    uint24 public initFee;
    uint160 public initSqrtPriceX96;
    bool public poolInitialized;

    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee_,
        uint160 sqrtPriceX96
    ) external payable returns (address) {
        initToken0 = token0;
        initToken1 = token1;
        initFee = fee_;
        initSqrtPriceX96 = sqrtPriceX96;
        poolInitialized = true;
        return address(uint160(uint256(keccak256(abi.encode(token0, token1, fee_)))));
    }

    function mint(MintParams calldata p) external payable returns (uint256, uint128, uint256, uint256) {
        token0 = p.token0;
        token1 = p.token1;
        fee = p.fee;
        tickLower = p.tickLower;
        tickUpper = p.tickUpper;
        amount0Desired = p.amount0Desired;
        amount1Desired = p.amount1Desired;
        recipient = p.recipient;
        lastValue = msg.value;
        called = true;
        return (1, 1, p.amount0Desired, p.amount1Desired);
    }
}
