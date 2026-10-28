//! Metaplex Token Metadata — the `CreateMetadataAccountV3` CPI.
//!
//! The curve mints the whole supply and renounces the mint authority inside
//! `Create`. That order is deliberate: no later instruction can mint. But it
//! also means metadata must be written **before** the renounce — after it, the
//! curve PDA is no longer the mint authority and Metaplex will refuse. A token
//! launched without this CPI would be permanently nameless on every indexer.
//!
//! Layout of the instruction data (Borsh):
//!
//! ```text
//!  0      discriminator u8 = 33 (CreateMetadataAccountV3)
//!  1..    name    String (u32 LE length + bytes)
//!         symbol  String
//!         uri     String
//!         seller_fee_basis_points u16 LE = 0
//!         creators            Option = None (1 byte 0)
//!         collection          Option = None
//!         uses                Option = None
//!         is_mutable          bool = false
//!         collection_details  Option = None
//! ```
//!
//! Accounts:
//!
//! ```text
//!  0 metadata (writable) — PDA of Metaplex, ["metadata", metaplex, mint]
//!  1 mint (readonly)
//!  2 mint authority (signer) — the curve PDA
//!  3 payer (signer, writable) — the creator
//!  4 update authority (readonly) — the curve PDA, so no one can rewrite it
//!  5 system program
//!  6 rent sysvar
//! ```

use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
};

pub const METAPLEX_PROGRAM_ID: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
pub const CREATE_METADATA_V3_DISCRIMINATOR: u8 = 33;
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_URI_LEN: usize = 200;

/// `["metadata", metaplex, mint]` under the Metaplex program.
pub fn metadata_pda(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"metadata",
            METAPLEX_PROGRAM_ID.as_ref(),
            mint.as_ref(),
        ],
        &METAPLEX_PROGRAM_ID,
    )
}

fn push_string(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(&(value.len() as u32).to_le_bytes());
    out.extend_from_slice(value.as_bytes());
}

/// The exact bytes `CreateMetadataAccountV3` expects. Pinned by unit tests.
pub fn create_metadata_v3_data(name: &str, symbol: &str, uri: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        1 + 4 + name.len() + 4 + symbol.len() + 4 + uri.len() + 2 + 5,
    );
    out.push(CREATE_METADATA_V3_DISCRIMINATOR);
    push_string(&mut out, name);
    push_string(&mut out, symbol);
    push_string(&mut out, uri);
    out.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
    out.push(0); // creators: None
    out.push(0); // collection: None
    out.push(0); // uses: None
    out.push(0); // is_mutable: false
    out.push(0); // collection_details: None
    out
}

#[allow(clippy::too_many_arguments)]
pub fn create_metadata_v3_instruction(
    metadata: Pubkey,
    mint: Pubkey,
    mint_authority: Pubkey,
    payer: Pubkey,
    update_authority: Pubkey,
    system_program: Pubkey,
    rent: Pubkey,
    name: &str,
    symbol: &str,
    uri: &str,
) -> Instruction {
    Instruction {
        program_id: METAPLEX_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(metadata, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(mint_authority, true),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(update_authority, false),
            AccountMeta::new_readonly(system_program, false),
            AccountMeta::new_readonly(rent, false),
        ],
        data: create_metadata_v3_data(name, symbol, uri),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    #[test]
    fn metadata_pda_matches_the_js_sdk_vector() {
        // mint [3u8;32] → 7AD2z3WLVQpLdUcyvwSsdXLeptJsQPyxrWDJNmi3cC7S (bump 255)
        let mint = key(3);
        let (pda, bump) = metadata_pda(&mint);
        assert_eq!(pda.to_string(), "7AD2z3WLVQpLdUcyvwSsdXLeptJsQPyxrWDJNmi3cC7S");
        assert_eq!(bump, 255);
    }

    #[test]
    fn data_starts_with_the_v3_discriminator_and_borsh_strings() {
        let data = create_metadata_v3_data("OAKEN", "OAK", "https://oaken.one/m/1.json");
        assert_eq!(data[0], 33);
        assert_eq!(&data[1..5], &5u32.to_le_bytes());
        assert_eq!(&data[5..10], b"OAKEN");
        assert_eq!(&data[10..14], &3u32.to_le_bytes());
        assert_eq!(&data[14..17], b"OAK");
        assert_eq!(&data[17..21], &26u32.to_le_bytes());
        assert_eq!(&data[21..47], b"https://oaken.one/m/1.json");
        // seller fee, three None options, is_mutable=false, collection_details=None
        assert_eq!(&data[47..49], &0u16.to_le_bytes());
        assert_eq!(&data[49..], &[0, 0, 0, 0, 0]);
        assert_eq!(data.len(), 54);
    }

    #[test]
    fn the_instruction_marks_the_two_signers_and_the_metadata_as_writable() {
        let ix = create_metadata_v3_instruction(
            key(1), key(2), key(3), key(4), key(5), key(6), key(7), "n", "s", "u",
        );
        assert_eq!(ix.program_id, METAPLEX_PROGRAM_ID);
        assert_eq!(ix.accounts.len(), 7);
        assert!(ix.accounts[0].is_writable);
        assert!(!ix.accounts[0].is_signer);
        assert!(ix.accounts[2].is_signer);
        assert!(ix.accounts[3].is_signer && ix.accounts[3].is_writable);
        assert_eq!(ix.data[0], 33);
    }
}
