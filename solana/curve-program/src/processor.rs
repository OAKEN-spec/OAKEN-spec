//! Program logic.
//!
//! Account order is fixed and documented at each instruction. Every account is
//! checked by owner, address or stored state; no account is "trusted because
//! it was passed". PDA signing uses the seeds documented in `lib.rs`.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program::invoke,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_program,
    sysvar::Sysvar,
};

use crate::instruction::CurveInstruction;
use crate::math::{
    self, GRADUATION_SOL, INITIAL_REAL_TOKEN, INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKEN,
    MAX_CREATOR_FEE_BPS, PROTOCOL_FEE_BPS, RESERVED_FOR_POOL, TOKEN_DECIMALS, TOTAL_SUPPLY,
};
use crate::metaplex;
use crate::pump;
use crate::spl;
use crate::state::{Curve, CURVE_LEN, LAYOUT_VERSION};

// Custom program errors. Values are part of the client-visible surface.
pub const E_BAD_ACCOUNT: u32 = 1;
pub const E_NOT_SIGNER: u32 = 2;
pub const E_NOT_WRITABLE: u32 = 3;
pub const E_WRONG_OWNER: u32 = 4;
pub const E_WRONG_PDA: u32 = 5;
pub const E_NOT_INITIALIZED: u32 = 6;
pub const E_COMPLETED: u32 = 7;
pub const E_GRADUATED: u32 = 8;
pub const E_BAD_FEE: u32 = 9;
pub const E_ZERO_AMOUNT: u32 = 10;
pub const E_SLIPPAGE: u32 = 11;
pub const E_NOT_COMPLETE: u32 = 12;
pub const E_MATH: u32 = 13;
pub const E_BAD_TOKEN_ACCOUNT: u32 = 14;
pub const E_LP_NOT_LOCKED: u32 = 15;

/// Lamports lent to the data-less pump authority so PumpSwap can create the
/// pool, the LP mint and the LP ATA. Actual rent ≈ 6.3M; this leaves a margin.
const PUMP_RENT_BUDGET: u64 = 12_000_000;
/// Refunded to the payer after the pool exists. The authority keeps the rest
/// (≈3–5M lamports) because its post-CPI balance cannot be read reliably.
const PUMP_RENT_REFUND: u64 = 2_000_000;

fn err(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match CurveInstruction::unpack(data)? {
        CurveInstruction::Create { creator_fee_bps } => create(program_id, accounts, creator_fee_bps),
        CurveInstruction::CreateWithMetadata {
            creator_fee_bps,
            name,
            symbol,
            uri,
        } => create_with_metadata(program_id, accounts, creator_fee_bps, &name, &symbol, &uri),
        CurveInstruction::Buy { amount_in, min_tokens_out } => {
            buy(program_id, accounts, amount_in, min_tokens_out)
        }
        CurveInstruction::Sell { amount_in, min_sol_out } => {
            sell(program_id, accounts, amount_in, min_sol_out)
        }
        CurveInstruction::Graduate => graduate(program_id, accounts),
        CurveInstruction::GraduatePumpSwap { index } => {
            graduate_pumpswap(program_id, accounts, index)
        }
    }
}

// ── Create ────────────────────────────────────────────────────────────────

struct CreateCtx<'a, 'b> {
    creator: &'a AccountInfo<'b>,
    mint: &'a AccountInfo<'b>,
    curve_ai: &'a AccountInfo<'b>,
    curve_ata: &'a AccountInfo<'b>,
    pump_authority: &'a AccountInfo<'b>,
    protocol_fee_recipient: &'a AccountInfo<'b>,
    creator_fee_recipient: &'a AccountInfo<'b>,
    token_program: &'a AccountInfo<'b>,
    system_program: &'a AccountInfo<'b>,
    ata_program: &'a AccountInfo<'b>,
    rent_ai: &'a AccountInfo<'b>,
}

struct MetadataRequest<'a, 'b> {
    metadata_ai: &'a AccountInfo<'b>,
    metaplex_program: &'a AccountInfo<'b>,
    name: &'a str,
    symbol: &'a str,
    uri: &'a str,
}

fn parse_create_accounts<'a, 'b>(
    it: &mut std::slice::Iter<'a, AccountInfo<'b>>,
) -> Result<CreateCtx<'a, 'b>, ProgramError> {
    Ok(CreateCtx {
        creator: next_account_info(it)?,
        mint: next_account_info(it)?,
        curve_ai: next_account_info(it)?,
        curve_ata: next_account_info(it)?,
        pump_authority: next_account_info(it)?,
        protocol_fee_recipient: next_account_info(it)?,
        creator_fee_recipient: next_account_info(it)?,
        token_program: next_account_info(it)?,
        system_program: next_account_info(it)?,
        ata_program: next_account_info(it)?,
        rent_ai: next_account_info(it)?,
    })
}

/// Accounts:
///   0 creator (signer, writable)
///   1 mint (signer, writable; a fresh keypair)
///   2 curve PDA (writable)
///   3 curve ATA (writable) — owned by the pump authority
///   4 pump authority PDA (readonly)
///   5 protocol fee recipient (readonly)
///   6 creator fee recipient (readonly)
///   7 token program
///   8 system program
///   9 ATA program
///  10 rent sysvar
fn create(program_id: &Pubkey, accounts: &[AccountInfo], creator_fee_bps: u16) -> ProgramResult {
    let ctx = parse_create_accounts(&mut accounts.iter())?;
    create_impl(program_id, ctx, creator_fee_bps, None)
}

