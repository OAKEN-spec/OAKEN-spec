// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title MockTokenNoReturn
 * @notice Test double for the ERC-20s that return nothing, like USDT.
 *
 * Same shape as MockToken with the boolean return values removed. Exists to pin
 * down the one piece of Solidity in the vault that is easy to get wrong:
 * `_callOptionalReturn` must accept a call that returned no data and must still
 * reject a call that returned `false`. A vault that demanded `true` would be
 * unusable with USDT, and one that demanded nothing would accept silent
 * failures, and neither would show up in a test using a well-behaved token.
 */
contract MockTokenNoReturn {
    string public name = "Mock No Return";
    string public symbol = "MOCKNR";
    uint8 public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    // No return values: the whole point of this mock.
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
