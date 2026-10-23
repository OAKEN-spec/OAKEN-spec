//! 五条指令的实现。
//!
//! 每条指令的账户表都写在它自己的函数头上 —— 顺序就是协议的一部分，
//! 改顺序 = 改协议。账户全部**先验后用**：owner 对不对、PDA 推出来是不是它、
//! 金额够不够，任何一条对不上就整笔回滚（Solana 的原子性替我们兜底，
//! 但每一条检查都要写出来，不能靠"反正会回滚"来省）。

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};

use crate::{
    instruction::LockInstruction,
    spl,
    state::{Config, Lock, CONFIG_LEN, LAYOUT_VERSION, LOCK_LEN},
};

/// 计数器 PDA 的种子。
pub const CONFIG_SEED: &[u8] = b"config";
/// 锁账户 PDA 的种子。
pub const LOCK_SEED: &[u8] = b"lock";

/// 第 `id` 把锁的 PDA。**页面上那份实现（`public/app/solana.js`）算的是同一个**，
/// 而测试也用它 —— 三处对同一件事只能有一种算法。
pub fn lock_pda(id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[LOCK_SEED, id.to_le_bytes().as_ref()], &crate::id())
}

/// 计数器 PDA。
pub fn config_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED], &crate::id())
}

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match LockInstruction::unpack(data)? {
        LockInstruction::CreateLock { id, amount, unlock_date, revocable, label } => {
            create_lock(program_id, accounts, id, amount, unlock_date, revocable, label)
        }
        LockInstruction::Claim => claim(program_id, accounts),
        LockInstruction::TransferOwnership { new_beneficiary } => {
            transfer_ownership(program_id, accounts, &new_beneficiary)
        }
        LockInstruction::Renounce => renounce(program_id, accounts),
        LockInstruction::Revoke => revoke(program_id, accounts),
    }
}

/// 账户（顺序即协议）：
/// 0 payer/creator（签名，可写）· 1 beneficiary（只读）· 2 mint（只读）·
/// 3 source（可写，payer 的 token account）· 4 lock（可写，PDA）·
/// 5 vault（可写，锁 PDA 的 ATA）· 6 config（可写，PDA）· 7 rent · 8 clock ·
/// 9 token program · 10 ata program · 11 system program
#[allow(clippy::too_many_arguments)]
fn create_lock(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    id: u64,
    amount: u64,
    unlock_date: i64,
    revocable: bool,
    label: [u8; 64],
) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let beneficiary = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let source = next_account_info(it)?;
    let lock_info = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let config_info = next_account_info(it)?;
    let rent_info = next_account_info(it)?;
    let clock_info = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let ata_program = next_account_info(it)?;
    let system_program = next_account_info(it)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if amount == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if mint.owner != token_program.key {
        return Err(ProgramError::IncorrectProgramId);
    }
    if source.owner != token_program.key {
        return Err(ProgramError::IncorrectProgramId);
    }

    // `lock` 必须是 `["lock", id]` 推出来的那个，`config` 同理。
    // 客户端选 id、程序验 —— 不验的话，任何人都能拿同一个 PDA 建两把锁。
    let (expected_lock, bump) = Pubkey::find_program_address(
        &[LOCK_SEED, id.to_le_bytes().as_ref()],
        program_id,
    );
    if expected_lock != *lock_info.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let (expected_config, config_bump) =
        Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if expected_config != *config_info.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let expected_vault = spl::ata_address(lock_info.key, mint.key);
    if expected_vault != *vault.key {
        return Err(ProgramError::InvalidSeeds);
    }

    let rent = Rent::from_account_info(rent_info)?;
    let clock = Clock::from_account_info(clock_info)?;

    // 计数器：第一次用时现建（8 字节的租金可以忽略），之后每建一把锁 +1。
    let mut config = if config_info.data_len() == 0 {
        invoke(
            &spl::create_account(
                payer.key,
                config_info.key,
                rent.minimum_balance(CONFIG_LEN),
                CONFIG_LEN as u64,
                program_id,
            ),
            &[payer.clone(), config_info.clone(), system_program.clone()],
        )?;
        Config { count: 0 }
    } else {
        Config::load(&config_info.data.borrow())?
    };
    if config.count != id {
        // id 必须正好是下一个：跳号会让"第 N 把锁"这个说法在页面上变得没有意义
        return Err(ProgramError::InvalidInstructionData);
    }

    if lock_info.data_len() != 0 {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // 锁账户：定长、owner 是本程序。
    invoke(
        &spl::create_account(
            payer.key,
            lock_info.key,
            rent.minimum_balance(LOCK_LEN),
            LOCK_LEN as u64,
            program_id,
        ),
        &[payer.clone(), lock_info.clone(), system_program.clone()],
    )?;

    // 金库：锁 PDA 名下的 ATA。幂等版 —— 已经在了就跳过。
    invoke(
        &spl::create_ata_idempotent(payer.key, vault.key, lock_info.key, mint.key),
        &[
            payer.clone(),
            vault.clone(),
            lock_info.clone(),
            mint.clone(),
            system_program.clone(),
            token_program.clone(),
            ata_program.clone(),
        ],
    )?;

    // 币从 payer 转到金库。签名人是 payer（source 的持有者），不是 PDA。
    let decimals = mint_decimals(mint)?;
    invoke(
        &spl::transfer_checked(source.key, mint.key, vault.key, payer.key, amount, decimals),
        &[source.clone(), mint.clone(), vault.clone(), payer.clone(), token_program.clone()],
    )?;

    let lock = Lock {
        version: LAYOUT_VERSION,
        bump,
        id,
        creator: *payer.key,
        beneficiary: *beneficiary.key,
        mint: *mint.key,
        vault: *vault.key,
        amount,
        lock_date: clock.unix_timestamp,
        unlock_date,
        claimed: 0,
        revocable,
        renounced: false,
        revoked: false,
        label,
    };
    lock.store(&mut lock_info.data.borrow_mut())?;

    config.count = config.count.checked_add(1).ok_or(ProgramError::InvalidInstructionData)?;
    config.store(&mut config_info.data.borrow_mut())?;
    let _ = config_bump;

    Ok(())
}