/// The same 11 accounts as `Create`, plus:
///  11 metadata PDA (writable) — `["metadata", metaplex, mint]`
///  12 Metaplex Token Metadata program (readonly)
///
/// The metadata is written between creating the mint and renouncing the mint
/// authority. Metaplex requires the mint authority to sign, and the curve PDA
/// is the only key that can sign for it; after the renounce it is gone.
fn create_with_metadata(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    creator_fee_bps: u16,
    name: &str,
    symbol: &str,
    uri: &str,
) -> ProgramResult {
    let mut iter = accounts.iter();
    let ctx = parse_create_accounts(&mut iter)?;
    let metadata_ai = next_account_info(&mut iter)?;
    let metaplex_program = next_account_info(&mut iter)?;

    if metaplex_program.key != &metaplex::METAPLEX_PROGRAM_ID {
        return Err(err(E_BAD_ACCOUNT));
    }
    let (expected_metadata, _) = metaplex::metadata_pda(ctx.mint.key);
    if expected_metadata != *metadata_ai.key {
        return Err(err(E_WRONG_PDA));
    }
    if !metadata_ai.is_writable {
        return Err(err(E_NOT_WRITABLE));
    }
    create_impl(
        program_id,
        ctx,
        creator_fee_bps,
        Some(MetadataRequest {
            metadata_ai,
            metaplex_program,
            name,
            symbol,
            uri,
        }),
    )
}

fn create_impl<'a, 'b>(
    program_id: &Pubkey,
    ctx: CreateCtx<'a, 'b>,
    creator_fee_bps: u16,
    metadata: Option<MetadataRequest<'a, 'b>>,
) -> ProgramResult {
    let CreateCtx {
        creator,
        mint,
        curve_ai,
        curve_ata,
        pump_authority,
        protocol_fee_recipient,
        creator_fee_recipient,
        token_program,
        system_program,
        ata_program,
        rent_ai,
    } = ctx;

    if !creator.is_signer || !mint.is_signer {
        return Err(err(E_NOT_SIGNER));
    }
    if !creator.is_writable || !mint.is_writable || !curve_ai.is_writable || !curve_ata.is_writable {
        return Err(err(E_NOT_WRITABLE));
    }
    if creator_fee_bps as u64 > MAX_CREATOR_FEE_BPS {
        return Err(err(E_BAD_FEE));
    }
    if token_program.key != &spl::TOKEN_PROGRAM_ID
        || system_program.key != &system_program::id()
        || ata_program.key != &spl::ATA_PROGRAM_ID
        || rent_ai.key != &solana_program::sysvar::rent::id()
    {
        return Err(err(E_BAD_ACCOUNT));
    }
    if mint.owner != system_program.key || curve_ai.owner != system_program.key {
        return Err(err(E_WRONG_OWNER));
    }
    if *protocol_fee_recipient.key == Pubkey::default() || *creator_fee_recipient.key == Pubkey::default() {
        return Err(err(E_BAD_ACCOUNT));
    }

    let (curve_key, curve_bump) =
        Pubkey::find_program_address(&[b"curve", mint.key.as_ref()], program_id);
    if curve_key != *curve_ai.key {
        return Err(err(E_WRONG_PDA));
    }
    let (pump_authority_key, _) = pump::pump_authority_pda(mint.key);
    if pump_authority_key != *pump_authority.key {
        return Err(err(E_WRONG_PDA));
    }
    // The token vault is owned by the data-less pump authority, which is also
    // the PumpSwap creator: PumpSwap transfers the vault's tokens using the
    // creator as authority, so the owners must match.
    let expected_ata = spl::ata_address(&pump_authority_key, mint.key);
    if expected_ata != *curve_ata.key {
        return Err(err(E_WRONG_PDA));
    }

    let rent = Rent::get()?;
    let mint_rent = rent.minimum_balance(82);
    let curve_rent = rent.minimum_balance(CURVE_LEN);

    // Mint account.
    invoke(
        &spl::create_account(creator.key, mint.key, mint_rent, 82, token_program.key),
        &[creator.clone(), mint.clone(), system_program.clone()],
    )?;
    invoke(
        &spl::initialize_mint(mint.key, TOKEN_DECIMALS, &curve_key),
        &[mint.clone(), rent_ai.clone()],
    )?;

    // Curve account, signed by its own PDA.
    invoke_signed(
        &spl::create_account(creator.key, curve_ai.key, curve_rent, CURVE_LEN as u64, program_id),
        &[creator.clone(), curve_ai.clone(), system_program.clone()],
        &[&[b"curve", mint.key.as_ref(), &[curve_bump]]],
    )?;

    // Curve ATA, then mint the entire supply into it and renounce the authority.
    invoke(
        &spl::create_ata_idempotent(creator.key, curve_ata.key, &pump_authority_key, mint.key),
        &[
            creator.clone(),
            curve_ata.clone(),
            pump_authority.clone(),
            mint.clone(),
            system_program.clone(),
            token_program.clone(),
        ],
    )?;
    // Metadata, while the curve PDA is still the mint authority. Metaplex
    // creates the metadata account itself from the payer, so the account must
    // be system-owned and empty before this call.
    if let Some(req) = metadata {
        if req.metadata_ai.owner != system_program.key {
            return Err(err(E_WRONG_OWNER));
        }
        let (metadata_key, _) = metaplex::metadata_pda(mint.key);
        if metadata_key != *req.metadata_ai.key {
            return Err(err(E_WRONG_PDA));
        }
        let ix = metaplex::create_metadata_v3_instruction(
            metadata_key,
            *mint.key,
            curve_key,
            *creator.key,
            curve_key,
            *system_program.key,
            *rent_ai.key,
            req.name,
            req.symbol,
            req.uri,
        );
        invoke_signed(
            &ix,
            &[
                req.metadata_ai.clone(),
                mint.clone(),
                curve_ai.clone(),
                creator.clone(),
                curve_ai.clone(),
                system_program.clone(),
                rent_ai.clone(),
                req.metaplex_program.clone(),
            ],
            &[&[b"curve", mint.key.as_ref(), &[curve_bump]]],
        )?;
    }

    invoke_signed(
        &spl::mint_to(mint.key, curve_ata.key, &curve_key, TOTAL_SUPPLY),
        &[mint.clone(), curve_ata.clone(), curve_ai.clone()],
        &[&[b"curve", mint.key.as_ref(), &[curve_bump]]],
    )?;
    invoke_signed(
        &spl::renounce_mint_authority(mint.key, &curve_key),
        &[mint.clone(), curve_ai.clone()],
        &[&[b"curve", mint.key.as_ref(), &[curve_bump]]],
    )?;

    let curve = Curve {
        version: LAYOUT_VERSION,
        bump: curve_bump,
        creator: *creator.key,
        mint: *mint.key,
        curve_ata: *curve_ata.key,
        protocol_fee_recipient: *protocol_fee_recipient.key,
        creator_fee_recipient: *creator_fee_recipient.key,
        virtual_sol_reserves: INITIAL_VIRTUAL_SOL,
        virtual_token_reserves: INITIAL_VIRTUAL_TOKEN,
        real_sol_reserves: 0,
        real_token_reserves: INITIAL_REAL_TOKEN,
        protocol_fee_bps: PROTOCOL_FEE_BPS as u16,
        creator_fee_bps,
        graduated: false,
        completed: false,
        pool: Pubkey::default(),
    };
    curve.store(&mut curve_ai.data.borrow_mut())?;

    msg!(
        "curve created mint={} curve={} supply={} sellable={} reserved={}",
        mint.key,
        curve_key,
        TOTAL_SUPPLY,
        INITIAL_REAL_TOKEN,
        RESERVED_FOR_POOL
    );
    Ok(())
}

