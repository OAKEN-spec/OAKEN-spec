/**
 * OAKEN Agent Reports — a deterministic, on-chain report builder.
 *
 * No LLM is used here on purpose. Every line in the report is derived from an
 * `eth_call`, `eth_getCode`, or `eth_getStorageAt` at a stated block, so the
 * report can be checked against the same contracts the site's Verify page
 * links to. An LLM can later add prose around these facts, but it must not be
 * allowed to invent or override them.
 *
 * Chain: Robinhood Chain (4663) only. USDG is the stablecoin on this chain;
 * there is no canonical USDC here.
 */

import { ethers } from './ethers.mjs'
import { rpc, callMany, readUint, decodeString } from '../src/rpc.mjs'
import {
  CHAINS,
  LOCK_VAULT,
  LOCK_VAULT_V2,
  LOCK_VAULT_V3,
  LOCK_VAULT_V4,
  PINKLOCK_ADAPTER,
  PINKLOCK_ADAPTER_V2,
  PINKLOCK_ADAPTER_V3,
  PINKLOCK_ADAPTER_V4,
  MULTICALL3,
} from '../src/chains.mjs'
import { BONDS as OAKEN_BONDS, SEL as BOND_SEL, DECIMALS as BOND_DECIMALS } from '../frontend/app/bonds/lib/contracts.js'

export const CHAIN_ID = 4663
const CHAIN = CHAINS[CHAIN_ID]

const PONS_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const ZERO = '0x0000000000000000000000000000000000000000'
const ETH_USD_FEED = '0x6091e64eb7138eef066a80fd3a0d7427b91f2721'
const USDG_USD_FEED = '0x8bEeE3503F6860D5dac4cE26b5eEee92982951c2e'
const ETH_USD_DECIMALS = 8
const MAX_LOCKS_PER_VERSION = 100

const DISCLAIMER =
  'This is a reading aid, not an audit, a security score, or financial advice. '
  + 'Every number comes from the chain at the stated block. Unknown checks are left unknown rather than guessed.'

const VERSIONS = [
  { version: 'v1', adapter: PINKLOCK_ADAPTER, vault: LOCK_VAULT },
  { version: 'v2', adapter: PINKLOCK_ADAPTER_V2, vault: LOCK_VAULT_V2 },
  { version: 'v3', adapter: PINKLOCK_ADAPTER_V3, vault: LOCK_VAULT_V3 },
  { version: 'v4', adapter: PINKLOCK_ADAPTER_V4, vault: LOCK_VAULT_V4 },
]

const ERC20 = new ethers.Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
])

const ADAPTER = new ethers.Interface([
  'function getLocksForToken(address token,uint256 start,uint256 end) view returns (tuple(uint256 id,address token,address owner,uint256 amount,uint256 lockDate,uint256 tgeDate,uint256 tgeBps,uint256 cycle,uint256 cycleBps,uint256 unlockedAmount,string description)[])',
  'function totalLockCountForToken(address token) view returns (uint256)',
])

const VAULT = new ethers.Interface([
  'function getLock(uint256 lockId) view returns ((address token, uint64 startTime, uint16 initialUnlockBps, bool revocable, bool transferable, address beneficiary, uint64 cliffTime, bool revoked, bool renounced, address creator, uint64 endTime, uint16 steps, uint128 amount, uint128 claimed, bytes32 label, address agent))',
])

const CURVE = new ethers.Interface(['function getReserves() view returns (uint256, uint256)'])
const FEED = new ethers.Interface(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)'])

/* OAKEN Curve v5 (the self-launch curve). The factory emits the launch event;
   the curve itself is the address a user opens at /curve/robinhood/<address>.
   The factory has no registry getter, so a curve report takes the curve
   address — the same address the site's page uses — and reads the token back
   from the curve before trusting anything else. */
const OAKEN_CURVE_FACTORY = '0x8D59368a7C369bEf20458442027bE0D9aD6C4F5f'

const OAKEN_CURVE = new ethers.Interface([
  'function token() view returns (address)',
  'function creator() view returns (address)',
  'function creatorFeeRecipient() view returns (address)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function protocolShareBps() view returns (uint256)',
  'function snipeTaxStartBps() view returns (uint256)',
  'function snipeTaxSeconds() view returns (uint256)',
  'function virtualTokens() view returns (uint256)',
  'function phantomQuote() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function launchSupply() view returns (uint256)',
  'function reservedTokens() view returns (uint256)',
  'function trackedQuote() view returns (uint256)',
  'function trackedTokens() view returns (uint256)',
  'function launchedAt() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function readyToGraduate() view returns (bool)',
  'function getReserves() view returns (uint256,uint256)',
  'function sellableTokens() view returns (uint256)',
  'function pendingCreatorFees() view returns (uint256)',
  'function protocolFeeBalance() view returns (uint256)',
  'function creatorFeeBalance() view returns (uint256)',
  'function creatorTaxBalance() view returns (uint256)',
  'function snipeTaxBalance() view returns (uint256)',
])

const SELECTOR_FLAGS = [
  ['mint', 'Mint function', '0x40c10f19', 'mint(address,uint256)'],
  ['pause', 'Pause function', '0x8456cb59', 'pause()'],
  ['blacklist', 'Blacklist function', '0xf9f92be4', 'blacklist(address)'],
  ['renounce', 'Renounce ownership', '0x715018a6', 'renounceOwnership()'],
  ['transfer_ownership', 'Ownership transfer', '0xf2fde38b', 'transferOwnership(address)'],
  ['upgrade_to', 'Upgrade function', '0x3659cfe6', 'upgradeTo(address)'],
  ['upgrade_to_and_call', 'Upgrade function', '0x4f1ef286', 'upgradeToAndCall(address,bytes)'],
  ['set_fee', 'Fee control', '0x69fe0e2d', 'setFee(uint256)'],
  ['set_tax', 'Tax control', '0x2e5bb6ff', 'setTax(uint256)'],
  ['exclude_from_fee', 'Fee exclusion', '0x437823ec', 'excludeFromFee(address)'],
  ['set_max_tx', 'Max transaction', '0xec28438a', 'setMaxTxAmount(uint256)'],
  ['enable_trading', 'Trading switch', '0x8a8c523c', 'enableTrading()'],
  ['set_trading_enabled', 'Trading switch', '0xc2e5ec04', 'setTradingEnabled(bool)'],
  ['set_limits', 'Trading limits', '0xc4590d3f', 'setLimits(uint256,uint256)'],
  ['set_blacklist', 'Blacklist control', '0x153b0d1e', 'setBlacklist(address,bool)'],
  ['set_minter', 'Minter control', '0xcf456ae7', 'setMinter(address,bool)'],
  ['set_router', 'Router control', '0xc0d78655', 'setRouter(address)'],
  ['set_pair', 'Pair control', '0x8187f516', 'setPair(address)'],
  ['set_max_wallet', 'Wallet cap', '0x5d0044ca', 'setMaxWallet(uint256)'],
  ['set_swap_enabled', 'Swap switch', '0xe01af92c', 'setSwapEnabled(bool)'],
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

export function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

function cleanText(value, max = 96) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function shortAddress(value) {
  const text = String(value || '')
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.slice(0, 6) + '…' + text.slice(-4) : text
}

function toAddressWord(value) {
  const n = BigInt(value)
  return '0x' + n.toString(16).padStart(40, '0')
}

function fmtUnits(raw, decimals, maxFrac = 2) {
  const n = Number(BigInt(raw)) / 10 ** Number(decimals)
  if (!Number.isFinite(n)) return String(raw)
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac })
  return n.toLocaleString('en-US', { maximumFractionDigits: Math.max(maxFrac, 4) })
}

function fmtUsd(value) {
  if (value == null || !Number.isFinite(value)) return null
  if (value >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B'
  if (value >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M'
  if (value >= 1e3) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 })
  return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

function fmtDate(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return new Date(n * 1000).toISOString().slice(0, 10)
}

function isoNow(seconds = nowSec()) {
  return new Date(seconds * 1000).toISOString()
}

/**
 * The block a report is pinned to, plus its timestamp. The block number alone
 * is precise but hard to read; the timestamp makes "when was this true"
 * obvious without trusting a server clock.
 */
async function readBlock(explicitNumber) {
  const blockNumber = explicitNumber ?? Number(BigInt(await rpc(CHAIN_ID, 'eth_blockNumber', [], { timeout: 20_000, attempts: 3 })))
  let blockTime = null
  try {
    const block = await rpc(CHAIN_ID, 'eth_getBlockByNumber', ['0x' + blockNumber.toString(16), false], { timeout: 20_000, attempts: 3 })
    if (block && block.timestamp) blockTime = Number(BigInt(block.timestamp))
  } catch { blockTime = null }
  return { blockNumber, blockTime, blockTimeIso: blockTime ? isoNow(blockTime) : null }
}

/**
 * Sourcify source verification for an arbitrary address on 4663.
 *
 * The report used to say "not checked in this version". Sourcify answers for
 * Robinhood Chain, so the report can now say what it actually found: exact,
 * partial, no verified source, or the lookup failed. A verified source is not
 * an audit; the check says that too.
 */
const SOURCIFY_CACHE = new Map()

async function sourcifyFor(address) {
  const key = String(address).toLowerCase()
  const hit = SOURCIFY_CACHE.get(key)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value
  const lookup = `https://sourcify.dev/#/lookup/${key}`
  let value
  try {
    const res = await fetch(`https://sourcify.dev/server/v2/contract/4663/${key}`, {
      signal: AbortSignal.timeout(12_000),
    })
    if (res.status === 404) {
      value = { provider: 'Sourcify', status: 'none', match: null, url: lookup }
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    } else {
      const body = await res.json()
      value = {
        provider: 'Sourcify',
        status: body.match === 'exact_match' ? 'exact' : body.match ? 'partial' : 'none',
        match: body.match || null,
        creationMatch: body.creationMatch || null,
        runtimeMatch: body.runtimeMatch || null,
        verifiedAt: body.verifiedAt || null,
        url: lookup,
      }
    }
  } catch (error) {
    value = {
      provider: 'Sourcify',
      status: 'error',
      match: null,
      error: String(error?.message || error).slice(0, 120),
      url: lookup,
    }
  }
  SOURCIFY_CACHE.set(key, { at: Date.now(), value })
  return value
}

function sourceCheck(source) {
  if (!source) {
    return { status: 'unknown', detail: 'Sourcify was not queried for this address.' }
  }
  if (source.status === 'exact') {
    return {
      status: 'pass',
      detail: `Sourcify exact match: creation and runtime bytecode match the published source${source.verifiedAt ? ` (verified ${source.verifiedAt})` : ''}. Verification is not an audit.`,
    }
  }
  if (source.status === 'partial') {
    return {
      status: 'info',
      detail: 'Sourcify returned a partial match. Read the source and the diff; a partial match is not an audit.',
    }
  }
  if (source.status === 'none') {
    return {
      status: 'unknown',
      detail: 'No verified source was returned by Sourcify for this address. That is not evidence of malice; it means the source cannot be read there.',
    }
  }
  return {
    status: 'unknown',
    detail: `Sourcify did not answer${source.error ? ` (${source.error})` : ''}. This is not evidence of malice.`,
  }
}

function sourceSummary(source) {
  if (!source) return 'not queried'
  if (source.status === 'exact') return `exact match${source.verifiedAt ? ` · verified ${source.verifiedAt}` : ''}`
  if (source.status === 'partial') return 'partial match'
  if (source.status === 'none') return 'no verified source'
  return 'lookup failed'
}

async function call(to, data, block = 'latest') {
  return rpc(CHAIN_ID, 'eth_call', [{ to, data }, block], { timeout: 20_000, attempts: 3 })
}

async function tryCall(to, data) {
  try {
    const result = await call(to, data)
    return result && result !== '0x' ? result : null
  } catch {
    return null
  }
}

/**
 * One `eth_call` to Multicall3 for many reads of the same contract.
 *
 * JSON-RPC batching is one HTTP request too, but from Cloudflare's RPC fallbacks
 * a batch endpoint can reject individual entries; Multicall3 lets each entry
 * fail on its own (`allowFailure: true`) and keeps the whole read to a single
 * subrequest. A null entry means that call reverted or returned `0x`; the
 * caller must treat it as unknown, never as zero.
 */
const MULTICALL3_ABI = new ethers.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
])

