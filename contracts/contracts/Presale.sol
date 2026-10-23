// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title Presale
 * @notice One token sale: a fixed price, a window, a soft cap that decides
 *         whether it happens at all, and a hard cap that decides when it stops.
 *
 * ## The rules, in one paragraph
 *
 * The creator funds the sale with tokens up front, so a buyer is never looking
 * at a promise to deliver later. People buy with the chain's native currency at
 * a rate fixed at creation. If the window closes under the soft cap, every
 * contribution goes back — there is no discretion in this, no vote, and no way
 * for the creator to keep the money. If it closes at or over the soft cap,
 * anyone can finalize it: the raise goes to the creator (or into a liquidity
 * pool, if the sale was created with a router), and buyers claim their tokens
 * at the same rate they bought at.
 *
 * ## What is deliberately not here
 *
 * **No owner.** The parameters are immutable and set at construction, which
 * means the page describing a sale and the contract running it cannot drift
 * apart. A sale that could be re-priced, extended, or paused mid-window is a
 * sale whose terms are a matter of trust, and the point of this contract is
 * that there is nothing to trust.
 *
 * **No whitelist, no tiers, no vesting of purchased tokens.** Those are real
 * things launchpads sell, and each of them is a second state machine on top of
 * this one. They belong in a later version with their own tests, not bolted on
 * here where they would quietly change what "claim" means.
 *
 * **No refunds after a successful sale.** Once the soft cap is met, the money
 * is the creator's and the tokens are the buyer's; a refund path that survives
 * finalization is a way to drain the raise.
 *
 * ## The invariant the factory enforces
 *
 * `tokensToSell >= hardCap * rate / 1e18` — a sale cannot promise more tokens
 * than it holds. This is checked before deployment rather than here, because it
 * is a property of the creation parameters, and a sale that violates it would
 * be a sale that silently runs out of tokens to claim.
 *
 * ## Rounding
 *
 * `tokensFor` truncates. A buyer with an odd contribution gets a fraction of a
 * token less than the exact maths; the remainder stays in the contract and goes
 * to the creator with the unsold tokens. Rounding *up* would let a large buyer
 * claim more than the sale holds, which is the one direction that matters.
 */