// ── Buy / sell ────────────────────────────────────────────────────────────

/// Accounts:
///   0 buyer (signer, writable)
///   1 curve (writable)
///   2 mint (readonly)
///   3 curve ATA (writable)
///   4 buyer ATA (writable)
///   5 SOL vault PDA (writable)
///   6 pump authority PDA (readonly) — owner/authority of the curve ATA
///   7 protocol fee recipient (writable)
///   8 creator fee recipient (writable)
///   9 token program
///  10 system program
fn buy(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount_in: u64,
    min_tokens_out: u64,
) -> ProgramResult {
    let it = &mut accounts.iter();
    let buyer = next_account_info(it)?;
    let curve_ai = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let curve_ata = next_account_info(it)?;
    let buyer_ata = next_account_info(it)?;
    let sol_vault = next_account_info(it)?;
    let pump_authority = next_account_info(it)?;
    let protocol_fee_recipient = next_account_info(it)?;
    let creator_fee_recipient = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let system_program = next_account_info(it)?;

    if !buyer.is_signer {
        return Err(err(E_NOT_SIGNER));
    }
    let mut curve = load_curve(program_id, curve_ai)?;
    if pump::sol_vault_pda(mint.key).0 != *sol_vault.key {
        return Err(err(E_WRONG_PDA));
    }
    let (pump_authority_key, pump_authority_bump) = pump::pump_authority_pda(mint.key);
    if pump_authority_key != *pump_authority.key {
        return Err(err(E_WRONG_PDA));
    }
    check_curve_accounts(
        &curve,
        curve_ai,
        mint,
        curve_ata,
        protocol_fee_recipient,
        creator_fee_recipient,
        token_program,
        system_program,
    )?;
    if curve.graduated || curve.completed {
        return Err(err(E_COMPLETED));
    }
    if amount_in == 0 {
        return Err(err(E_ZERO_AMOUNT));
    }
    if token_account_mint(buyer_ata)? != *mint.key {
        return Err(err(E_BAD_TOKEN_ACCOUNT));
    }

    let mut gross = amount_in;
    let mut fees = math::split_fees(gross, curve.creator_fee_bps as u64)?;
    let mut net = gross
        .checked_sub(fees.protocol + fees.creator)
        .ok_or_else(|| err(E_MATH))?;
    let mut tokens_out = math::quote_buy(net, curve.virtual_sol_reserves, curve.virtual_token_reserves)
        .ok_or_else(|| err(E_MATH))?;

    // A buy that would take the last sellable token is capped. The instruction
    // carries a **maximum** input, not an escrowed amount: the buyer is debited
    // exactly `gross` (net + fees), and the unused part of the maximum simply
    // stays in the buyer's wallet. Never refund from the curve — it never
    // received the unused lamports.
    let mut unused = 0u64;
    if tokens_out > curve.real_token_reserves {
        tokens_out = curve.real_token_reserves;
        net = math::quote_buy_in(tokens_out, curve.virtual_sol_reserves, curve.virtual_token_reserves)
            .ok_or_else(|| err(E_MATH))?;
        let total_fee_bps = PROTOCOL_FEE_BPS + curve.creator_fee_bps as u64;
        let gross_needed =
            (net as u128 * math::BPS as u128 + (math::BPS - total_fee_bps) as u128 - 1)
                / (math::BPS - total_fee_bps) as u128;
        if gross_needed > u64::MAX as u128 {
            return Err(err(E_MATH));
        }
        let gross_needed = gross_needed as u64;
        if gross_needed > amount_in {
            return Err(err(E_SLIPPAGE));
        }
        unused = amount_in - gross_needed;
        gross = gross_needed;
        fees = math::split_fees(gross, curve.creator_fee_bps as u64)?;
        net = gross - fees.protocol - fees.creator;
    }
    if tokens_out < min_tokens_out || tokens_out == 0 {
        return Err(err(E_SLIPPAGE));
    }

    // Lamports: buyer pays the SOL vault and both fee recipients. The vault is
    // a system account with no data; the System program can credit it (and
    // create it on the first buy).
    invoke(
        &spl::transfer_lamports(buyer.key, sol_vault.key, net),
        &[buyer.clone(), sol_vault.clone(), system_program.clone()],
    )?;
    if fees.protocol != 0 && buyer.key != protocol_fee_recipient.key {
        invoke(
            &spl::transfer_lamports(buyer.key, protocol_fee_recipient.key, fees.protocol),
            &[buyer.clone(), protocol_fee_recipient.clone(), system_program.clone()],
        )?;
    }
    if fees.creator != 0 && buyer.key != creator_fee_recipient.key {
        invoke(
            &spl::transfer_lamports(buyer.key, creator_fee_recipient.key, fees.creator),
            &[buyer.clone(), creator_fee_recipient.clone(), system_program.clone()],
        )?;
    }

    let pump_seeds: &[&[u8]] = &[b"pump", mint.key.as_ref(), &[pump_authority_bump]];
    invoke_signed(
        &spl::transfer_checked(
            curve_ata.key,
            mint.key,
            buyer_ata.key,
            pump_authority.key,
            tokens_out,
            TOKEN_DECIMALS,
        ),
        &[
            curve_ata.clone(),
            mint.clone(),
            buyer_ata.clone(),
            pump_authority.clone(),
        ],
        &[pump_seeds],
    )?;

    curve.virtual_sol_reserves = curve
        .virtual_sol_reserves
        .checked_add(net)
        .ok_or_else(|| err(E_MATH))?;
    curve.virtual_token_reserves = curve
        .virtual_token_reserves
        .checked_sub(tokens_out)
        .ok_or_else(|| err(E_MATH))?;
    curve.real_sol_reserves = curve
        .real_sol_reserves
        .checked_add(net)
        .ok_or_else(|| err(E_MATH))?;
    curve.real_token_reserves -= tokens_out;
    if curve.real_token_reserves == 0 {
        curve.completed = true;
    }
    curve.store(&mut curve_ai.data.borrow_mut())?;

    msg!(
        "buy payer={} gross={} net={} tokens={} unused={} real_sol={} real_token={} completed={}",
        buyer.key,
        gross,
        net,
        tokens_out,
        unused,
        curve.real_sol_reserves,
        curve.real_token_reserves,
        curve.completed
    );
    Ok(())
}