async function multicallFor(to, dataList) {
  const encoded = MULTICALL3_ABI.encodeFunctionData('aggregate3', [
    dataList.map((data) => ({ target: to, allowFailure: true, callData: data })),
  ])
  const raw = await call(MULTICALL3, encoded)
  const [rows] = MULTICALL3_ABI.decodeFunctionResult('aggregate3', raw)
  return rows.map((row) => (row.success && row.returnData !== '0x' ? row.returnData : null))
}

async function readFeed(address, name) {
  const result = await tryCall(address, FEED.encodeFunctionData('latestRoundData'))
  if (!result) return null
  try {
    const [, answer, , updatedAt] = FEED.decodeFunctionResult('latestRoundData', result)
    const price = Number(answer) / 10 ** ETH_USD_DECIMALS
    if (!Number.isFinite(price) || price <= 0) return null
    const updated = Number(updatedAt)
    return {
      name,
      address,
      price,
      updatedAt: updated,
      updatedAtIso: isoNow(updated),
      stale: nowSec() - updated > 24 * 60 * 60,
    }
  } catch {
    return null
  }
}

async function tokenMetadata(token) {
  const code = await rpc(CHAIN_ID, 'eth_getCode', [token, 'latest'], { timeout: 20_000, attempts: 3 })
  const codeBytes = Math.max(0, (String(code || '').length - 2) / 2)
  if (codeBytes === 0) {
    return {
      address: token,
      name: null,
      symbol: null,
      decimals: null,
      totalSupply: null,
      totalSupplyHuman: null,
      codeBytes: 0,
      proxy: null,
      proxyAdmin: null,
      proxyBeacon: null,
      owner: null,
      paused: null,
      selectors: Object.fromEntries(SELECTOR_FLAGS.map(([key]) => [key, false])),
    }
  }

  const calls = [
    { to: token, data: ERC20.encodeFunctionData('name') },
    { to: token, data: ERC20.encodeFunctionData('symbol') },
    { to: token, data: ERC20.encodeFunctionData('decimals') },
    { to: token, data: ERC20.encodeFunctionData('totalSupply') },
    { to: token, data: ERC20.encodeFunctionData('owner') },
    { to: token, data: ERC20.encodeFunctionData('paused') },
  ]
  let results = []
  try {
    results = await callMany(CHAIN_ID, calls)
  } catch {
    results = []
    for (const entry of calls) results.push(await tryCall(entry.to, entry.data))
  }

  let name = null
  let symbol = null
  try { name = cleanText(decodeString(results[0]), 64) || null } catch { name = null }
  try { symbol = cleanText(decodeString(results[1]), 24) || null } catch { symbol = null }

  let decimals = null
  try {
    if (results[2]) {
      const d = Number(readUint(results[2], 0))
      if (Number.isInteger(d) && d >= 0 && d <= 36) decimals = d
    }
  } catch { decimals = null }

  let totalSupply = null
  try {
    if (results[3]) totalSupply = readUint(results[3], 0).toString()
  } catch { totalSupply = null }

  let owner = null
  try {
    const raw = results[4]
    if (raw && raw.length >= 42) {
      const candidate = '0x' + raw.slice(-40).toLowerCase()
      if (candidate !== ZERO) owner = candidate
    }
  } catch { owner = null }

  let paused = null
  try {
    if (results[5]) paused = readUint(results[5], 0) !== 0n
  } catch { paused = null }

  const proxySlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
  const adminSlot = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'
  const beaconSlot = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
  const readSlot = async (slot) => {
    try {
      const value = await rpc(CHAIN_ID, 'eth_getStorageAt', [token, slot, 'latest'], { timeout: 20_000, attempts: 3 })
      if (value && value.length >= 42) {
        const candidate = '0x' + value.slice(-40).toLowerCase()
        if (candidate !== ZERO) return candidate
      }
    } catch { /* leave empty */ }
    return null
  }
  const [proxy, proxyAdmin, proxyBeacon] = await Promise.all([
    readSlot(proxySlot),
    readSlot(adminSlot),
    readSlot(beaconSlot),
  ])

  const lower = String(code).toLowerCase()
  const selectors = Object.fromEntries(SELECTOR_FLAGS.map(([key, , selector]) => [key, lower.includes(selector.slice(2))]))

  return {
    address: token,
    name,
    symbol,
    decimals,
    totalSupply,
    totalSupplyHuman: totalSupply != null && decimals != null ? fmtUnits(totalSupply, decimals) : null,
    codeBytes,
    proxy,
    proxyAdmin,
    proxyBeacon,
    owner,
    paused,
    selectors,
  }
}

async function locksFor(token, decimals) {
  const summary = {
    total: 0,
    active: 0,
    revocable: 0,
    expired: 0,
    revoked: 0,
    totalAmount: '0',
    totalRemaining: '0',
    totalAmountHuman: null,
    totalRemainingHuman: null,
    nextUnlock: null,
    nextUnlockIso: null,
    versions: [],
    rows: [],
    truncated: false,
  }
  let totalAmount = 0n
  let totalRemaining = 0n
  const now = nowSec()

  for (const entry of VERSIONS) {
    let count = 0
    try {
      const raw = await call(entry.adapter, ADAPTER.encodeFunctionData('totalLockCountForToken', [token]))
      count = Number(ADAPTER.decodeFunctionResult('totalLockCountForToken', raw)[0])
    } catch {
      summary.versions.push({ version: entry.version, count: null, error: 'adapter did not answer' })
      continue
    }
    if (count === 0) {
      summary.versions.push({ version: entry.version, count: 0 })
      continue
    }

    const end = Math.min(count - 1, MAX_LOCKS_PER_VERSION - 1)
    if (count > MAX_LOCKS_PER_VERSION) summary.truncated = true
    let views = []
    try {
      const raw = await call(entry.adapter, ADAPTER.encodeFunctionData('getLocksForToken', [token, 0, end]))
      views = ADAPTER.decodeFunctionResult('getLocksForToken', raw)[0] || []
    } catch {
      summary.versions.push({ version: entry.version, count, error: 'lock list did not answer' })
      continue
    }

    let vaultResults = []
    try {
      vaultResults = await callMany(CHAIN_ID, views.map((view) => ({
        to: entry.vault,
        data: VAULT.encodeFunctionData('getLock', [view.id]),
      })))
    } catch {
      vaultResults = []
    }

    views.forEach((view, index) => {
      let lock = null
      try {
        const raw = vaultResults[index]
        if (raw) lock = VAULT.decodeFunctionResult('getLock', raw)[0]
      } catch { lock = null }

      const amount = BigInt(String(view.amount ?? 0))
      const claimed = lock ? BigInt(String(lock.claimed ?? 0)) : BigInt(String(view.unlockedAmount ?? 0))
      const remaining = amount > claimed ? amount - claimed : 0n
      const endTime = Number(lock ? lock.endTime : (view.tgeDate || view.lockDate || 0))
      const revocable = lock ? Boolean(lock.revocable) : false
      const revoked = lock ? Boolean(lock.revoked) : false
      const renounced = lock ? Boolean(lock.renounced) : false
      const active = remaining > 0n && !revoked
      const expired = remaining > 0n && endTime > 0 && endTime <= now

      summary.total += 1
      if (active) summary.active += 1
      if (active && revocable) summary.revocable += 1
      if (expired) summary.expired += 1
      if (revoked) summary.revoked += 1
      totalAmount += amount
      totalRemaining += remaining
      if (active && endTime > now && (!summary.nextUnlock || endTime < summary.nextUnlock)) {
        summary.nextUnlock = endTime
        summary.nextUnlockIso = isoNow(endTime)
      }

      summary.rows.push({
        id: String(view.id),
        version: entry.version,
        beneficiary: String(view.owner || (lock && lock.beneficiary) || '').toLowerCase() || null,
        creator: lock ? String(lock.creator || '').toLowerCase() || null : null,
        amount: amount.toString(),
        claimed: claimed.toString(),
        remaining: remaining.toString(),
        amountHuman: decimals != null ? fmtUnits(amount, decimals) : null,
        remainingHuman: decimals != null ? fmtUnits(remaining, decimals) : null,
        start: view.lockDate != null ? Number(view.lockDate) : null,
        end: endTime || null,
        endIso: endTime ? isoNow(endTime) : null,
        steps: lock ? Number(lock.steps) : Number(view.cycle || 0),
        initialUnlockBps: lock ? Number(lock.initialUnlockBps) : Number(view.tgeBps || 0),
        revocable,
        revoked,
        renounced,
        expired,
        active,
        description: cleanText(view.description, 96) || null,
      })
    })

    summary.versions.push({ version: entry.version, count, shown: views.length })
  }

  summary.totalAmount = totalAmount.toString()
  summary.totalRemaining = totalRemaining.toString()
  summary.totalAmountHuman = decimals != null ? fmtUnits(totalAmount, decimals) : null
  summary.totalRemainingHuman = decimals != null ? fmtUnits(totalRemaining, decimals) : null
  return summary
}

