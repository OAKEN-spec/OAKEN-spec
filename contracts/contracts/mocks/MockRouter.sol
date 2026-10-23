// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * A Uniswap-V2 router, reduced to the one function `Presale.finalize` calls.
 *
 * It pulls the tokens and keeps the ETH, like the real thing creates a pool —
 * and it can hand a configurable slice of the ETH back to the caller, which is
 * what the real router does when the pool already exists at a different ratio.
 * That path is the one `Presale` has to survive without stranding funds, so the
 * tests drive it on purpose rather than hoping it never happens.
 */
contract MockRouter {
    uint16 public refundBps;
    uint256 public lastTokenAmount;
    uint256 public lastEthAmount;

    error PullFailed();
    error RefundFailed();

    function setRefund(uint16 bps) external {
        refundBps = bps;
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256,
        uint256,
        address,
        uint256
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amountTokenDesired)   // transferFrom
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert PullFailed();

        lastTokenAmount = amountTokenDesired;
        lastEthAmount = msg.value;

        if (refundBps > 0) {
            uint256 back = msg.value * refundBps / 10_000;
            (bool sent, ) = msg.sender.call{ value: back }("");
            if (!sent) revert RefundFailed();
        }
        return (amountTokenDesired, msg.value, amountTokenDesired);
    }

    receive() external payable { }
}
