//! Integration test: graduate a completed curve into the **real PumpSwap
//! program** (the mainnet `.so`, cloned into `tests/fixtures`).
//!
//! Run with `cargo-test-sbf` (it builds `oaken_curve.so`, sets `BPF_OUT_DIR`,
//! and ProgramTest then runs both programs in-process). Plain `cargo test`
//! skips this test because the BPF files are not staged.
//!
//! The fixture's global-config account is the real mainnet account
//! `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw`, captured 2026-10-25.
//! The event authority `GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR` is owned
//! by the system program with no data.

use oaken_curve::{
    instruction::CurveInstruction,
    math::RESERVED_FOR_POOL,
    pump,
    spl,
    state::Curve,
};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    native_token::LAMPORTS_PER_SOL,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    sysvar::rent,
    transaction::Transaction,
};

fn pump_global_config_lamports() -> u64 {
    include_str!("fixtures/pump_global_config_lamports.txt")
        .trim()
        .parse()
        .expect("bad pump_global_config_lamports.txt")
}

fn pump_event_authority_lamports() -> u64 {
    include_str!("fixtures/pump_event_authority_lamports.txt")
        .trim()
        .parse()
        .expect("bad pump_event_authority_lamports.txt")
}

fn token_amount(account: &Account) -> u64 {
    u64::from_le_bytes(account.data[64..72].try_into().unwrap())
}

fn mint_supply(account: &Account) -> u64 {
    u64::from_le_bytes(account.data[36..44].try_into().unwrap())
}

async fn send(
    ctx: &mut ProgramTestContext,
    ixs: &[Instruction],
    signers: &[&Keypair],
) {
    let payer = ctx.payer.insecure_clone();
    let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let mut all: Vec<&Keypair> = vec![&payer];
    for s in signers {
        if s.pubkey() != payer.pubkey() {
            all.push(s);
        }
    }
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, blockhash);
    let result = ctx
        .banks_client
        .process_transaction_with_metadata(tx)
        .await
        .expect("banks client failed");
    if let Err(e) = result.result {
        let logs = result
            .metadata
            .map(|m| m.log_messages.join("\n"))
            .unwrap_or_default();
        panic!("transaction failed: {e:?}\n{logs}");
    }
}

async fn send_expect_err(
    ctx: &mut ProgramTestContext,
    ixs: &[Instruction],
    signers: &[&Keypair],
) -> bool {
    let payer = ctx.payer.insecure_clone();
    let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let mut all: Vec<&Keypair> = vec![&payer];
    for s in signers {
        if s.pubkey() != payer.pubkey() {
            all.push(s);
        }
    }
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, blockhash);
    match ctx.banks_client.process_transaction_with_metadata(tx).await {
        Ok(result) => result.result.is_err(),
        Err(_) => true,
    }
}

