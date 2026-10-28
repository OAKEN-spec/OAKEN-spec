// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IOakenCurveGraduator, IOakenCurvePoolInitializer} from "../IOakenCurveGraduator.sol";
import {GraduationMath} from "./GraduationMath.sol";
import {PoolKey, ModifyLiquidityParams, IPoolManager, IPositionManager, IPermit2, IHooks, V4Actions} from "./V4Minimal.sol";

interface IOakenCurveRef {
    function factory() external view returns (address);
}

interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * @title OakenCurveGraduatorV4
 * @notice Seeds the Uniswap V4 pool for a graduated OAKEN curve and keeps the
 * position forever.
 *
 * Three jobs, all of them mechanical:
 *
 *   1. **At launch**, initialize the pool at the exact graduation price and
 *      amounts. The curve's graduation amounts are fixed by its immutable
 *      terms, so this can happen before a single trade.
 *   2. **At graduation**, mint a full-range position and leave it owned by
 *      this contract. There is no transfer, rescue or execute function here,
 *      so the liquidity cannot be removed by anyone — including OAKEN.
 *   3. **As the pool's hook**, refuse to initialize or add liquidity unless
 *      the caller is this graduator. `beforeAddLiquidity` opens after the
 *      graduation mint so anyone can add liquidity to the live pool.
 *
 * ## Deployment note (hook address)
 *
 * V4 reads the hook's permissions from the low bits of its address. This
 * contract needs `beforeInitialize` (1 << 13) and `beforeAddLiquidity`
 * (1 << 11), so it must be deployed by CREATE2 at an address whose low 14 bits
 * are `0x2800`. The deploy script mines the salt and asserts the flag bits
 * before binding the factory. A plain `new` address will not receive the hook
 * callbacks.
 *
 * The factory is bound once after deployment (it is the graduator's only
 * privileged caller). After `bindFactory`, no admin power remains: the
 * graduator cannot move the position or change a pool.
 */
