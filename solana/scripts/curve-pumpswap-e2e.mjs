// OAKEN Curve → PumpSwap graduation, end-to-end on a **forked mainnet** validator.
//
//   node scripts/curve-pumpswap-e2e.mjs              # validator already running
//   node scripts/curve-pumpswap-e2e.mjs --start      # spawns a validator that clones PumpSwap
//
// The validator needs the real PumpSwap program and its two global PDAs, plus
// the SPL Token / Token-2022 / ATA programs. `--start` does that with
// `solana-test-validator --clone-upgradeable-program … --url <mainnet>`, which
// is why this runs on Linux/CI: Windows needs symlink privileges (error 1314).
//
// Assertions are read back from the chain: the curve bytes (pool slot), the
// PumpSwap pool account, the pool's reserves, the LP mint and the curve's LP
// ATA (locked liquidity), and the closed wSOL account.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID, getMint, getAccount, createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token'
import {
  PROGRAM_ID, PUMP_AMM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WSOL_MINT,
  curvePda, curveAta, createCurveIx, buyIx, graduatePumpSwapIx, decodeCurve,
  pumpPoolPda, pumpLpMintPda, pumpGlobalConfigPda, pumpEventAuthorityPda, pumpAuthorityPda,
  curveWsolAta, curveLpAta, poolBaseAta, poolQuoteAta,
} from '../curve-program/client.mjs'

const RPC = process.env.RPC || 'http://127.0.0.1:8899'
const LOCAL = /127\.0\.0\.1|localhost/.test(RPC)
const CLONE_URL = process.env.CLONE_URL || 'https://api.mainnet-beta.solana.com'
const ONE = 1_000_000n
const SUPPLY = 1_000_000_000n * ONE
const RESERVED = 206_900_000n * ONE
const SOL = 1_000_000_000n

let ok = 0, bad = 0
const check = (label, got, want) => {
  const pass = String(got) === String(want)
  if (pass) ok++; else bad++
  console.log(`  ${pass ? '✓' : '✗'} ${label}${pass ? '' : `   expected ${want}, got ${got}`}`)
}

/** PumpSwap `Pool` account header (Anchor discriminator included). */
function decodePool(data) {
  const key = (at) => new PublicKey(data.subarray(at, at + 32))
  return {
    discriminator: data.subarray(0, 8).toString('hex'),
    bump: data[8],
    index: data.readUInt16LE(9),
    creator: key(11),
    baseMint: key(43),
    quoteMint: key(75),
    lpMint: key(107),
    poolBaseTokenAccount: key(139),
    poolQuoteTokenAccount: key(171),
    lpSupply: data.readBigUInt64LE(203),
  }
}

async function send(conn, tx, signers) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = signers[0].publicKey
  tx.sign(...signers)
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 })
  for (let i = 0; i < 180; i++) {
    const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })
    const v = st.value[0]
    if (v?.err) throw new Error('transaction failed: ' + JSON.stringify(v.err) + ' · ' + sig)
    if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) return sig
    if (i % 5 === 0) {
      const height = await conn.getBlockHeight('confirmed').catch(() => 0)
      if (height > lastValidBlockHeight) throw new Error('expired ' + sig)
    }
    await sleep(1000)
  }
  throw new Error('timed out: ' + sig)
}

