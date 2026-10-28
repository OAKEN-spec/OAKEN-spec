//! PumpSwap (Pump AMM) — the graduation target on Solana.
//!
//! Graduation creates a **permissionless** PumpSwap pool whose creator is the
//! curve PDA itself. Because the program has no instruction that moves the LP
//! tokens, the pool's LP supply stays locked at the curve's ATA forever.
//!
//! `create_pool` is an Anchor instruction:
//!
//! ```text
//! discriminator  8 bytes  e9 92 d1 8e cf 68 40 bc
//! index          u16 LE
//! base_amount_in u64 LE
//! quote_amount_in u64 LE
//! coin_creator   32 bytes (all zero = permissionless pool)
//! is_mayhem_mode 1 byte  (false)
//! OptionBool     1 byte  (false — the deployed program ignores the trailing
//! OptionU64      8 bytes (0)    three fields; the upgraded one reads them)
//! OptionBool     1 byte  (false)
//! ```
//!
//! The 69-byte layout and every address below are pinned by unit tests against
//! the values `@pump-fun/pump-swap-sdk` produces offline (2026-10-25).

use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
};

use crate::spl::{ATA_PROGRAM_ID, TOKEN_PROGRAM_ID};

pub const PUMP_AMM_PROGRAM_ID: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

pub const CREATE_POOL_DISCRIMINATOR: [u8; 8] = [0xe9, 0x92, 0xd1, 0x8e, 0xcf, 0x68, 0x40, 0xbc];
pub const CREATE_POOL_DATA_LEN: usize = 69;

/// `["pool", index u16 LE, creator, base_mint, quote_mint]` under the AMM program.
pub fn pool_pda(
    index: u16,
    creator: &Pubkey,
    base_mint: &Pubkey,
    quote_mint: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"pool",
            &index.to_le_bytes(),
            creator.as_ref(),
            base_mint.as_ref(),
            quote_mint.as_ref(),
        ],
        &PUMP_AMM_PROGRAM_ID,
    )
}

/// `["pool_lp_mint", pool]` under the AMM program.
pub fn lp_mint_pda(pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"pool_lp_mint", pool.as_ref()], &PUMP_AMM_PROGRAM_ID)
}

/// `["sol", mint]` under **this** program: the data-less, system-owned account
/// that holds the curve's raised SOL. A System transfer cannot use a data
/// account as its source, so the SOL must not live in the curve account.
pub fn sol_vault_pda(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"sol", mint.as_ref()], &crate::id())
}

/// `["pump", mint]` under **this** program: the PumpSwap pool creator and LP
/// owner. It is data-less, so it can pay for PumpSwap's accounts and its
/// unused rent can be refunded with a plain System transfer.
pub fn pump_authority_pda(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"pump", mint.as_ref()], &crate::id())
}

/// `["global_config"]` under the AMM program.
pub fn global_config_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"global_config"], &PUMP_AMM_PROGRAM_ID)
}

/// `["__event_authority"]` under the AMM program.
pub fn event_authority_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"__event_authority"], &PUMP_AMM_PROGRAM_ID)
}

/// `create_pool` instruction data, exactly 69 bytes.
pub fn create_pool_data(index: u16, base_amount_in: u64, quote_amount_in: u64) -> Vec<u8> {
    let mut data = Vec::with_capacity(CREATE_POOL_DATA_LEN);
    data.extend_from_slice(&CREATE_POOL_DISCRIMINATOR);
    data.extend_from_slice(&index.to_le_bytes());
    data.extend_from_slice(&base_amount_in.to_le_bytes());
    data.extend_from_slice(&quote_amount_in.to_le_bytes());
    data.extend_from_slice(&[0u8; 32]); // coin_creator: default = permissionless
    data.push(0); // is_mayhem_mode
    data.push(0); // is_cashback_coin: OptionBool(false)
    data.extend_from_slice(&[0u8; 8]); // creator_fee_bps: OptionU64(0)
    data.push(0); // can_edit_creator_fee: OptionBool(false)
    debug_assert_eq!(data.len(), CREATE_POOL_DATA_LEN);
    data
}

