//! # Oaken Lock — Solana
//!
//! EVM 那边那个 `LockVault` 的 Solana 版：把 SPL 代币锁进一个**只有到期才动得了**的
//! 金库，没有 owner、没有暂停、没有升级开关。同一个产品，另一条链上的一等公民
//! —— 不是"桥过去的包装"，因为 Solana 上没有 ERC-20，也没有 EVM 的账户模型。
//!
//! ## 和 EVM 版对齐的地方
//!
//! | | EVM | 这里 |
//! |---|---|---|
//! | 币放哪 | `LockVault` 合约自己持有 | 锁 PDA 名下的 ATA（`vault`） |
//! | 谁能领 | 到期后任何人可代提交，币只进受益人 | 一样：任何人都能提交，币只进受益人的 ATA |
//! | 能不能改 | 没有 owner、没有升级 | 程序部署后**升级权要置空**（见 README） |
//! | 撤锁 | 创建时声明 `revocable` 才可撤，且只在到期前 | 一样 |
//! | 放弃 | `renounceLockOwnership` | `Renounce` |
//! | 转让 | `transferLockOwnership` | `TransferOwnership` |
//!
//! ## 刻意不一样的地方
//!
//! **v1 只做"某天一次性解锁"**，没有 EVM 那边的阶梯 vesting。阶梯是下一版的事：
//! 一个字段加上去容易，但每个新增字段都要在状态布局、指令、页面三处对齐，
//! 而"这版没有"必须意味着"代码里也没有"，不是一个被跳过分支。
//!
//! ## 为什么不用 Anchor
//!
//! Anchor 会带进一整套宏和依赖，产出一个"生成出来的"程序 —— 而这里卖的是
//! "读我然后自己判断"。整个程序不到五百行、只依赖 `solana-program`，
//! SPL Token / ATA / System 的指令字节是手写的（`src/spl.rs`，附规格注释和单测）。
//!
//! ## 程序地址
//!
//! 见下面的 `declare_id!`。部署用 `solana/program-keypair.json`，
//! **那个文件就是程序的身份**（将来升级也用它），不要丢。

pub mod instruction;
pub mod processor;
pub mod spl;
pub mod state;

use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

solana_program::declare_id!("Co9ZnAVxX2siGThhjTpPgXPHYrCev1nrXFyGB1VcZcQW");

/// 入口。真正的逻辑在 `processor::process` —— 这里只留一层，方便宿主端测试直接调。
#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    processor::process(program_id, accounts, data)
}
