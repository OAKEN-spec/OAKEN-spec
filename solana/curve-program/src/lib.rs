//! # OAKEN Curve — Solana
//!
//! The pump.fun-shaped launch: a fixed 1B supply minted to one bonding curve,
//! no creator allocation, buys and sells on a constant-product curve with a
//! 30 SOL virtual reserve, and a graduation vault that the program can pay into
//! but never out of.
//!
//! The constants and the curve are from pump.fun's on-chain `Global` account
//! (2026-10-25); see `math.rs`. Like the lock program, this crate depends on
//! `solana-program` only and writes the SPL/System instruction bytes by hand.
//!
//! **Two graduation paths, and only two:**
//!
//! * `Graduate` moves the remaining tokens and SOL into a PDA vault with no
//!   withdraw instruction anywhere in this program.
//! * `GraduatePumpSwap` creates a permissionless PumpSwap pool with a data-less
//!   `["pump", mint]` authority as its creator, deposits the whole pool
//!   allocation and the raised SOL, and leaves the LP tokens in that
//!   authority's Token-2022 ATA. The same authority owns the curve's token
//!   accounts, so PumpSwap's token transfers authorize correctly. No
//!   instruction moves the LP out, so the pool's liquidity is locked forever.
//!
//! Neither path can run twice: both set `graduated`.
//!
//! `CreateWithMetadata` is the launch path that gives the token a name: it
//! writes Metaplex metadata through a CPI **before** renouncing the mint
//! authority, because after the renounce the curve PDA can no longer sign for
//! Metaplex. The older `Create` stays for clients that want the raw curve.

pub mod instruction;
pub mod math;
pub mod metaplex;
pub mod processor;
pub mod pump;
pub mod spl;
pub mod state;

use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

solana_program::declare_id!("BvTeztC4ENG8x2TW19AkiJ9EnC9JNresmA1pE6MBWpRi");

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    processor::process(program_id, accounts, data)
}