function attachSupplyPercent(tokenMeta, locks) {
  if (tokenMeta.totalSupply == null || tokenMeta.decimals == null) return locks
  try {
    const supply = BigInt(tokenMeta.totalSupply)
    if (supply <= 0n) return locks
    const remaining = BigInt(locks.totalRemaining || '0')
    const total = BigInt(locks.totalAmount || '0')
    locks.remainingPctOfSupply = Number((remaining * 1_000_000n) / supply) / 10_000
    locks.totalPctOfSupply = Number((total * 1_000_000n) / supply) / 10_000
    locks.remainingPctFormatted = locks.remainingPctOfSupply.toFixed(2) + '%'
    locks.totalPctFormatted = locks.totalPctOfSupply.toFixed(2) + '%'
  } catch { /* leave the percentages absent */ }
  return locks
}

async function ponsFor(token, tokenMeta) {
  let raw
  try {
    raw = await call(PONS_FACTORY, '0x3cf28b5a' + token.slice(2).toLowerCase().padStart(64, '0'))
  } catch {
    return null
  }
  if (!raw || raw === '0x' || (raw.length - 2) / 64 < 15) return null
  if (readUint(raw, 14) === 0n) return null

  const word = (index) => readUint(raw, index)
  const addr = (index) => toAddressWord(word(index))
  const pairToken = addr(4)
  const phase = Number(word(10))
  const phaseLabel = (
    phase === 0 ? 'On the Pons curve (not graduated)'
      : phase === 1 ? 'Graduated — curve swept'
        : phase === 2 ? 'Graduated — Uniswap V4 pool created'
          : phase === 3 ? 'Rescued'
            : `Unknown phase ${phase}`
  )

  const report = {
    factory: PONS_FACTORY,
    token: addr(0),
    curve: addr(1),
    deployer: addr(2),
    creatorFeeRecipient: addr(3),
    pairToken,
    pairLabel: pairToken === ZERO || pairToken === WETH ? 'ETH' : pairToken === USDG ? 'USDG' : 'token ' + shortAddress(pairToken),
    graduationThreshold: word(5).toString(),
    graduationThresholdHuman: fmtUnits(word(5), 18, 4),
    poolFee: Number(word(6)),
    tickSpacing: Number(word(7)),
    creatorTaxBps: Number(word(8)),
    buybackEnabled: word(9) !== 0n,
    phase,
    phaseLabel,
    sweptQuote: word(11).toString(),
    sweptTokens: word(12).toString(),
    sweptAt: Number(word(13)),
    reserves: null,
    oracle: null,
    estimates: null,
  }

  if (phase === 0 && report.curve !== ZERO) {
    try {
      const reservesRaw = await call(report.curve, CURVE.encodeFunctionData('getReserves'))
      const [quoteReserve, tokenReserve] = CURVE.decodeFunctionResult('getReserves', reservesRaw)
      const quoteDecimals = report.pairLabel === 'USDG' ? 6 : 18
      const quoteHuman = Number(quoteReserve) / 10 ** quoteDecimals
      const tokenHuman = tokenMeta.decimals != null ? Number(tokenReserve) / 10 ** tokenMeta.decimals : null
      const tokensPerQuote = tokenHuman != null && quoteHuman > 0 ? tokenHuman / quoteHuman : null
      report.reserves = {
        quoteReserve: quoteReserve.toString(),
        tokenReserve: tokenReserve.toString(),
        quoteDecimals,
        quoteHuman,
        quoteHumanFormatted: quoteHuman.toLocaleString('en-US', { maximumFractionDigits: 4 }),
        tokenHuman,
        tokenHumanFormatted: tokenHuman != null ? tokenHuman.toLocaleString('en-US', { maximumFractionDigits: 2 }) : null,
        tokensPerQuote,
        tokensPerQuoteFormatted: tokensPerQuote != null ? tokensPerQuote.toLocaleString('en-US', { maximumFractionDigits: 0 }) : null,
      }

      let feed = null
      if (report.pairLabel === 'ETH') feed = await readFeed(ETH_USD_FEED, 'ETH/USD')
      else if (report.pairLabel === 'USDG') feed = await readFeed(USDG_USD_FEED, 'USDG/USD')
      if (feed) {
        const quoteUsd = quoteHuman * feed.price
        const tokenPriceUsd = tokenHuman && tokenHuman > 0 ? quoteUsd / tokenHuman : null
        const supplyHuman = tokenMeta.totalSupply != null && tokenMeta.decimals != null
          ? Number(tokenMeta.totalSupply) / 10 ** tokenMeta.decimals
          : null
        report.oracle = feed
        report.estimates = {
          quoteUsd,
          quoteUsdFormatted: fmtUsd(quoteUsd),
          tokenPriceUsd,
          tokenPriceUsdFormatted: tokenPriceUsd != null ? '$' + tokenPriceUsd.toPrecision(4) : null,
          fdvUsd: tokenPriceUsd != null && supplyHuman != null ? tokenPriceUsd * supplyHuman : null,
          fdvUsdFormatted: tokenPriceUsd != null && supplyHuman != null ? fmtUsd(tokenPriceUsd * supplyHuman) : null,
          basis: `${feed.name} $${feed.price.toLocaleString('en-US', { maximumFractionDigits: 2 })} at ${feed.updatedAtIso}${feed.stale ? ' (stale)' : ''}`,
        }
      }
    } catch { /* reserves unavailable; the phase is still useful */ }
  }

  return report
}

function contractChecks(tokenMeta) {
  const checks = []
  const add = (key, label, status, detail) => checks.push({ key, label, status, detail })

  add(
    'contract',
    'Contract code',
    tokenMeta.codeBytes > 0 ? 'pass' : 'flag',
    tokenMeta.codeBytes > 0
      ? `${tokenMeta.codeBytes.toLocaleString('en-US')} bytes of runtime code at the address.`
      : 'No runtime code at this address on Robinhood Chain. It may be an EOA or a wrong chain.',
  )

  add(
    'owner',
    'Owner / admin',
    tokenMeta.owner ? 'info' : 'pass',
    tokenMeta.owner
      ? `owner() returns ${tokenMeta.owner}. The owner can change owner-gated behaviour; read the verified source to see what it controls.`
      : 'No non-zero owner() result. The token may be ownerless or may name its admin differently; this is not proof of renouncement.',
  )

  add(
    'mint',
    'Mint selector',
    tokenMeta.selectors.mint ? 'flag' : 'pass',
    tokenMeta.selectors.mint
      ? 'A function selector matching mint(address,uint256) is present in the bytecode. It may be disabled or unreachable; this is a selector check, not a call.'
      : 'No mint(address,uint256) selector found in the runtime bytecode.',
  )

  add(
    'pause',
    'Pause selector',
    tokenMeta.selectors.pause ? 'flag' : 'pass',
    tokenMeta.selectors.pause
      ? 'A function selector matching pause() is present in the bytecode. It may be disabled or unreachable; this is a selector check, not a call.'
      : 'No pause() selector found in the runtime bytecode.',
  )

  add(
    'blacklist',
    'Blacklist selector',
    tokenMeta.selectors.blacklist ? 'flag' : 'pass',
    tokenMeta.selectors.blacklist
      ? 'A function selector matching blacklist(address) is present in the bytecode. It may be disabled or unreachable; this is a selector check, not a call.'
      : 'No blacklist(address) selector found in the runtime bytecode.',
  )

  add(
    'paused_state',
    'Paused state',
    tokenMeta.paused === true ? 'flag' : tokenMeta.paused === false ? 'pass' : 'unknown',
    tokenMeta.paused === true
      ? 'paused() returns true on the contract. Transfers or other actions may be disabled right now.'
      : tokenMeta.paused === false
        ? 'paused() returns false on the contract.'
        : 'paused() did not answer or the token does not expose it. No conclusion is drawn.',
  )

  const powerKeys = [
    'transfer_ownership', 'upgrade_to', 'upgrade_to_and_call', 'set_fee', 'set_tax',
    'exclude_from_fee', 'set_max_tx', 'enable_trading', 'set_trading_enabled', 'set_limits',
    'set_blacklist', 'set_minter', 'set_router', 'set_pair', 'set_max_wallet', 'set_swap_enabled',
  ]
  const labels = Object.fromEntries(SELECTOR_FLAGS.map(([key, label]) => [key, label]))
  const powers = powerKeys.filter((key) => tokenMeta.selectors[key]).map((key) => labels[key])
  add(
    'powers',
    'Privileged selectors',
    powers.length ? 'info' : 'pass',
    powers.length
      ? `Found selectors: ${[...new Set(powers)].join(', ')}. A selector in bytecode is not a live function; read the source to see what it controls.`
      : 'No common fee, trading, ownership, router or upgrade selectors were found in the runtime bytecode.',
  )

  const proxyDetail = tokenMeta.proxy
    ? `The EIP-1967 implementation slot names ${tokenMeta.proxy}.`
      + (tokenMeta.proxyAdmin ? ` The admin slot names ${tokenMeta.proxyAdmin}.` : ' The admin slot is empty.')
      + (tokenMeta.proxyBeacon ? ` The beacon slot names ${tokenMeta.proxyBeacon}.` : '')
      + ' The implementation can change; the proxy address alone does not pin the rules.'
    : (tokenMeta.proxyAdmin || tokenMeta.proxyBeacon)
      ? `The implementation slot is empty, but ${tokenMeta.proxyAdmin ? `the admin slot names ${tokenMeta.proxyAdmin}` : `the beacon slot names ${tokenMeta.proxyBeacon}`}. This is not a conventional EIP-1967 proxy; read the source.`
      : 'The EIP-1967 implementation, admin and beacon slots are empty; this is not a conventional upgradeable proxy.'
  add('proxy', 'Proxy', tokenMeta.proxy || tokenMeta.proxyAdmin || tokenMeta.proxyBeacon ? 'info' : 'pass', proxyDetail)

  return checks
}

