//! The curve account layout — fixed bytes, no framework serialization.
//!
//! One account per launch, a PDA of `["curve", mint]`. It holds the accounting
//! only: the tokens live in an ATA owned by the data-less `["pump", mint]`
//! authority (`curve_ata`) and the raised SOL lives in a separate data-less
//! `["sol", mint]` account. A data account cannot be the source of a System
//! transfer, which is why neither the tokens nor the SOL live here. After
//! graduation the reserved tokens and SOL move to a vault or a PumpSwap pool;
//! this program has no instruction that moves the LP out again.
//!
//! Layout (232 bytes):
//!
//! ```text
//!  0      version u8
//!  1      bump u8
//!  2..34  creator
//! 34..66  mint
//! 66..98  curve_ata
//! 98..130 protocol_fee_recipient
//! 130..162 creator_fee_recipient
//! 162..170 virtual_sol_reserves u64
//! 170..178 virtual_token_reserves u64
//! 178..186 real_sol_reserves u64
//! 186..194 real_token_reserves u64
//! 194..196 protocol_fee_bps u16
//! 196..198 creator_fee_bps u16
//! 198     graduated u8
//! 199     completed u8
//! 200..232 pool (zero until a PumpSwap graduation; the vault path leaves it zero)
//! ```

use solana_program::{program_error::ProgramError, pubkey::Pubkey};

pub const CURVE_LEN: usize = 232;
pub const LAYOUT_VERSION: u8 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Curve {
    pub version: u8,
    pub bump: u8,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub curve_ata: Pubkey,
    pub protocol_fee_recipient: Pubkey,
    pub creator_fee_recipient: Pubkey,
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub real_token_reserves: u64,
    pub protocol_fee_bps: u16,
    pub creator_fee_bps: u16,
    pub graduated: bool,
    /// True once the sellable allocation is gone; buys and sells stop here and
    /// graduation becomes callable.
    pub completed: bool,
    /// The PumpSwap pool created at graduation, or the default key when the
    /// curve graduated into the vault (or has not graduated yet).
    pub pool: Pubkey,
}

fn read_key(data: &[u8], at: usize) -> Pubkey {
    let mut raw = [0u8; 32];
    raw.copy_from_slice(&data[at..at + 32]);
    Pubkey::new_from_array(raw)
}

fn write_key(data: &mut [u8], at: usize, key: &Pubkey) {
    data[at..at + 32].copy_from_slice(key.as_ref());
}

impl Curve {
    pub fn load(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != CURVE_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self {
            version: data[0],
            bump: data[1],
            creator: read_key(data, 2),
            mint: read_key(data, 34),
            curve_ata: read_key(data, 66),
            protocol_fee_recipient: read_key(data, 98),
            creator_fee_recipient: read_key(data, 130),
            virtual_sol_reserves: u64::from_le_bytes(data[162..170].try_into().unwrap()),
            virtual_token_reserves: u64::from_le_bytes(data[170..178].try_into().unwrap()),
            real_sol_reserves: u64::from_le_bytes(data[178..186].try_into().unwrap()),
            real_token_reserves: u64::from_le_bytes(data[186..194].try_into().unwrap()),
            protocol_fee_bps: u16::from_le_bytes(data[194..196].try_into().unwrap()),
            creator_fee_bps: u16::from_le_bytes(data[196..198].try_into().unwrap()),
            graduated: data[198] == 1,
            completed: data[199] == 1,
            pool: read_key(data, 200),
        })
    }

    pub fn store(&self, data: &mut [u8]) -> Result<(), ProgramError> {
        if data.len() != CURVE_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[0] = self.version;
        data[1] = self.bump;
        write_key(data, 2, &self.creator);
        write_key(data, 34, &self.mint);
        write_key(data, 66, &self.curve_ata);
        write_key(data, 98, &self.protocol_fee_recipient);
        write_key(data, 130, &self.creator_fee_recipient);
        data[162..170].copy_from_slice(&self.virtual_sol_reserves.to_le_bytes());
        data[170..178].copy_from_slice(&self.virtual_token_reserves.to_le_bytes());
        data[178..186].copy_from_slice(&self.real_sol_reserves.to_le_bytes());
        data[186..194].copy_from_slice(&self.real_token_reserves.to_le_bytes());
        data[194..196].copy_from_slice(&self.protocol_fee_bps.to_le_bytes());
        data[196..198].copy_from_slice(&self.creator_fee_bps.to_le_bytes());
        data[198] = self.graduated as u8;
        data[199] = self.completed as u8;
        write_key(data, 200, &self.pool);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    #[test]
    fn round_trips_through_the_fixed_layout() {
        let curve = Curve {
            version: LAYOUT_VERSION,
            bump: 254,
            creator: key(1),
            mint: key(2),
            curve_ata: key(3),
            protocol_fee_recipient: key(4),
            creator_fee_recipient: key(5),
            virtual_sol_reserves: 30_000_000_000,
            virtual_token_reserves: 1_073_000_000_000_000,
            real_sol_reserves: 0,
            real_token_reserves: 793_100_000_000_000,
            protocol_fee_bps: 95,
            creator_fee_bps: 5,
            graduated: false,
            completed: false,
            pool: key(6),
        };
        let mut data = [0u8; CURVE_LEN];
        curve.store(&mut data).unwrap();
        assert_eq!(Curve::load(&data).unwrap(), curve);
    }

    #[test]
    fn rejects_the_wrong_length_instead_of_truncating() {
        assert!(Curve::load(&[0u8; CURVE_LEN - 1]).is_err());
        assert!(Curve::load(&[0u8; CURVE_LEN + 1]).is_err());
        let mut short = [0u8; CURVE_LEN - 1];
        let curve = Curve {
            version: 1, bump: 1, creator: key(1), mint: key(2), curve_ata: key(3),
            protocol_fee_recipient: key(4), creator_fee_recipient: key(5),
            virtual_sol_reserves: 0, virtual_token_reserves: 0, real_sol_reserves: 0,
            real_token_reserves: 0, protocol_fee_bps: 0, creator_fee_bps: 0,
            graduated: false, completed: false, pool: Pubkey::default(),
        };
        assert!(curve.store(&mut short).is_err());
    }

    #[test]
    fn flags_are_single_bytes() {
        let mut data = [0u8; CURVE_LEN];
        data[198] = 1;
        data[199] = 1;
        let curve = Curve::load(&data).unwrap();
        assert!(curve.graduated);
        assert!(curve.completed);
    }

    #[test]
    fn the_pool_slot_is_zero_until_a_pumpswap_graduation() {
        let mut data = [0u8; CURVE_LEN];
        assert_eq!(Curve::load(&data).unwrap().pool, Pubkey::default());
        data[200..232].copy_from_slice(&[7u8; 32]);
        assert_eq!(
            Curve::load(&data).unwrap().pool,
            Pubkey::new_from_array([7u8; 32])
        );
    }
}