/// The AMM `create_pool` CPI. Account order is the IDL's, not ours.
#[allow(clippy::too_many_arguments)]
pub fn create_pool_instruction(
    pool: &Pubkey,
    global_config: &Pubkey,
    creator: &Pubkey,
    base_mint: &Pubkey,
    quote_mint: &Pubkey,
    lp_mint: &Pubkey,
    user_base_token_account: &Pubkey,
    user_quote_token_account: &Pubkey,
    user_pool_token_account: &Pubkey,
    pool_base_token_account: &Pubkey,
    pool_quote_token_account: &Pubkey,
    event_authority: &Pubkey,
    index: u16,
    base_amount_in: u64,
    quote_amount_in: u64,
) -> Instruction {
    Instruction {
        program_id: PUMP_AMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*pool, false),
            AccountMeta::new_readonly(*global_config, false),
            AccountMeta::new(*creator, true),
            AccountMeta::new_readonly(*base_mint, false),
            AccountMeta::new_readonly(*quote_mint, false),
            AccountMeta::new(*lp_mint, false),
            AccountMeta::new(*user_base_token_account, false),
            AccountMeta::new(*user_quote_token_account, false),
            AccountMeta::new(*user_pool_token_account, false),
            AccountMeta::new(*pool_base_token_account, false),
            AccountMeta::new(*pool_quote_token_account, false),
            AccountMeta::new_readonly(solana_program::system_program::id(), false),
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(ATA_PROGRAM_ID, false),
            AccountMeta::new_readonly(*event_authority, false),
            AccountMeta::new_readonly(PUMP_AMM_PROGRAM_ID, false),
        ],
        data: create_pool_data(index, base_amount_in, quote_amount_in),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_pool_data_matches_the_sdk_byte_for_byte() {
        let data = create_pool_data(0, 1000, 2000);
        assert_eq!(data.len(), 69);
        assert_eq!(
            data,
            vec![
                0xe9, 0x92, 0xd1, 0x8e, 0xcf, 0x68, 0x40, 0xbc, // discriminator
                0x00, 0x00, // index 0
                0xe8, 0x03, 0, 0, 0, 0, 0, 0, // base 1000
                0xd0, 0x07, 0, 0, 0, 0, 0, 0, // quote 2000
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // coin_creator
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                0x00, // is_mayhem_mode
                0x00, // OptionBool false
                0, 0, 0, 0, 0, 0, 0, 0, // OptionU64 0
                0x00, // OptionBool false
            ]
        );
    }

    #[test]
    fn pool_addresses_match_the_sdk_for_a_known_mint() {
        // mint = [3u8; 32]; the pool creator is our data-less pump authority.
        let mint = Pubkey::new_from_array([3u8; 32]);
        let (sol_vault, _) = sol_vault_pda(&mint);
        let (pump_authority, _) = pump_authority_pda(&mint);
        assert_eq!(sol_vault.to_string(), "JN5XMnTaggzvoH1vkuzaEb9aJmJMdALDGxdLkiDn4zW");
        assert_eq!(pump_authority.to_string(), "JBXzzNFmNtAvq2UN4qaJWbJUxjxmtMMG4wpUH2LoHQh5");
        assert_eq!(global_config_pda().0.to_string(), "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
        assert_eq!(event_authority_pda().0.to_string(), "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");
        let (pool, _) = pool_pda(0, &pump_authority, &mint, &WSOL_MINT);
        assert_eq!(pool.to_string(), "5s7zt9Vzpui7hjdN8cwaWbpEAbBVx9S8KF3Ndd2V4HWf");
        assert_eq!(lp_mint_pda(&pool).0.to_string(), "9PrUSVskT6jJgc9XxhVfHs5zBVUFnubUucAEujtw3u4f");
    }

    #[test]
    fn create_pool_account_order_is_the_idl_order() {
        let ix = create_pool_instruction(
            &Pubkey::new_from_array([1; 32]),
            &global_config_pda().0,
            &Pubkey::new_from_array([2; 32]),
            &Pubkey::new_from_array([3; 32]),
            &WSOL_MINT,
            &Pubkey::new_from_array([5; 32]),
            &Pubkey::new_from_array([6; 32]),
            &Pubkey::new_from_array([7; 32]),
            &Pubkey::new_from_array([8; 32]),
            &Pubkey::new_from_array([9; 32]),
            &Pubkey::new_from_array([10; 32]),
            &event_authority_pda().0,
            0,
            1000,
            2000,
        );
        assert_eq!(ix.program_id, PUMP_AMM_PROGRAM_ID);
        assert_eq!(ix.accounts.len(), 18);
        assert!(ix.accounts[2].is_signer); // creator = the curve PDA
        assert!(ix.accounts[2].is_writable);
        assert_eq!(ix.accounts[12].pubkey, TOKEN_2022_PROGRAM_ID);
        assert_eq!(ix.accounts[13].pubkey, TOKEN_PROGRAM_ID);
        assert_eq!(ix.accounts[14].pubkey, TOKEN_PROGRAM_ID);
        assert_eq!(ix.accounts[17].pubkey, PUMP_AMM_PROGRAM_ID);
    }
}
