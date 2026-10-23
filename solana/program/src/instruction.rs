//! 指令的线格式与解析。
//!
//! 一个 tag 字节 + 定长字段，没有框架的序列化。**改这里就是改协议** —— tag 的
//! 含义一旦上线就不能复用，所以新增只能是新的 tag。

use solana_program::{program_error::ProgramError, pubkey::Pubkey};

use crate::state::LABEL_LEN;

/// 指令。
#[derive(Debug, PartialEq, Eq)]
pub enum LockInstruction {
    /// 建一把锁并把代币转进锁的金库。
    ///
    /// `id` 是**客户端选的**（它得先读计数器才知道下一个是几）—— 所以程序里要
    /// 验它：`id == config.count`，且 `lock` 这个 PDA 确实是 `["lock", id]` 推出来的。
    /// 客户端选、程序验，比"程序自己数"少一次账户写入，也少一个能对不上的地方。
    CreateLock {
        id: u64,
        amount: u64,
        unlock_date: i64,
        revocable: bool,
        label: [u8; LABEL_LEN],
    },
    /// 到期后把锁里的币领走（任何人可以代付 gas 提交，币只进受益人）。
    Claim,
    /// 受益人把领取权转给别人。
    TransferOwnership { new_beneficiary: Pubkey },
    /// 受益人永久放弃领取（对标 EVM 那边的 renounce）。
    Renounce,
    /// 创建者撤锁（只有创建时声明 `revocable` 的锁可以）。
    Revoke,
}

impl LockInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
        match tag {
            0 => {
                // [0][id u64][amount u64][unlock_date i64][revocable u8][label 64B]
                if rest.len() != 8 + 8 + 8 + 1 + LABEL_LEN {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let mut label = [0u8; LABEL_LEN];
                label.copy_from_slice(&rest[25..25 + LABEL_LEN]);
                Ok(Self::CreateLock {
                    id: u64::from_le_bytes(rest[0..8].try_into().unwrap()),
                    amount: u64::from_le_bytes(rest[8..16].try_into().unwrap()),
                    unlock_date: i64::from_le_bytes(rest[16..24].try_into().unwrap()),
                    revocable: rest[24] == 1,
                    label,
                })
            }
            1 => {
                if !rest.is_empty() {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(Self::Claim)
            }
            2 => {
                if rest.len() != 32 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(Self::TransferOwnership {
                    new_beneficiary: Pubkey::new_from_array(rest[0..32].try_into().unwrap()),
                })
            }
            3 => {
                if !rest.is_empty() {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(Self::Renounce)
            }
            4 => {
                if !rest.is_empty() {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(Self::Revoke)
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

/// 把 `CreateLock` 的参数编回去 —— 客户端（脚本和页面）用的就是这一段，
/// 所以它和上面的解析必须**对称**，单元测试钉住。
pub fn encode_create_lock(
    id: u64,
    amount: u64,
    unlock_date: i64,
    revocable: bool,
    label: &str,
) -> Vec<u8> {
    let mut data = Vec::with_capacity(1 + 25 + LABEL_LEN);
    data.push(0u8);
    data.extend_from_slice(&id.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&unlock_date.to_le_bytes());
    data.push(revocable as u8);
    let mut label_bytes = [0u8; LABEL_LEN];
    let raw = label.as_bytes();
    let n = raw.len().min(LABEL_LEN);
    label_bytes[..n].copy_from_slice(&raw[..n]);
    data.extend_from_slice(&label_bytes);
    data
}

pub fn encode_tag(tag: u8) -> Vec<u8> {
    vec![tag]
}

pub fn encode_transfer_ownership(new_beneficiary: &Pubkey) -> Vec<u8> {
    let mut data = vec![2u8];
    data.extend_from_slice(new_beneficiary.as_ref());
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_lock_round_trips() {
        let data = encode_create_lock(9, 12345, 1_800_000_000, true, "Team");
        match LockInstruction::unpack(&data).unwrap() {
            LockInstruction::CreateLock { id, amount, unlock_date, revocable, label } => {
                assert_eq!(id, 9);
                assert_eq!(amount, 12345);
                assert_eq!(unlock_date, 1_800_000_000);
                assert!(revocable);
                assert_eq!(&label[..4], b"Team");
                assert_eq!(label[4], 0, "标签后面必须是补零，不是垃圾桶里的字节");
            }
            other => panic!("解错了：{other:?}"),
        }
    }

    #[test]
    fn a_label_longer_than_sixty_four_is_truncated_not_rejected() {
        let long = "x".repeat(200);
        let data = encode_create_lock(1, 1, 1, false, &long);
        match LockInstruction::unpack(&data).unwrap() {
            LockInstruction::CreateLock { label, .. } => assert_eq!(label, [b'x'; LABEL_LEN]),
            _ => unreachable!(),
        }
    }

    #[test]
    fn unknown_tag_is_rejected() {
        assert!(LockInstruction::unpack(&[9]).is_err());
    }

    #[test]
    fn empty_data_is_rejected() {
        assert!(LockInstruction::unpack(&[]).is_err());
    }

    #[test]
    fn claim_must_not_carry_payload() {
        assert!(LockInstruction::unpack(&[1]).is_ok());
        assert!(LockInstruction::unpack(&[1, 0]).is_err());
    }

    #[test]
    fn transfer_ownership_round_trips() {
        let who = Pubkey::new_from_array([5u8; 32]);
        match LockInstruction::unpack(&encode_transfer_ownership(&who)).unwrap() {
            LockInstruction::TransferOwnership { new_beneficiary } => assert_eq!(new_beneficiary, who),
            _ => unreachable!(),
        }
    }
}
