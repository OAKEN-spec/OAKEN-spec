//! Instruction wire format: one tag byte + fixed little-endian fields.
//!
//! Changing a tag's meaning is a protocol change; new behaviour gets a new tag.

use solana_program::program_error::ProgramError;

use crate::metaplex::{MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CurveInstruction {
    /// Create the mint, the curve account, the curve ATA and the fixed supply.
    /// `creator_fee_bps` is capped at 300 by the processor.
    Create { creator_fee_bps: u16 },
    /// Create the same curve, but write Metaplex metadata before renouncing the
    /// mint authority. The metadata name/symbol/uri are part of this program's
    /// wire format (u16 length prefixes), not a second instruction.
    CreateWithMetadata {
        creator_fee_bps: u16,
        name: String,
        symbol: String,
        uri: String,
    },
    /// Buy tokens with lamports. `min_tokens_out` is the slippage floor.
    Buy { amount_in: u64, min_tokens_out: u64 },
    /// Sell tokens for lamports. `min_sol_out` is the slippage floor.
    Sell { amount_in: u64, min_sol_out: u64 },
    /// Move the remaining tokens and SOL into the graduation vault.
    Graduate,
    /// Graduate into a permissionless PumpSwap pool instead of the vault.
    /// `index` is the pool index (0 for the first pool under this curve).
    GraduatePumpSwap { index: u16 },
}

fn take_u16(data: &[u8], at: &mut usize) -> Result<u16, ProgramError> {
    let end = at.checked_add(2).ok_or(ProgramError::InvalidInstructionData)?;
    if end > data.len() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let value = u16::from_le_bytes([data[*at], data[*at + 1]]);
    *at = end;
    Ok(value)
}

fn take_string(data: &[u8], at: &mut usize, max: usize) -> Result<String, ProgramError> {
    let len = take_u16(data, at)? as usize;
    if len == 0 || len > max {
        return Err(ProgramError::InvalidInstructionData);
    }
    let end = at.checked_add(len).ok_or(ProgramError::InvalidInstructionData)?;
    if end > data.len() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let value = std::str::from_utf8(&data[*at..end])
        .map_err(|_| ProgramError::InvalidInstructionData)?
        .to_string();
    *at = end;
    Ok(value)
}

impl CurveInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
        match tag {
            0 => {
                if rest.len() != 2 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(Self::Create {
                    creator_fee_bps: u16::from_le_bytes(rest[0..2].try_into().unwrap()),
                })
            }
            5 => {
                let mut at = 0usize;
                let creator_fee_bps = take_u16(rest, &mut at)?;
                let name = take_string(rest, &mut at, MAX_NAME_LEN)?;
                let symbol = take_string(rest, &mut at, MAX_SYMBOL_LEN)?;
                let uri = take_string(rest, &mut at, MAX_URI_LEN)?;
                if at != rest.len() {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(Self::CreateWithMetadata {
                    creator_fee_bps,
                    name,
                    symbol,
                    uri,
                })
            }
            1 => {
                if rest.len() != 16 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(Self::Buy {
                    amount_in: u64::from_le_bytes(rest[0..8].try_into().unwrap()),
                    min_tokens_out: u64::from_le_bytes(rest[8..16].try_into().unwrap()),
                })
            }
            2 => {
                if rest.len() != 16 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(Self::Sell {
                    amount_in: u64::from_le_bytes(rest[0..8].try_into().unwrap()),
                    min_sol_out: u64::from_le_bytes(rest[8..16].try_into().unwrap()),
                })
            }
            3 => {
                if !rest.is_empty() {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(Self::Graduate)
            }
            4 => {
                if rest.len() != 2 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(Self::GraduatePumpSwap {
                    index: u16::from_le_bytes(rest[0..2].try_into().unwrap()),
                })
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }

    pub fn pack(&self) -> Vec<u8> {
        match self {
            Self::Create { creator_fee_bps } => {
                let mut out = vec![0u8];
                out.extend_from_slice(&creator_fee_bps.to_le_bytes());
                out
            }
            Self::CreateWithMetadata {
                creator_fee_bps,
                name,
                symbol,
                uri,
            } => {
                let mut out = vec![5u8];
                out.extend_from_slice(&creator_fee_bps.to_le_bytes());
                for value in [name, symbol, uri] {
                    out.extend_from_slice(&(value.len() as u16).to_le_bytes());
                    out.extend_from_slice(value.as_bytes());
                }
                out
            }
            Self::Buy { amount_in, min_tokens_out } => {
                let mut out = vec![1u8];
                out.extend_from_slice(&amount_in.to_le_bytes());
                out.extend_from_slice(&min_tokens_out.to_le_bytes());
                out
            }
            Self::Sell { amount_in, min_sol_out } => {
                let mut out = vec![2u8];
                out.extend_from_slice(&amount_in.to_le_bytes());
                out.extend_from_slice(&min_sol_out.to_le_bytes());
                out
            }
            Self::Graduate => vec![3u8],
            Self::GraduatePumpSwap { index } => {
                let mut out = vec![4u8];
                out.extend_from_slice(&index.to_le_bytes());
                out
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_instruction_round_trips() {
        for ix in [
            CurveInstruction::Create { creator_fee_bps: 300 },
            CurveInstruction::CreateWithMetadata {
                creator_fee_bps: 5,
                name: "OAKEN".to_string(),
                symbol: "OAK".to_string(),
                uri: "https://oaken.one/m/1.json".to_string(),
            },
            CurveInstruction::Buy { amount_in: 1_000_000_000, min_tokens_out: 42 },
            CurveInstruction::Sell { amount_in: 7, min_sol_out: 9 },
            CurveInstruction::Graduate,
            CurveInstruction::GraduatePumpSwap { index: 7 },
        ] {
            assert_eq!(CurveInstruction::unpack(&ix.pack()).unwrap(), ix);
        }
    }

    #[test]
    fn create_with_metadata_pins_the_wire_layout() {
        let ix = CurveInstruction::CreateWithMetadata {
            creator_fee_bps: 0x0102,
            name: "AB".to_string(),
            symbol: "C".to_string(),
            uri: "D".to_string(),
        };
        assert_eq!(ix.pack(), vec![5, 0x02, 0x01, 2, 0, b'A', b'B', 1, 0, b'C', 1, 0, b'D']);
    }

    #[test]
    fn create_with_metadata_rejects_bad_strings() {
        // empty name
        assert!(CurveInstruction::unpack(&[5, 0, 0, 0, 0, 1, 0, b'C', 1, 0, b'D']).is_err());
        // name over 32 bytes
        let mut long = vec![5, 0, 0, 33, 0];
        long.extend(std::iter::repeat(b'A').take(33));
        long.extend_from_slice(&[1, 0, b'C', 1, 0, b'D']);
        assert!(CurveInstruction::unpack(&long).is_err());
        // invalid UTF-8 in the name
        assert!(CurveInstruction::unpack(&[5, 0, 0, 1, 0, 0xff, 1, 0, b'C', 1, 0, b'D']).is_err());
        // trailing byte after the URI
        assert!(CurveInstruction::unpack(&[5, 0, 0, 1, 0, b'A', 1, 0, b'C', 1, 0, b'D', 9]).is_err());
    }

    #[test]
    fn wrong_lengths_and_unknown_tags_are_rejected() {
        assert!(CurveInstruction::unpack(&[]).is_err());
        assert!(CurveInstruction::unpack(&[0]).is_err());
        assert!(CurveInstruction::unpack(&[0, 1, 2, 3]).is_err());
        assert!(CurveInstruction::unpack(&[1, 0, 0, 0, 0, 0, 0, 0, 0]).is_err());
        assert!(CurveInstruction::unpack(&[3, 0]).is_err());
        assert!(CurveInstruction::unpack(&[9]).is_err());
    }
}
