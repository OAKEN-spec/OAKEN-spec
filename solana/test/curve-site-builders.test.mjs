// The browser builders and the curve program's client builders are two copies
// of the same protocol. These tests compare them byte for byte, so a change on
// one side cannot drift silently from the page.

import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js'
import { makeSolana } from '../../frontend/app/solana-build.js'
import {
  createCurveWithMetadataIx as clientCreate,
  buyIx as clientBuy,
  sellIx as clientSell,
  graduatePumpSwapIx as clientGraduatePumpSwap,
  metadataPda as clientMetadataPda,
  curvePda as clientCurvePda,
  decodeCurve as clientDecodeCurve,
} from '../curve-program/client.mjs'

const web3 = { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, Buffer }
const A = makeSolana(web3)

const mint = new PublicKey(Buffer.alloc(32, 3))
const wallet = new PublicKey(Buffer.alloc(32, 4))
const protocol = new PublicKey(Buffer.alloc(32, 5))
const creatorFee = new PublicKey(Buffer.alloc(32, 6))

function keyList(ix) {
  return ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])
}

test('site create-with-metadata matches the program client byte for byte', () => {
  const args = {
    creator: wallet,
    mint,
    protocolFeeRecipient: protocol,
    creatorFeeRecipient: creatorFee,
    creatorFeeBps: 5,
    name: 'OAKEN',
    symbol: 'OAK',
    uri: 'https://oaken.one/m/1.json',
  }
  const site = A.createCurveWithMetadataIx(args)
  const client = clientCreate(args).instruction
  assert.deepEqual([...site.data], [...client.data])
  assert.deepEqual(keyList(site), keyList(client))
  assert.equal(site.keys.length, 13)
  assert.equal(site.keys[11].pubkey.toBase58(), clientMetadataPda(mint)[0].toBase58())
})

test('site buy and sell match the program client', () => {
  const buyArgs = {
    buyer: wallet,
    mint,
    buyerAta: wallet,
    protocolFeeRecipient: protocol,
    creatorFeeRecipient: creatorFee,
    amountIn: 1_000_000_000,
    minTokensOut: 42,
  }
  const siteBuy = A.curveBuyIx(buyArgs)
  const clientBuyIx = clientBuy(buyArgs)
  assert.deepEqual([...siteBuy.data], [...clientBuyIx.data])
  assert.deepEqual(keyList(siteBuy), keyList(clientBuyIx))

  const sellArgs = {
    seller: wallet,
    mint,
    sellerAta: wallet,
    protocolFeeRecipient: protocol,
    creatorFeeRecipient: creatorFee,
    amountIn: 7,
    minSolOut: 9,
  }
  const siteSell = A.curveSellIx(sellArgs)
  const clientSellIx = clientSell(sellArgs)
  assert.deepEqual([...siteSell.data], [...clientSellIx.data])
  assert.deepEqual(keyList(siteSell), keyList(clientSellIx))
})

test('site PumpSwap graduation matches the program client', () => {
  const site = A.curveGraduatePumpSwapIx({ payer: wallet, mint, index: 2 })
  const client = clientGraduatePumpSwap({ payer: wallet, mint, index: 2 })
  assert.deepEqual([...site.data], [...client.data])
  assert.deepEqual(keyList(site), keyList(client))
  assert.equal(site.keys.length, 20)
})

test('site curve PDA and decoder match the program client', () => {
  assert.equal(A.curvePda(mint)[0].toBase58(), clientCurvePda(mint)[0].toBase58())
  const data = Buffer.alloc(232)
  data[0] = 2
  data[1] = 252
  data[198] = 1
  data[199] = 1
  data.writeBigUInt64LE(123n, 162)
  data.writeBigUInt64LE(456n, 178)
  data.writeUInt16LE(95, 194)
  data.writeUInt16LE(5, 196)
  const site = A.decodeCurve(data)
  const client = clientDecodeCurve(data)
  assert.equal(site.version, client.version)
  assert.equal(site.virtualSol, client.virtualSol)
  assert.equal(site.realSol, client.realSol)
  assert.equal(site.protocolFeeBps, client.protocolFeeBps)
  assert.equal(site.creatorFeeBps, client.creatorFeeBps)
  assert.equal(site.graduated, client.graduated)
  assert.equal(site.pool, client.pool.toBase58())
})

test('site metadata PDA matches the curve client', () => {
  assert.equal(A.curveMetadataPda(mint)[0].toBase58(), clientMetadataPda(mint)[0].toBase58())
})