function buildChecks(tokenMeta, locks, pons, source) {
  const checks = contractChecks(tokenMeta)
  const add = (key, label, status, detail) => checks.push({ key, label, status, detail })

  add(
    'locks',
    'OAKEN locks',
    locks.active > 0 ? 'pass' : 'flag',
    locks.active > 0
      ? `${locks.total} lock${locks.total === 1 ? '' : 's'} across v1–v4; ${locks.active} still active, ${locks.totalRemainingHuman || '?'} tokens still locked${locks.remainingPctFormatted ? ` (${locks.remainingPctFormatted} of supply)` : ''}.`
      : locks.total > 0
        ? `${locks.total} lock${locks.total === 1 ? '' : 's'} found, but none has tokens left to unlock.`
        : 'No OAKEN lock was found for this token in v1–v4. A lock created directly against the vault is not indexed by the adapter.',
  )

  add(
    'revocable',
    'Revocable locks',
    locks.revocable > 0 ? 'flag' : 'pass',
    locks.revocable > 0
      ? `${locks.revocable} active lock${locks.revocable === 1 ? ' is' : 's are'} revocable by the creator. Revocable is not the same as unlocked, but it is a creator power.`
      : 'No active lock is marked revocable.',
  )

  add(
    'pons',
    'Pons launch',
    pons ? 'info' : 'unknown',
    pons
      ? `${pons.phaseLabel}; pair ${pons.pairLabel}; creator tax ${pons.creatorTaxBps} bps.`
      : 'The Pons factory did not return a launch record for this address. It may have launched elsewhere.',
  )

  const sourceState = sourceCheck(source)
  add('source', 'Source verification', sourceState.status, sourceState.detail)

  return checks
}

function buildSummary(report) {
  const { token, locks, pons, checks } = report
  const parts = []

  parts.push(`Read at block ${report.blockNumber.toLocaleString('en-US')} on Robinhood Chain (4663).`)
  if (token.name && token.symbol && token.name.toLowerCase() !== token.symbol.toLowerCase()) {
    parts.push(`Token: ${token.name} (${token.symbol}) at ${token.address}.`)
  } else if (token.name || token.symbol) {
    parts.push(`Token: ${token.name || token.symbol} at ${token.address}.`)
  }

  if (token.codeBytes === 0) {
    parts.push('The address has no runtime code, so there is nothing else to read.')
  } else {
    parts.push(`The contract is ${token.codeBytes.toLocaleString('en-US')} bytes; ${token.proxy ? 'it uses an EIP-1967 proxy' : 'the EIP-1967 implementation slot is empty'}; ${token.owner ? `owner() returns ${token.owner}` : 'no non-zero owner() was read'}.`)
  }

  if (locks.total > 0) {
    parts.push(
      `OAKEN sees ${locks.total} lock${locks.total === 1 ? '' : 's'} across v1–v4: ${locks.totalAmountHuman || '?'} ${token.symbol || 'tokens'} locked in total, `
      + `${locks.totalRemainingHuman || '?'} still locked${locks.remainingPctFormatted ? ` (${locks.remainingPctFormatted} of supply)` : ''}, ${locks.revocable} active revocable lock${locks.revocable === 1 ? '' : 's'}.`
      + (locks.nextUnlock ? ` Next unlock: ${fmtDate(locks.nextUnlock)}.` : ' No future unlock was found in the read range.'),
    )
  } else {
    parts.push('OAKEN found no lock for this token in v1–v4.')
  }

  if (pons) {
    let line = `Pons: ${pons.phaseLabel}.`
    if (pons.reserves) {
      line += ` Curve reserves: ${pons.reserves.quoteHumanFormatted} ${pons.pairLabel} / ${pons.reserves.tokenHumanFormatted || '?'} ${token.symbol || 'tokens'}`
        + (pons.reserves.tokensPerQuoteFormatted ? ` (${pons.reserves.tokensPerQuoteFormatted} tokens per ${pons.pairLabel})` : '') + '.'
    }
    if (pons.estimates) {
      line += ` Using ${pons.estimates.basis}, the quote side is about ${pons.estimates.quoteUsdFormatted}`
        + (pons.estimates.fdvUsdFormatted ? ` and the implied FDV is about ${pons.estimates.fdvUsdFormatted}` : '') + '.'
    }
    line += ` Creator tax ${pons.creatorTaxBps} bps${pons.buybackEnabled ? ', buyback enabled' : ''}.`
    parts.push(line)
  } else {
    parts.push('No Pons launch record was returned for this address.')
  }

  const flags = checks.filter((check) => check.status === 'flag')
  if (flags.length) {
    parts.push(`${flags.length} check${flags.length === 1 ? '' : 's'} need attention: ${flags.map((check) => check.label.toLowerCase()).join(', ')}.`)
  } else {
    parts.push('No flag was raised by the checks in this version.')
  }

  parts.push(DISCLAIMER)
  return parts.join(' ')
}

function buildSources(report) {
  const sources = [
    { label: 'Chain', value: 'Robinhood Chain (4663)' },
    { label: 'Block', value: String(report.blockNumber) },
    { label: 'Block time', value: report.blockTimeIso || 'unavailable' },
    { label: 'Token', value: report.token.address },
  ]
  for (const entry of report.locks.versions) {
    if (entry.count) sources.push({ label: `Locks ${entry.version}`, value: `${entry.count} (adapter ${VERSIONS.find((v) => v.version === entry.version).adapter})` })
  }
  if (report.pons) {
    sources.push({ label: 'Pons factory', value: PONS_FACTORY })
    if (report.pons.curve && report.pons.curve !== ZERO) sources.push({ label: 'Pons curve', value: report.pons.curve })
    if (report.pons.oracle) sources.push({ label: report.pons.oracle.name, value: `${report.pons.oracle.address} · updated ${report.pons.oracle.updatedAtIso}` })
  }
  if (report.source) {
    sources.push({ label: 'Sourcify', value: sourceSummary(report.source), href: report.source.url })
  }
  sources.push({ label: 'Reads', value: 'eth_call · eth_getCode · eth_getStorageAt at the block above' })
  return sources
}

export async function buildReport(token, options = {}) {
  if (!isAddress(token)) throw new Error('A token address on Robinhood Chain (0x + 40 hex) is required.')
  const address = token.toLowerCase()
  const block = await readBlock(options.blockNumber)
  const blockNumber = block.blockNumber
  const tokenMeta = await tokenMetadata(address)
  const [locksRaw, pons, source] = await Promise.all([
    locksFor(address, tokenMeta.decimals),
    tokenMeta.codeBytes > 0 ? ponsFor(address, tokenMeta) : Promise.resolve(null),
    tokenMeta.codeBytes > 0 ? sourcifyFor(address) : Promise.resolve(null),
  ])
  const locks = attachSupplyPercent(tokenMeta, locksRaw)

  const report = {
    kind: 'token-lock-report',
    version: 1,
    chain: { id: CHAIN_ID, name: CHAIN.name, explorer: CHAIN.explorer },
    blockNumber,
    blockTime: block.blockTime,
    blockTimeIso: block.blockTimeIso,
    token: tokenMeta,
    locks,
    pons,
    source,
    checks: [],
    summary: null,
    sources: [],
    disclaimer: DISCLAIMER,
  }
  report.checks = buildChecks(tokenMeta, locks, pons, source)
  report.summary = buildSummary(report)
  report.sources = buildSources(report)
  return report
}

/**
 * Curve report: the OAKEN Curve v5 launch behind one curve address.
 *
 * The input is the curve, not the token. The v5 factory has no registry getter,
 * so a token address cannot be turned into a curve address without replaying
 * factory logs; the curve address is the one the site already puts in the URL
 * (`/curve/robinhood/<curve>`), and `token()` on it is the binding check.
 *
 * Every number is a contract read at one block. After graduation the contract
 * zeroes `trackedTokens` / `trackedQuote` and moves the pool position; the
 * report says "graduated" and stops presenting the curve as a live market
 * instead of printing the zeros as if they were progress.
 */
