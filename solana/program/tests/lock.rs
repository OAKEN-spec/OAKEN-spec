//! `cargo test-sbf` 的集成测试：**真的 SBF 字节码**跑在进程内的 bank 上。
//!
//! 为什么不是 `solana-test-validator`：那东西在这台 Windows 上起不来 ——
//! 它要建符号链接，而建符号链接需要开发者模式或管理员权限，报的是
//! 1314「客户端没有所需的特权」。`cargo test-sbf` 走的是进程内 bank，
//! 既没有那条路，也不用起端口。
//!
//! 两个外部程序（SPL Token / ATA）是**从主网 dump 下来的真字节码**
//! （`solana program dump`），不是我们写的替身 —— 我们程序里那些手写的 CPI 字节
//! 只有对着真程序跑才算验过。夹具跟着**真实现**走，不跟着我们自己的实现走。

use solana_program_test::{ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::ReadableAccount,
    instruction::{AccountMeta, Instruction},
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::Transaction,
};
use solana_sdk::native_token::LAMPORTS_PER_SOL;

const TOKEN_PROGRAM: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM: Pubkey = solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RENT_SYSVAR: Pubkey = solana_program::pubkey!("SysvarRent111111111111111111111111111111111");
const CLOCK_SYSVAR: Pubkey = solana_program::pubkey!("SysvarClock11111111111111111111111111111111");

const LOCK_LEN: u64 = 240;
const DECIMALS: u8 = 6;              // 故意用 6：精度换算的坑只在不是 18 的时候才露头

fn program_test() -> ProgramTest {
    let mut pt = ProgramTest::default();
    // None = 用 `target/deploy/<name>.so` 里的 BPF 产物（cargo test-sbf 会先把它编出来）
    pt.add_program("oaken_lock", oaken_lock::id(), None);
    pt.add_program("spl_token", TOKEN_PROGRAM, None);
    pt.add_program("spl_associated_token_account", ATA_PROGRAM, None);
    pt.prefer_bpf(true);
    pt
}

struct Env {
    ctx: ProgramTestContext,
    payer: Keypair,
    mint: Pubkey,
    payer_token: Pubkey,
}

async fn setup() -> Env {
    let mut ctx = program_test().start_with_context().await;
    let payer = Keypair::new();
    // 给付款人打钱（进程内 bank 直接改账户）
    ctx.set_account(&payer.pubkey(), &solana_sdk::account::Account {
        lamports: 100 * LAMPORTS_PER_SOL,
        ..Default::default()
    }.into());

    let mint = Keypair::new();
    let payer_token = Keypair::new();
    let rent = ctx.banks_client.get_rent().await.unwrap();

    let tx = Transaction::new_signed_with_payer(
        &[
            system_instruction::create_account(
                &payer.pubkey(), &mint.pubkey(), rent.minimum_balance(spl_token::state::Mint::LEN), spl_token::state::Mint::LEN as u64, &TOKEN_PROGRAM,
            ),
            spl_token::instruction::initialize_mint(&TOKEN_PROGRAM, &mint.pubkey(), &payer.pubkey(), None, DECIMALS).unwrap(),
            system_instruction::create_account(
                &payer.pubkey(), &payer_token.pubkey(), rent.minimum_balance(spl_token::state::Account::LEN), spl_token::state::Account::LEN as u64, &TOKEN_PROGRAM,
            ),
            spl_token::instruction::initialize_account(&TOKEN_PROGRAM, &payer_token.pubkey(), &mint.pubkey(), &payer.pubkey()).unwrap(),
            spl_token::instruction::mint_to(&TOKEN_PROGRAM, &mint.pubkey(), &payer_token.pubkey(), &payer.pubkey(), &[], 1_000_000_000).unwrap(),
        ],
        Some(&payer.pubkey()),
        &[&payer, &mint, &payer_token],
        ctx.last_blockhash,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();

    Env { ctx, payer, mint: mint.pubkey(), payer_token: payer_token.pubkey() }
}

fn ata_of(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    ).0
}

