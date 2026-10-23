// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title MockToken
 * @notice Test double standing in for three kinds of real ERC-20.
 *
 * With `feeBps == 0` it is a plain token. With `feeBps != 0` it is a taxed
 * token, which is the case the vault's balance-delta accounting exists for:
 * PinkLock makes the user whitelist PinkLock's address in the token before a
 * lock will work, and this mock is what proves the vault does not need that
 * step. `feeBps == 10000` taxes the whole transfer, which is the case that must
 * revert rather than create an empty lock.
 */
contract MockToken {
    string public name;
    string public symbol;
    uint8 public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /** Basis points taken from every transfer and sent to `feeSink`. */
    uint16 public feeBps;
    address public feeSink;

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    function setFee(uint16 bps, address sink) external {
        require(bps <= 10_000, "fee too high");
        feeBps = bps;
        feeSink = sink;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    /**
     * Move `amount` out of `from`, keeping `feeBps` back for the sink. The
     * recipient therefore receives less than `amount`, which is exactly the
     * situation the vault must measure rather than assume.
     */
    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        uint256 fee = (amount * feeBps) / 10_000;
        if (fee != 0) {
            balanceOf[feeSink] += fee;
            emit Transfer(from, feeSink, fee);
        }
        balanceOf[to] += amount - fee;
        emit Transfer(from, to, amount - fee);
    }

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
}
