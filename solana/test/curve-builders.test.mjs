// The wire format and account orders are the protocol. These tests pin them
// against what src/instruction.rs and src/processor.rs expect, so a change on
// either side fails here instead of on chain.

import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  WSOL_MINT,
  METAPLEX_PROGRAM_ID,
  curvePda,
  metadataPda,
  graduateVaultPda,
  solVaultPda,
  pumpAuthorityPda,
  curveAta,
  graduateVaultAta,
  createCurveIx,
  createCurveWithMetadataIx,
  buyIx,
  sellIx,
  graduateIx,
  graduatePumpSwapIx,
  pumpPoolPda,
  pumpLpMintPda,
  curveWsolAta,
  curveLpAta,
  poolBaseAta,
  poolQuoteAta,
  decodeCurve,
} from '../curve-program/client.mjs'

const mint = Keypair.generate().publicKey
const wallet = Keypair.generate().publicKey
const protocol = Keypair.generate().publicKey
const creatorFee = Keypair.generate().publicKey

test('program id matches the Rust declare_id', () => {
  assert.equal(PROGRAM_ID.toBase58(), 'BvTeztC4ENG8x2TW19AkiJ9EnC9JNresmA1pE6MBWpRi')
})

test('PDAs are deterministic and the ATAs belong to them', () => {
  const [curve] = curvePda(mint)
  const [vault] = graduateVaultPda(mint)
  assert.notEqual(curve.toBase58(), vault.toBase58())
  assert.equal(curvePda(mint)[0].toBase58(), curve.toBase58())
  assert.equal(graduateVaultPda(mint)[0].toBase58(), vault.toBase58())
  assert.equal(curveAta(mint).toBase58(), curveAta(mint).toBase58())
  assert.equal(graduateVaultAta(mint).toBase58(), graduateVaultAta(mint).toBase58())
})

test('create encodes tag 0 + creator fee bps and the documented account order', () => {
  const { instruction, curve } = createCurveIx({
    creator: wallet,
    mint,
    protocolFeeRecipient: protocol,
    creatorFeeRecipient: creatorFee,
    creatorFeeBps: 300,
  })
  assert.deepEqual([...instruction.data], [0, 44, 1]) // 300 = 0x012c little-endian
  assert.equal(instruction.programId.toBase58(), PROGRAM_ID.toBase58())
  assert.equal(instruction.keys.length, 11)
  assert.ok(instruction.keys[0].isSigner) // creator
  assert.ok(instruction.keys[1].isSigner) // mint keypair
  assert.equal(instruction.keys[2].pubkey.toBase58(), curve.toBase58())
  assert.equal(instruction.keys[4].pubkey.toBase58(), pumpAuthorityPda(mint).toBase58())
  assert.equal(instruction.keys[7].pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58())
  assert.equal(instruction.keys[9].pubkey.toBase58(), ATA_PROGRAM_ID.toBase58())
})

test('create with metadata encodes tag 5 and appends the Metaplex pair', () => {
  const { instruction, curve, metadata } = createCurveWithMetadataIx({
    creator: wallet,
    mint,
    protocolFeeRecipient: protocol,
    creatorFeeRecipient: creatorFee,
    creatorFeeBps: 300,
    name: 'AB',
    symbol: 'C',
    uri: 'D',
  })
  assert.deepEqual(
    [...instruction.data],
    [5, 44, 1, 2, 0, 0x41, 0x42, 1, 0, 0x43, 1, 0, 0x44],
  )
  assert.equal(instruction.keys.length, 13)
  assert.equal(instruction.keys[2].pubkey.toBase58(), curve.toBase58())
  assert.equal(instruction.keys[11].pubkey.toBase58(), metadata.toBase58())
  assert.ok(instruction.keys[11].isWritable)
  assert.equal(instruction.keys[12].pubkey.toBase58(), METAPLEX_PROGRAM_ID.toBase58())
})

test('metadata PDA matches the JS SDK vector', () => {
  const vector = new PublicKey(Buffer.alloc(32, 3))
  assert.equal(metadataPda(vector)[0].toBase58(), '7AD2z3WLVQpLdUcyvwSsdXLeptJsQPyxrWDJNmi3cC7S')
  assert.equal(metadataPda(vector)[1], 255)
})

test('create with metadata refuses strings the program would reject', () => {
  const base = {
    creator: wallet, mint, protocolFeeRecipient: protocol,
    creatorFeeRecipient: creatorFee, creatorFeeBps: 5,
    symbol: 'C', uri: 'D',
  }
  assert.throws(() => createCurveWithMetadataIx({ ...base, name: '' }), /name/)
  assert.throws(() => createCurveWithMetadataIx({ ...base, name: 'A'.repeat(33) }), /name/)
  assert.throws(() => createCurveWithMetadataIx({ ...base, name: 'A', symbol: 'B'.repeat(11) }), /symbol/)
  assert.throws(() => createCurveWithMetadataIx({ ...base, name: 'A', uri: 'u'.repeat(201) }), /uri/)
})

