// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title OakenTaxToken
 * @notice A fixed-supply ERC-20 with Flap-style buy/sell tax on DEX pools.
 *
 * The whole supply is minted to the bonding curve at launch, so the creator
 * starts with nothing. The curve phase is untaxed: tax only applies to
 * transfers where one side is a registered pool, and pools are registered by
 * the graduator when the curve hands over its reserves.
 *
 * Tax policy (all immutable):
 *   · buy and sell rates are one of Flap's four steps: 1% / 3% / 5% / 10%
 *   · the tax is split into four buckets that must add up to 10000 bps:
 *     marketing / deflation (sent to a dead address) / dividend / liquidity
 *   · a 0.06%-of-volume platform commission is taken from the tax:
 *     commissionBps = 60000 / taxRateBps (6% of a 1% tax, 2% of a 3% tax, …)
 *   · the window starts when the first pool is registered and lasts
 *     `taxDuration` seconds
 *
 * There is no owner and no setter for the rates or wallets. `setPool` is the
 * only state-changing privileged call and only the factory or the graduator
 * may make it.
 */
contract OakenTaxToken {
    uint256 private constant BPS = 10_000;
    uint256 private constant COMMISSION_SCALE = 60_000;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    struct TaxConfig {
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint64 taxDuration;
        uint16 marketingBps;
        uint16 deflationBps;
        uint16 dividendBps;
        uint16 liquidityBps;
        address marketingWallet;
        address dividendWallet;
        address liquidityWallet;
        address commissionReceiver;
    }

    struct Init {
        string name;
        string symbol;
        uint256 supply;
        address curve;
        address factory;
        address graduator;
        address creator;
        TaxConfig tax;
    }

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public immutable totalSupply;

    mapping(address account => uint256) public balanceOf;
    mapping(address account => mapping(address spender => uint256)) public allowance;

    address public immutable curve;
    address public immutable factory;
    address public immutable graduator;
    address public immutable creator;
    TaxConfig public tax;

    mapping(address account => bool) public exempt;
    mapping(address pool => bool) public isPool;
    uint64 public taxStart;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event PoolSet(address indexed pool, bool on);
    event Taxed(address indexed from, address indexed to, uint256 gross, uint256 tax, uint256 commission);

    error ZeroAddress();
    error InvalidTaxRate();
    error InvalidBuckets();
    error InsufficientBalance();
    error InsufficientAllowance();
    error NotPoolAuthority();

    constructor(Init memory init) {
        if (
            init.curve == address(0) || init.factory == address(0) || init.graduator == address(0)
                || init.creator == address(0) || init.supply == 0
        ) revert ZeroAddress();
        if (!_validRate(init.tax.buyTaxBps) || !_validRate(init.tax.sellTaxBps)) revert InvalidTaxRate();
        if (
            uint256(init.tax.marketingBps) + init.tax.deflationBps + init.tax.dividendBps + init.tax.liquidityBps
                != BPS
        ) revert InvalidBuckets();
        if (init.tax.commissionReceiver == address(0)) revert ZeroAddress();
        if (init.tax.marketingBps != 0 && init.tax.marketingWallet == address(0)) revert ZeroAddress();
        if (init.tax.dividendBps != 0 && init.tax.dividendWallet == address(0)) revert ZeroAddress();
        if (init.tax.liquidityBps != 0 && init.tax.liquidityWallet == address(0)) revert ZeroAddress();

        name = init.name;
        symbol = init.symbol;
        totalSupply = init.supply;
        curve = init.curve;
        factory = init.factory;
        graduator = init.graduator;
        creator = init.creator;
        tax = init.tax;

        balanceOf[init.curve] = init.supply;
        emit Transfer(address(0), init.curve, init.supply);

        exempt[init.curve] = true;
        exempt[init.factory] = true;
        exempt[init.graduator] = true;
        exempt[init.creator] = true;
        exempt[init.tax.commissionReceiver] = true;
        if (init.tax.marketingWallet != address(0)) exempt[init.tax.marketingWallet] = true;
        if (init.tax.dividendWallet != address(0)) exempt[init.tax.dividendWallet] = true;
        if (init.tax.liquidityWallet != address(0)) exempt[init.tax.liquidityWallet] = true;
    }

    /** @notice The factory or the graduator registers the DEX pool(s). */
    function setPool(address pool, bool on) external {
        if (msg.sender != factory && msg.sender != graduator) revert NotPoolAuthority();
        if (pool == address(0)) revert ZeroAddress();
        isPool[pool] = on;
        if (on && taxStart == 0) taxStart = uint64(block.timestamp);
        emit PoolSet(pool, on);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function taxActive() public view returns (bool) {
        return taxStart != 0 && block.timestamp < uint256(taxStart) + tax.taxDuration;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        uint256 taxAmount = 0;
        bool taxed = !exempt[from] && !exempt[to] && (isPool[from] || isPool[to]) && taxActive();
        if (taxed) {
            // Tokens going *into* a pool are a sell; tokens coming *out* are a buy.
            uint16 rate = isPool[to] ? tax.sellTaxBps : tax.buyTaxBps;
            if (rate != 0) taxAmount = (amount * rate) / BPS;
        }
        _move(from, to, amount - taxAmount);
        if (taxAmount != 0) _collect(from, to, amount, taxAmount);
    }

    function _collect(address from, address to, uint256 gross, uint256 taxAmount) private {
        bool selling = isPool[to];
        uint16 rate = selling ? tax.sellTaxBps : tax.buyTaxBps;
        uint256 commission = (taxAmount * (COMMISSION_SCALE / rate)) / BPS;
        uint256 rest = taxAmount - commission;
        uint256 marketing = (rest * tax.marketingBps) / BPS;
        uint256 deflation = (rest * tax.deflationBps) / BPS;
        uint256 dividend = (rest * tax.dividendBps) / BPS;
        uint256 liquidity = rest - marketing - deflation - dividend;

        if (commission != 0) _move(from, tax.commissionReceiver, commission);
        if (marketing != 0) _move(from, tax.marketingWallet, marketing);
        if (deflation != 0) _move(from, BURN, deflation);
        if (dividend != 0) _move(from, tax.dividendWallet, dividend);
        if (liquidity != 0) _move(from, tax.liquidityWallet, liquidity);
        emit Taxed(from, to, gross, taxAmount, commission);
    }

    function _move(address from, address to, uint256 amount) private {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _validRate(uint16 rate) private pure returns (bool) {
        return rate == 100 || rate == 300 || rate == 500 || rate == 1_000;
    }
}
