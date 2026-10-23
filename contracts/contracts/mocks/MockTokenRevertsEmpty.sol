// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @dev A token whose transfers revert with no data, covering the vault's
///      empty-returndata branch in `_callOptionalReturn`.
contract MockTokenRevertsEmpty {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address, uint256) external pure {
        revert();
    }

    function transferFrom(address, address, uint256) external pure {
        revert();
    }
}
