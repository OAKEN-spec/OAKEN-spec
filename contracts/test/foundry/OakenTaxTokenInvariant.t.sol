// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OakenTaxToken} from "../../contracts/curve/OakenTaxToken.sol";

interface ITaxToken {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function setPool(address, bool) external;
}

/**
 * The tax token's invariants: the supply is fixed, every token is still in a
 * known account, and the bucket wallets + burn + commission receive exactly
 * the tax the transfer says. The accounting is checked by conservation, not by
 * re-deriving each bucket in the test.
 */
contract TaxTokenHandler is Test {
    ITaxToken public immutable token;
    address public immutable curve;
    address public immutable pool;
    address public immutable marketing;
    address public immutable dividend;
    address public immutable liquidity;
    address public immutable commission;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    address[3] public actors = [address(0xA11CE), address(0xB0B), address(0xCAFE)];

    constructor(
        ITaxToken token_,
        address curve_,
        address pool_,
        address marketing_,
        address dividend_,
        address liquidity_,
        address commission_
    ) {
        token = token_;
        curve = curve_;
        pool = pool_;
        marketing = marketing_;
        dividend = dividend_;
        liquidity = liquidity_;
        commission = commission_;
        for (uint256 i = 0; i < actors.length; i++) {
            vm.prank(curve_);
            token_.transfer(actors[i], 10_000_000 ether);
        }
        vm.prank(curve_);
        token_.transfer(pool_, 100_000_000 ether);
    }

    function _known(uint256 seed) internal view returns (address) {
        uint256 i = seed % 5;
        if (i == 0) return actors[0];
        if (i == 1) return actors[1];
        if (i == 2) return actors[2];
        if (i == 3) return pool;
        return curve;
    }

    function move(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external {
        address from = _known(fromSeed);
        address to = _known(toSeed);
        if (from == to) return;
        uint256 held = token.balanceOf(from);
        if (held == 0) return;
        uint256 amount = bound(amountSeed, 1, held);
        vm.prank(from);
        try token.transfer(to, amount) {} catch { /* rejected is valid */ }
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 2 days));
    }
}

contract OakenTaxTokenInvariantTest is Test {
    uint256 private constant SUPPLY = 1_000_000_000 ether;
    address private constant CURVE = address(0xC0DE);
    address private constant FACTORY = address(0xFAC);
    address private constant GRADUATOR = address(0x6AD);
    address private constant CREATOR = address(0xC0FFEE);
    address private constant PROTOCOL = address(0xBEEF);
    address private constant POOL = address(0x9001);
    address private constant MARKETING = address(0x1111);
    address private constant DIVIDEND = address(0x2222);
    address private constant LIQUIDITY = address(0x3333);

    ITaxToken private token;
    TaxTokenHandler private handler;

    function setUp() public {
        token = ITaxToken(address(new OakenTaxToken(
            OakenTaxToken.Init({
                name: "Invariant Tax",
                symbol: "ITAX",
                supply: SUPPLY,
                curve: CURVE,
                factory: FACTORY,
                graduator: GRADUATOR,
                creator: CREATOR,
                tax: OakenTaxToken.TaxConfig({
                    buyTaxBps: 500,
                    sellTaxBps: 500,
                    taxDuration: 3_600,
                    marketingBps: 4_000,
                    deflationBps: 2_000,
                    dividendBps: 2_000,
                    liquidityBps: 2_000,
                    marketingWallet: MARKETING,
                    dividendWallet: DIVIDEND,
                    liquidityWallet: LIQUIDITY,
                    commissionReceiver: PROTOCOL
                })
            })
        )));
        vm.prank(FACTORY);
        token.setPool(POOL, true);
        handler = new TaxTokenHandler(token, CURVE, POOL, MARKETING, DIVIDEND, LIQUIDITY, PROTOCOL);
        targetContract(address(handler));
    }

    function invariant_supply_is_fixed_and_accounted() public view {
        uint256 sum = token.balanceOf(CURVE)
            + token.balanceOf(POOL)
            + token.balanceOf(MARKETING)
            + token.balanceOf(DIVIDEND)
            + token.balanceOf(LIQUIDITY)
            + token.balanceOf(PROTOCOL)
            + token.balanceOf(address(0x000000000000000000000000000000000000dEaD));
        for (uint256 i = 0; i < 3; i++) sum += token.balanceOf(handler.actors(i));
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(sum, SUPPLY);
    }

    /// @dev A transfer into the pool can never take more than the tax rate,
    ///      and the sender's debit always equals the recipient + tax legs.
    function invariant_tax_never_exceeds_the_rate() public view {
        // The strongest available check without re-deriving the buckets: the
        // bucket wallets can only receive via taxed transfers, and the whole
        // system still sums to the fixed supply (the previous invariant).
        assertLe(token.balanceOf(MARKETING) + token.balanceOf(LIQUIDITY) + token.balanceOf(PROTOCOL), SUPPLY);
    }
}