/// Accounts:
///   0 seller (signer, writable)
///   1 curve (writable)
///   2 mint (readonly)
///   3 seller ATA (writable)
///   4 curve ATA (writable)
///   5 SOL vault PDA (writable)
///   6 protocol fee recipient (writable)
///   7 creator fee recipient (writable)
///   8 token program
///   9 system program
fn sell(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount_in: u64,
    min_sol_out: u64,
) -> ProgramResult {
    let it = &mut accounts.iter();
    let seller = next_account_info(it)?;
    let curve_ai = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let seller_ata = next_account_info(it)?;
    let curve_ata = next_account_info(it)?;
    let sol_vault = next_account_info(it)?;
    let protocol_fee_recipient = next_account_info(it)?;
    let creator_fee_recipient = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let system_program = next_account_info(it)?;

    if !seller.is_signer {
        return Err(err(E_NOT_SIGNER));
    }
    let (sol_vault_key, sol_vault_bump) = pump::sol_vault_pda(mint.key);
    if sol_vault_key != *sol_vault.key {
        return Err(err(E_WRONG_PDA));
    }
    let mut curve = load_curve(program_id, curve_ai)?;
    check_curve_accounts(
        &curve,
        curve_ai,
        mint,
        curve_ata,
        protocol_fee_recipient,
        creator_fee_recipient,
        token_program,
        system_program,
    )?;
    if curve.graduated || curve.completed {
        return Err(err(E_COMPLETED));
    }
    if amount_in == 0 {
        return Err(err(E_ZERO_AMOUNT));
    }
    if token_account_mint(seller_ata)? != *mint.key {
        return Err(err(E_BAD_TOKEN_ACCOUNT));
    }

    let gross = math::quote_sell(amount_in, curve.virtual_sol_reserves, curve.virtual_token_reserves)
        .ok_or_else(|| err(E_MATH))?;
    if gross > curve.real_sol_reserves {
        return Err(err(E_MATH));
    }
    let fees = math::split_fees(gross, curve.creator_fee_bps as u64)?;
    let net = gross
        .checked_sub(fees.protocol + fees.creator)
        .ok_or_else(|| err(E_MATH))?;
    if net < min_sol_out || net == 0 {
        return Err(err(E_SLIPPAGE));
    }

    invoke(
        &spl::transfer_checked(
            seller_ata.key,
            mint.key,
            curve_ata.key,
            seller.key,
            amount_in,
            TOKEN_DECIMALS,
        ),
        &[seller_ata.clone(), mint.clone(), curve_ata.clone(), seller.clone()],
    )?;

    if sol_vault.lamports() < gross {
        return Err(err(E_MATH));
    }
    let sol_seeds: &[&[u8]] = &[b"sol", mint.key.as_ref(), &[sol_vault_bump]];
    invoke_signed(
        &spl::transfer_lamports(sol_vault.key, seller.key, net),
        &[sol_vault.clone(), seller.clone(), system_program.clone()],
        &[sol_seeds],
    )?;
    if fees.protocol != 0 {
        invoke_signed(
            &spl::transfer_lamports(sol_vault.key, protocol_fee_recipient.key, fees.protocol),
            &[
                sol_vault.clone(),
                protocol_fee_recipient.clone(),
                system_program.clone(),
            ],
            &[sol_seeds],
        )?;
    }
    if fees.creator != 0 {
        invoke_signed(
            &spl::transfer_lamports(sol_vault.key, creator_fee_recipient.key, fees.creator),
            &[
                sol_vault.clone(),
                creator_fee_recipient.clone(),
                system_program.clone(),
            ],
            &[sol_seeds],
        )?;
    }

    curve.virtual_sol_reserves -= gross;
    curve.virtual_token_reserves = curve
        .virtual_token_reserves
        .checked_add(amount_in)
        .ok_or_else(|| err(E_MATH))?;
    curve.real_sol_reserves -= gross;
    curve.real_token_reserves = curve
        .real_token_reserves
        .checked_add(amount_in)
        .ok_or_else(|| err(E_MATH))?;
    curve.store(&mut curve_ai.data.borrow_mut())?;

    msg!(
        "sell seller={} tokens={} gross={} net={} real_sol={} real_token={}",
        seller.key,
        amount_in,
        gross,
        net,
        curve.real_sol_reserves,
        curve.real_token_reserves
    );
    Ok(())
}