#[tokio::test]
async fn graduate_into_real_pumpswap() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: run with cargo-test-sbf so the BPF programs are staged");
        return;
    }

    let program_id = oaken_curve::id();
    let mut pt = ProgramTest::new(
        "oaken_curve",
        program_id,
        processor!(oaken_curve::processor::process),
    );
    pt.set_compute_max_units(1_400_000);
    // The real AMM, cloned from mainnet. ProgramTest itself supplies SPL Token,
    // Token-2022 and the ATA program from its bundled copies.
    pt.add_program("pump_amm", pump::PUMP_AMM_PROGRAM_ID, None);
    pt.add_account(
        pump::global_config_pda().0,
        Account {
            lamports: pump_global_config_lamports(),
            data: include_bytes!("fixtures/pump_global_config.bin").to_vec(),
            owner: pump::PUMP_AMM_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    pt.add_account(
        pump::event_authority_pda().0,
        Account {
            lamports: pump_event_authority_lamports(),
            data: vec![],
            owner: system_program::id(),
            executable: false,
            rent_epoch: 0,
        },
    );

    let mut ctx = pt.start_with_context().await;
    let payer = ctx.payer.insecure_clone();
    let payer_key = payer.pubkey();
    let balance = ctx.banks_client.get_balance(payer_key).await.unwrap();
    assert!(balance > 250 * LAMPORTS_PER_SOL, "payer only has {balance}");
    // A separate fee recipient avoids a self-transfer; it needs no signature.
    let fee_key = Keypair::new().pubkey();

    // 1 — create the curve
    let mint = Keypair::new();
    let (curve, _) = Pubkey::find_program_address(
        &[b"curve", mint.pubkey().as_ref()],
        &program_id,
    );
    let (pump_authority, _) = pump::pump_authority_pda(&mint.pubkey());
    let curve_ata = spl::ata_address(&pump_authority, &mint.pubkey());
    let create_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(payer_key, true),
            AccountMeta::new(mint.pubkey(), true),
            AccountMeta::new(curve, false),
            AccountMeta::new(curve_ata, false),
            AccountMeta::new_readonly(pump_authority, false),
            AccountMeta::new_readonly(fee_key, false),
            AccountMeta::new_readonly(fee_key, false),
            AccountMeta::new_readonly(spl::TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl::ATA_PROGRAM_ID, false),
            AccountMeta::new_readonly(rent::id(), false),
        ],
        data: CurveInstruction::Create { creator_fee_bps: 5 }.pack(),
    };
    send(&mut ctx, &[create_ix], &[&mint]).await;

    // 2 — buyer ATA + buy to completion
    let buyer_ata = spl::ata_address(&payer_key, &mint.pubkey());
    let (sol_vault, _) = pump::sol_vault_pda(&mint.pubkey());
    send(
        &mut ctx,
        &[spl::create_ata_idempotent(
            &payer_key,
            &buyer_ata,
            &payer_key,
            &mint.pubkey(),
        )],
        &[],
    )
    .await;

    let buy_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(payer_key, true),
            AccountMeta::new(curve, false),
            AccountMeta::new_readonly(mint.pubkey(), false),
            AccountMeta::new(curve_ata, false),
            AccountMeta::new(buyer_ata, false),
            AccountMeta::new(sol_vault, false),
            AccountMeta::new_readonly(pump_authority, false),
            AccountMeta::new(fee_key, false),
            AccountMeta::new(fee_key, false),
            AccountMeta::new_readonly(spl::TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: CurveInstruction::Buy {
            amount_in: 200 * LAMPORTS_PER_SOL,
            min_tokens_out: 0,
        }
        .pack(),
    };
    send(&mut ctx, &[buy_ix], &[]).await;

    let curve_account = ctx.banks_client.get_account(curve).await.unwrap().unwrap();
    let curve_state = Curve::load(&curve_account.data).unwrap();
    assert!(curve_state.completed, "curve did not complete");
    assert_eq!(curve_state.real_token_reserves, 0);
    let raised = curve_state.real_sol_reserves;
    assert!(
        (85 * LAMPORTS_PER_SOL..87 * LAMPORTS_PER_SOL).contains(&raised),
        "raised {raised}"
    );

    // 3 — graduate into PumpSwap
    let (pool, _) = pump::pool_pda(0, &pump_authority, &mint.pubkey(), &pump::WSOL_MINT);
    let (lp_mint, _) = pump::lp_mint_pda(&pool);
    let curve_wsol = spl::ata_address_for(&pump_authority, &pump::WSOL_MINT, &spl::TOKEN_PROGRAM_ID);
    let curve_lp = spl::ata_address_for(&pump_authority, &lp_mint, &pump::TOKEN_2022_PROGRAM_ID);
    let pool_base = spl::ata_address_for(&pool, &mint.pubkey(), &spl::TOKEN_PROGRAM_ID);
    let pool_quote = spl::ata_address_for(&pool, &pump::WSOL_MINT, &spl::TOKEN_PROGRAM_ID);
    let graduate_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(payer_key, true),
            AccountMeta::new(curve, false),
            AccountMeta::new_readonly(mint.pubkey(), false),
            AccountMeta::new(curve_ata, false),
            AccountMeta::new(sol_vault, false),
            AccountMeta::new(pump_authority, false),
            AccountMeta::new(curve_wsol, false),
            AccountMeta::new(pool, false),
            AccountMeta::new_readonly(pump::global_config_pda().0, false),
            AccountMeta::new(lp_mint, false),
            AccountMeta::new(curve_lp, false),
            AccountMeta::new(pool_base, false),
            AccountMeta::new(pool_quote, false),
            AccountMeta::new_readonly(pump::event_authority_pda().0, false),
            AccountMeta::new_readonly(pump::PUMP_AMM_PROGRAM_ID, false),
            AccountMeta::new_readonly(pump::WSOL_MINT, false),
            AccountMeta::new_readonly(spl::TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(pump::TOKEN_2022_PROGRAM_ID, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl::ATA_PROGRAM_ID, false),
        ],
        data: CurveInstruction::GraduatePumpSwap { index: 0 }.pack(),
    };
    send(
        &mut ctx,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(1_200_000),
            graduate_ix.clone(),
        ],
        &[],
    )
    .await;

    // 4 — the curve recorded the pool and its token account is empty
    let curve_account = ctx.banks_client.get_account(curve).await.unwrap().unwrap();
    let curve_state = Curve::load(&curve_account.data).unwrap();
    assert!(curve_state.graduated);
    assert_eq!(curve_state.pool, pool);
    let curve_ata_account = ctx.banks_client.get_account(curve_ata).await.unwrap().unwrap();
    assert_eq!(token_amount(&curve_ata_account), 0);

    // 5 — the real PumpSwap pool
    let pool_account = ctx.banks_client.get_account(pool).await.unwrap().unwrap();
    assert_eq!(pool_account.owner, pump::PUMP_AMM_PROGRAM_ID);
    assert_eq!(&pool_account.data[11..43], pump_authority.as_ref()); // creator = the pump authority
    assert_eq!(&pool_account.data[43..75], mint.pubkey().as_ref());
    assert_eq!(&pool_account.data[75..107], pump::WSOL_MINT.as_ref());
    assert_eq!(&pool_account.data[107..139], lp_mint.as_ref());

    let base_account = ctx.banks_client.get_account(pool_base).await.unwrap().unwrap();
    assert_eq!(token_amount(&base_account), RESERVED_FOR_POOL);
    let quote_account = ctx.banks_client.get_account(pool_quote).await.unwrap().unwrap();
    assert_eq!(token_amount(&quote_account), raised);

    // 6 — the LP supply sits in the curve-owned Token-2022 account
    let lp_mint_account = ctx.banks_client.get_account(lp_mint).await.unwrap().unwrap();
    assert_eq!(lp_mint_account.owner, pump::TOKEN_2022_PROGRAM_ID);
    let supply = mint_supply(&lp_mint_account);
    assert!(supply > 0, "LP supply is zero");
    let locked = ctx.banks_client.get_account(curve_lp).await.unwrap().unwrap();
    assert_eq!(locked.owner, pump::TOKEN_2022_PROGRAM_ID);
    assert_eq!(token_amount(&locked), supply);
    assert_eq!(&locked.data[32..64], pump_authority.as_ref()); // LP owner = pump authority

    // The SOL vault was emptied into the pool; the data-less system account is gone.
    let vault_after = ctx.banks_client.get_account(sol_vault).await.unwrap();
    assert!(vault_after.is_none() || vault_after.unwrap().lamports == 0);

    // 7 — the wSOL account was closed
    assert!(ctx.banks_client.get_account(curve_wsol).await.unwrap().is_none());

    // 8 — neither graduation path can run twice
    assert!(send_expect_err(
        &mut ctx,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(1_200_000),
            graduate_ix,
        ],
        &[],
    )
    .await);

    let (vault, _) = Pubkey::find_program_address(
        &[b"graduate", mint.pubkey().as_ref()],
        &program_id,
    );
    let vault_ata = spl::ata_address(&vault, &mint.pubkey());
    let vault_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(payer_key, true),
            AccountMeta::new(curve, false),
            AccountMeta::new_readonly(mint.pubkey(), false),
            AccountMeta::new(curve_ata, false),
            AccountMeta::new(sol_vault, false),
            AccountMeta::new_readonly(pump_authority, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(vault_ata, false),
            AccountMeta::new_readonly(spl::TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl::ATA_PROGRAM_ID, false),
        ],
        data: CurveInstruction::Graduate.pack(),
    };
    assert!(send_expect_err(&mut ctx, &[vault_ix], &[]).await);
}