/// 和 `public/app/solana.js` / `processor.rs` 里那张表**同一个顺序**。
fn create_lock_ix(env: &Env, id: u64, amount: u64, unlock_date: i64, revocable: bool, label: &str) -> (Instruction, Pubkey, Pubkey) {
    let (lock, _) = oaken_lock::processor::lock_pda(id);
    let vault = ata_of(&lock, &env.mint);
    let (config, _) = oaken_lock::processor::config_pda();
    let data = oaken_lock::instruction::encode_create_lock(id, amount, unlock_date, revocable, label);
    let ix = Instruction {
        program_id: oaken_lock::id(),
        accounts: vec![
            AccountMeta::new(env.payer.pubkey(), true),
            AccountMeta::new_readonly(env.payer.pubkey(), false),   // beneficiary = payer
            AccountMeta::new_readonly(env.mint, false),
            AccountMeta::new(env.payer_token, true),
            AccountMeta::new(lock, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(config, false),
            AccountMeta::new_readonly(RENT_SYSVAR, false),
            AccountMeta::new_readonly(CLOCK_SYSVAR, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data,
    };
    (ix, lock, vault)
}

async fn token_amount(env: &mut Env, account: &Pubkey) -> u64 {
    let acc = env.ctx.banks_client.get_account(*account).await.unwrap().expect("token account 不在");
    spl_token::state::Account::unpack(acc.data()).unwrap().amount
}

async fn send(env: &mut Env, ixs: &[Instruction], signers: &[&Keypair]) {
    let blockhash = env.ctx.banks_client.get_latest_blockhash().await.unwrap();
    let mut all: Vec<&Keypair> = vec![&env.payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&env.payer.pubkey()), &all, blockhash);
    env.ctx.banks_client.process_transaction(tx).await.unwrap();
    env.ctx.last_blockhash = blockhash;
}

fn now(env: &mut Env) -> i64 {
    // 进程内 bank 的时钟
    env.ctx.banks_client.get_sysvar::<solana_program::clock::Clock>().map(|c| c.unix_timestamp).unwrap_or(0)
}

#[tokio::test]
async fn create_claim_transfer_renounce_and_revoke() {
    let mut env = setup().await;
    let payer = env.payer.pubkey();
    let clock = env.ctx.banks_client.get_sysvar::<solana_program::clock::Clock>().unwrap();

    // ① 建一把锁：金额 4 亿（400.000000），到期在未来
    let amount = 400_000_000u64;
    let unlock = clock.unix_timestamp + 3600;
    let (ix, lock_pda, vault) = create_lock_ix(&env, 0, amount, unlock, false, "Team");
    send(&mut env, &[ix], &[]).await;

    let lock = oaken_lock::state::Lock::load(&env.ctx.banks_client.get_account(lock_pda).await.unwrap().unwrap().data()).unwrap();
    assert_eq!(lock.id, 0);
    assert_eq!(lock.amount, amount);
    assert_eq!(lock.beneficiary, payer);
    assert_eq!(lock.label_str(), "Team");
    assert!(!lock.revocable);
    assert_eq!(lock.unlock_date, unlock);
    assert_eq!(token_amount(&mut env, &vault).await, amount, "金库必须真的收到币");
    assert_eq!(token_amount(&mut env, &env.payer_token).await, 1_000_000_000 - amount);
    assert_eq!(oaken_lock::state::Config::load(&env.ctx.banks_client.get_account(oaken_lock::processor::config_pda().0).await.unwrap().unwrap().data()).unwrap().count, 1);

    // ② 没到期：claim 必须失败
    let dest = ata_of(&payer, &env.mint);
    let claim = Instruction {
        program_id: oaken_lock::id(),
        accounts: vec![
            AccountMeta::new_readonly(lock_pda, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(env.mint, false),
            AccountMeta::new(dest, false),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            AccountMeta::new_readonly(CLOCK_SYSVAR, false),
        ],
        data: vec![1u8],
    };
    let blockhash = env.ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(&[claim.clone()], Some(&payer), &[&env.payer], blockhash);
    assert!(env.ctx.banks_client.process_transaction(tx).await.is_err(), "没到期不该能领出来");
    assert_eq!(token_amount(&mut env, &vault).await, amount, "失败的那笔不能动钱");

    // ③ 再建一把**已经到期**的锁（锁的是同一段逻辑，只是日期不同），任何第三方都能提交领取
    let (ix2, lock2, vault2) = create_lock_ix(&env, 1, amount, now(&mut env) - 1, false, "Advisors");
    send(&mut env, &[ix2], &[]).await;
    let claim2 = Instruction { accounts: vec![
        AccountMeta::new_readonly(lock2, false), AccountMeta::new(vault2, false),
        AccountMeta::new_readonly(env.mint, false), AccountMeta::new(dest, false),
        AccountMeta::new(payer, true), AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        AccountMeta::new_readonly(ATA_PROGRAM, false), AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        AccountMeta::new_readonly(CLOCK_SYSVAR, false),
    ], ..claim.clone() };
    send(&mut env, &[claim2], &[]).await;

    assert_eq!(token_amount(&mut env, &dest).await, amount, "受益人（=付款人）拿到币");
    assert_eq!(token_amount(&mut env, &vault2).await, 0, "金库空了");
    let lock2_state = oaken_lock::state::Lock::load(&env.ctx.banks_client.get_account(lock2).await.unwrap().unwrap().data()).unwrap();
    assert_eq!(lock2_state.claimed, amount);

    // ④ 转让受益人
    let heir = Keypair::new().pubkey();
    let transfer = Instruction {
        program_id: oaken_lock::id(),
        accounts: vec![
            AccountMeta::new(lock2, false),
            AccountMeta::new_readonly(payer, true),
            AccountMeta::new_readonly(heir, false),
        ],
        data: oaken_lock::instruction::encode_transfer_ownership(&heir),
    };
    send(&mut env, &[transfer], &[]).await;
    let after = oaken_lock::state::Lock::load(&env.ctx.banks_client.get_account(lock2).await.unwrap().unwrap().data()).unwrap();
    assert_eq!(after.beneficiary, heir);

    // ⑤ 放弃（renounce）
    let renounce = Instruction {
        program_id: oaken_lock::id(),
        accounts: vec![AccountMeta::new(lock_pda, false), AccountMeta::new_readonly(payer, true)],
        data: vec![3u8],
    };
    send(&mut env, &[renounce], &[]).await;
    let ren = oaken_lock::state::Lock::load(&env.ctx.banks_client.get_account(lock_pda).await.unwrap().unwrap().data()).unwrap();
    assert!(ren.renounced);

    // ⑥ 撤锁：不可撤的那把撤不动；可撤的那把能把币拿回来
    let revoke = |lock: Pubkey, vault: Pubkey| Instruction {
        program_id: oaken_lock::id(),
        accounts: vec![
            AccountMeta::new(lock, false),
            AccountMeta::new_readonly(payer, true),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(env.mint, false),
            AccountMeta::new(env.payer_token, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(CLOCK_SYSVAR, false),
        ],
        data: vec![4u8],
    };
    let blockhash = env.ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(&[revoke(lock_pda, vault)], Some(&payer), &[&env.payer], blockhash);
    assert!(env.ctx.banks_client.process_transaction(tx).await.is_err(), "没声明 revocable 的锁不该撤得动");

    let (ix3, lock3, vault3) = create_lock_ix(&env, 2, amount, now(&mut env) + 3600, true, "Marketing");
    send(&mut env, &[ix3], &[]).await;
    let before = token_amount(&mut env, &env.payer_token).await;
    send(&mut env, &[revoke(lock3, vault3)], &[]).await;
    assert_eq!(token_amount(&mut env, &env.payer_token).await - before, amount, "撤锁把币退回来了");
    let l3 = oaken_lock::state::Lock::load(&env.ctx.banks_client.get_account(lock3).await.unwrap().unwrap().data()).unwrap();
    assert!(l3.revoked);
    assert_eq!(l3.claimed, l3.amount, "撤了就是撤了：领取路径关掉");

    // ⑦ 计数器
    let config = oaken_lock::state::Config::load(&env.ctx.banks_client.get_account(oaken_lock::processor::config_pda().0).await.unwrap().unwrap().data()).unwrap();
    assert_eq!(config.count, 3);
}