contract OakenCurveGraduatorV4 is IOakenCurveGraduator, IOakenCurvePoolInitializer, IHooks {
    bytes32 private constant POOLS_SLOT = bytes32(uint256(6));
    uint256 private constant MINT_DEADLINE_WINDOW = 300;

    address public immutable binder;
    address public factory;

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IPermit2 public immutable permit2;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    uint160 public immutable sqrtLowerX96;
    uint160 public immutable sqrtUpperX96;

    /// @notice Pools whose graduation mint ran; adding liquidity is open after that.
    mapping(bytes32 poolId => bool open) public poolOpen;
    /// @notice Pools that already received their one graduation mint.
    mapping(bytes32 poolId => bool done) public poolGraduated;
    /// @notice True only inside the graduation mint's modifyLiquidities call.
    bool public arming;

    error NotBinder();
    error AlreadyBound();
    error NotFactory();
    error NotCurve();
    error WrongValue();
    error ZeroLiquidity();
    error AlreadyGraduated();
    error AmountTooLarge();
    error NotPoolManager();
    error TransferFailed();

    constructor(
        address binder_,
        address poolManager_,
        address positionManager_,
        address permit2_,
        uint24 poolFee_,
        int24 tickSpacing_,
        uint160 sqrtLowerX96_,
        uint160 sqrtUpperX96_
    ) {
        if (binder_ == address(0) || poolManager_ == address(0) || positionManager_ == address(0) || permit2_ == address(0)) {
            revert ZeroLiquidity();
        }
        if (sqrtLowerX96_ == 0 || sqrtUpperX96_ == 0 || sqrtLowerX96_ >= sqrtUpperX96_) revert ZeroLiquidity();
        binder = binder_;
        poolManager = IPoolManager(poolManager_);
        positionManager = IPositionManager(positionManager_);
        permit2 = IPermit2(permit2_);
        poolFee = poolFee_;
        tickSpacing = tickSpacing_;
        int24 lower = (int24(-887272) / tickSpacing_) * tickSpacing_;
        int24 upper = (int24(887272) / tickSpacing_) * tickSpacing_;
        tickLower = lower;
        tickUpper = upper;
        sqrtLowerX96 = sqrtLowerX96_;
        sqrtUpperX96 = sqrtUpperX96_;
    }

    /** @notice The factory is the only caller in the life of this contract. */
    function bindFactory(address factory_) external {
        if (msg.sender != binder) revert NotBinder();
        if (factory != address(0)) revert AlreadyBound();
        if (factory_ == address(0)) revert NotFactory();
        factory = factory_;
    }

    // ── Launch-time pool initialization ───────────────────────────────────

    /**
     * @notice Called by the factory in the launch transaction, after the
     * token exists and its curve is initialized.
     *
     * The price comes from the curve's immutable graduation amounts, so it is
     * fixed before the token can trade. The hook only accepts this call from
     * the graduator itself, which shuts out anyone trying to initialize the
     * pool first at a different price.
     */
    function initializePool(address token, uint256 quoteAmount, uint256 tokenAmount) external override {
        if (msg.sender != factory) revert NotFactory();
        PoolKey memory key = _key(token);
        uint160 sqrtPriceX96 = GraduationMath.sqrtPriceX96FromAmounts(quoteAmount, tokenAmount);
        poolManager.initialize(key, sqrtPriceX96);
    }

    // ── Graduation ────────────────────────────────────────────────────────

    /**
     * @notice Mint the curve's reserved tokens and quote reserve into a
     * full-range V4 position owned by this contract.
     */
    function graduate(address token, uint256 tokenAmount, uint256 quoteAmount) external payable override {
        IOakenCurveRef curve = IOakenCurveRef(msg.sender);
        if (curve.factory() != factory) revert NotCurve();
        if (msg.value != quoteAmount) revert WrongValue();
        if (tokenAmount == 0 || quoteAmount == 0) revert ZeroLiquidity();
        if (tokenAmount > type(uint128).max || quoteAmount > type(uint128).max) revert AmountTooLarge();
        if (tokenAmount > type(uint160).max) revert AmountTooLarge();

        PoolKey memory key = _key(token);
        bytes32 poolId = keccak256(abi.encode(key));
        if (poolGraduated[poolId]) revert AlreadyGraduated();
        uint160 sqrtPriceX96 = _slot0SqrtPrice(key);
        uint128 liquidity =
            GraduationMath.liquidityForAmounts(sqrtPriceX96, sqrtLowerX96, sqrtUpperX96, quoteAmount, tokenAmount);
        if (liquidity == 0) revert ZeroLiquidity();

        _approvePermit2(token, tokenAmount);

        bytes memory actions =
            abi.encodePacked(uint8(V4Actions.MINT_POSITION), uint8(V4Actions.SETTLE_PAIR), uint8(V4Actions.SWEEP));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            key,
            tickLower,
            tickUpper,
            uint256(liquidity),
            uint128(quoteAmount),
            uint128(tokenAmount),
            address(this),
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        params[2] = abi.encode(key.currency0, address(this));

        arming = true;
        positionManager.modifyLiquidities{value: quoteAmount}(abi.encode(actions, params), block.timestamp + MINT_DEADLINE_WINDOW);
        arming = false;
        poolGraduated[poolId] = true;
        poolOpen[poolId] = true;
    }

    // ── Hook callbacks ────────────────────────────────────────────────────

    /// @notice Only this graduator may create the pool.
    function beforeInitialize(address sender, PoolKey calldata, uint160) external view override returns (bytes4) {
        if (msg.sender != address(poolManager) || sender != address(this)) return bytes4(0);
        return IHooks.beforeInitialize.selector;
    }

    /// @notice Only the graduation mint may add liquidity before the pool opens.
    function beforeAddLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        if (msg.sender != address(poolManager)) return bytes4(0);
        if (poolOpen[keccak256(abi.encode(key))]) return IHooks.beforeAddLiquidity.selector;
        if (arming && sender == address(positionManager)) return IHooks.beforeAddLiquidity.selector;
        return bytes4(0);
    }

    // ── ERC-721 custody ───────────────────────────────────────────────────

    /**
     * @notice Accept the position NFT. There is deliberately no matching
     * transfer function: the position stays here.
     */
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {}

    // ── Internal ──────────────────────────────────────────────────────────

    function _key(address token) private view returns (PoolKey memory) {
        // Native currency sorts below every ERC-20, so it is always currency0.
        return PoolKey({
            currency0: address(0),
            currency1: token,
            fee: poolFee,
            tickSpacing: tickSpacing,
            hooks: address(this)
        });
    }

    function _slot0SqrtPrice(PoolKey memory key) private view returns (uint160 sqrtPriceX96) {
        bytes32 poolId = keccak256(abi.encode(key));
        bytes32 stateSlot = keccak256(abi.encode(poolId, POOLS_SLOT));
        uint256 data = uint256(poolManager.extsload(stateSlot));
        sqrtPriceX96 = uint160(data & ((uint256(1) << 160) - 1));
    }

    function _approvePermit2(address token, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Minimal.approve.selector, address(permit2), amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) revert TransferFailed();
        permit2.approve(token, address(positionManager), uint160(amount), uint48(block.timestamp + MINT_DEADLINE_WINDOW));
    }
}
