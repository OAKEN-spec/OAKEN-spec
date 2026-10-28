// OAKEN Curve — client-side instruction builders.
//
// These mirror `src/instruction.rs` and the account orders documented above
// each processor function. They are pure: no network, no wallet. The E2E
// script and the site use the same builders, so a layout drift is caught in
// `test/builders.test.mjs` rather than on chain.

import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js'

export const PROGRAM_ID = new PublicKey('BvTeztC4ENG8x2TW19AkiJ9EnC9JNresmA1pE6MBWpRi')
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')
export const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')

const PUMP_GLOBAL_CONFIG = PublicKey.findProgramAddressSync(
  [Buffer.from('global_config')],
  PUMP_AMM_PROGRAM_ID,
)[0]
const PUMP_EVENT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  PUMP_AMM_PROGRAM_ID,
)[0]

export function curvePda(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('curve'), mint.toBuffer()], PROGRAM_ID)
}

/** `["metadata", metaplex, mint]` under the Metaplex Token Metadata program. */
export function metadataPda(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_PROGRAM_ID,
  )
}

export function graduateVaultPda(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('graduate'), mint.toBuffer()], PROGRAM_ID)
}

/** The data-less system account that holds the curve's raised SOL. */
export function solVaultPda(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('sol'), mint.toBuffer()], PROGRAM_ID)[0]
}

/** The data-less PumpSwap pool creator and LP owner. */
export function pumpAuthorityPda(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('pump'), mint.toBuffer()], PROGRAM_ID)[0]
}

export function curveAta(mint) {
  return ataFor(pumpAuthorityPda(mint), mint, TOKEN_PROGRAM_ID)
}

export function graduateVaultAta(mint) {
  const [vault] = graduateVaultPda(mint)
  return PublicKey.findProgramAddressSync(
    [vault.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  )[0]
}

export function ata(wallet, mint) {
  return ataFor(wallet, mint, TOKEN_PROGRAM_ID)
}

export function ataFor(wallet, mint, tokenProgram) {
  return PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  )[0]
}

export function pumpPoolPda(mint, index = 0, creator = pumpAuthorityPda(mint)) {
  const idx = Buffer.alloc(2)
  idx.writeUInt16LE(index)
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), idx, creator.toBuffer(), mint.toBuffer(), WSOL_MINT.toBuffer()],
    PUMP_AMM_PROGRAM_ID,
  )
}

export function pumpLpMintPda(pool) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_lp_mint'), pool.toBuffer()],
    PUMP_AMM_PROGRAM_ID,
  )
}

export const pumpGlobalConfigPda = PUMP_GLOBAL_CONFIG
export const pumpEventAuthorityPda = PUMP_EVENT_AUTHORITY

export function curveWsolAta(mint) {
  return ataFor(pumpAuthorityPda(mint), WSOL_MINT, TOKEN_PROGRAM_ID)
}

export function curveLpAta(mint, lpMint) {
  return ataFor(pumpAuthorityPda(mint), lpMint, TOKEN_2022_PROGRAM_ID)
}

export function poolBaseAta(pool, mint) {
  return ataFor(pool, mint, TOKEN_PROGRAM_ID)
}

export function poolQuoteAta(pool) {
  return ataFor(pool, WSOL_MINT, TOKEN_PROGRAM_ID)
}

/** Decodes the 232-byte curve account. Throws on any other length. */
export function decodeCurve(data) {
  if (data.length !== 232) throw new Error('curve account is ' + data.length + ' bytes')
  const key = (at) => new PublicKey(data.subarray(at, at + 32))
  const u64 = (at) => data.readBigUInt64LE(at)
  return {
    version: data[0], bump: data[1],
    creator: key(2), mint: key(34), curveAta: key(66),
    protocolFeeRecipient: key(98), creatorFeeRecipient: key(130),
    virtualSol: u64(162), virtualToken: u64(170),
    realSol: u64(178), realToken: u64(186),
    protocolFeeBps: data.readUInt16LE(194), creatorFeeBps: data.readUInt16LE(196),
    graduated: data[198] === 1, completed: data[199] === 1,
    pool: key(200),
  }
}

function u16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}

function u64(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}

export function createCurveIx({ creator, mint, protocolFeeRecipient, creatorFeeRecipient, creatorFeeBps }) {
  const [curve, bump] = curvePda(mint)
  return {
    instruction: new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: creator, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: true, isWritable: true },
        { pubkey: curve, isSigner: false, isWritable: true },
        { pubkey: curveAta(mint), isSigner: false, isWritable: true },
        { pubkey: pumpAuthorityPda(mint), isSigner: false, isWritable: false },
        { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },
        { pubkey: creatorFeeRecipient, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([0]), u16(creatorFeeBps)]),
    }),
    curve,
    bump,
  }
}

