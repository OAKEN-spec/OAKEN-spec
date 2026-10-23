// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title OakenToken
 * @notice A plain, fixed-supply ERC-20, deployed by `TokenFactory`.
 *
 * ## Why this exists at all
 *
 * Every token on these chains is 90% this file and 10% whatever the project
 * actually wanted to add. Shipping the 90% means a project can have a token in
 * one transaction instead of copying a template it has not read — and the copy
 * it would have found online is usually an ERC-20 with a mint function, an
 * owner, a fee switch and a pause, none of which the project asked for and all
 * of which a buyer has to discover later.
 *
 * So the whole design here is subtraction:
 *
 *   · **No owner.** There is no privileged address, so there is no function
 *     that only one address can call.
 *   · **No mint, ever.** The supply is fixed in the constructor. Nothing can
 *     create more — including this contract, which has no code path for it.
 *   · **No pause, no blacklist, no fee.** A transfer moves the amount it says.
 *     Fee-on-transfer tokens exist and are legitimate; a token that becomes one
 *     after launch is a rug, and the difference is only visible if the
 *     possibility was in the code all along.
 *   · **No burn.** Burning is a supply change with extra steps, and it is the
 *     one the "we will burn the rest" promise is built on.
 *
 * What is left is ERC-20 as it was specified, which is also the version every
 * wallet, DEX and lock contract already knows how to talk to.
 *
 * ## What it is not
 *
 * This is not a standard-compliant `IERC20Metadata` implementation with the
 * optional extensions (permit, votes, snapshots). A project that needs those
 * needs a different token, and this factory is not the right tool — saying so
 * here is cheaper than discovering it after the token is live.
 */
contract OakenToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error InsufficientBalance(uint256 available, uint256 required);
    error InsufficientAllowance(uint256 available, uint256 required);
    error ZeroAddress();

    /**
     * The whole supply is minted to `owner` in the constructor and that is the
     * only mint this contract will ever perform. Everything after this is
     * transfers.
     */
    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 supply_, address owner) {
        if (owner == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        totalSupply = supply_;
        balanceOf[owner] = supply_;
        emit Transfer(address(0), owner, supply_);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        // An infinite allowance is not decremented: it is what a user who has
        // approved once expects, and decrementing it costs a storage write on
        // every transfer, which is the tax every token with this behaviour
        // charges its own holders.
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(allowed, amount);
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(balance, amount);
        unchecked {
            // Cannot underflow: checked immediately above. Cannot overflow:
            // the sum of all balances is `totalSupply`, fixed at construction.
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