/// 账户：0 lock（只读，PDA）· 1 vault（可写）· 2 mint（只读）· 3 destination（可写，
/// 受益人的 ATA）· 4 payer（签名，可写，谁都可以）· 5 token program · 6 ata program ·
/// 7 system program · 8 clock
fn claim(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let lock_info = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let destination = next_account_info(it)?;
    let payer = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let ata_program = next_account_info(it)?;
    let system_program = next_account_info(it)?;
    let clock_info = next_account_info(it)?;

    if lock_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut lock = Lock::load(&lock_info.data.borrow())?;
    if *vault.key != lock.vault {
        return Err(ProgramError::InvalidSeeds);
    }
    if *mint.key != lock.mint {
        return Err(ProgramError::InvalidSeeds);
    }

    // 目标账户必须是受益人的 ATA —— 这条检查就是"币只进受益人"的全部实现。
    // 少写它，任何人都能提交一笔 claim 把币领到自己账上。
    let expected_destination = spl::ata_address(&lock.beneficiary, mint.key);
    if expected_destination != *destination.key {
        return Err(ProgramError::InvalidSeeds);
    }

    let clock = Clock::from_account_info(clock_info)?;
    let amount = lock.claimable(clock.unix_timestamp);
    if amount == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    invoke(
        &spl::create_ata_idempotent(payer.key, destination.key, &lock.beneficiary, mint.key),
        &[
            payer.clone(),
            destination.clone(),
            lock_info.clone(),
            mint.clone(),
            system_program.clone(),
            token_program.clone(),
            ata_program.clone(),
        ],
    )?;

    let decimals = mint_decimals(mint)?;
    // 金库的持有者是锁 PDA，所以这里要**用种子签名**。
    invoke_signed(
        &spl::transfer_checked(vault.key, mint.key, destination.key, lock_info.key, amount, decimals),
        &[vault.clone(), mint.clone(), destination.clone(), lock_info.clone(), token_program.clone()],
        &[&[LOCK_SEED, lock.id.to_le_bytes().as_ref(), &[lock.bump]]],
    )?;

    lock.claimed = lock.claimed.saturating_add(amount);
    lock.store(&mut lock_info.data.borrow_mut())?;
    Ok(())
}

