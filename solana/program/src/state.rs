//! 账户布局与（反）序列化 —— 手写字节，不用 borsh。
//!
//! 和 EVM 那边一个道理：读者要能一眼看出"链上那个字节串到底代表了什么"。
//! 布局是固定的、有注释、按字节对齐写死的；改布局 = 改版本号，不是"框架替我记住"。

use solana_program::{program_error::ProgramError, pubkey::Pubkey};

/// 标签（锁的标题）固定 64 字节 —— Solana 的账户是定长的，字符串只能这么放。
pub const LABEL_LEN: usize = 64;

/// `Lock` 账户的总长度。
pub const LOCK_LEN: usize = 240;

/// 计数器账户（`["config"]` PDA）：8 字节，只存"下一把锁的 id"。
pub const CONFIG_LEN: usize = 8;

/// 布局版本。字段增删都要动它 —— 页面上按版本解释字节，不是按"我以为的形状"。
pub const LAYOUT_VERSION: u8 = 1;

/// 一把锁。
///
/// 字段和 EVM 那边的 `LockVault.Lock` 是**一一对应**的（`owner` 在这里叫
/// `beneficiary`，因为 Solana 上"签名的人"和"拿币的人"更常分开）。少掉的只有
/// 阶梯 vesting 那几项：v1 只有"某天一次性解锁"，多档解锁是下一版的事，
/// 而这一版里不做的东西**在代码里也不存在**，不是一个被忽略的分支。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lock {
    pub version: u8,
    /// PDA bump —— 认领时要拿它做 `invoke_signed`。
    pub bump: u8,
    pub id: u64,
    /// 出币的人，也是唯一能 revoke 的人（且只有声明了 revocable 的锁）。
    pub creator: Pubkey,
    /// 到期后收币的人。可以转让给别的地址。
    pub beneficiary: Pubkey,
    /// 被锁的 SPL 代币。
    pub mint: Pubkey,
    /// 持有代币的那个 token account（owner 是这个锁的 PDA）。
    pub vault: Pubkey,
    pub amount: u64,
    pub lock_date: i64,
    pub unlock_date: i64,
    pub claimed: u64,
    /// 创建时声明：creator 能不能在到期前把锁撤了。默认 false ——
    /// "能撤"必须是一项**声明**，不是默认行为，否则每个读到"已锁仓"的人都得去查创建者是谁。
    pub revocable: bool,
    /// 受益人永久放弃领取（对标 EVM 那边的 renounce）。
    pub renounced: bool,
    pub revoked: bool,
    pub label: [u8; LABEL_LEN],
}

impl Lock {
    /// 从账户数据里读出来，长度不对就拒绝（不猜、不截断）。
    pub fn load(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != LOCK_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut label = [0u8; LABEL_LEN];
        label.copy_from_slice(&data[176..176 + LABEL_LEN]);
        Ok(Self {
            version: data[0],
            bump: data[1],
            id: u64::from_le_bytes(data[2..10].try_into().unwrap()),
            creator: Pubkey::new_from_array(data[10..42].try_into().unwrap()),
            beneficiary: Pubkey::new_from_array(data[42..74].try_into().unwrap()),
            mint: Pubkey::new_from_array(data[74..106].try_into().unwrap()),
            vault: Pubkey::new_from_array(data[106..138].try_into().unwrap()),
            amount: u64::from_le_bytes(data[138..146].try_into().unwrap()),
            lock_date: i64::from_le_bytes(data[146..154].try_into().unwrap()),
            unlock_date: i64::from_le_bytes(data[154..162].try_into().unwrap()),
            claimed: u64::from_le_bytes(data[162..170].try_into().unwrap()),
            revocable: data[170] == 1,
            renounced: data[171] == 1,
            revoked: data[172] == 1,
            label,
        })
    }