async function main() {
  let validator = null
  if (process.argv.includes('--start')) {
    const so = path.resolve(import.meta.dirname, '../target/deploy/oaken_curve.so')
    validator = spawn('solana-test-validator', [
      '--bpf-program', PROGRAM_ID.toBase58(), so,
      '--clone-upgradeable-program', PUMP_AMM_PROGRAM_ID.toBase58(),
      '--clone', pumpGlobalConfigPda.toBase58(),
      '--clone', pumpEventAuthorityPda.toBase58(),
      // SPL Token is a BPF v2 program; Token-2022 and the ATA program are upgradeable.
      '--clone', TOKEN_PROGRAM_ID.toBase58(),
      '--clone-upgradeable-program', TOKEN_2022_PROGRAM_ID.toBase58(),
      '--clone-upgradeable-program', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      '--url', CLONE_URL,
      '--reset', '--quiet',
    ], { stdio: 'inherit' })
    // Cloning five programs from mainnet takes a while; poll until RPC answers.
    let up = false
    for (let i = 0; i < 180 && !up; i++) {
      try { await new Connection(RPC, 'confirmed').getSlot(); up = true } catch { await sleep(1000) }
    }
    if (!up) throw new Error('validator did not come up within 180s')
  }
  const conn = new Connection(RPC, 'confirmed')
  const payerFile = process.env.PAYER_KEYPAIR || path.join(os.homedir(), '.config', 'solana', 'id.json')
  const payer = fs.existsSync(payerFile)
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerFile, 'utf8'))))
    : Keypair.generate()
  if (LOCAL) {
    const sig = await conn.requestAirdrop(payer.publicKey, 500 * LAMPORTS_PER_SOL)
    await conn.confirmTransaction(sig, 'confirmed')
  }
  console.log('payer =', payer.publicKey.toBase58())
  const feeRecipient = Keypair.generate().publicKey

  const mint = Keypair.generate()
  const [curve] = curvePda(mint.publicKey)
  const [pool] = pumpPoolPda(mint.publicKey, 0)
  const [lpMint] = pumpLpMintPda(pool)
  const pumpAuthority = pumpAuthorityPda(mint.publicKey)
  console.log('mint  =', mint.publicKey.toBase58())
  console.log('curve =', curve.toBase58(), 'pool =', pool.toBase58())

  // 1 — create the curve
  {
    const { instruction } = createCurveIx({
      creator: payer.publicKey, mint: mint.publicKey,
      protocolFeeRecipient: feeRecipient, creatorFeeRecipient: feeRecipient,
      creatorFeeBps: 5,
    })
    await send(conn, new Transaction().add(instruction), [payer, mint])
    const c = decodeCurve((await conn.getAccountInfo(curve)).data)
    check('fresh curve starts with an empty pool slot', c.pool.toBase58(), PublicKey.default.toBase58())
  }

  // buyer ATA
  const buyerAta = (await import('@solana/spl-token')).getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey)
  await send(conn, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, buyerAta, payer.publicKey, mint.publicKey),
  ), [payer])

  // 2 — buy to completion (the cap refunds whatever is above ~85 SOL)
  {
    await send(conn, new Transaction().add(buyIx({
      buyer: payer.publicKey, mint: mint.publicKey, buyerAta,
      protocolFeeRecipient: feeRecipient, creatorFeeRecipient: feeRecipient,
      amountIn: 200n * SOL, minTokensOut: 0,
    })), [payer])
    const c = decodeCurve((await conn.getAccountInfo(curve)).data)
    check('curve completed', c.completed, true)
    check('no sellable tokens left', c.realToken, 0n)
    check('about 85 SOL raised', c.realSol >= 85n * SOL && c.realSol < 87n * SOL, true)
  }

  const raised = decodeCurve((await conn.getAccountInfo(curve)).data).realSol

  // 3 — graduate into PumpSwap
  {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }))
      .add(graduatePumpSwapIx({ payer: payer.publicKey, mint: mint.publicKey }))
    await send(conn, tx, [payer])
    const c = decodeCurve((await conn.getAccountInfo(curve)).data)
    check('curve graduated', c.graduated, true)
    check('curve records the pool', c.pool.toBase58(), pool.toBase58())
    check('curve token account is empty', (await getAccount(conn, curveAta(mint.publicKey))).amount, 0n)
    let wsolGone = false
    try { await getAccount(conn, curveWsolAta(mint.publicKey)) } catch { wsolGone = true }
    check('wSOL account was closed', wsolGone, true)
  }

  // 4 — the PumpSwap side
  {
    const info = await conn.getAccountInfo(pool)
    check('pool account exists', info !== null, true)
    const p = decodePool(info.data)
    check('pool creator is the data-less pump authority', p.creator.toBase58(), pumpAuthority.toBase58())
    check('pool base mint is the curve token', p.baseMint.toBase58(), mint.publicKey.toBase58())
    check('pool quote mint is wSOL', p.quoteMint.toBase58(), WSOL_MINT.toBase58())
    check('pool LP mint is the derived PDA', p.lpMint.toBase58(), lpMint.toBase58())

    const base = await getAccount(conn, poolBaseAta(pool, mint.publicKey))
    const quote = await getAccount(conn, poolQuoteAta(pool))
    check('pool holds the reserved slice', base.amount, RESERVED)
    check('pool holds the raised SOL', quote.amount, raised)

    const lp = await getMint(conn, lpMint)
    const locked = await getAccount(conn, curveLpAta(mint.publicKey, lpMint))
    check('LP supply is non-zero', lp.supply > 0n, true)
    check('the whole LP supply is in the curve ATA', locked.amount, lp.supply)
    check('LP ATA is owned by the pump authority, not a wallet', locked.owner.toBase58(), pumpAuthority.toBase58())
    console.log(`  · LP supply ${lp.supply} locked at ${curveLpAta(mint.publicKey, lpMint).toBase58()}`)
  }

  // 5 — a second graduation is refused
  {
    let failed = false
    try {
      await send(conn, new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }))
        .add(graduatePumpSwapIx({ payer: payer.publicKey, mint: mint.publicKey })), [payer])
    } catch { failed = true }
    check('a second PumpSwap graduation is refused', failed, true)
  }

  // 6 — the vault path cannot run after PumpSwap either
  {
    let failed = false
    try {
      await send(conn, new Transaction().add((await import('../curve-program/client.mjs')).graduateIx({
        payer: payer.publicKey, mint: mint.publicKey,
      })), [payer])
    } catch { failed = true }
    check('the vault graduation is refused after PumpSwap', failed, true)
  }

  console.log(`\n${bad === 0 ? '✅' : '❌'} PumpSwap graduation E2E: ${ok} passed, ${bad} failed`)
  if (validator) validator.kill()
  process.exit(bad === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('❌ PumpSwap graduation E2E failed:', e)
  process.exit(1)
})