// ── Graduate ──────────────────────────────────────────────────────────────

/// Accounts:
///   0 payer (signer, writable)
///   1 curve (writable)
///   2 mint (readonly)
///   3 curve ATA (writable)
///   4 SOL vault PDA (writable)
///   5 pump authority PDA (readonly) — owner/authority of the curve ATA
///   6 graduation vault PDA (writable)
///   7 graduation vault ATA (writable)
///   8 token program
///   9 system program
///  10 ATA program
fn graduate(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let curve_ai = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let curve_ata = next_account_info(it)?;
    let sol_vault = next_account_info(it)?;
    let pump_authority = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let vault_ata = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let system_program = next_account_info(it)?;
    let ata_program = next_account_info(it)?;

    if !payer.is_signer || !payer.is_writable {
        return Err(err(E_NOT_SIGNER));
    }
    if token_program.key != &spl::TOKEN_PROGRAM_ID
        || system_program.key != &system_program::id()
        || ata_program.key != &spl::ATA_PROGRAM_ID
    {
        return Err(err(E_BAD_ACCOUNT));
    }
    let (sol_vault_key, sol_vault_bump) = pump::sol_vault_pda(mint.key);
    if sol_vault_key != *sol_vault.key {
        return Err(err(E_WRONG_PDA));
    }
    let (pump_authority_key, pump_authority_bump) = pump::pump_authority_pda(mint.key);
    if pump_authority_key != *pump_authority.key {
        return Err(err(E_WRONG_PDA));
    }
    let mut curve = load_curve(program_id, curve_ai)?;
    if curve.mint != *mint.key || curve.curve_ata != *curve_ata.key {
        return Err(err(E_BAD_ACCOUNT));
    }
    if curve.graduated {
        return Err(err(E_GRADUATED));
    }
    if !curve.completed {
        return Err(err(E_NOT_COMPLETE));
    }
    let (vault_key, _) =
        Pubkey::find_program_address(&[b"graduate", mint.key.as_ref()], program_id);
    if vault_key != *vault.key || spl::ata_address(&vault_key, mint.key) != *vault_ata.key {
        return Err(err(E_WRONG_PDA));
    }

    invoke(
        &spl::create_ata_idempotent(payer.key, vault_ata.key, vault.key, mint.key),
        &[
            payer.clone(),
            vault_ata.clone(),
            vault.clone(),
            mint.clone(),
            system_program.clone(),
            token_program.clone(),
        ],
    )?;

    // Everything left in the curve ATA belongs to the pool, including the
    // 206.9M slice that was never sellable.
    let tokens_to_vault = curve
        .real_token_reserves
        .checked_add(RESERVED_FOR_POOL)
        .ok_or_else(|| err(E_MATH))?;
    let pump_seeds: &[&[u8]] = &[b"pump", mint.key.as_ref(), &[pump_authority_bump]];
    invoke_signed(
        &spl::transfer_checked(
            curve_ata.key,
            mint.key,
            vault_ata.key,
            pump_authority.key,
            tokens_to_vault,
            TOKEN_DECIMALS,
        ),
        &[
            curve_ata.clone(),
            mint.clone(),
            vault_ata.clone(),
            pump_authority.clone(),
        ],
        &[pump_seeds],
    )?;

    // The SOL lives in a data-less vault PDA, so the System program can move it.
    if curve.real_sol_reserves != 0 {
        let sol_seeds: &[&[u8]] = &[b"sol", mint.key.as_ref(), &[sol_vault_bump]];
        invoke_signed(
            &spl::transfer_lamports(sol_vault.key, vault.key, curve.real_sol_reserves),
            &[sol_vault.clone(), vault.clone(), system_program.clone()],
            &[sol_seeds],
        )?;
    }

    curve.graduated = true;
    curve.store(&mut curve_ai.data.borrow_mut())?;

    msg!(
        "graduated mint={} vault={} tokens={} sol={}",
        mint.key,
        vault.key,
        tokens_to_vault,
        curve.real_sol_reserves
    );
    let _ = GRADUATION_SOL;
    Ok(())
}