export async function buildCurveReport(address, options = {}) {
  if (!isAddress(address)) throw new Error('A curve address on Robinhood Chain (0x + 40 hex) is required.')
  const curveAddress = address.toLowerCase()

  const code = await rpc(CHAIN_ID, 'eth_getCode', [curveAddress, 'latest'], { timeout: 20_000, attempts: 3 })
  const curveCodeBytes = Math.max(0, (String(code || '').length - 2) / 2)
  if (curveCodeBytes === 0) throw new Error('No contract code at that address on Robinhood Chain.')

  const tokenRaw = await tryCall(curveAddress, OAKEN_CURVE.encodeFunctionData('token'))
  if (!tokenRaw) throw new Error('That contract does not answer token(); it is not an OAKEN curve.')
  const token = toAddressWord(readUint(tokenRaw, 0))
  if (token === ZERO) throw new Error('The curve returned the zero address for its token.')

  const block = await readBlock(options.blockNumber)
  const blockNumber = block.blockNumber

  const names = [
    'token', 'creator', 'creatorFeeRecipient', 'feeBps', 'creatorTaxBps', 'protocolShareBps',
    'snipeTaxStartBps', 'snipeTaxSeconds', 'virtualTokens', 'phantomQuote', 'graduationThreshold',
    'launchSupply', 'reservedTokens', 'trackedQuote', 'trackedTokens', 'launchedAt', 'graduated',
    'readyToGraduate', 'getReserves', 'sellableTokens', 'pendingCreatorFees', 'protocolFeeBalance',
    'creatorFeeBalance', 'creatorTaxBalance', 'snipeTaxBalance',
  ]
  const calls = names.map((name) => ({ to: curveAddress, data: OAKEN_CURVE.encodeFunctionData(name) }))
  let results = []
  try {
    results = await multicallFor(curveAddress, calls.map((entry) => entry.data))
  } catch {
    try {
      results = await callMany(CHAIN_ID, calls)
    } catch {
      results = []
      for (const entry of calls) results.push(await tryCall(entry.to, entry.data))
    }
  }
  const at = (name) => results[names.indexOf(name)] || null
  const uint = (name) => { const raw = at(name); return raw ? readUint(raw, 0) : null }
  const bool = (name) => { const raw = at(name); return raw ? readUint(raw, 0) !== 0n : null }
  const addr = (name) => { const raw = at(name); return raw ? toAddressWord(readUint(raw, 0)) : null }

  const launchSupply = uint('launchSupply')
  const trackedQuote = uint('trackedQuote')
  const trackedTokens = uint('trackedTokens')
  const graduationThreshold = uint('graduationThreshold')
  const graduated = bool('graduated')
  const readyToGraduate = bool('readyToGraduate')
  if (launchSupply === null || trackedQuote === null || trackedTokens === null
    || graduationThreshold === null || graduated === null || readyToGraduate === null) {
    const missing = [
      ['launchSupply', launchSupply], ['trackedQuote', trackedQuote], ['trackedTokens', trackedTokens],
      ['graduationThreshold', graduationThreshold], ['graduated', graduated], ['readyToGraduate', readyToGraduate],
    ].filter(([, value]) => value === null).map(([name]) => name)
    throw new Error(`The curve did not answer ${missing.join(', ')}; refusing to build a report from partial reads.`)
  }

  let reserves = null
  try {
    const raw = at('getReserves')
    if (raw) {
      const [quoteReserve, tokenReserve] = OAKEN_CURVE.decodeFunctionResult('getReserves', raw)
      reserves = { quoteReserve: BigInt(quoteReserve), tokenReserve: BigInt(tokenReserve) }
    }
  } catch { reserves = null }

  const tokenMeta = await tokenMetadata(token)
  const [locksRaw, sourceCurve, sourceToken] = await Promise.all([
    locksFor(token, tokenMeta.decimals),
    sourcifyFor(curveAddress),
    sourcifyFor(token),
  ])
  const locks = attachSupplyPercent(tokenMeta, locksRaw)

  const decimals = tokenMeta.decimals
  const supplyHuman = decimals != null ? Number(launchSupply) / 10 ** decimals : null
  const reserved = uint('reservedTokens') ?? 0n
  const sellableTotal = launchSupply > reserved ? launchSupply - reserved : 0n
  const sold = launchSupply > trackedTokens ? launchSupply - trackedTokens : 0n
  const soldShown = sold > sellableTotal ? sellableTotal : sold
  const pct = (part, whole) => (whole > 0n ? Number((part * 1_000_000n) / whole) / 10_000 : null)
  const soldPct = pct(soldShown, sellableTotal)
  const raisePct = pct(trackedQuote, graduationThreshold)
  const raisedHuman = Number(trackedQuote) / 10 ** 18
  const thresholdHuman = Number(graduationThreshold) / 10 ** 18
  const reservedHuman = decimals != null ? Number(reserved) / 10 ** decimals : null
  const soldHuman = decimals != null ? Number(soldShown) / 10 ** decimals : null
  const sellableHuman = decimals != null ? Number(sellableTotal) / 10 ** decimals : null
  const remainingHuman = Number(graduationThreshold > trackedQuote ? graduationThreshold - trackedQuote : 0n) / 10 ** 18

  const spotPrice = reserves && reserves.tokenReserve > 0n && decimals != null
    ? (Number(reserves.quoteReserve) / 10 ** 18) / (Number(reserves.tokenReserve) / 10 ** decimals)
    : null
  const spotFdv = spotPrice != null && supplyHuman != null ? spotPrice * supplyHuman : null
  const realPrice = soldHuman != null && soldHuman > 0 ? raisedHuman / soldHuman : null
  const realFdv = realPrice != null && supplyHuman != null ? realPrice * supplyHuman : null

  const feed = await readFeed(ETH_USD_FEED, 'ETH/USD')
  const estimates = feed
    ? {
      quoteUsd: raisedHuman * feed.price,
      quoteUsdFormatted: fmtUsd(raisedHuman * feed.price),
      spotPriceUsd: spotPrice != null ? spotPrice * feed.price : null,
      spotPriceUsdFormatted: spotPrice != null ? '$' + (spotPrice * feed.price).toPrecision(4) : null,
      spotFdvUsd: spotFdv != null ? spotFdv * feed.price : null,
      spotFdvUsdFormatted: spotFdv != null ? fmtUsd(spotFdv * feed.price) : null,
      realPriceUsd: realPrice != null ? realPrice * feed.price : null,
      realFdvUsd: realFdv != null ? realFdv * feed.price : null,
      realFdvUsdFormatted: realFdv != null ? fmtUsd(realFdv * feed.price) : null,
      basis: `${feed.name} $${feed.price.toLocaleString('en-US', { maximumFractionDigits: 2 })} at ${feed.updatedAtIso}${feed.stale ? ' (stale)' : ''}`,
    }
    : null

  const feeBps = uint('feeBps')
  const creatorTaxBps = uint('creatorTaxBps')
  const protocolShareBps = uint('protocolShareBps')
  const snipeTaxStartBps = uint('snipeTaxStartBps')
  const snipeTaxSeconds = uint('snipeTaxSeconds')
  const launchedAt = uint('launchedAt')
  const creator = addr('creator')
  const creatorFeeRecipient = addr('creatorFeeRecipient')
  const statusKey = graduated ? 'graduated' : readyToGraduate ? 'ready' : 'curve'
  const statusLabel = graduated ? 'Graduated' : readyToGraduate ? 'Ready to graduate' : 'On the curve'

  const expectedReady = !graduated && launchSupply > 0n && trackedTokens <= reserved
  const accountingOk = readyToGraduate === expectedReady
    && (!graduated || (trackedTokens === 0n && trackedQuote === 0n))

  const human = (raw) => (raw != null && decimals != null ? fmtUnits(raw, decimals) : null)
  const quoteHuman = (raw) => (raw != null ? fmtUnits(raw, 18, 4) : null)
  const fdvLabel = (value) => {
    if (value == null || !Number.isFinite(value) || value < 0) return null
    if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B'
    if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M'
    if (value >= 1e3) return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
    return value.toLocaleString('en-US', { maximumFractionDigits: 4 })
  }

  const curve = {
    address: curveAddress,
    factory: OAKEN_CURVE_FACTORY,
    token,
    creator,
    creatorFeeRecipient,
    launchedAt: launchedAt != null ? Number(launchedAt) : null,
    launchedAtIso: launchedAt != null && launchedAt > 0n ? isoNow(Number(launchedAt)) : null,
    status: statusKey,
    statusLabel,
    graduated,
    readyToGraduate,
    launchSupply: launchSupply.toString(),
    launchSupplyHuman: human(launchSupply),
    reservedTokens: reserved.toString(),
    reservedTokensHuman: human(reserved),
    sellableTotal: sellableTotal.toString(),
    sellableTotalHuman: human(sellableTotal),
    sellableTokens: uint('sellableTokens') != null ? uint('sellableTokens').toString() : null,
    sellableTokensHuman: human(uint('sellableTokens')),
    trackedQuote: trackedQuote.toString(),
    trackedQuoteHuman: quoteHuman(trackedQuote),
    trackedTokens: trackedTokens.toString(),
    trackedTokensHuman: human(trackedTokens),
    graduationThreshold: graduationThreshold.toString(),
    graduationThresholdHuman: quoteHuman(graduationThreshold),
    remainingToGraduate: (graduationThreshold > trackedQuote ? graduationThreshold - trackedQuote : 0n).toString(),
    remainingToGraduateHuman: fmtUnits(graduationThreshold > trackedQuote ? graduationThreshold - trackedQuote : 0n, 18, 4),
    sold: soldShown.toString(),
    soldHuman: human(soldShown),
    soldPct: soldPct == null ? null : Number(soldPct.toFixed(4)),
    soldPctFormatted: soldPct == null ? null : soldPct.toFixed(2) + '%',
    raisePct: raisePct == null ? null : Number(raisePct.toFixed(4)),
    raisePctFormatted: raisePct == null ? null : raisePct.toFixed(2) + '%',
    virtualTokens: uint('virtualTokens') != null ? uint('virtualTokens').toString() : null,
    virtualTokensHuman: human(uint('virtualTokens')),
    phantomQuote: uint('phantomQuote') != null ? uint('phantomQuote').toString() : null,
    phantomQuoteHuman: quoteHuman(uint('phantomQuote')),
    reserves: reserves ? {
      quoteReserve: reserves.quoteReserve.toString(),
      tokenReserve: reserves.tokenReserve.toString(),
      quoteReserveHuman: quoteHuman(reserves.quoteReserve),
      tokenReserveHuman: human(reserves.tokenReserve),
      spotPrice,
      spotPriceFormatted: spotPrice != null ? spotPrice.toPrecision(6) : null,
    } : null,
    price: {
      spot: spotPrice,
      spotFormatted: spotPrice != null ? spotPrice.toPrecision(6) : null,
      real: realPrice,
      realFormatted: realPrice != null ? realPrice.toPrecision(6) : null,
      spotFdv,
      spotFdvFormatted: fdvLabel(spotFdv),
      realFdv,
      realFdvFormatted: fdvLabel(realFdv),
    },
    fees: {
      feeBps: feeBps != null ? Number(feeBps) : null,
      feeFormatted: feeBps != null ? (Number(feeBps) / 100).toFixed(2) + '%' : null,
      creatorTaxBps: creatorTaxBps != null ? Number(creatorTaxBps) : null,
      creatorTaxFormatted: creatorTaxBps != null ? (Number(creatorTaxBps) / 100).toFixed(2) + '%' : null,
      protocolShareBps: protocolShareBps != null ? Number(protocolShareBps) : null,
      protocolShareFormatted: protocolShareBps != null ? (Number(protocolShareBps) / 100).toFixed(2) + '%' : null,
      snipeTaxStartBps: snipeTaxStartBps != null ? Number(snipeTaxStartBps) : null,
      snipeTaxSeconds: snipeTaxSeconds != null ? Number(snipeTaxSeconds) : null,
    },
    balances: {
      pendingCreatorFees: uint('pendingCreatorFees') != null ? uint('pendingCreatorFees').toString() : null,
      pendingCreatorFeesHuman: quoteHuman(uint('pendingCreatorFees')),
      protocolFeeBalance: uint('protocolFeeBalance') != null ? uint('protocolFeeBalance').toString() : null,
      protocolFeeBalanceHuman: quoteHuman(uint('protocolFeeBalance')),
      creatorFeeBalance: uint('creatorFeeBalance') != null ? uint('creatorFeeBalance').toString() : null,
      creatorFeeBalanceHuman: quoteHuman(uint('creatorFeeBalance')),
      creatorTaxBalance: uint('creatorTaxBalance') != null ? uint('creatorTaxBalance').toString() : null,
      creatorTaxBalanceHuman: quoteHuman(uint('creatorTaxBalance')),
      snipeTaxBalance: uint('snipeTaxBalance') != null ? uint('snipeTaxBalance').toString() : null,
      snipeTaxBalanceHuman: quoteHuman(uint('snipeTaxBalance')),
    },
    estimates,
  }

  const checks = []
  const add = (key, label, status, detail) => checks.push({ key, label, status, detail })
  add(
    'curve_contract',
    'Curve contract',
    curveCodeBytes > 0 ? 'pass' : 'flag',
    `${curveCodeBytes.toLocaleString('en-US')} bytes of runtime code at the curve address.`,
  )
  add(
    'binding',
    'Curve ↔ token',
    'pass',
    `token() returns ${token}. The token facts below are read from that address, not from the input.`,
  )
  add(
    'supply',
    'Fixed supply',
    tokenMeta.totalSupply == null
      ? 'unknown'
      : BigInt(tokenMeta.totalSupply) === launchSupply ? 'pass' : 'flag',
    tokenMeta.totalSupply == null
      ? 'totalSupply() did not answer; the curve and the token supply cannot be compared.'
      : BigInt(tokenMeta.totalSupply) === launchSupply
        ? `The token's totalSupply equals launchSupply (${human(launchSupply) || launchSupply.toString()}).`
        : `The token's totalSupply is ${tokenMeta.totalSupplyHuman || tokenMeta.totalSupply}, but the curve says launchSupply is ${human(launchSupply) || launchSupply.toString()}. The curve is not the only source of this token's supply.`,
  )
  add(
    'reserves',
    'Curve reserves',
    reserves ? 'pass' : 'unknown',
    reserves
      ? `getReserves() returns ${quoteHuman(reserves.quoteReserve)} ETH / ${human(reserves.tokenReserve) || '?'} ${tokenMeta.symbol || 'tokens'} (virtual reserves).`
      : 'getReserves() did not answer. The curve may be paused or the RPC may have failed; no price is derived.',
  )
  add(
    'graduation',
    'Graduation',
    'info',
    graduated
      ? 'graduated() returns true. The curve has zeroed its tracked reserves and the market, if any, is the DEX pool; this report does not read that pool.'
      : readyToGraduate
        ? 'readyToGraduate() returns true. Buys and sells are closed; anyone can graduate the curve.'
        : `On the curve. ${curve.soldPctFormatted || '?'} of the sellable allocation is sold; ${fmtUnits(graduationThreshold > trackedQuote ? graduationThreshold - trackedQuote : 0n, 18, 4)} ETH remains to the graduation line.`,
  )
  add(
    'accounting',
    'Curve accounting',
    accountingOk ? 'pass' : 'flag',
    accountingOk
      ? `trackedTokens ${human(trackedTokens) || trackedTokens.toString()} / reserved ${human(reserved) || reserved.toString()}; readyToGraduate agrees with the state.`
      : `readyToGraduate() and the stored reserves disagree (trackedTokens ${trackedTokens.toString()}, reserved ${reserved.toString()}, graduated ${graduated}, ready ${readyToGraduate}). Read the contract before trusting either field.`,
  )
  add(
    'fees',
    'Fee parameters',
    feeBps == null || Number(feeBps) > 1_000 ? 'flag' : 'pass',
    feeBps == null
      ? 'feeBps() did not answer.'
      : `feeBps() returns ${feeBps} (${(Number(feeBps) / 100).toFixed(2)}%)${creatorTaxBps != null ? `; creator tax ${Number(creatorTaxBps)} bps (${(Number(creatorTaxBps) / 100).toFixed(2)}%)` : ''}${protocolShareBps != null ? `; protocol share ${Number(protocolShareBps)} bps` : ''}.`,
  )
  add(
    'creator_tax',
    'Creator tax',
    creatorTaxBps == null ? 'unknown' : Number(creatorTaxBps) > 1_000 ? 'flag' : 'pass',
    creatorTaxBps == null
      ? 'creatorTaxBps() did not answer.'
      : Number(creatorTaxBps) > 1_000
        ? `creatorTaxBps() returns ${creatorTaxBps}, above the 1,000 bps cap the v5 factory documents.`
        : `creatorTaxBps() returns ${creatorTaxBps} bps, within the 1,000 bps cap.`,
  )
  checks.push(...contractChecks(tokenMeta))
  add(
    'locks',
    'OAKEN locks',
    locks.active > 0 ? 'pass' : 'flag',
    locks.active > 0
      ? `${locks.total} lock${locks.total === 1 ? '' : 's'} across v1–v4; ${locks.active} still active, ${locks.totalRemainingHuman || '?'} tokens still locked${locks.remainingPctFormatted ? ` (${locks.remainingPctFormatted} of supply)` : ''}.`
      : locks.total > 0
        ? `${locks.total} lock${locks.total === 1 ? '' : 's'} found, but none has tokens left to unlock.`
        : 'No OAKEN lock was found for this token in v1–v4. A lock created directly against the vault is not indexed by the adapter.',
  )
  add('source', 'Curve source', sourceCheck(sourceCurve).status, sourceCheck(sourceCurve).detail)
  add('token_source', 'Token source', sourceCheck(sourceToken).status, sourceCheck(sourceToken).detail)

  const reportedSymbol = tokenMeta.symbol || shortAddress(token)
  const parts = []
  parts.push(`Curve report read at block ${blockNumber.toLocaleString('en-US')} on Robinhood Chain (4663).`)
  parts.push(`${tokenMeta.name && tokenMeta.symbol && tokenMeta.name.toLowerCase() !== tokenMeta.symbol.toLowerCase() ? `${tokenMeta.name} (${tokenMeta.symbol})` : (tokenMeta.name || reportedSymbol)} at ${token}; OAKEN Curve v5 at ${curveAddress}.`)
  parts.push(`Status: ${statusLabel}. Sold ${curve.soldHuman || '?'} of ${curve.sellableTotalHuman || '?'} sellable ${reportedSymbol} (${curve.soldPctFormatted || '?'}); raised ${curve.trackedQuoteHuman || '?'} of ${curve.graduationThresholdHuman || '?'} ETH (${curve.raisePctFormatted || '?'}).`)
  if (curve.price.spot != null) {
    parts.push(`Curve spot ${curve.price.spotFormatted} ETH per ${reportedSymbol}${estimates?.spotPriceUsdFormatted ? ` (${estimates.spotPriceUsdFormatted})` : ''}; implied FDV ${curve.price.spotFdvFormatted} ETH${estimates?.spotFdvUsdFormatted ? ` (${estimates.spotFdvUsdFormatted})` : ''}.`)
  }
  if (estimates) parts.push(`Quote side is about ${estimates.quoteUsdFormatted} using ${estimates.basis}.`)
  parts.push(`Fees: ${curve.fees.feeFormatted || '?'} protocol, ${curve.fees.creatorTaxFormatted || '?'} creator tax${curve.fees.snipeTaxSeconds != null ? `, snipe tax starts at ${(Number(curve.fees.snipeTaxStartBps || 0) / 100).toFixed(0)}% for ${curve.fees.snipeTaxSeconds}s` : ''}.`)
  parts.push(locks.total > 0
    ? `OAKEN sees ${locks.total} lock${locks.total === 1 ? '' : 's'} for this token; ${locks.totalRemainingHuman || '?'} ${reportedSymbol} still locked.`
    : 'OAKEN sees no lock for this token.')
  const flags = checks.filter((check) => check.status === 'flag')
  parts.push(flags.length
    ? `${flags.length} check${flags.length === 1 ? '' : 's'} need attention: ${flags.map((check) => check.label.toLowerCase()).join(', ')}.`
    : 'No flag was raised by the checks in this version.')
  parts.push('A curve price is not a promise of liquidity. After graduation this report does not read the DEX pool.')
  parts.push(DISCLAIMER)

  const sources = [
    { label: 'Chain', value: 'Robinhood Chain (4663)' },
    { label: 'Block', value: String(blockNumber) },
    { label: 'Block time', value: block.blockTimeIso || 'unavailable' },
    { label: 'Curve', value: curveAddress },
    { label: 'Token', value: token },
    { label: 'Factory', value: OAKEN_CURVE_FACTORY },
  ]
  if (feed) sources.push({ label: feed.name, value: `${feed.address} · updated ${feed.updatedAtIso}` })
  sources.push({ label: 'Sourcify (curve)', value: sourceSummary(sourceCurve), href: sourceCurve.url })
  sources.push({ label: 'Sourcify (token)', value: sourceSummary(sourceToken), href: sourceToken.url })
  sources.push({ label: 'Reads', value: 'eth_call · eth_getCode at the block above' })

  return {
    kind: 'curve-report',
    version: 1,
    chain: { id: CHAIN_ID, name: CHAIN.name, explorer: CHAIN.explorer },
    blockNumber,
    blockTime: block.blockTime,
    blockTimeIso: block.blockTimeIso,
    token: tokenMeta,
    curve,
    locks,
    source: sourceCurve,
    tokenSource: sourceToken,
    checks,
    summary: parts.join(' '),
    sources,
    disclaimer: DISCLAIMER,
  }
}