/// 账户：0 lock（可写）· 1 beneficiary（签名）· 2 new_beneficiary（只读）
fn transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_beneficiary: &Pubkey,
) -> ProgramResult {
    let it = &mut accounts.iter();
    let lock_info = next_account_info(it)?;
    let beneficiary = next_account_info(it)?;
    let new_beneficiary_info = next_account_info(it)?;

    if lock_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut lock = Lock::load(&lock_info.data.borrow())?;
    if !beneficiary.is_signer || *beneficiary.key != lock.beneficiary {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *new_beneficiary_info.key != *new_beneficiary {
        return Err(ProgramError::InvalidInstructionData);
    }
    if *new_beneficiary == Pubkey::default() {
        return Err(ProgramError::InvalidInstructionData);
    }
    lock.beneficiary = *new_beneficiary;
    lock.store(&mut lock_info.data.borrow_mut())?;
    Ok(())
}

/// 账户：0 lock（可写）· 1 beneficiary（签名）
fn renounce(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let lock_info = next_account_info(it)?;
    let beneficiary = next_account_info(it)?;

    if lock_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut lock = Lock::load(&lock_info.data.borrow())?;
    if !beneficiary.is_signer || *beneficiary.key != lock.beneficiary {
        return Err(ProgramError::MissingRequiredSignature);
    }
    lock.renounced = true;
    lock.store(&mut lock_info.data.borrow_mut())?;
    Ok(())
}

/// 账户：0 lock（可写）· 1 creator（签名）· 2 vault（可写）· 3 mint（只读）·
/// 4 creator_destination（可写，creator 的 ATA）· 5 token program · 6 clock
fn revoke(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let lock_info = next_account_info(it)?;
    let creator = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let destination = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let clock_info = next_account_info(it)?;

    if lock_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut lock = Lock::load(&lock_info.data.borrow())?;
    if !creator.is_signer || *creator.key != lock.creator {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // 只有**创建时声明**可撤的锁能撤；而且只有在到期之前 ——
    // 到期之后撤锁就是"把已经属于受益人的东西拿回去"，那不是撤销，是偷。
    if !lock.revocable || lock.revoked {
        return Err(ProgramError::InvalidInstructionData);
    }
    let clock = Clock::from_account_info(clock_info)?;
    if clock.unix_timestamp >= lock.unlock_date {
        return Err(ProgramError::InvalidInstructionData);
    }
    if *vault.key != lock.vault || *mint.key != lock.mint {
        return Err(ProgramError::InvalidSeeds);
    }
    let expected_destination = spl::ata_address(&lock.creator, mint.key);
    if expected_destination != *destination.key {
        return Err(ProgramError::InvalidSeeds);
    }

    let refund = lock.amount.saturating_sub(lock.claimed);
    let decimals = mint_decimals(mint)?;
    if refund > 0 {
        invoke_signed(
            &spl::transfer_checked(vault.key, mint.key, destination.key, lock_info.key, refund, decimals),
            &[vault.clone(), mint.clone(), destination.clone(), lock_info.clone(), token_program.clone()],
            &[&[LOCK_SEED, lock.id.to_le_bytes().as_ref(), &[lock.bump]]],
        )?;
    }
    lock.revoked = true;
    lock.claimed = lock.amount;      // 撤了就是撤了：余额归零，领取路径彻底关掉
    lock.store(&mut lock_info.data.borrow_mut())?;
    Ok(())
}

/// SPL Mint 账户里的精度：布局是 `[COption<Pubkey> 36B][supply u64][decimals u8]`。
fn mint_decimals(mint: &AccountInfo) -> Result<u8, ProgramError> {
    let data = mint.data.borrow();
    if data.len() < 45 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(data[44])
}
