// OAKEN Curve — end-to-end on a Solana validator.
//
//   node scripts/curve-e2e.mjs                 # validator already running with the program
//   node scripts/curve-e2e.mjs --start         # start solana-test-validator (Linux/CI; Windows needs symlink privileges)
//
// Every assertion is read back from the chain after the step that changes it:
// the curve account bytes, the token balances, the mint supply and the vault.
// This script is what the Windows-local E2E cannot do (see README).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID, getMint, getAccount,
} from '@solana/spl-token'
import {
  PROGRAM_ID, curvePda, curveAta, graduateVaultPda, graduateVaultAta,
  createCurveIx, buyIx, sellIx, graduateIx, decodeCurve,
} from '../curve-program/client.mjs'

const RPC = process.env.RPC || 'http://127.0.0.1:8899'
const LOCAL = /127\.0\.0\.1|localhost/.test(RPC)
const ONE = 1_000_000n
const SUPPLY = 1_000_000_000n * ONE
const RESERVED = 206_900_000n * ONE

const SOL = 1_000_000_000n

let ok = 0, bad = 0
const check = (label, got, want) => {
  const pass = String(got) === String(want)
  if (pass) ok++; else bad++
  console.log(`  ${pass ? '✓' : '✗'} ${label}${pass ? '' : `   期望 ${want}，拿到 ${got}`}`)
}

async function send(conn, tx, signers) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = signers[0].publicKey
  tx.sign(...signers)
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 })
  for (let i = 0; i < 120; i++) {
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
      '--bpf-program', PROGRAM_ID.toBase58(), so, '--reset', '--quiet',
    ], { stdio: 'ignore' })
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
  console.log('mint  =', mint.publicKey.toBase58(), 'curve =', curve.toBase58())

  // 1 — create
  {
    const { instruction } = createCurveIx({
      creator: payer.publicKey, mint: mint.publicKey,
      protocolFeeRecipient: feeRecipient, creatorFeeRecipient: feeRecipient,
      creatorFeeBps: 5,
    })
    await send(conn, new Transaction().add(instruction), [payer, mint])
    const info = await conn.getAccountInfo(curve)
    const c = decodeCurve(info.data)
    check('virtual SOL is 30', c.virtualSol, 30n * SOL)
    check('virtual tokens is 1.073B', c.virtualToken, 1_073_000_000n * ONE)
    check('sellable tokens is 793.1M', c.realToken, 793_100_000n * ONE)
    check('curve holds the whole supply', (await conn.getTokenAccountBalance(curveAta(mint.publicKey))).value.amount, SUPPLY.toString())
    const mintInfo = await getMint(conn, mint.publicKey)
    check('mint supply is 1B', mintInfo.supply, SUPPLY)
    check('mint authority is renounced', mintInfo.mintAuthority, null)
  }

  // buyer ATA
  const buyerAta = (await import('@solana/spl-token')).getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey)
  {
    const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token')
    await send(conn, new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, buyerAta, payer.publicKey, mint.publicKey),
    ), [payer])
  }

  // 2 — buy 1 SOL
  {
    await send(conn, new Transaction().add(buyIx({
      buyer: payer.publicKey, mint: mint.publicKey, buyerAta,
      protocolFeeRecipient: feeRecipient, creatorFeeRecipient: feeRecipient,
      amountIn: SOL, minTokensOut: 0,
    })), [payer])
    const c = decodeCurve((await conn.getAccountInfo(curve)).data)
    check('1% fee leaves 0.99 SOL in the curve', c.realSol, (SOL * 99n) / 100n)
    check('tokens were delivered', (await getAccount(conn, buyerAta)).amount > 0n, true)
  }

  // 3 — sell half
  {
    const held = (await getAccount(conn, buyerAta)).amount
    const half = held / 2n
    await send(conn, new Transaction().add(sellIx({
      seller: payer.publicKey, mint: mint.publicKey, sellerAta: buyerAta,
      protocolFeeRecipient: feeRecipient, creatorFeeRecipient: feeRecipient,
      amountIn: half, minSolOut: 0,
    })), [payer])
    const c = decodeCurve((await conn.getAccountInfo(curve)).data)
    check('sell reduced the curve SOL', c.realSol < (SOL * 99n) / 100n, true)
    check('seller keeps the other half', (await getAccount(conn, buyerAta)).amount, held - half)
  }

  // 4 — buy to completion
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

  // 5 — graduate
  {
    const [vault] = graduateVaultPda(mint.publicKey)
    await send(conn, new Transaction().add(graduateIx({ payer: payer.publicKey, mint: mint.publicKey })), [payer])
    const c = decodeCurve((await conn.getAccountInfo(curve)).data)
    check('curve marked graduated', c.graduated, true)
    check('vault path leaves the pool slot empty', c.pool.toBase58(), PublicKey.default.toBase58())
    check('vault holds the reserved slice', (await conn.getTokenAccountBalance(graduateVaultAta(mint.publicKey))).value.amount, RESERVED.toString())
    check('vault holds the raised SOL', await conn.getBalance(vault), c.realSol)
    let secondFailed = false
    try {
      await send(conn, new Transaction().add(graduateIx({ payer: payer.publicKey, mint: mint.publicKey })), [payer])
    } catch { secondFailed = true }
    check('a second graduation is refused', secondFailed, true)
  }

  console.log(`\n${bad === 0 ? '✅' : '❌'} curve E2E: ${ok} passed, ${bad} failed`)
  if (validator) validator.kill()
  process.exit(bad === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('❌ curve E2E failed:', e)
  process.exit(1)
})
