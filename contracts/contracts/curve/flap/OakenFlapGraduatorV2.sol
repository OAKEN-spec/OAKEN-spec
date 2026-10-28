// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IOakenCurveGraduator} from "../IOakenCurveGraduator.sol";

interface IOakenCurveFactoryRef {
    function factory() external view returns (address);
}

interface IPancakeRouter02 {
    function factory() external view returns (address);
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

interface IPancakeFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface ITaxTokenPool {
    function setPool(address pool, bool on) external;
}

interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * @title OakenFlapGraduatorV2
 * @notice Graduates a Flap-model tax token into a PancakeSwap V2 pair and keeps
 * the LP tokens here forever.
 *
 * The pair is created by the router's `addLiquidityETH` with the curve's
 * reserved token balance and the real quote reserve. The LP tokens are minted
 * to this contract; there is no transfer, rescue or execute function, so the
 * liquidity cannot be removed. The pair is registered in the token so buys and
 * sells through it pay the configured tax.
 */
contract OakenFlapGraduatorV2 is IOakenCurveGraduator {
    address public immutable binder;
    address public factory;
    address public immutable router;
    address public immutable wbnb;

    error NotBinder();
    error AlreadyBound();
    error NotFactory();
    error NotCurve();
    error WrongValue();
    error TransferFailed();

    constructor(address binder_, address router_, address wbnb_) {
        if (binder_ == address(0) || router_ == address(0) || wbnb_ == address(0)) revert NotFactory();
        binder = binder_;
        router = router_;
        wbnb = wbnb_;
    }

    function bindFactory(address factory_) external {
        if (msg.sender != binder) revert NotBinder();
        if (factory != address(0)) revert AlreadyBound();
        if (factory_ == address(0)) revert NotFactory();
        factory = factory_;
    }

    function graduate(address token, uint256 tokenAmount, uint256 quoteAmount) external payable override {
        if (IOakenCurveFactoryRef(msg.sender).factory() != factory) revert NotCurve();
        if (msg.value != quoteAmount) revert WrongValue();

        _approve(token, router, tokenAmount);
        IPancakeRouter02(router).addLiquidityETH{value: quoteAmount}(
            token, tokenAmount, 0, 0, address(this), block.timestamp + 300
        );

        address pair = IPancakeFactory(IPancakeRouter02(router).factory()).getPair(token, wbnb);
        if (pair != address(0)) ITaxTokenPool(token).setPool(pair, true);
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Approve.approve.selector, spender, amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) revert TransferFailed();
    }

    receive() external payable {}
}
