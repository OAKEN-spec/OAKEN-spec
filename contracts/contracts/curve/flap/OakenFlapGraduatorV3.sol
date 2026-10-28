// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IOakenCurveGraduator} from "../IOakenCurveGraduator.sol";
import {GraduationMath} from "../v4/GraduationMath.sol";

interface IOakenCurveFactoryRefV3 {
    function factory() external view returns (address);
}

interface INonfungiblePositionManager {
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

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool);
}

interface IERC20ApproveV3 {
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * @title OakenFlapGraduatorV3
 * @notice Graduates a Flap-model standard (non-tax) token into a PancakeSwap V3
 * pool and keeps the position NFT here forever.
 *
 * The position is full-range at the configured fee tier. The NPM wraps the
 * native quote into WBNB itself, so the pair is token/WBNB. Like the V2
 * graduator, there is no function that can transfer the position or its fees.
 */
contract OakenFlapGraduatorV3 is IOakenCurveGraduator {
    address public immutable binder;
    address public factory;
    address public immutable positionManager;
    address public immutable wbnb;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    error NotBinder();
    error AlreadyBound();
    error NotFactory();
    error NotCurve();
    error WrongValue();
    error TransferFailed();
    error MintFailed();

    constructor(
        address binder_,
        address positionManager_,
        address wbnb_,
        uint24 poolFee_,
        int24 tickSpacing_
    ) {
        if (binder_ == address(0) || positionManager_ == address(0) || wbnb_ == address(0) || tickSpacing_ <= 0) {
            revert NotFactory();
        }
        binder = binder_;
        positionManager = positionManager_;
        wbnb = wbnb_;
        poolFee = poolFee_;
        tickSpacing = tickSpacing_;
        tickLower = (int24(-887272) / tickSpacing_) * tickSpacing_;
        tickUpper = (int24(887272) / tickSpacing_) * tickSpacing_;
    }

    function bindFactory(address factory_) external {
        if (msg.sender != binder) revert NotBinder();
        if (factory != address(0)) revert AlreadyBound();
        if (factory_ == address(0)) revert NotFactory();
        factory = factory_;
    }

    function graduate(address token, uint256 tokenAmount, uint256 quoteAmount) external payable override {
        if (IOakenCurveFactoryRefV3(msg.sender).factory() != factory) revert NotCurve();
        if (msg.value != quoteAmount) revert WrongValue();

        _approve(token, positionManager, tokenAmount);

        bool tokenIs0 = token < wbnb;
        uint256 amount0 = tokenIs0 ? tokenAmount : quoteAmount;
        uint256 amount1 = tokenIs0 ? quoteAmount : tokenAmount;
        // Pancake V3's mint does not create the pool; initialize it at the
        // graduation price first, exactly as the V4 adapter does.
        uint160 sqrtPriceX96 = GraduationMath.sqrtPriceX96FromAmounts(amount0, amount1);
        INonfungiblePositionManager(positionManager).createAndInitializePoolIfNecessary(
            tokenIs0 ? token : wbnb, tokenIs0 ? wbnb : token, poolFee, sqrtPriceX96
        );

        INonfungiblePositionManager.MintParams memory p = INonfungiblePositionManager.MintParams({
            token0: tokenIs0 ? token : wbnb,
            token1: tokenIs0 ? wbnb : token,
            fee: poolFee,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: amount0,
            amount1Desired: amount1,
            amount0Min: 0,
            amount1Min: 0,
            recipient: address(this),
            deadline: block.timestamp + 300
        });
        (uint256 tokenId,,,) = INonfungiblePositionManager(positionManager).mint{value: quoteAmount}(p);
        if (tokenId == 0) revert MintFailed();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20ApproveV3.approve.selector, spender, amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) revert TransferFailed();
    }

    receive() external payable {}
}