// ── Graduate into PumpSwap ────────────────────────────────────────────────

/// Accounts:
///   0 payer (signer, writable) — funds the PumpSwap account rent
///   1 curve (writable)
///   2 mint (readonly)
///   3 curve ATA (writable) — holds every remaining token
///   4 SOL vault PDA (writable) — holds the raised SOL; data-less
///   5 pump authority PDA (writable) — the pool creator / LP owner; data-less
///   6 curve wSOL ATA (writable) — created, funded, synced, closed here
///   7 PumpSwap pool (writable)
///   8 PumpSwap global config (readonly)
///   9 PumpSwap LP mint (writable)
///  10 pump-authority LP ATA (writable) — PumpSwap creates it; LP stays locked
///  11 pool base ATA (writable)
///  12 pool quote ATA (writable)
///  13 PumpSwap event authority (readonly)
///  14 PumpSwap program (readonly)
///  15 wSOL mint (readonly)
///  16 token program (readonly)
///  17 token-2022 program (readonly)
///  18 system program (readonly)
///  19 ATA program (readonly)
fn graduate_pumpswap(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    index: u16,
) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let curve_ai = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let curve_ata = next_account_info(it)?;
    let sol_vault = next_account_info(it)?;
    let pump_authority = next_account_info(it)?;
    let curve_wsol_ata = next_account_info(it)?;
    let pool = next_account_info(it)?;
    let global_config = next_account_info(it)?;
    let lp_mint = next_account_info(it)?;
    let curve_lp_ata = next_account_info(it)?;
    let pool_base_ata = next_account_info(it)?;
    let pool_quote_ata = next_account_info(it)?;
    let event_authority = next_account_info(it)?;
    let pump_program = next_account_info(it)?;
    let wsol_mint = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let token_2022_program = next_account_info(it)?;
    let system_program = next_account_info(it)?;
    let ata_program = next_account_info(it)?;

    if !payer.is_signer || !payer.is_writable {
        return Err(err(E_NOT_SIGNER));
    }
    if token_program.key != &spl::TOKEN_PROGRAM_ID
        || token_2022_program.key != &pump::TOKEN_2022_PROGRAM_ID
        || system_program.key != &system_program::id()
        || ata_program.key != &spl::ATA_PROGRAM_ID
        || pump_program.key != &pump::PUMP_AMM_PROGRAM_ID
        || wsol_mint.key != &pump::WSOL_MINT
    {
        return Err(err(E_BAD_ACCOUNT));
    }

    let mut curve = load_curve(program_id, curve_ai)?;
    if curve.mint != *mint.key || curve.curve_ata != *curve_ata.key {
        return Err(err(E_BAD_ACCOUNT));
    }
    if curve.graduated {
        return Err(err(E_GRADUATED));
    }
    if !curve.completed {
        return Err(err(E_NOT_COMPLETE));
    }

    // Every PDA and ATA is derived here; nothing is trusted because it was
    // passed. The pool address commits to the data-less pump authority, so no
    // one else can front-run the pool into existence.
    let (sol_vault_key, sol_vault_bump) = pump::sol_vault_pda(mint.key);
    let (pump_authority_key, pump_authority_bump) = pump::pump_authority_pda(mint.key);
    if sol_vault_key != *sol_vault.key || pump_authority_key != *pump_authority.key {
        return Err(err(E_WRONG_PDA));
    }
    if pump::pool_pda(index, pump_authority.key, mint.key, &pump::WSOL_MINT).0 != *pool.key {
        return Err(err(E_WRONG_PDA));
    }
    if pump::lp_mint_pda(pool.key).0 != *lp_mint.key {
        return Err(err(E_WRONG_PDA));
    }
    if pump::global_config_pda().0 != *global_config.key
        || pump::event_authority_pda().0 != *event_authority.key
    {
        return Err(err(E_WRONG_PDA));
    }
    if spl::ata_address_for(pump_authority.key, &pump::WSOL_MINT, token_program.key)
        != *curve_wsol_ata.key
        || spl::ata_address_for(pump_authority.key, lp_mint.key, token_2022_program.key)
            != *curve_lp_ata.key
        || spl::ata_address_for(pool.key, mint.key, token_program.key) != *pool_base_ata.key
        || spl::ata_address_for(pool.key, &pump::WSOL_MINT, token_program.key)
            != *pool_quote_ata.key
    {
        return Err(err(E_WRONG_PDA));
    }

    let tokens_to_pool = curve
        .real_token_reserves
        .checked_add(RESERVED_FOR_POOL)
        .ok_or_else(|| err(E_MATH))?;
    if curve.real_sol_reserves == 0 {
        return Err(err(E_NOT_COMPLETE));
    }
    if sol_vault.lamports() < curve.real_sol_reserves {
        return Err(err(E_MATH));
    }
    if curve_ata.owner != token_program.key || token_account_mint(curve_ata)? != *mint.key {
        return Err(err(E_BAD_TOKEN_ACCOUNT));
    }
    // The curve ATA must hold at least the pool allocation. Extra tokens are
    // possible: anyone can transfer to the ATA, and rejecting on an exact
    // balance would let a one-unit donation block graduation forever. The
    // surplus stays in the curve ATA, which no instruction can move after
    // `graduated`.
    if token_account_amount(curve_ata)? < tokens_to_pool {
        return Err(err(E_BAD_TOKEN_ACCOUNT));
    }

    // 1 — wrap the raised SOL. The vault is data-less, so the System program
    // can move it; the wSOL ATA is created by the payer and funded by the vault.
    invoke(
        &spl::create_ata_idempotent_for(
            payer.key,
            curve_wsol_ata.key,
            pump_authority.key,
            wsol_mint.key,
            token_program.key,
        ),
        &[
            payer.clone(),
            curve_wsol_ata.clone(),
            pump_authority.clone(),
            wsol_mint.clone(),
            system_program.clone(),
            token_program.clone(),
        ],
    )?;
    let sol_seeds: &[&[u8]] = &[b"sol", mint.key.as_ref(), &[sol_vault_bump]];
    invoke_signed(
        &spl::transfer_lamports(sol_vault.key, curve_wsol_ata.key, curve.real_sol_reserves),
        &[sol_vault.clone(), curve_wsol_ata.clone(), system_program.clone()],
        &[sol_seeds],
    )?;
    invoke(
        &spl::sync_native(curve_wsol_ata.key),
        &[curve_wsol_ata.clone()],
    )?;

    // 2 — fund the data-less pump authority, which pays for the accounts
    // PumpSwap creates. It is funded from the payer (both are data-less).
    invoke(
        &spl::transfer_lamports(payer.key, pump_authority.key, PUMP_RENT_BUDGET),
        &[
            payer.clone(),
            pump_authority.clone(),
            system_program.clone(),
        ],
    )?;

    // 3 — the pool-side ATAs. The pool account does not exist yet; the ATA
    // program only hashes the owner, so no signature from the pool is needed.
    invoke(
        &spl::create_ata_idempotent_for(
            payer.key,
            pool_base_ata.key,
            pool.key,
            mint.key,
            token_program.key,
        ),
        &[
            payer.clone(),
            pool_base_ata.clone(),
            pool.clone(),
            mint.clone(),
            system_program.clone(),
            token_program.clone(),
        ],
    )?;
    invoke(
        &spl::create_ata_idempotent_for(
            payer.key,
            pool_quote_ata.key,
            pool.key,
            wsol_mint.key,
            token_program.key,
        ),
        &[
            payer.clone(),
            pool_quote_ata.clone(),
            pool.clone(),
            wsol_mint.clone(),
            system_program.clone(),
            token_program.clone(),
        ],
    )?;

    // 4 — create the pool. PumpSwap creates the LP mint and the pump
    // authority's LP ATA (it is the only party that can: the LP mint does not
    // exist until now). The pump authority signs as the pool's creator.
    let ix = pump::create_pool_instruction(
        pool.key,
        global_config.key,
        pump_authority.key,
        mint.key,
        wsol_mint.key,
        lp_mint.key,
        curve_ata.key,
        curve_wsol_ata.key,
        curve_lp_ata.key,
        pool_base_ata.key,
        pool_quote_ata.key,
        event_authority.key,
        index,
        tokens_to_pool,
        curve.real_sol_reserves,
    );
    let pump_seeds: &[&[u8]] = &[b"pump", mint.key.as_ref(), &[pump_authority_bump]];
    invoke_signed(
        &ix,
        &[
            pool.clone(),
            global_config.clone(),
            pump_authority.clone(),
            mint.clone(),
            wsol_mint.clone(),
            lp_mint.clone(),
            curve_ata.clone(),
            curve_wsol_ata.clone(),
            curve_lp_ata.clone(),
            pool_base_ata.clone(),
            pool_quote_ata.clone(),
            system_program.clone(),
            token_2022_program.clone(),
            token_program.clone(),
            token_program.clone(),
            ata_program.clone(),
            event_authority.clone(),
            pump_program.clone(),
        ],
        &[pump_seeds],
    )?;

    // 5 — the LP lands in the pump authority's ATA. The lock is structural: the
    // pool's creator is the pump authority, PumpSwap creates the LP ATA from
    // the (creator, token-2022, lp_mint) seeds, and no instruction in this
    // program can move it. If the runtime did expose the fresh account's data,
    // also reject a wrong mint or a zero balance; otherwise the E2E asserts
    // both over RPC after the transaction.
    if let Ok(seen_mint) = token_account_mint(curve_lp_ata) {
        if seen_mint != *lp_mint.key || token_account_amount(curve_lp_ata).unwrap_or(0) == 0 {
            return Err(err(E_LP_NOT_LOCKED));
        }
    }

    // 6 — unwrap: close the now-empty wSOL account back to the payer.
    invoke_signed(
        &spl::close_account(curve_wsol_ata.key, payer.key, pump_authority.key),
        &[
            curve_wsol_ata.clone(),
            payer.clone(),
            pump_authority.clone(),
        ],
        &[pump_seeds],
    )?;

    // 7 — refund a fixed part of the rent budget. Reading the authority's
    // lamports after the CPI is not reliable; PUMP_RENT_BUDGET is set well
    // above the actual rent (≈6.3M), so the transfer cannot overdraw. The
    // remainder (≈3–5M lamports) stays locked in the data-less authority.
    invoke_signed(
        &spl::transfer_lamports(pump_authority.key, payer.key, PUMP_RENT_REFUND),
        &[
            pump_authority.clone(),
            payer.clone(),
            system_program.clone(),
        ],
        &[pump_seeds],
    )?;

    let raised = curve.real_sol_reserves;
    curve.graduated = true;
    curve.pool = *pool.key;
    curve.store(&mut curve_ai.data.borrow_mut())?;

    msg!(
        "graduated-to-pumpswap mint={} pool={} tokens={} sol={} lp-owner={}",
        mint.key,
        pool.key,
        tokens_to_pool,
        raised,
        pump_authority.key
    );
    Ok(())
}

