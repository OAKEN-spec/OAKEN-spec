//! The pump.fun curve, in lamports and 6-decimal token base units.
//!
//! Constants are read from pump.fun's on-chain `Global` account (2026-10-25):
//!
//!   initialVirtualTokenReserves  = 1,073,000,000 tokens
//!   initialVirtualSolReserves    = 30 SOL
//!   initialRealTokenReserves     = 793,100,000 tokens
//!   tokenTotalSupply             = 1,000,000,000 tokens
//!   feeBasisPoints               = 95 (0.95%)
//!   creatorFeeBasisPoints        = 5 (0.05%), max configurable 300 (3%)
//!
//! The virtual token reserve is larger than the supply: the 279.9M difference
//! is what makes the curve finish at ~85 SOL of real reserves while leaving the
//! 206.9M reserved slice in the curve for the pool.

use solana_program::program_error::ProgramError;

pub const TOKEN_DECIMALS: u8 = 6;
pub const ONE_TOKEN: u64 = 1_000_000;
pub const TOTAL_SUPPLY: u64 = 1_000_000_000 * ONE_TOKEN;
pub const INITIAL_VIRTUAL_SOL: u64 = 30_000_000_000; // 30 SOL in lamports
pub const INITIAL_VIRTUAL_TOKEN: u64 = 1_073_000_000 * ONE_TOKEN;
pub const INITIAL_REAL_TOKEN: u64 = 793_100_000 * ONE_TOKEN;
pub const RESERVED_FOR_POOL: u64 = TOTAL_SUPPLY - INITIAL_REAL_TOKEN;
pub const GRADUATION_SOL: u64 = 85_000_000_000; // where the curve empties (approx.)
pub const BPS: u64 = 10_000;
pub const PROTOCOL_FEE_BPS: u64 = 95;
pub const MAX_CREATOR_FEE_BPS: u64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fees {
    pub protocol: u64,
    pub creator: u64,
}

/// Split a quote amount into the protocol and creator fee legs.
pub fn split_fees(amount: u64, creator_fee_bps: u64) -> Result<Fees, ProgramError> {
    if creator_fee_bps > MAX_CREATOR_FEE_BPS {
        return Err(ProgramError::InvalidArgument);
    }
    let protocol = (amount as u128 * PROTOCOL_FEE_BPS as u128 / BPS as u128) as u64;
    let creator = (amount as u128 * creator_fee_bps as u128 / BPS as u128) as u64;
    Ok(Fees { protocol, creator })
}

/// Tokens out for a net quote input (fees already removed).
pub fn quote_buy(sol_net: u64, virtual_sol: u64, virtual_token: u64) -> Option<u64> {
    if sol_net == 0 || virtual_sol == 0 || virtual_token == 0 {
        return None;
    }
    let k = virtual_sol as u128 * virtual_token as u128;
    let new_virtual_sol = virtual_sol as u128 + sol_net as u128;
    let new_virtual_token = k / new_virtual_sol;
    if new_virtual_token >= virtual_token as u128 {
        return None;
    }
    Some((virtual_token as u128 - new_virtual_token) as u64)
}

/// Net quote out for a token input.
pub fn quote_sell(tokens_in: u64, virtual_sol: u64, virtual_token: u64) -> Option<u64> {
    if tokens_in == 0 || virtual_sol == 0 || virtual_token == 0 {
        return None;
    }
    let k = virtual_sol as u128 * virtual_token as u128;
    let new_virtual_token = virtual_token as u128 + tokens_in as u128;
    let new_virtual_sol = k / new_virtual_token;
    if new_virtual_sol >= virtual_sol as u128 {
        return None;
    }
    Some((virtual_sol as u128 - new_virtual_sol) as u64)
}

/// Net quote needed to buy an exact token amount (rounded up), used when a
/// buy would take the last of the sellable allocation.
pub fn quote_buy_in(tokens_out: u64, virtual_sol: u64, virtual_token: u64) -> Option<u64> {
    if tokens_out == 0 || tokens_out >= virtual_token {
        return None;
    }
    let k = virtual_sol as u128 * virtual_token as u128;
    let new_virtual_token = virtual_token as u128 - tokens_out as u128;
    let new_virtual_sol = k / new_virtual_token + 1;
    if new_virtual_sol <= virtual_sol as u128 {
        return None;
    }
    Some((new_virtual_sol - virtual_sol as u128) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_curve_empties_at_about_85_sol_and_793_1m_tokens() {
        // 85 SOL of net buys consumes essentially the whole sellable slice;
        // the last few tokens cost slightly more because of integer rounding,
        // so the constant is an approximate line, not an exact equality.
        let tokens = quote_buy(GRADUATION_SOL, INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKEN).unwrap();
        assert!(tokens <= INITIAL_REAL_TOKEN);
        assert!(INITIAL_REAL_TOKEN - tokens < INITIAL_REAL_TOKEN / 10_000); // < 0.01%
        // Selling that allocation back, from the reserves the buy left,
        // returns the same ~85 SOL (the curve is path-dependent, so this must
        // be measured from the post-buy reserves, not from the launch state).
        let virtual_sol_after = INITIAL_VIRTUAL_SOL + GRADUATION_SOL;
        let virtual_token_after = INITIAL_VIRTUAL_TOKEN - tokens;
        let sol = quote_sell(tokens, virtual_sol_after, virtual_token_after).unwrap();
        assert!((sol as i128 - GRADUATION_SOL as i128).abs() <= 2);
        // The reserved slice is the difference between supply and the sellable.
        assert_eq!(RESERVED_FOR_POOL, 206_900_000 * ONE_TOKEN);
    }

    #[test]
    fn round_trip_buy_in_matches_quote_buy() {
        let net = 1_000_000_000; // 1 SOL
        let tokens = quote_buy(net, INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKEN).unwrap();
        let needed = quote_buy_in(tokens, INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKEN).unwrap();
        assert!(needed >= net);
        assert!(needed - net <= 2);
    }

    #[test]
    fn fees_are_95_and_creator_bps_with_a_3_percent_cap() {
        let f = split_fees(1_000_000_000, 5).unwrap();
        assert_eq!(f.protocol, 9_500_000);
        assert_eq!(f.creator, 500_000);
        assert!(split_fees(1_000_000_000, 301).is_err());
        let f = split_fees(1_000_000_000, 300).unwrap();
        assert_eq!(f.creator, 30_000_000);
    }

    #[test]
    fn zero_and_empty_reserves_are_rejected() {
        assert!(quote_buy(0, INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKEN).is_none());
        assert!(quote_sell(0, INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKEN).is_none());
        assert!(quote_buy(1, 0, INITIAL_VIRTUAL_TOKEN).is_none());
        assert!(quote_sell(1, INITIAL_VIRTUAL_SOL, 0).is_none());
    }
}
