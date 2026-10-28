//! Integration test: `CreateWithMetadata` against the **real Metaplex Token
//! Metadata program** (the mainnet `.so`, cloned into `tests/fixtures`).
//!
//! Run with `cargo-test-sbf` (it builds `oaken_curve.so`, sets `BPF_OUT_DIR`,
//! and ProgramTest runs both programs in-process). Plain `cargo test` skips it
//! because the BPF files are not staged.
//!
//! What this pins:
//!   - the metadata PDA is derived by Metaplex and the account is created;
//!   - name / symbol / uri are the Borsh strings the caller sent;
//!   - the update authority is the curve PDA (nobody can rewrite it);
//!   - the mint authority is renounced **after** the metadata CPI;
//!   - a metadata account that is not the mint's PDA is rejected.

use oaken_curve::{
    instruction::CurveInstruction,
    math::TOTAL_SUPPLY,
    metaplex,
    pump,
    spl,
};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    sysvar::rent,
    transaction::Transaction,
};

async fn send(ctx: &mut ProgramTestContext, ixs: &[Instruction], signers: &[&Keypair]) {
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

fn create_ix(
    program_id: Pubkey,
    payer: Pubkey,
    mint: Pubkey,
    curve: Pubkey,
    curve_ata: Pubkey,
    pump_authority: Pubkey,
    fee_key: Pubkey,
    metadata: Pubkey,
    data: Vec<u8>,
) -> Instruction {
    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(mint, true),
            AccountMeta::new(curve, false),
            AccountMeta::new(curve_ata, false),
            AccountMeta::new_readonly(pump_authority, false),
            AccountMeta::new_readonly(fee_key, false),
            AccountMeta::new_readonly(fee_key, false),
            AccountMeta::new_readonly(spl::TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl::ATA_PROGRAM_ID, false),
            AccountMeta::new_readonly(rent::id(), false),
            AccountMeta::new(metadata, false),
            AccountMeta::new_readonly(metaplex::METAPLEX_PROGRAM_ID, false),
        ],
        data,
    }
}

/// Metadata account layout (Metaplex Token Metadata, `MetadataV1`):
///   key u8 = 4 | update_authority 32 | mint 32
///   | name String (u32 length + fixed-32 value) | symbol String (fixed 10)
///   | uri String (fixed 200) | …
/// Metaplex declares each field at its maximum length and NUL-pads the value,
/// so the declared bytes are trimmed before comparing.
fn read_metadata(data: &[u8]) -> (Pubkey, Pubkey, String, String, String) {
    assert_eq!(data[0], 4, "not a MetadataV1 account");
    let update_authority = Pubkey::new_from_array(data[1..33].try_into().unwrap());
    let mint = Pubkey::new_from_array(data[33..65].try_into().unwrap());
    let mut at = 65usize;
    let mut read_string = || {
        let len = u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize;
        at += 4;
        let raw = &data[at..at + len];
        at += len;
        let end = raw.iter().position(|b| *b == 0).unwrap_or(len);
        String::from_utf8(raw[..end].to_vec()).unwrap()
    };
    let name = read_string();
    let symbol = read_string();
    let uri = read_string();
    (update_authority, mint, name, symbol, uri)
}

#[tokio::test]
async fn create_with_metadata_writes_metaplex_then_renounces() {
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
    pt.set_compute_max_units(600_000);
    pt.add_program(
        "mpl_token_metadata",
        metaplex::METAPLEX_PROGRAM_ID,
        None,
    );

    let mut ctx = pt.start_with_context().await;
    let payer_key = ctx.payer.pubkey();
    let fee_key = Keypair::new().pubkey();

    let mint = Keypair::new();
    let mint_key = mint.pubkey();
    let (curve, _) = Pubkey::find_program_address(
        &[b"curve", mint_key.as_ref()],
        &program_id,
    );
    let (pump_authority, _) = pump::pump_authority_pda(&mint_key);
    let curve_ata = spl::ata_address(&pump_authority, &mint_key);
    let (metadata, _) = metaplex::metadata_pda(&mint_key);

    let ix = create_ix(
        program_id,
        payer_key,
        mint_key,
        curve,
        curve_ata,
        pump_authority,
        fee_key,
        metadata,
        CurveInstruction::CreateWithMetadata {
            creator_fee_bps: 5,
            name: "OAKEN Curve Test".to_string(),
            symbol: "OCTT".to_string(),
            uri: "https://oaken.one/m/test.json".to_string(),
        }
        .pack(),
    );
    send(
        &mut ctx,
        &[ComputeBudgetInstruction::set_compute_unit_limit(500_000), ix],
        &[&mint],
    )
    .await;

    // The metadata account exists, is owned by Metaplex, and carries our strings.
    let metadata_account = ctx
        .banks_client
        .get_account(metadata)
        .await
        .unwrap()
        .expect("metadata account was not created");
    assert_eq!(metadata_account.owner, metaplex::METAPLEX_PROGRAM_ID);
    let (update_authority, metadata_mint, name, symbol, uri) = read_metadata(&metadata_account.data);
    assert_eq!(metadata_mint, mint_key);
    assert_eq!(update_authority, curve, "update authority must be the curve PDA");
    assert_eq!(name, "OAKEN Curve Test");
    assert_eq!(symbol, "OCTT");
    assert_eq!(uri, "https://oaken.one/m/test.json");

    // The full supply went to the curve ATA and the mint authority is gone.
    let mint_account = ctx.banks_client.get_account(mint_key).await.unwrap().unwrap();
    assert_eq!(
        u64::from_le_bytes(mint_account.data[36..44].try_into().unwrap()),
        TOTAL_SUPPLY
    );
    assert_eq!(
        mint_account.data[0..4],
        [0, 0, 0, 0],
        "mint authority must be renounced after the metadata CPI"
    );

    // A metadata account that is not this mint's PDA is refused before any CPI.
    let mint2 = Keypair::new();
    let (curve2, _) = Pubkey::find_program_address(
        &[b"curve", mint2.pubkey().as_ref()],
        &program_id,
    );
    let (pump2, _) = pump::pump_authority_pda(&mint2.pubkey());
    let bad_ix = create_ix(
        program_id,
        payer_key,
        mint2.pubkey(),
        curve2,
        spl::ata_address(&pump2, &mint2.pubkey()),
        pump2,
        fee_key,
        metadata,
        CurveInstruction::CreateWithMetadata {
            creator_fee_bps: 5,
            name: "Wrong".to_string(),
            symbol: "WRG".to_string(),
            uri: "https://oaken.one/m/wrong.json".to_string(),
        }
        .pack(),
    );
    assert!(send_expect_err(&mut ctx, &[bad_ix], &[&mint2]).await);
}