// ── Checks ────────────────────────────────────────────────────────────────

fn load_curve(program_id: &Pubkey, curve_ai: &AccountInfo) -> Result<Curve, ProgramError> {
    if curve_ai.owner != program_id {
        return Err(err(E_WRONG_OWNER));
    }
    Curve::load(&curve_ai.data.borrow()).map_err(|_| err(E_NOT_INITIALIZED))
}

fn check_curve_accounts(
    curve: &Curve,
    curve_ai: &AccountInfo,
    mint: &AccountInfo,
    curve_ata: &AccountInfo,
    protocol_fee_recipient: &AccountInfo,
    creator_fee_recipient: &AccountInfo,
    token_program: &AccountInfo,
    system_program: &AccountInfo,
) -> ProgramResult {
    if token_program.key != &spl::TOKEN_PROGRAM_ID || system_program.key != &system_program::id() {
        return Err(err(E_BAD_ACCOUNT));
    }
    if curve.mint != *mint.key
        || curve.curve_ata != *curve_ata.key
        || curve.protocol_fee_recipient != *protocol_fee_recipient.key
        || curve.creator_fee_recipient != *creator_fee_recipient.key
    {
        return Err(err(E_BAD_ACCOUNT));
    }
    if curve_ai.owner == &system_program::id() {
        return Err(err(E_NOT_INITIALIZED));
    }
    Ok(())
}