contract Presale {
    /** Cap on the liquidity share, in basis points (100%). */
    uint16 public constant BPS_DENOMINATOR = 10_000;

    // ---- creation parameters (immutable) -----------------------------------
    /** The token being sold. Held by this contract before the first buy. */
    address public immutable token;
    /** Receives the raise (or the liquidity position), and the unsold tokens. */
    address public immutable creator;
    uint64 public immutable startTime;
    uint64 public immutable endTime;
    /** Below this, the sale is cancelled and contributions are refunded. */
    uint128 public immutable softCap;
    /** At this, the sale stops accepting money. */
    uint128 public immutable hardCap;
    uint128 public immutable minBuy;
    /** Per address, across the whole window. */
    uint128 public immutable maxBuy;
    /** Tokens (in the token's own smallest unit) per 1 native, where 1 native = 1e18 wei. */
    uint256 public immutable rate;
    /**
     * A Uniswap-V2-style router, or zero.
     *
     * Zero means the creator receives the whole raise and adds liquidity
     * themselves (and can lock that LP with Oaken Lock like anyone else). A
     * router means finalize puts `liquidityBps` of the raise into a pool at the
     * sale price and locks the LP tokens by sending them to the creator — this
     * contract never becomes the owner of a pool.
     */
    address public immutable router;
    uint16 public immutable liquidityBps;

    // ---- state -------------------------------------------------------------
    uint128 public raised;
    /** Tokens already claimed by buyers. */
    uint256 public claimedTokens;
    bool public finalized;
    bool public liquidityAdded;

    mapping(address => uint128) public contribution;
    mapping(address => bool) public claimed;

    error NotStarted(uint64 startTime);
    error Ended(uint64 endTime);
    error BelowMinimum(uint256 sent, uint256 minimum);
    error AboveMaximum(uint256 totalAfter, uint256 maximum);
    error HardCapReached(uint256 hardCap);
    error NotEnded(uint64 endTime);
    error SoftCapMissed(uint256 raised, uint256 softCap);
    error AlreadyFinalized();
    error NotFinalized();
    error SaleFailed();
    error NotCreator();
    error NothingContributed();
    error NothingToClaim();
    error AlreadyClaimed();
    error NativeTransferFailed();
    error LiquidityCallFailed();
    error TokenCallFailed();

    event Bought(address indexed buyer, uint256 amount, uint256 tokens);
    event Refunded(address indexed buyer, uint256 amount);
    event Finalized(address indexed by, uint256 raised, uint256 toCreator, uint256 toLiquidity);
    event LiquidityAdded(address indexed router, uint256 nativeAmount, uint256 tokenAmount);
    event Claimed(address indexed buyer, uint256 tokens);
    event UnsoldWithdrawn(address indexed creator, uint256 tokens);

    constructor(
        address token_,
        address creator_,
        uint64 startTime_,
        uint64 endTime_,
        uint128 softCap_,
        uint128 hardCap_,
        uint128 minBuy_,
        uint128 maxBuy_,
        uint256 rate_,
        address router_,
        uint16 liquidityBps_
    ) {
        token = token_;
        creator = creator_;
        startTime = startTime_;
        endTime = endTime_;
        softCap = softCap_;
        hardCap = hardCap_;
        minBuy = minBuy_;
        maxBuy = maxBuy_;
        rate = rate_;
        router = router_;
        liquidityBps = liquidityBps_;
    }

    // ---- buying ------------------------------------------------------------

    /**
     * Buy at the fixed rate.
     *
     * There is no price impact, no curve, and no bonus for being early beyond
     * being able to buy before the cap is reached. The checks are the sale's
     * published terms and nothing else: the window, the per-address limits, and
     * the hard cap.
     */
    function buy() external payable {
        if (block.timestamp < startTime) revert NotStarted(startTime);
        if (block.timestamp > endTime) revert Ended(endTime);

        uint256 amount = msg.value;
        if (amount < minBuy) revert BelowMinimum(amount, minBuy);
        uint256 after_ = uint256(contribution[msg.sender]) + amount;
        if (after_ > maxBuy) revert AboveMaximum(after_, maxBuy);

        uint256 newRaised = uint256(raised) + amount;
        if (newRaised > hardCap) revert HardCapReached(hardCap);

        contribution[msg.sender] = uint128(after_);
        raised = uint128(newRaised);

        emit Bought(msg.sender, amount, tokensFor(amount));
    }

    /** Tokens a given contribution buys. Truncating — see the header. */
    function tokensFor(uint256 amount) public view returns (uint256) {
        return amount * rate / 1e18;
    }

    /**
     * Get the contribution back after a sale that missed its soft cap.
     *
     * Open once the window has closed and the soft cap is not met, and it stays
     * open forever: a refund window with a deadline is a way to keep money for
     * something that was never sold.
     */
    function refund() external {
        if (block.timestamp <= endTime) revert NotEnded(endTime);
        if (raised >= softCap) revert SaleFailed();     // it sold: there is nothing to give back
        uint256 amount = contribution[msg.sender];
        if (amount == 0) revert NothingContributed();

        contribution[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
        emit Refunded(msg.sender, amount);
    }

    // ---- finalizing --------------------------------------------------------

    /**
     * Close a successful sale and move the money.
     *
     * Callable by anyone once the window has closed and the soft cap is met:
     * the creator cannot delay it, and neither can anyone else. With a router,
     * `liquidityBps` of the raise is paired with tokens at the sale price and
     * the LP tokens go to the creator; without one, the whole raise goes to the
     * creator and this contract's job is done.
     */
    function finalize() external {
        if (block.timestamp <= endTime) revert NotEnded(endTime);
        if (raised < softCap) revert SoftCapMissed(raised, softCap);
        if (finalized) revert AlreadyFinalized();
        finalized = true;

        uint256 toLiquidity;
        if (router != address(0) && liquidityBps > 0) {
            toLiquidity = uint256(raised) * liquidityBps / BPS_DENOMINATOR;
            uint256 tokensForLiquidity = tokensFor(toLiquidity);
            _approve(router, tokensForLiquidity);
            // 0 minimums: the creator chose the router and the share at
            // creation, and the alternative — parameters set here — would be
            // parameters set by whoever calls finalize.
            // The ETH side of the liquidity goes **with the call** — the router
            // pairs what it is given, and a call without a value pairs nothing.
            (bool ok, ) = router.call{ value: toLiquidity }(
                abi.encodeWithSelector(
                    IRouter02.addLiquidityETH.selector,
                    token,
                    tokensForLiquidity,
                    0,
                    0,
                    creator,
                    block.timestamp
                )
            );
            if (!ok) revert LiquidityCallFailed();
            liquidityAdded = true;
            emit LiquidityAdded(router, toLiquidity, tokensForLiquidity);
        }

        uint256 toCreator = address(this).balance;
        if (toCreator > 0) {
            // Everything in here belongs to this sale: the raise, plus whatever
            // the router handed back when the pool's existing ratio meant it
            // needed less than the amounts offered. Sending the whole balance
            // is the version of this that cannot leave dust behind.
            (bool sent, ) = creator.call{ value: toCreator }("");
            if (!sent) revert NativeTransferFailed();
        }
        emit Finalized(msg.sender, raised, toCreator, toLiquidity);
    }

    /** After a successful, finalized sale: the tokens bought, at the same rate. */
    function claim() external {
        if (!finalized) revert NotFinalized();
        if (claimed[msg.sender]) revert AlreadyClaimed();
        uint256 amount = tokensFor(contribution[msg.sender]);
        if (amount == 0) revert NothingToClaim();

        claimed[msg.sender] = true;
        claimedTokens += amount;
        _transfer(token, msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /**
     * Take back the tokens that did not sell.
     *
     * Available to the creator once the sale is over, one way or the other:
     * after a successful sale, minus whatever buyers can still claim; after a
     * failed one, everything — the buyers get their money back, and no tokens
     * were sold to anyone.
     */
    function withdrawUnsold() external {
        if (msg.sender != creator) revert NotCreator();
        if (block.timestamp <= endTime) revert NotEnded(endTime);

        bool failed = raised < softCap;
        if (!failed && !finalized) revert NotFinalized();

        uint256 balance = _balanceOf(address(this));
        // Reserve for claims only after a success: every buyer's tokens must
        // still be here when they call claim(). Already-claimed tokens are not
        // reserved — they have left the building, and counting them twice would
        // make the last withdrawable slice unreachable.
        uint256 reserved = failed ? 0 : (_totalTokensOwed() - claimedTokens);
        if (balance <= reserved) revert NothingToClaim();

        uint256 amount = balance - reserved;
        _transfer(token, creator, amount);
        emit UnsoldWithdrawn(creator, amount);
    }

    // ---- views the front end uses -----------------------------------------

    /** The most tokens this sale can hand out — the promise, in tokens. */
    function promisedTokens() external view returns (uint256) {
        return tokensFor(hardCap);
    }

    /** Everything a buyer still owes the sale in claims. */
    function _totalTokensOwed() private view returns (uint256) {
        return tokensFor(raised);   // sum of per-buyer floors is at most this
    }

    function status() external view returns (string memory) {
        if (block.timestamp < startTime) return "upcoming";
        if (block.timestamp <= endTime) return "live";
        if (raised < softCap) return "failed";
        if (!finalized) return "ended, awaiting finalize";
        return "finalized";
    }

    // ---- token plumbing ----------------------------------------------------

    function _balanceOf(address who) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(IERC20BalanceOf.balanceOf.selector, who));
        if (!ok || data.length < 32) revert TokenCallFailed();
        return abi.decode(data, (uint256));
    }

    function _transfer(address who, address to, uint256 amount) private {
        (bool ok, bytes memory data) = who.call(abi.encodeWithSelector(IERC20Transfer.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _approve(address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Approve.approve.selector, spender, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    receive() external payable {
        // Only the router refunding part of a deposit should reach this.
        if (msg.sender != router) revert();
    }
}

interface IERC20Transfer {
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IERC20BalanceOf {
    function balanceOf(address who) external view returns (uint256);
}

/** The two functions of a Uniswap-V2 router this contract uses. */
interface IRouter02 {
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}
