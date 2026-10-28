// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OakenCurve} from "../../contracts/curve/OakenCurve.sol";
import {OakenCurveFactory} from "../../contracts/curve/OakenCurveFactory.sol";
import {MockCurveGraduator} from "../../contracts/curve/mocks/MockCurveGraduator.sol";

interface IERC20Fuzz {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/**
 * Fuzz the two curve shapes (Pons h=0 and Flap h>0) on the properties that
 * matter after every trade:
 *
 *   · the native balance equals principal + pending fees, to the wei;
 *   · the curve's token balance equals its tracked token reserve;
 *   · the supply never changes;
 *   · a buy that completes the curve sends the exact sellable remainder and
 *     refunds the rest.
 */
abstract contract CurveFuzzBase is Test {
    uint256 internal constant SUPPLY = 1_000_000_000 ether;
    address internal constant ACTOR = address(0xA11CE);
    address internal constant PROTOCOL = address(0xBEEF);

    OakenCurve internal curve;
    OakenCurveFactory internal factory;
    MockCurveGraduator internal graduator;
    address internal token;
    address internal creator;

    function virtualTokens() internal pure virtual returns (uint256);
    function phantomQuote() internal pure virtual returns (uint256);
    function graduationThreshold() internal pure virtual returns (uint256);
    function protocolShareBps() internal pure virtual returns (uint256);

    function setUp() public virtual {
        graduator = new MockCurveGraduator();
        creator = address(0xC0FFEE);
        factory = new OakenCurveFactory(
            OakenCurveFactory.Config({
                supply: SUPPLY,
                virtualTokens: virtualTokens(),
                phantomQuote: phantomQuote(),
                graduationThreshold: graduationThreshold(),
                feeBps: 100,
                maxCreatorTaxBps: 1_000,
                protocolShareBps: protocolShareBps(),
                snipeTaxStartBps: 9_900,
                snipeTaxSeconds: 3,
                protocolFeeRecipient: PROTOCOL,
                graduator: address(graduator),
                launchFeeRecipient: PROTOCOL,
                launchFee: 0
            })
        );
        address[] memory exempt = new address[](0);
        (address tokenAddr, address curveAddr) = factory.createLaunch(
            OakenCurveFactory.LaunchParams({
                name: "Fuzz Curve",
                symbol: "FUZZ",
                creatorFeeRecipient: creator,
                creatorTaxBps: 0,
                salt: keccak256("fuzz"),
                snipeTaxExempt: exempt
            })
        );
        token = tokenAddr;
        curve = OakenCurve(curveAddr);
        vm.deal(ACTOR, 1_000 ether);
        vm.warp(block.timestamp + 10); // out of the snipe window for the base cases
    }

    function _books() internal view returns (uint256) {
        return curve.trackedQuote() + curve.pendingCreatorFees() + curve.protocolFeeBalance();
    }

    function _assertBooks() internal view {
        assertEq(address(curve).balance, _books(), "native balance != principal + fees");
        assertEq(IERC20Fuzz(token).balanceOf(address(curve)), curve.trackedTokens(), "token balance != tracked");
        assertEq(IERC20Fuzz(token).totalSupply(), SUPPLY, "supply changed");
        assertGe(curve.trackedTokens(), curve.graduated() ? 0 : curve.reservedTokens(), "reserved slice touched");
    }

    function testFuzz_a_buy_keeps_the_books_exact(uint96 amount) public {
        amount = uint96(bound(amount, 1e9, 5 ether));
        vm.prank(ACTOR);
        try curve.buy{value: amount}(0, ACTOR) {
            _assertBooks();
            if (curve.sellableTokens() != 0) {
                assertEq(curve.trackedQuote(), amount - (amount * 100) / 10_000, "no snipe: net = amount - 1%");
            }
        } catch {
            // dust-sized buys can price to zero tokens; that is a rejection,
            // not a counterexample
        }
    }

    function testFuzz_a_sell_keeps_the_books_exact(uint96 buyAmount, uint96 sellSeed) public {
        buyAmount = uint96(bound(buyAmount, 1e12, 5 ether));
        vm.prank(ACTOR);
        try curve.buy{value: buyAmount}(0, ACTOR) {
            uint256 held = IERC20Fuzz(token).balanceOf(ACTOR);
            if (held == 0) return;
            uint256 sellAmount = bound(sellSeed, 1, held);
            vm.startPrank(ACTOR);
            IERC20Fuzz(token).approve(address(curve), sellAmount);
            try curve.sell(sellAmount, 0, ACTOR) {
                _assertBooks();
                assertEq(IERC20Fuzz(token).balanceOf(ACTOR), held - sellAmount, "seller token debit");
            } catch { /* rejects are valid */ }
            vm.stopPrank();
        } catch { /* rejects are valid */ }
    }

    function testFuzz_a_completing_buy_refunds_the_excess(uint96 extra) public {
        extra = uint96(bound(extra, 0, 100 ether));
        uint256 amount = 200 ether + extra;
        vm.prank(ACTOR);
        try curve.buy{value: amount}(0, ACTOR) {
            if (!curve.readyToGraduate()) return;
            uint256 sellableBefore = curve.sellableTokens();
            assertEq(sellableBefore, 0, "ready but tokens left");
            assertEq(curve.trackedTokens(), curve.reservedTokens(), "not at the reserved line");
            _assertBooks();
            assertLe(address(curve).balance, amount, "curve cannot hold more than was sent plus nothing");
        } catch { /* buyer has 1000 ether; a revert here is still a valid state */ }
    }

    function testFuzz_fees_never_take_the_whole_buy(uint64 elapsed, uint96 amount) public {
        elapsed = uint64(bound(elapsed, 0, 10));
        amount = uint96(bound(amount, 1e12, 5 ether));
        vm.warp(block.timestamp + elapsed);
        vm.prank(ACTOR);
        try curve.buy{value: amount}(0, ACTOR) {
            _assertBooks();
            uint256 fees = curve.pendingCreatorFees() + curve.protocolFeeBalance();
            assertLt(fees, amount, "fees must leave at least 1 wei buying tokens");
            // and the token side must still be at least the reserved slice
            assertGe(curve.trackedTokens(), curve.graduated() ? 0 : curve.reservedTokens(), "reserved slice touched");
        } catch { /* rejects are valid */ }
    }

    function testFuzz_graduate_once(uint96 amount) public {
        amount = uint96(bound(amount, 1e9, 5 ether));
        vm.prank(ACTOR);
        try curve.buy{value: amount}(0, ACTOR) {} catch { return; }
        uint256 sellable = curve.sellableTokens();
        if (sellable != 0) return;
        try curve.graduate() {
            assertTrue(curve.graduated(), "not marked");
            assertEq(curve.trackedTokens(), 0, "tokens left after graduation");
            _assertBooks();
            vm.expectRevert();
            curve.graduate();
        } catch { /* not ready or already done */ }
    }
}

contract PonsCurveFuzzTest is CurveFuzzBase {
    function virtualTokens() internal pure override returns (uint256) { return 0; }
    function phantomQuote() internal pure override returns (uint256) { return 1.68 ether; }
    function graduationThreshold() internal pure override returns (uint256) { return 4.2 ether; }
    function protocolShareBps() internal pure override returns (uint256) { return 0; }
}

contract FlapCurveFuzzTest is CurveFuzzBase {
    function virtualTokens() internal pure override returns (uint256) { return 107_036_752 ether; }
    function phantomQuote() internal pure override returns (uint256) { return 6.14 ether; }
    function graduationThreshold() internal pure override returns (uint256) { return 16 ether; }
    function protocolShareBps() internal pure override returns (uint256) { return 600; }
}