/// Reads the mint field of an SPL token account (layout: mint, owner, amount).
fn token_account_mint(ai: &AccountInfo) -> Result<Pubkey, ProgramError> {
    let data = ai.data.borrow();
    if data.len() < 72 {
        return Err(err(E_BAD_TOKEN_ACCOUNT));
    }
    let mut raw = [0u8; 32];
    raw.copy_from_slice(&data[0..32]);
    Ok(Pubkey::new_from_array(raw))
}

/// Reads the amount field of an SPL token account (offset 64).
fn token_account_amount(ai: &AccountInfo) -> Result<u64, ProgramError> {
    let data = ai.data.borrow();
    if data.len() < 72 {
        return Err(err(E_BAD_TOKEN_ACCOUNT));
    }
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_account_mint_reads_the_first_field() {
        let mut data = vec![0u8; 165];
        data[0..32].copy_from_slice(&[7u8; 32]);
        data[64..72].copy_from_slice(&1234u64.to_le_bytes());
        let key = Pubkey::new_from_array([9u8; 32]);
        let owner = Pubkey::new_from_array([8u8; 32]);
        let mut lamports = 0;
        let ai = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false, 0);
        assert_eq!(token_account_mint(&ai).unwrap(), Pubkey::new_from_array([7u8; 32]));
        assert_eq!(token_account_amount(&ai).unwrap(), 1234);
    }

    #[test]
    fn a_short_token_account_is_rejected() {
        let key = Pubkey::new_from_array([9u8; 32]);
        let owner = Pubkey::new_from_array([8u8; 32]);
        let mut lamports = 0;
        let mut data = vec![0u8; 10];
        let ai = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false, 0);
        assert!(token_account_mint(&ai).is_err());
    }
}