    /// 写回账户数据。写到一半失败是不可能的（长度先验过），但**顺序**是有意的：
    /// 金额和 claimed 先落，标志位最后 —— 任何一次中断都不会留下"币动了、账没记"的状态。
    pub fn store(&self, data: &mut [u8]) -> Result<(), ProgramError> {
        if data.len() != LOCK_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[0] = self.version;
        data[1] = self.bump;
        data[2..10].copy_from_slice(&self.id.to_le_bytes());
        data[10..42].copy_from_slice(self.creator.as_ref());
        data[42..74].copy_from_slice(self.beneficiary.as_ref());
        data[74..106].copy_from_slice(self.mint.as_ref());
        data[106..138].copy_from_slice(self.vault.as_ref());
        data[138..146].copy_from_slice(&self.amount.to_le_bytes());
        data[146..154].copy_from_slice(&self.lock_date.to_le_bytes());
        data[154..162].copy_from_slice(&self.unlock_date.to_le_bytes());
        data[162..170].copy_from_slice(&self.claimed.to_le_bytes());
        data[170] = self.revocable as u8;
        data[171] = self.renounced as u8;
        data[172] = self.revoked as u8;
        data[176..176 + LABEL_LEN].copy_from_slice(&self.label);
        Ok(())
    }

    /// 还没到点就一分都领不出来；到点后一次性全给（v1 没有阶梯）。
    pub fn is_due(&self, now: i64) -> bool {
        now >= self.unlock_date
    }

    /// 现在能领多少。
    pub fn claimable(&self, now: i64) -> u64 {
        if self.renounced || self.revoked || !self.is_due(now) {
            return 0;
        }
        self.amount.saturating_sub(self.claimed)
    }

    /// 标签 → 字符串（去掉尾部的零字节）。
    pub fn label_str(&self) -> String {
        let end = self.label.iter().position(|&b| b == 0).unwrap_or(LABEL_LEN);
        String::from_utf8_lossy(&self.label[..end]).to_string()
    }
}

/// 计数器：`["config"]` PDA。存在的理由只有一个 —— 让 id 是 1、2、3，
/// 而不是 32 字节的地址（站上的记录页 URL 因此和 EVM 那边长得一样）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Config {
    pub count: u64,
}

impl Config {
    pub fn load(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != CONFIG_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { count: u64::from_le_bytes(data[0..8].try_into().unwrap()) })
    }

    pub fn store(&self, data: &mut [u8]) -> Result<(), ProgramError> {
        if data.len() != CONFIG_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[0..8].copy_from_slice(&self.count.to_le_bytes());
        Ok(())
    }
}

/// 把 [u8] 的某一段读成定长数组 —— 帮助函数，省掉每处 `try_into().unwrap()` 的噪声。
pub fn array<const N: usize>(data: &[u8], at: usize) -> [u8; N] {
    let mut out = [0u8; N];
    out.copy_from_slice(&data[at..at + N]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Lock {
        let mut label = [0u8; LABEL_LEN];
        label[..4].copy_from_slice(b"Team");
        Lock {
            version: LAYOUT_VERSION,
            bump: 254,
            id: 7,
            creator: Pubkey::new_from_array([1u8; 32]),
            beneficiary: Pubkey::new_from_array([2u8; 32]),
            mint: Pubkey::new_from_array([3u8; 32]),
            vault: Pubkey::new_from_array([4u8; 32]),
            amount: 1_000_000,
            lock_date: 1_700_000_000,
            unlock_date: 1_800_000_000,
            claimed: 0,
            revocable: false,
            renounced: false,
            revoked: false,
            label,
        }
    }

    #[test]
    fn round_trips_through_the_byte_layout() {
        let lock = sample();
        let mut buf = [0u8; LOCK_LEN];
        lock.store(&mut buf).unwrap();
        assert_eq!(Lock::load(&buf).unwrap(), lock);
    }

    #[test]
    fn refuses_the_wrong_length() {
        assert!(Lock::load(&[0u8; 10]).is_err());
    }

    #[test]
    fn nothing_is_claimable_before_the_date() {
        let lock = sample();
        assert_eq!(lock.claimable(lock.unlock_date - 1), 0);
        assert_eq!(lock.claimable(lock.unlock_date), lock.amount);
    }

    #[test]
    fn a_renounced_or_revoked_lock_pays_nobody() {
        let mut lock = sample();
        lock.renounced = true;
        assert_eq!(lock.claimable(lock.unlock_date + 1), 0);
        lock.renounced = false;
        lock.revoked = true;
        assert_eq!(lock.claimable(lock.unlock_date + 1), 0);
    }

    #[test]
    fn claimed_amount_is_subtracted_not_ignored() {
        let mut lock = sample();
        lock.claimed = 400_000;
        assert_eq!(lock.claimable(lock.unlock_date + 1), 600_000);
    }

    #[test]
    fn label_round_trips_and_stops_at_the_first_zero() {
        let lock = sample();
        assert_eq!(lock.label_str(), "Team");
    }
}
