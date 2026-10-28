// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OakenCurve} from "../../contracts/curve/OakenCurve.sol";
import {OakenCurveFactory} from "../../contracts/curve/OakenCurveFactory.sol";
import {MockCurveGraduator} from "../../contracts/curve/mocks/MockCurveGraduator.sol";

/**
 * Handler for the OAKEN curve invariant suite (4663 parameters).
 *
 * It is allowed to buy and sell from several actors at any time, and to
 * graduate once the curve is complete. Rejections are caught: a rejected buy
 * after graduation is a legitimate state, not a counterexample.
 *
 * What must hold after every sequence:
 *   · the token supply never changes and every token is in a known account;
 *   · the curve's native balance is exactly its principal plus pending fees;
 *   · the curve can never sell into its reserved graduation slice;
 *   · graduation happens at most once.
 */
contract FlapCurveHandler is Test {
    OakenCurve public immutable curve;
    OakenCurveFactory public immutable factory;
    MockCurveGraduator public immutable graduator;
    address public immutable token;
    address public immutable creator;

    address[3] public actors;
    uint256 public buys;
    uint256 public sells;
    uint256 public graduations;

    constructor(OakenCurve curve_, OakenCurveFactory factory_, MockCurveGraduator graduator_, address token_) {
        curve = curve_;
        factory = factory_;
        graduator = graduator_;
        token = token_;
        creator = address(0xC0FFEE);
        actors = [address(0xA11CE), address(0xB0B), address(0xCAFE)];
        for (uint256 i = 0; i < actors.length; i++) {
            vm.deal(actors[i], 1_000 ether);
        }
    }

    function buy(uint256 actorSeed, uint256 amountSeed) external {
        address actor = actors[actorSeed % actors.length];
        uint256 amount = bound(amountSeed, 1, 5 ether);
        if (actor.balance < amount) return;
        vm.prank(actor);
        try curve.buy{value: amount}(0, actor) {
            buys++;
        } catch { /* rejected is a valid state */ }
    }

    function sell(uint256 actorSeed, uint256 amountSeed) external {
        address actor = actors[actorSeed % actors.length];
        uint256 held = IERC20Minimal(token).balanceOf(actor);
        if (held == 0) return;
        uint256 amount = bound(amountSeed, 1, held);
        vm.startPrank(actor);
        IERC20Minimal(token).approve(address(curve), amount);
        try curve.sell(amount, 0, actor) {
            sells++;
        } catch { /* rejected is a valid state */ }
        vm.stopPrank();
    }

    /// @dev Push the curve over its line so graduation is exercised too.
    function complete(uint256 actorSeed) external {
        address actor = actors[actorSeed % actors.length];
        uint256 amount = actor.balance < 200 ether ? actor.balance : 200 ether;
        if (amount == 0) return;
        vm.prank(actor);
        try curve.buy{value: amount}(0, actor) {
            buys++;
        } catch { /* rejected is a valid state */ }
    }

    function graduate() external {
        try curve.graduate() {
            graduations++;
        } catch { /* not complete yet, or already graduated */ }
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 1 hours));
    }
}

interface IERC20Minimal {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

contract OakenFlapCurveInvariantTest is Test {
    uint256 private constant SUPPLY = 1_000_000_000 ether;
    uint256 private constant VIRTUAL_TOKENS = 107_036_752 ether;
    uint256 private constant PHANTOM = 6.14 ether;
    uint256 private constant THRESHOLD = 16 ether;

    OakenCurve private curve;
    OakenCurveFactory private factory;
    MockCurveGraduator private graduator;
    address private token;
    FlapCurveHandler private handler;

    function setUp() public {
        graduator = new MockCurveGraduator();
        factory = new OakenCurveFactory(
            OakenCurveFactory.Config({
                supply: SUPPLY,
                virtualTokens: VIRTUAL_TOKENS,
                phantomQuote: PHANTOM,
                graduationThreshold: THRESHOLD,
                feeBps: 100,
                maxCreatorTaxBps: 1_000,
                protocolShareBps: 600,
                snipeTaxStartBps: 9_900,
                snipeTaxSeconds: 3,
                protocolFeeRecipient: address(0xBEEF),
                graduator: address(graduator),
                launchFeeRecipient: address(0xBEEF),
                launchFee: 0
            })
        );
        address[] memory exempt = new address[](0);
        (address tokenAddr, address curveAddr) = factory.createLaunch(
            OakenCurveFactory.LaunchParams({
                name: "Flap Invariant",
                symbol: "FINV",
                creatorFeeRecipient: address(0xC0FFEE),
                creatorTaxBps: 0,
                salt: keccak256("flap-invariant"),
                snipeTaxExempt: exempt
            })
        );
        token = tokenAddr;
        curve = OakenCurve(curveAddr);
        handler = new FlapCurveHandler(curve, factory, graduator, token);
        targetContract(address(handler));
    }

    /// @dev The Flap-shaped curve (h > 0) holds the same invariants as the Pons one.
    function invariant_supply_and_balances() public view {
        uint256 sum = IERC20Minimal(token).balanceOf(address(curve))
            + IERC20Minimal(token).balanceOf(address(graduator))
            + IERC20Minimal(token).balanceOf(address(0xC0FFEE));
        for (uint256 i = 0; i < 3; i++) {
            sum += IERC20Minimal(token).balanceOf(handler.actors(i));
        }
        assertEq(IERC20Minimal(token).totalSupply(), SUPPLY);
        assertEq(sum, SUPPLY);
        assertEq(IERC20Minimal(token).balanceOf(address(curve)), curve.trackedTokens());
    }

    /// @dev The curve's native balance is principal plus pending fees; nothing
    ///      else can be hiding there.
    function invariant_curve_balance_matches_books() public view {
        uint256 books = curve.trackedQuote()
            + curve.pendingCreatorFees()
            + curve.protocolFeeBalance();
        assertEq(address(curve).balance, books);
    }

    /// @dev The curve never sells into the reserved allocation, and once it is
    ///      ready it never trades again.
    function invariant_reserved_slice_is_untouched() public view {
        assertGe(curve.trackedTokens(), curve.graduated() ? 0 : curve.reservedTokens());
        if (curve.graduated()) {
            assertEq(curve.trackedTokens(), 0);
            assertEq(curve.trackedQuote(), 0);
        }
    }

    /// @dev Graduation happens at most once.
    function invariant_graduation_once() public view {
        assertLe(handler.graduations(), 1);
    }
}
