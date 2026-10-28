//! Hand-written System / SPL Token / ATA instruction bytes.
//!
//! Same reason as the lock program: the deployed program depends on
//! `solana-program` only, so a reader does not have to follow an import graph
//! to know what is being signed. Each encoder names its byte layout and has a
//! unit test pinning it.

use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
};

pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// `SystemInstruction::CreateAccount` — `[0u32][lamports u64][space u64][owner 32B]`.
pub fn create_account(
    payer: &Pubkey,
    new_account: &Pubkey,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(52);
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: solana_program::system_program::id(),
        accounts: vec![AccountMeta::new(*payer, true), AccountMeta::new(*new_account, true)],
        data,
    }
}

/// `SystemInstruction::Transfer` — `[2u32][lamports u64]`.
pub fn transfer_lamports(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    let mut data = Vec::with_capacity(12);
    data.extend_from_slice(&2u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: solana_program::system_program::id(),
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)],
        data,
    }
}

/// `TokenInstruction::InitializeMint` — `[0u8][decimals u8][mint_authority 32B][freeze option]`.
pub fn initialize_mint(mint: &Pubkey, decimals: u8, mint_authority: &Pubkey) -> Instruction {
    let mut data = Vec::with_capacity(67);
    data.push(0u8);
    data.push(decimals);
    data.extend_from_slice(mint_authority.as_ref());
    data.push(0u8); // no freeze authority
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new_readonly(solana_program::sysvar::rent::id(), false),
        ],
        data,
    }
}

/// `TokenInstruction::MintTo` — `[7u8][amount u64]`.
pub fn mint_to(mint: &Pubkey, to: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(7u8);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// `TokenInstruction::SetAuthority(MintTokens, None)` — `[6u8][0u8][0u8]`.
pub fn renounce_mint_authority(mint: &Pubkey, authority: &Pubkey) -> Instruction {
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data: vec![6u8, 0u8, 0u8],
    }
}

/// `TokenInstruction::TransferChecked` — `[12u8][amount u64][decimals u8]`.
pub fn transfer_checked(
    source: &Pubkey,
    mint: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.push(12u8);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*source, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// `AssociatedTokenAccountInstruction::CreateIdempotent` — `[1u8]`, six accounts.
/// `token_program` is the mint's owner: SPL Token for normal accounts, Token-2022
/// for the PumpSwap LP account.
pub fn create_ata_idempotent_for(
    payer: &Pubkey,
    ata: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*ata, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(solana_program::system_program::id(), false),
            AccountMeta::new_readonly(*token_program, false),
        ],
        data: vec![1u8],
    }
}

pub fn create_ata_idempotent(payer: &Pubkey, ata: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Instruction {
    create_ata_idempotent_for(payer, ata, owner, mint, &TOKEN_PROGRAM_ID)
}

pub fn ata_address_for(wallet: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
}

pub fn ata_address(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    ata_address_for(wallet, mint, &TOKEN_PROGRAM_ID)
}

/// `TokenInstruction::SyncNative` — `[17u8]`, one writable token account.
/// Sets a wrapped-SOL account's token amount from its lamports.
pub fn sync_native(account: &Pubkey) -> Instruction {
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*account, false)],
        data: vec![17u8],
    }
}

/// `TokenInstruction::CloseAccount` — `[9u8]`, account/destination/owner.
/// Closing a wrapped-SOL account returns its rent and any remaining lamports to
/// the destination; the owner must sign.
pub fn close_account(account: &Pubkey, destination: &Pubkey, owner: &Pubkey) -> Instruction {
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*owner, true),
        ],
        data: vec![9u8],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_mint_encodes_zero_tag_decimals_and_authority() {
        let mint = Pubkey::new_from_array([1u8; 32]);
        let auth = Pubkey::new_from_array([2u8; 32]);
        let ix = initialize_mint(&mint, 6, &auth);
        assert_eq!(ix.data[0], 0);
        assert_eq!(ix.data[1], 6);
        assert_eq!(&ix.data[2..34], auth.as_ref());
        assert_eq!(ix.data[34], 0);
        assert_eq!(ix.accounts.len(), 2);
    }

    #[test]
    fn mint_to_and_renounce_encode_the_expected_tags() {
        let p = Pubkey::new_from_array([3u8; 32]);
        let ix = mint_to(&p, &p, &p, 0x0102_0304_0506_0708);
        assert_eq!(ix.data, vec![7, 8, 7, 6, 5, 4, 3, 2, 1]);
        let ix = renounce_mint_authority(&p, &p);
        assert_eq!(ix.data, vec![6, 0, 0]);
    }

    #[test]
    fn transfer_encodes_tag_two_and_lamports() {
        let p = Pubkey::new_from_array([4u8; 32]);
        let ix = transfer_lamports(&p, &p, 0x0102_0304_0506_0708);
        assert_eq!(ix.program_id, solana_program::system_program::id());
        assert_eq!(ix.data, vec![2, 0, 0, 0, 8, 7, 6, 5, 4, 3, 2, 1]);
    }

    #[test]
    fn transfer_checked_and_ata_match_the_lock_program() {
        let p = Pubkey::new_from_array([5u8; 32]);
        let ix = transfer_checked(&p, &p, &p, &p, 42, 6);
        assert_eq!(ix.data, vec![12, 42, 0, 0, 0, 0, 0, 0, 0, 6]);
        assert_eq!(ix.accounts.len(), 4);
        assert!(ix.accounts[3].is_signer);
        let ix = create_ata_idempotent(&p, &p, &p, &p);
        assert_eq!(ix.data, vec![1]);
        assert_eq!(ix.accounts.len(), 6);
    }

    #[test]
    fn sync_native_and_close_account_use_tags_17_and_9() {
        let p = Pubkey::new_from_array([6u8; 32]);
        assert_eq!(sync_native(&p).data, vec![17]);
        let ix = close_account(&p, &p, &p);
        assert_eq!(ix.data, vec![9]);
        assert_eq!(ix.accounts.len(), 3);
        assert!(ix.accounts[2].is_signer);
    }
}