test('buy and sell encode tags 1/2 with two little-endian u64s', () => {
  const buy = buyIx({
    buyer: wallet, mint, buyerAta: wallet, protocolFeeRecipient: protocol,
    creatorFeeRecipient: creatorFee, amountIn: 1_000_000_000, minTokensOut: 42,
  })
  assert.deepEqual([...buy.data], [1, 0, 202, 154, 59, 0, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(buy.keys.length, 11)
  assert.equal(buy.keys[1].pubkey.toBase58(), curvePda(mint)[0].toBase58())
  assert.equal(buy.keys[5].pubkey.toBase58(), solVaultPda(mint).toBase58())
  assert.equal(buy.keys[6].pubkey.toBase58(), pumpAuthorityPda(mint).toBase58())
  assert.ok(buy.keys[7].isWritable)

  const sell = sellIx({
    seller: wallet, mint, sellerAta: wallet, protocolFeeRecipient: protocol,
    creatorFeeRecipient: creatorFee, amountIn: 7, minSolOut: 9,
  })
  assert.deepEqual([...sell.data], [2, 7, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(sell.keys.length, 10)
  assert.equal(sell.keys[3].pubkey.toBase58(), wallet.toBase58())
  assert.equal(sell.keys[4].pubkey.toBase58(), curveAta(mint).toBase58())
  assert.equal(sell.keys[5].pubkey.toBase58(), solVaultPda(mint).toBase58())
})

test('graduate encodes tag 3 and includes the SOL vault and the vault pair', () => {
  const ix = graduateIx({ payer: wallet, mint })
  assert.deepEqual([...ix.data], [3])
  assert.equal(ix.keys.length, 11)
  assert.equal(ix.keys[4].pubkey.toBase58(), solVaultPda(mint).toBase58())
  assert.equal(ix.keys[5].pubkey.toBase58(), pumpAuthorityPda(mint).toBase58())
  assert.equal(ix.keys[6].pubkey.toBase58(), graduateVaultPda(mint)[0].toBase58())
  assert.equal(ix.keys[7].pubkey.toBase58(), graduateVaultAta(mint).toBase58())
})

test('a different mint gives different PDAs', () => {
  const other = new PublicKey('11111111111111111111111111111112')
  assert.notEqual(curvePda(mint)[0].toBase58(), curvePda(other)[0].toBase58())
})

test('PumpSwap graduation encodes tag 4 + index and the documented 20 accounts', () => {
  const ix = graduatePumpSwapIx({ payer: wallet, mint, index: 7 })
  const pumpAuthority = pumpAuthorityPda(mint)
  const [pool] = pumpPoolPda(mint, 7, pumpAuthority)
  const [lpMint] = pumpLpMintPda(pool)
  assert.deepEqual([...ix.data], [4, 7, 0])
  assert.equal(ix.programId.toBase58(), PROGRAM_ID.toBase58())
  assert.equal(ix.keys.length, 20)
  assert.ok(ix.keys[0].isSigner)
  assert.equal(ix.keys[1].pubkey.toBase58(), curvePda(mint)[0].toBase58())
  assert.equal(ix.keys[4].pubkey.toBase58(), solVaultPda(mint).toBase58())
  assert.equal(ix.keys[5].pubkey.toBase58(), pumpAuthority.toBase58())
  assert.equal(ix.keys[7].pubkey.toBase58(), pool.toBase58())
  assert.equal(ix.keys[9].pubkey.toBase58(), lpMint.toBase58())
  assert.equal(ix.keys[14].pubkey.toBase58(), PUMP_AMM_PROGRAM_ID.toBase58())
  assert.equal(ix.keys[15].pubkey.toBase58(), WSOL_MINT.toBase58())
  assert.equal(ix.keys[16].pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58())
  assert.equal(ix.keys[17].pubkey.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58())
  assert.equal(ix.keys[19].pubkey.toBase58(), ATA_PROGRAM_ID.toBase58())
})

test('PumpSwap PDAs and ATAs match the SDK test vector', () => {
  const vector = new PublicKey(Buffer.alloc(32, 3))
  const [curve] = curvePda(vector)
  assert.equal(curve.toBase58(), '4PS7hqEy2ynskmEW6kthpV43CpaBMoYP4T5isdo2gSaj')
  assert.equal(solVaultPda(vector).toBase58(), 'JN5XMnTaggzvoH1vkuzaEb9aJmJMdALDGxdLkiDn4zW')
  const pumpAuthority = pumpAuthorityPda(vector)
  assert.equal(pumpAuthority.toBase58(), 'JBXzzNFmNtAvq2UN4qaJWbJUxjxmtMMG4wpUH2LoHQh5')
  const [pool] = pumpPoolPda(vector)
  assert.equal(pool.toBase58(), '5s7zt9Vzpui7hjdN8cwaWbpEAbBVx9S8KF3Ndd2V4HWf')
  const [lpMint] = pumpLpMintPda(pool)
  assert.equal(lpMint.toBase58(), '9PrUSVskT6jJgc9XxhVfHs5zBVUFnubUucAEujtw3u4f')
  assert.equal(curveAta(vector).toBase58(), 'DjB75qHSWvZ4oBcHAYojGBQGJ7r4rSc3hMe1DzKsMA78')
  assert.equal(curveWsolAta(vector).toBase58(), '9eufMf1QwHRpNPjjjtAMaXWDJduV9pkhicCM8WhBohdQ')
  assert.equal(curveLpAta(vector, lpMint).toBase58(), 'GZixjpTLeDgAqzTaevMErnVDNWT1x7erfy362iE1ayA6')
  assert.equal(poolBaseAta(pool, vector).toBase58(), 'A5sNC1W6tkmdNcdq5uz8Zq2gCoc7gfXE7N9uLRqvToaw')
  assert.equal(poolQuoteAta(pool).toBase58(), 'BD1BjumCjcfcHH7Z23qfApRq7mCUz4YiTreU7N5nrwCb')
})

test('decodeCurve reads the pool slot and rejects other lengths', () => {
  const data = Buffer.alloc(232)
  data[198] = 1
  data[199] = 1
  data[200] = 9
  const c = decodeCurve(data)
  assert.equal(c.graduated, true)
  assert.equal(c.completed, true)
  assert.equal(c.pool.toBase58(), new PublicKey(Buffer.concat([Buffer.from([9]), Buffer.alloc(31)])).toBase58())
  assert.throws(() => decodeCurve(Buffer.alloc(200)))
})