function curveString(value, max, label) {
  const text = String(value || '')
  const bytes = Buffer.from(text, 'utf8')
  if (!bytes.length || bytes.length > max) {
    throw new Error(`${label} must be 1–${max} UTF-8 bytes`)
  }
  return Buffer.concat([u16(bytes.length), bytes])
}

/**
 * `CreateWithMetadata` (tag 5): the same 11 accounts as `Create`, then the
 * Metaplex metadata PDA (writable) and the Token Metadata program (readonly).
 *
 * The program writes the metadata through a CPI **before** it mints and
 * renounces; after the renounce the curve PDA can no longer sign for Metaplex.
 */
export function createCurveWithMetadataIx({
  creator, mint, protocolFeeRecipient, creatorFeeRecipient, creatorFeeBps,
  name, symbol, uri,
}) {
  const [curve, bump] = curvePda(mint)
  const [metadata] = metadataPda(mint)
  return {
    instruction: new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: creator, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: true, isWritable: true },
        { pubkey: curve, isSigner: false, isWritable: true },
        { pubkey: curveAta(mint), isSigner: false, isWritable: true },
        { pubkey: pumpAuthorityPda(mint), isSigner: false, isWritable: false },
        { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },
        { pubkey: creatorFeeRecipient, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: metadata, isSigner: false, isWritable: true },
        { pubkey: METAPLEX_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        Buffer.from([5]),
        u16(creatorFeeBps),
        curveString(name, 32, 'name'),
        curveString(symbol, 10, 'symbol'),
        curveString(uri, 200, 'uri'),
      ]),
    }),
    curve,
    metadata,
    bump,
  }
}

export function buyIx({ buyer, mint, buyerAta, protocolFeeRecipient, creatorFeeRecipient, amountIn, minTokensOut }) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: curvePda(mint)[0], isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: curveAta(mint), isSigner: false, isWritable: true },
      { pubkey: buyerAta, isSigner: false, isWritable: true },
      { pubkey: solVaultPda(mint), isSigner: false, isWritable: true },
      { pubkey: pumpAuthorityPda(mint), isSigner: false, isWritable: false },
      { pubkey: protocolFeeRecipient, isSigner: false, isWritable: true },
      { pubkey: creatorFeeRecipient, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([1]), u64(amountIn), u64(minTokensOut)]),
  })
}

export function sellIx({ seller, mint, sellerAta, protocolFeeRecipient, creatorFeeRecipient, amountIn, minSolOut }) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: seller, isSigner: true, isWritable: true },
      { pubkey: curvePda(mint)[0], isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: sellerAta, isSigner: false, isWritable: true },
      { pubkey: curveAta(mint), isSigner: false, isWritable: true },
      { pubkey: solVaultPda(mint), isSigner: false, isWritable: true },
      { pubkey: protocolFeeRecipient, isSigner: false, isWritable: true },
      { pubkey: creatorFeeRecipient, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([2]), u64(amountIn), u64(minSolOut)]),
  })
}

export function graduateIx({ payer, mint }) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: curvePda(mint)[0], isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: curveAta(mint), isSigner: false, isWritable: true },
      { pubkey: solVaultPda(mint), isSigner: false, isWritable: true },
      { pubkey: pumpAuthorityPda(mint), isSigner: false, isWritable: false },
      { pubkey: graduateVaultPda(mint)[0], isSigner: false, isWritable: true },
      { pubkey: graduateVaultAta(mint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([3]),
  })
}

/**
 * Graduation into a permissionless PumpSwap pool. A data-less `pump` PDA is the
 * pool creator and owns the LP tokens, so the LP is locked (no instruction can
 * move it) and the pool's account rent can be paid/refunded with plain System
 * transfers. The curve's raised SOL lives in a data-less `sol` PDA for the same
 * reason.
 *
 * The transaction also needs a compute-unit limit (PumpSwap creates four
 * accounts and runs several CPIs): add
 * `ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 })`.
 */
export function graduatePumpSwapIx({ payer, mint, index = 0 }) {
  const [curve] = curvePda(mint)
  const pumpAuthority = pumpAuthorityPda(mint)
  const [pool] = pumpPoolPda(mint, index, pumpAuthority)
  const [lpMint] = pumpLpMintPda(pool)
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: curve, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: curveAta(mint), isSigner: false, isWritable: true },
      { pubkey: solVaultPda(mint), isSigner: false, isWritable: true },
      { pubkey: pumpAuthority, isSigner: false, isWritable: true },
      { pubkey: curveWsolAta(mint), isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: PUMP_GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: lpMint, isSigner: false, isWritable: true },
      { pubkey: curveLpAta(mint, lpMint), isSigner: false, isWritable: true },
      { pubkey: poolBaseAta(pool, mint), isSigner: false, isWritable: true },
      { pubkey: poolQuoteAta(pool), isSigner: false, isWritable: true },
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([4]), u16(index)]),
  })
}
