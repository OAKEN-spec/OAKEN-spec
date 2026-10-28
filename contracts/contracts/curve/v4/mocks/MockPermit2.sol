// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IOakenCurveGraduator} from "../../IOakenCurveGraduator.sol";

/** Records the two-step Permit2 approval the graduator performs. */
contract MockPermit2 {
    address public lastToken;
    address public lastSpender;
    uint160 public lastAmount;
    uint48 public lastExpiration;
    uint256 public calls;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        lastToken = token;
        lastSpender = spender;
        lastAmount = amount;
        lastExpiration = expiration;
        calls += 1;
    }
}

/** Stands in for an OakenCurve: the graduator only needs its factory getter. */
contract MockCurveRef {
    address public factory;

    constructor(address factory_) {
        factory = factory_;
    }

    function callGraduate(address graduator, address token, uint256 tokenAmount, uint256 quoteAmount)
        external
        payable
    {
        IOakenCurveGraduator(graduator).graduate{value: msg.value}(token, tokenAmount, quoteAmount);
    }
}
