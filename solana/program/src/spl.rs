//! 三条外部指令的字节，**手写**：System 的 `CreateAccount`、SPL Token 的
//! `TransferChecked`、Associated Token Account 的 `CreateIdempotent`。
//!
//! 为什么不用 `spl-token` / `spl-associated-token-account` 两个 crate：它们各自拖进
//! 一串依赖，而这里真正用到的编码加起来不到三十行 —— 一个 tag 字节加几个小端整数。
//! 和 EVM 那边不用 OpenZeppelin 是同一条理由：这个项目卖的是"读我然后自己判断"，
//! 那就不能让读者顺着 import 图去追信任链。下面每个函数都附了它的字节形状，
//! 和 SPL 的规格逐字节对得上（单元测试钉住）。

use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
};

/// SPL Token 程序（主网/测试网/本地都是这个地址）。
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// Associated Token Account 程序。
pub const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// `SystemProgram::CreateAccount` —— `[0u32][lamports u64][space u64][owner 32B]`。
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
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*new_account, true),
        ],
        data,
    }
}

/// `TokenInstruction::TransferChecked` —— `[12u8][amount u64][decimals u8]`。
///
/// 用 Checked 版本（四个账户，多一个 mint）而不是老三参数那版：它会核对 mint 的
/// 精度，等于顺手挡住"拿错代币的 token account 来领"这类错。
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

/// `AssociatedTokenAccountInstruction::CreateIdempotent` —— `[1u8]`，六个账户。
/// 幂等版：账户已经在就什么都不做（领币时别人可能已经替受益人建好了）。
pub fn create_ata_idempotent(payer: &Pubkey, ata: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*ata, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(solana_program::system_program::id(), false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        data: vec![1u8],
    }
}

/// 某个钱包某个 mint 的 ATA 地址（种子 `[wallet, token_program, mint]`，程序 = ATA 程序）。
pub fn ata_address(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_checked_encodes_tag_amount_and_decimals() {
        let ix = transfer_checked(
            &Pubkey::new_from_array([1u8; 32]),
            &Pubkey::new_from_array([2u8; 32]),
            &Pubkey::new_from_array([3u8; 32]),
            &Pubkey::new_from_array([4u8; 32]),
            0x0102_0304_0506_0708,
            9,
        );
        assert_eq!(ix.program_id, TOKEN_PROGRAM_ID);
        assert_eq!(ix.data, vec![12, 8, 7, 6, 5, 4, 3, 2, 1, 9]);
        assert_eq!(ix.accounts.len(), 4);
        assert!(ix.accounts[3].is_signer, "authority 必须是 signer");
    }

    #[test]
    fn create_account_encodes_the_system_layout() {
        let owner = Pubkey::new_from_array([9u8; 32]);
        let ix = create_account(
            &Pubkey::new_from_array([1u8; 32]),
            &Pubkey::new_from_array([2u8; 32]),
            1_000,
            240,
            &owner,
        );
        assert_eq!(ix.program_id, solana_program::system_program::id());
        assert_eq!(&ix.data[0..4], &[0, 0, 0, 0]);
        assert_eq!(&ix.data[4..12], &1_000u64.to_le_bytes());
        assert_eq!(&ix.data[12..20], &240u64.to_le_bytes());
        assert_eq!(&ix.data[20..52], owner.as_ref());
    }

    #[test]
    fn ata_create_is_the_idempotent_tag_with_six_accounts() {
        let ix = create_ata_idempotent(
            &Pubkey::new_from_array([1u8; 32]),
            &Pubkey::new_from_array([2u8; 32]),
            &Pubkey::new_from_array([3u8; 32]),
            &Pubkey::new_from_array([4u8; 32]),
        );
        assert_eq!(ix.program_id, ATA_PROGRAM_ID);
        assert_eq!(ix.data, vec![1u8]);
        assert_eq!(ix.accounts.len(), 6);
    }

    #[test]
    fn ata_address_is_a_pda_of_the_ata_program_not_the_wallet() {
        let wallet = Pubkey::new_from_array([7u8; 32]);
        let mint = Pubkey::new_from_array([8u8; 32]);
        let ata = ata_address(&wallet, &mint);
        assert_ne!(ata, wallet);
        // 反向验证：同一条种子算出来的必须一样（PDA 是确定的，不是随机的）
        assert_eq!(ata, ata_address(&wallet, &mint));
    }
}