async function readOracle(address, name) {
  const [round, decimalsRaw] = await Promise.all([
    tryCall(address, BOND_SEL.oracle.latestRoundData),
    tryCall(address, BOND_SEL.oracle.decimals),
  ])
  if (!round) return null
  const decimals = decimalsRaw ? Number(readUint(decimalsRaw)) : 8
  try {
    const [, answer, , updatedAt] = FEED.decodeFunctionResult('latestRoundData', round)
    const price = Number(answer) / 10 ** decimals
    if (!Number.isFinite(price) || price <= 0) return null
    const updated = Number(updatedAt)
    return {
      name,
      address,
      decimals,
      price,
      updatedAt: updated,
      updatedAtIso: isoNow(updated),
      stale: nowSec() - updated > 24 * 60 * 60,
    }
  } catch {
    return null
  }
}

/**
 * Pre-launch review: the token facts are on-chain; the lock plan is what the
 * creator typed. The plan is never presented as an on-chain fact, and the
 * heuristics are labelled as OAKEN's own thresholds rather than as audit rules.
 */
export async function buildPrelaunchReport(input = {}) {
  const rawToken = String(input.token || '').trim()
  if (!isAddress(rawToken)) throw new Error('A token address on Robinhood Chain (0x + 40 hex) is required.')
  const token = rawToken.toLowerCase()

  const lockAmount = Number(input.lockAmount)
  const lockDays = Number(input.lockDays)
  const steps = Number(input.steps ?? 0)
  const initialUnlockPct = Number(input.initialUnlockPct ?? 0)
  const revocable = input.revocable === true || input.revocable === 'true' || input.revocable === 1

  if (!Number.isFinite(lockAmount) || lockAmount <= 0) throw new Error('Enter the number of tokens you plan to lock.')
  if (!Number.isFinite(lockDays) || lockDays < 0 || lockDays > 3650) throw new Error('Lock days must be between 0 and 3650.')
  if (!Number.isFinite(steps) || steps < 0 || steps > 24) throw new Error('Vesting steps must be between 0 and 24.')
  if (!Number.isFinite(initialUnlockPct) || initialUnlockPct < 0 || initialUnlockPct > 100) throw new Error('Initial unlock must be between 0 and 100%.')

  const block = await readBlock()
  const blockNumber = block.blockNumber
  const tokenMeta = await tokenMetadata(token)
  const [locksRaw, pons, source] = await Promise.all([
    locksFor(token, tokenMeta.decimals),
    tokenMeta.codeBytes > 0 ? ponsFor(token, tokenMeta) : Promise.resolve(null),
    tokenMeta.codeBytes > 0 ? sourcifyFor(token) : Promise.resolve(null),
  ])
  const locks = attachSupplyPercent(tokenMeta, locksRaw)

  const supplyHuman = tokenMeta.totalSupply != null && tokenMeta.decimals != null
    ? Number(tokenMeta.totalSupply) / 10 ** tokenMeta.decimals
    : null
  const sharePct = supplyHuman != null && supplyHuman > 0 ? (lockAmount / supplyHuman) * 100 : null
  const endTime = nowSec() + Math.round(lockDays * 86_400)
  const plan = {
    lockAmount,
    lockAmountFormatted: lockAmount.toLocaleString('en-US', { maximumFractionDigits: 4 }),
    lockDays,
    steps,
    initialUnlockPct,
    revocable,
    endTime,
    endIso: isoNow(endTime),
    sharePct,
    sharePctFormatted: sharePct != null ? sharePct.toFixed(sharePct >= 1 ? 2 : 4) + '%' : null,
    source: 'user-provided plan; not an on-chain lock',
  }

  const checks = contractChecks(tokenMeta)
  const add = (key, label, status, detail) => checks.push({ key, label, status, detail })

  add(
    'lock_amount',
    'Planned lock amount',
    'pass',
    `The plan locks ${plan.lockAmountFormatted} ${tokenMeta.symbol || 'tokens'}.`,
  )
  add(
    'supply_share',
    'Share of supply',
    sharePct == null ? 'unknown' : 'info',
    sharePct == null
      ? 'The token did not return a readable totalSupply, so the share of supply cannot be computed.'
      : `The planned lock is ${plan.sharePctFormatted} of the current total supply.`,
  )
  add(
    'lock_days',
    'Lock duration',
    lockDays >= 30 ? 'pass' : 'flag',
    `${lockDays} day${lockDays === 1 ? '' : 's'} from now (${fmtDate(endTime)}). OAKEN's own heuristic treats anything under 30 days as a weak lock, not as a rule of the contract.`,
  )
  add(
    'initial_unlock',
    'Initial unlock',
    initialUnlockPct <= 25 ? 'pass' : 'flag',
    `${initialUnlockPct}% unlocks at the start. OAKEN's own heuristic flags above 25%; the contract allows any 0–100%.`,
  )
  add(
    'revocable',
    'Revocable',
    revocable ? 'flag' : 'pass',
    revocable
      ? 'The creator keeps the ability to revoke the lock. Revocable is a creator power, not an unlocked balance.'
      : 'The planned lock is not revocable by the creator.',
  )
  add(
    'steps',
    'Vesting steps',
    'info',
    steps === 0 ? 'One unlock at the end; no tranches.' : `${steps} step${steps === 1 ? '' : 's'} release the tail linearly after the initial unlock.`,
  )
  add(
    'existing_locks',
    'Existing OAKEN locks',
    'info',
    locks.total > 0
      ? `${locks.total} existing lock${locks.total === 1 ? '' : 's'} already read from v1–v4; the plan adds another.`
      : 'No existing OAKEN lock was found; this is consistent with a pre-launch review.',
  )
  add(
    'pons',
    'Pons status',
    'info',
    pons ? `A Pons record already exists (${pons.phaseLabel}); this is a post-launch review, not a pre-launch one.` : 'The Pons factory has no record for this address yet.',
  )
  const sourceState = sourceCheck(source)
  add('source', 'Source verification', sourceState.status, sourceState.detail)

  const report = {
    kind: 'prelaunch-review',
    version: 1,
    chain: { id: CHAIN_ID, name: CHAIN.name, explorer: CHAIN.explorer },
    blockNumber,
    blockTime: block.blockTime,
    blockTimeIso: block.blockTimeIso,
    token: tokenMeta,
    locks,
    pons,
    plan,
    source,
    checks,
    summary: null,
    sources: [],
    disclaimer: DISCLAIMER,
  }

  const flags = checks.filter((check) => check.status === 'flag')
  const parts = []
  parts.push(`Pre-launch plan review read at block ${blockNumber.toLocaleString('en-US')} on Robinhood Chain (4663). The token facts are on-chain; the lock plan is user-provided and is not an on-chain lock.`)
  if (tokenMeta.name || tokenMeta.symbol) {
    parts.push(`Token: ${tokenMeta.name && tokenMeta.symbol && tokenMeta.name.toLowerCase() !== tokenMeta.symbol.toLowerCase() ? `${tokenMeta.name} (${tokenMeta.symbol})` : (tokenMeta.name || tokenMeta.symbol)} at ${token}.`)
  }
  if (tokenMeta.codeBytes === 0) {
    parts.push('The address has no runtime code, so there is nothing on-chain to review.')
  } else {
    parts.push(`Supply: ${tokenMeta.totalSupplyHuman || 'unreadable'} ${tokenMeta.symbol || 'tokens'}; contract ${tokenMeta.codeBytes.toLocaleString('en-US')} bytes; ${tokenMeta.owner ? `owner() returns ${tokenMeta.owner}` : 'no non-zero owner() was read'}.`)
  }
  parts.push(`Plan: lock ${plan.lockAmountFormatted} tokens${plan.sharePctFormatted ? ` (${plan.sharePctFormatted} of supply)` : ''} for ${lockDays} days, ${steps === 0 ? 'one terminal unlock' : `${steps} vesting steps`}, ${initialUnlockPct}% initial unlock, ${revocable ? 'revocable' : 'not revocable'}.`)
  parts.push(locks.total > 0 ? `OAKEN already sees ${locks.total} lock${locks.total === 1 ? '' : 's'} for this token.` : 'OAKEN sees no existing lock for this token.')
  if (pons) parts.push(`Pons: ${pons.phaseLabel}.`)
  parts.push(flags.length
    ? `${flags.length} check${flags.length === 1 ? '' : 's'} need attention: ${flags.map((check) => check.label.toLowerCase()).join(', ')}.`
    : 'No flag was raised by the checks in this version.')
  parts.push(DISCLAIMER)
  report.summary = parts.join(' ')
  report.sources = [
    { label: 'Chain', value: 'Robinhood Chain (4663)' },
    { label: 'Block', value: String(blockNumber) },
    { label: 'Block time', value: block.blockTimeIso || 'unavailable' },
    { label: 'Token', value: token },
    { label: 'Plan', value: 'user-provided; not an on-chain lock' },
  ]
  if (source) report.sources.push({ label: 'Sourcify', value: sourceSummary(source), href: source.url })
  return report
}

