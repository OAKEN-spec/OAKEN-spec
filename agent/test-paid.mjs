/**
 * One real x402 settlement against a running report service.
 *
 *   node agent/test-paid.mjs
 *   AGENT_URL=https://agents.oaken.one node agent/test-paid.mjs
 *   AGENT_URL=http://127.0.0.1:8870 KIND=token node agent/test-paid.mjs
 *
 * The payer is DEPLOYER_KEY from `.env` (override with PAYER_KEY). It signs an
 * EIP-3009 TransferWithAuthorization in USDG; the service's facilitator pays
 * gas. This spends the report price (and only the report price) in USDG.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ethers } from './ethers.mjs'
import { rpc } from '../src/rpc.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const BASE = (process.env.AGENT_URL || 'http://127.0.0.1:8870').replace(/\/$/, '')
const KIND = process.env.KIND || 'token'
const TOKEN = process.env.TOKEN || '0x02b0de4c4d4a7416a3465126730df71a026d7bbb'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const CHAIN_ID = 4663
const DOMAIN = { name: 'Global Dollar', version: '1', chainId: CHAIN_ID, verifyingContract: USDG }
const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

const env = fs.readFileSync(path.join(root, '.env'), 'utf8')
const keyOf = (name) => env.match(new RegExp('^' + name + '=(.+)$', 'm'))?.[1]?.trim()
const payer = new ethers.Wallet(process.env.PAYER_KEY || keyOf('DEPLOYER_KEY'))
const wallets = JSON.parse(fs.readFileSync(path.join(root, '_secrets', 'agent-wallets.json'), 'utf8'))
const treasury = ethers.getAddress(wallets.treasury.address)

const bal = async (address) => BigInt(await rpc(CHAIN_ID, 'eth_call', [{ to: USDG, data: '0x70a08231' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0') }, 'latest']))

function body() {
  if (KIND === 'bond') return { kind: 'bond', symbol: 'OAKEN', fresh: true }
  if (KIND === 'prelaunch') {
    return { kind: 'prelaunch', token: TOKEN, lockAmount: 5_000_000, lockDays: 180, steps: 6, initialUnlockPct: 10, revocable: false }
  }
  return { kind: 'token', token: TOKEN, fresh: true }
}

async function post(headers = {}) {
  const started = Date.now()
  const response = await fetch(BASE + '/api/agents/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body()),
    signal: AbortSignal.timeout(240_000),
  })
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* keep text for the error */ }
  return { status: response.status, headers: response.headers, data, text, ms: Date.now() - started }
}

const payerBefore = await bal(payer.address)
const treasuryBefore = await bal(treasury)
console.log('payer    ', payer.address, ethers.formatUnits(payerBefore, 6), 'USDG')
console.log('treasury ', treasury, ethers.formatUnits(treasuryBefore, 6), 'USDG')
console.log('service  ', BASE)

const first = await post()
if (first.status !== 402) {
  console.log('expected a 402 challenge, got', first.status, first.text.slice(0, 400))
  process.exit(1)
}
const accept = first.data?.accepts?.[0]
if (!accept) {
  console.log('402 without accepts:', first.text.slice(0, 400))
  process.exit(1)
}
const amount = BigInt(accept.maxAmountRequired)
console.log('challenge', accept.scheme, accept.network, 'amount', ethers.formatUnits(amount, 6), 'USDG to', accept.payTo)

const now = Math.floor(Date.now() / 1000)
const nonce = ethers.hexlify(ethers.randomBytes(32))
const message = {
  from: payer.address,
  to: ethers.getAddress(accept.payTo),
  value: amount.toString(),
  validAfter: String(now - 60),
  validBefore: String(now + 600),
  nonce,
}
const signature = await payer.signTypedData(DOMAIN, TYPES, message)
const payload = {
  x402Version: 1,
  scheme: accept.scheme,
  network: accept.network,
  payload: { signature, authorization: message },
}
const header = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')

const paid = await post({ 'x-payment': header })
if (paid.status !== 200 || !paid.data?.report) {
  console.log('paid request failed', paid.status, paid.text.slice(0, 600))
  process.exit(1)
}
const receiptHeader = paid.headers.get('x-payment-response')
const settlement = receiptHeader ? JSON.parse(Buffer.from(receiptHeader, 'base64').toString('utf8')) : null
if (!settlement?.success || !settlement.transaction) {
  console.log('settlement header missing or failed', settlement, receiptHeader)
  process.exit(1)
}

const chainReceipt = await rpc(CHAIN_ID, 'eth_getTransactionReceipt', [settlement.transaction], { attempts: 3 })
const payerAfter = await bal(payer.address)
const treasuryAfter = await bal(treasury)
const evidence = {
  at: new Date().toISOString(),
  service: BASE,
  kind: KIND,
  reportId: paid.data.report.id,
  blockNumber: paid.data.report.blockNumber,
  payer: payer.address,
  payTo: treasury,
  amountAtomic: amount.toString(),
  amount: ethers.formatUnits(amount, 6),
  asset: USDG,
  network: accept.network,
  authorization: { ...message, nonce },
  settlement,
  receipt: chainReceipt ? { status: chainReceipt.status, blockNumber: Number(BigInt(chainReceipt.blockNumber)), gasUsed: Number(BigInt(chainReceipt.gasUsed)) } : null,
  balances: {
    payerBefore: payerBefore.toString(),
    payerAfter: payerAfter.toString(),
    treasuryBefore: treasuryBefore.toString(),
    treasuryAfter: treasuryAfter.toString(),
  },
  tookMs: paid.ms,
}
const evidenceFile = path.join(root, 'data', `agent-x402-settlement-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n')

console.log('report   ', paid.data.report.id, 'block', paid.data.report.blockNumber)
console.log('tx       ', settlement.transaction)
console.log('receipt  ', chainReceipt?.status, 'gas', chainReceipt ? Number(BigInt(chainReceipt.gasUsed)) : null)
console.log('payer    ', ethers.formatUnits(payerAfter, 6), 'USDG (Δ', ethers.formatUnits(payerAfter - payerBefore, 6) + ')')
console.log('treasury ', ethers.formatUnits(treasuryAfter, 6), 'USDG (Δ', ethers.formatUnits(treasuryAfter - treasuryBefore, 6) + ')')
console.log('evidence ', path.relative(root, evidenceFile))

if (payerAfter !== payerBefore - amount || treasuryAfter !== treasuryBefore + amount) {
  console.log('BALANCE MISMATCH')
  process.exit(1)
}
if (String(chainReceipt?.status) !== '0x1') {
  console.log('RECEIPT NOT SUCCESSFUL')
  process.exit(1)
}
console.log('PASS real x402 settlement')