/**
 * Bond health: the OAKEN bond is a different product from a lock, and this
 * report keeps the boundary explicit. It reads the vault, the NAV oracle and
 * the staking pool; it does not treat the bond as if it were a lock.
 */
export async function buildBondReport(symbol = 'OAKEN') {
  const wanted = String(symbol || 'OAKEN').trim().toLowerCase()
  const bond = OAKEN_BONDS.find((entry) => entry.symbol.toLowerCase() === wanted)
  if (!bond) throw new Error(`Unknown bond. Available: ${OAKEN_BONDS.map((entry) => entry.symbol).join(', ')}.`)

  const block = await readBlock()
  const blockNumber = block.blockNumber
  const calls = [
    { to: bond.token, data: BOND_SEL.bond.totalSupply },
    { to: bond.token, data: BOND_SEL.bond.decimals },
    { to: bond.token, data: '0x95d89b41' },
    { to: bond.vault, data: BOND_SEL.vault.price },
    { to: bond.vault, data: BOND_SEL.vault.reserves },
    { to: bond.vault, data: BOND_SEL.vault.isSolvent },
    { to: bond.vault, data: BOND_SEL.vault.redeemFeeBps },
    { to: bond.vault, data: BOND_SEL.vault.mintCap },
    { to: bond.vault, data: BOND_SEL.vault.paused },
    { to: bond.staking, data: BOND_SEL.staking.totalStaked },
    { to: bond.staking, data: BOND_SEL.staking.rewardDuration },
    { to: bond.staking, data: BOND_SEL.staking.streamRemaining },
    { to: bond.vault, data: BOND_SEL.vault.usdgOutFor + BigInt(10n ** 18n).toString(16).padStart(64, '0') },
    { to: bond.vault, data: BOND_SEL.vault.bondOutFor + BigInt(1_000_000n).toString(16).padStart(64, '0') },
    { to: bond.staking, data: BOND_SEL.staking.snapshot + '0'.repeat(64) },
  ]
  const [answers, source] = await Promise.all([
    callMany(CHAIN_ID, calls).catch(() => []),
    sourcifyFor(bond.token),
  ])

  const at = (index) => answers[index] || null
  const supply = at(0) ? readUint(at(0), 0) : null
  const bondDecimals = at(1) ? Number(readUint(at(1), 0)) : BOND_DECIMALS.bond
  let bondSymbol = bond.symbol
  try { const decoded = decodeString(at(2)); if (decoded) bondSymbol = cleanText(decoded, 24) } catch { /* keep registry symbol */ }
  const priceRaw = at(3) ? readUint(at(3), 0) : null
  const reserves = at(4) ? readUint(at(4), 0) : null
  const solvent = at(5) ? readUint(at(5), 0) !== 0n : null
  const redeemFeeBps = at(6) ? Number(readUint(at(6), 0)) : null
  const mintCap = at(7) ? readUint(at(7), 0) : null
  const paused = at(8) ? readUint(at(8), 0) !== 0n : null
  const stakingTotal = at(9) ? readUint(at(9), 0) : null
  const rewardDuration = at(10) ? Number(readUint(at(10), 0)) : null
  const streamRemaining = at(11) ? readUint(at(11), 0) : null
  const redeemOneBondUsdg = at(12) ? readUint(at(12), 0) : null
  const mintOneUsdgBonds = at(13) ? readUint(at(13), 0) : null
  const snapshot = at(14)
  const snapshotWord = (index) => (snapshot ? readUint(snapshot, index) : null)
  const snapshotTotal = snapshotWord(0)
  const snapshotRateU = snapshotWord(4)
  const snapshotRateA = snapshotWord(5)
  const snapshotQueuedU = snapshotWord(6)
  const snapshotQueuedA = snapshotWord(7)
  const snapshotFinishU = snapshotWord(10)

  const nav = priceRaw != null ? Number(priceRaw) / 10 ** BOND_DECIMALS.feed : null
  const supplyHuman = supply != null ? Number(supply) / 10 ** bondDecimals : null
  const reservesHuman = reserves != null ? Number(reserves) / 10 ** BOND_DECIMALS.usdg : null
  const backingPerBond = supplyHuman != null && supplyHuman > 0 && reservesHuman != null ? reservesHuman / supplyHuman : null
  const coveragePct = backingPerBond != null && nav != null && nav > 0 ? (backingPerBond / nav) * 100 : null
  const SECONDS_PER_YEAR = 365 * 24 * 60 * 60
  const stakedBonds = snapshotTotal != null
    ? Number(snapshotTotal) / 10 ** bondDecimals
    : stakingTotal != null ? Number(stakingTotal) / 10 ** bondDecimals : null
  const tvlUsdg = stakedBonds != null && nav != null ? stakedBonds * nav : null
  const usdgPerSec = snapshotRateU != null ? Number(snapshotRateU) / 1e18 / 10 ** BOND_DECIMALS.usdg : null
  const apyUsdg = tvlUsdg != null && tvlUsdg > 0 && usdgPerSec != null && usdgPerSec > 0
    ? (usdgPerSec * SECONDS_PER_YEAR) / tvlUsdg
    : null
  const oakenPerSec = snapshotRateA != null ? Number(snapshotRateA) / 1e18 / 10 ** BOND_DECIMALS.reward : null
  const oakenPerBondYear = stakedBonds != null && stakedBonds > 0 && oakenPerSec != null && oakenPerSec > 0
    ? (oakenPerSec * SECONDS_PER_YEAR) / stakedBonds
    : null
  const oracle = await readOracle(bond.oracle, `${bondSymbol}/USDG`)

  const checks = []
  const add = (key, label, status, detail) => checks.push({ key, label, status, detail })
  add(
    'solvent',
    'Vault solvency',
    solvent === null ? 'unknown' : solvent ? 'pass' : 'flag',
    solvent === null ? 'isSolvent() did not answer.' : solvent ? 'isSolvent() returns true.' : 'isSolvent() returns false; the vault cannot cover every bond at the current NAV.',
  )
  add(
    'coverage',
    'Reserve coverage',
    coveragePct == null ? 'unknown' : coveragePct >= 100 ? 'pass' : 'flag',
    coveragePct == null
      ? 'Coverage could not be computed (supply, reserves or NAV is unreadable).'
      : `${coveragePct.toFixed(1)}% of the NAV value of outstanding bonds is covered by USDG reserves.`,
  )
  add(
    'paused',
    'Mint / redeem paused',
    paused === null ? 'unknown' : paused ? 'flag' : 'pass',
    paused === null ? 'paused() did not answer.' : paused ? 'The vault is paused; mint and redeem are disabled.' : 'The vault is not paused.',
  )
  add(
    'oracle',
    'NAV oracle',
    oracle == null ? 'unknown' : oracle.stale ? 'flag' : 'pass',
    oracle == null ? 'The NAV oracle did not answer.' : `${oracle.name} $${oracle.price.toFixed(4)} at ${oracle.updatedAtIso}${oracle.stale ? ' (stale)' : ''}.`,
  )
  add(
    'reserves',
    'USDG reserves',
    reserves == null ? 'unknown' : reserves === 0n && (supply ?? 0n) > 0n ? 'flag' : 'pass',
    reserves == null ? 'reserves() did not answer.' : `${fmtUnits(reserves, BOND_DECIMALS.usdg)} USDG in the vault.`,
  )
  add(
    'fee',
    'Redeem fee',
    'info',
    redeemFeeBps == null ? 'redeemFeeBps() did not answer.' : `${(redeemFeeBps / 100).toFixed(2)}% of the USDG out is charged on redemption.`,
  )
  add(
    'staking',
    'Staking pool',
    'info',
    stakingTotal == null
      ? 'totalStaked() did not answer.'
      : `${fmtUnits(stakingTotal, bondDecimals)} ${bondSymbol} staked; reward duration ${rewardDuration ? (rewardDuration / 86_400).toFixed(0) + ' days' : 'unknown'}${streamRemaining != null ? `; ${fmtUnits(streamRemaining, BOND_DECIMALS.reward)} reward left in the stream` : ''}.`,
  )
  const sourceState = sourceCheck(source)
  add('source', 'Source verification', sourceState.status, sourceState.detail)

  const report = {
    kind: 'bond-health-report',
    version: 1,
    chain: { id: CHAIN_ID, name: CHAIN.name, explorer: CHAIN.explorer },
    blockNumber,
    blockTime: block.blockTime,
    blockTimeIso: block.blockTimeIso,
    bond: {
      symbol: bondSymbol,
      name: bond.name,
      token: bond.token,
      vault: bond.vault,
      oracle: bond.oracle,
      staking: bond.staking,
      supply: supply != null ? supply.toString() : null,
      supplyHuman: supplyHuman != null ? fmtUnits(supply, bondDecimals) : null,
      decimals: bondDecimals,
      reserves: reserves != null ? reserves.toString() : null,
      reservesHuman: reservesHuman != null ? fmtUnits(reserves, BOND_DECIMALS.usdg) : null,
      nav,
      navFormatted: nav != null ? '$' + nav.toFixed(4) : null,
      coveragePct,
      coverageFormatted: coveragePct != null ? coveragePct.toFixed(1) + '%' : null,
      backingPerBond,
      solvent,
      paused,
      redeemFeeBps,
      redeemFeeFormatted: redeemFeeBps != null ? (redeemFeeBps / 100).toFixed(2) + '%' : null,
      mintCap: mintCap != null ? mintCap.toString() : null,
      mintCapHuman: mintCap != null ? fmtUnits(mintCap, bondDecimals) : null,
      oraclePrice: oracle?.price ?? null,
      oracleUpdatedAt: oracle?.updatedAtIso ?? null,
      oracleStale: oracle?.stale ?? null,
      stakingTotal: stakingTotal != null ? stakingTotal.toString() : null,
      stakingTotalHuman: stakingTotal != null ? fmtUnits(stakingTotal, bondDecimals) : null,
      rewardDuration,
      rewardDurationDays: rewardDuration != null ? Number((rewardDuration / 86_400).toFixed(1)) : null,
      streamRemaining: streamRemaining != null ? streamRemaining.toString() : null,
      redeemOneBondUsdg: redeemOneBondUsdg != null ? redeemOneBondUsdg.toString() : null,
      redeemOneBondUsdgHuman: redeemOneBondUsdg != null ? fmtUnits(redeemOneBondUsdg, BOND_DECIMALS.usdg) : null,
      mintOneUsdgBonds: mintOneUsdgBonds != null ? mintOneUsdgBonds.toString() : null,
      mintOneUsdgBondsHuman: mintOneUsdgBonds != null ? fmtUnits(mintOneUsdgBonds, bondDecimals) : null,
      stakingSnapshotTotal: snapshotTotal != null ? snapshotTotal.toString() : null,
      stakingSnapshotTotalHuman: snapshotTotal != null ? fmtUnits(snapshotTotal, bondDecimals) : null,
      stakingRateU: snapshotRateU != null ? snapshotRateU.toString() : null,
      stakingRateA: snapshotRateA != null ? snapshotRateA.toString() : null,
      stakingQueuedU: snapshotQueuedU != null ? snapshotQueuedU.toString() : null,
      stakingQueuedA: snapshotQueuedA != null ? snapshotQueuedA.toString() : null,
      stakingFinishU: snapshotFinishU != null ? Number(snapshotFinishU) : null,
      stakingFinishIso: snapshotFinishU != null && snapshotFinishU > 0n ? isoNow(Number(snapshotFinishU)) : null,
      apyUsdg,
      apyUsdgFormatted: apyUsdg != null ? (apyUsdg * 100).toFixed(2) + '%' : null,
      oakenPerBondYear,
      oakenPerBondYearFormatted: oakenPerBondYear != null ? oakenPerBondYear.toFixed(4) : null,
    },
    source,
    checks,
    summary: null,
    sources: [
      { label: 'Chain', value: 'Robinhood Chain (4663)' },
      { label: 'Block', value: String(blockNumber) },
    { label: 'Block time', value: block.blockTimeIso || 'unavailable' },
      { label: 'Bond token', value: bond.token },
      { label: 'Vault', value: bond.vault },
      { label: 'NAV oracle', value: bond.oracle },
      { label: 'Staking', value: bond.staking },
      { label: 'Sourcify', value: sourceSummary(source), href: source.url },
    ],
    disclaimer: DISCLAIMER,
  }
  const flags = checks.filter((check) => check.status === 'flag')
  const parts = []
  parts.push(`Bond health read at block ${blockNumber.toLocaleString('en-US')} on Robinhood Chain (4663). ${bond.name} (${bondSymbol}).`)
  parts.push(`Supply: ${report.bond.supplyHuman || 'unreadable'} bonds; USDG reserves: ${report.bond.reservesHuman || 'unreadable'}; NAV ${report.bond.navFormatted || 'unreadable'}; coverage ${report.bond.coverageFormatted || 'unreadable'}; isSolvent: ${solvent === null ? 'unreadable' : solvent ? 'true' : 'false'}.`)
  parts.push(`Redeem fee: ${report.bond.redeemFeeFormatted || 'unreadable'}; paused: ${paused === null ? 'unreadable' : paused ? 'yes' : 'no'}; mintCap() returns ${report.bond.mintCapHuman || report.bond.mintCap || 'unreadable'}.`)
  if (report.bond.redeemOneBondUsdgHuman != null) {
    const mintHuman = report.bond.mintOneUsdgBondsHuman
    parts.push(`1 bond currently redeems for ${report.bond.redeemOneBondUsdgHuman} USDG after the fee${mintHuman ? `; 1 USDG mints ${mintHuman} bond${mintHuman === '1' ? '' : 's'}` : ''}.`)
  }
  if (oracle) parts.push(`NAV oracle ${oracle.name} $${oracle.price.toFixed(4)} at ${oracle.updatedAtIso}${oracle.stale ? ' (stale)' : ''}.`)
  parts.push(`Staking: ${report.bond.stakingTotalHuman || 'unreadable'} ${bondSymbol} staked; reward duration ${report.bond.rewardDurationDays != null ? report.bond.rewardDurationDays + ' days' : 'unreadable'}`
    + `${report.bond.apyUsdgFormatted ? `; instant USDG APR ${report.bond.apyUsdgFormatted}` : ''}`
    + `${report.bond.oakenPerBondYearFormatted ? `; ${report.bond.oakenPerBondYearFormatted} OAKEN per bond / yr` : ''}.`)
  parts.push(flags.length
    ? `${flags.length} check${flags.length === 1 ? '' : 's'} need attention: ${flags.map((check) => check.label.toLowerCase()).join(', ')}.`
    : 'No flag was raised by the checks in this version.')
  parts.push('Bonds are not locks: they have an admin, a NAV keeper and an oracle. Reading them as an ownerless lock would be a user-interface mistake.')
  parts.push(DISCLAIMER)
  report.summary = parts.join(' ')
  return report
}

export { CHAIN, PONS_FACTORY, DISCLAIMER, contractChecks }
