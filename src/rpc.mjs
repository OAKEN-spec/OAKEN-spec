/**
 * JSON-RPC access, with no Ethereum library.
 *
 * The indexer needs three things off a chain: block numbers, logs, and a
 * handful of `eth_call`s that return a single `uint256` or `bool`. None of that
 * justifies shipping an ABI encoder into a Worker, so the calldata is built by
 * hand from selectors and 32-byte words, and the results are read as words.
 *
 * That only works because of a decision made on the contract side: `LockCreated`
 * carries the entire lock, so a lock's every field comes from an event and the
 * chain is only asked for the one number that changes with time (`claimable`).
 * Decoding `getLock`'s thirteen-field struct here would have meant a real ABI
 * implementation; reading one word does not.
 *
 * Batching is JSON-RPC batching, not Multicall3. Both are one HTTP request, but
 * batching needs no calldata encoding at all, and the requests stay legible in
 * a log.
 */

import { CHAINS } from './chains.mjs'

/**
 * Selectors for the view functions the indexer and the lock page call.
 *
 * Computed with ethers from the compiled ABI and pinned by a test that
 * recomputes them, for the same reason the event topics are: a selector that is
 * quietly wrong returns an empty response that looks like a legitimate zero.
 */
export const SELECTORS = {
  /** `claimable(uint256)` — how much can be withdrawn right now. */
  claimable: '0xd1d58b25',
  /** `vestedAt(uint256,uint64)` — cumulative vested at a timestamp. */
  vestedAt: '0x9b612e1a',
  /** `isReleasable(uint256)` — for position locks. */
  isReleasable: '0x2dc93ebf',
  /** `nextLockId()` — how many locks the contract has issued. */
  nextLockId: '0x6518a0b3',
  /** `getTotalLockCount()` — the adapter's own counter（/api/stats 用，selector 现算过） */
  totalLockCount: '0xfd981c66',
  /** `name()`, `symbol()`, `decimals()` — ERC-20 metadata, for the create form. */
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  /** `balanceOf(address)` and `allowance(address,address)`, ditto. */
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
}

/** A `uint256` as a full 32-byte word, which is how `eth_call` data is laid out. */
export function word(value) {
  return BigInt(value).toString(16).padStart(64, '0')
}

export function calldata(selector, ...args) {
  return selector + args.map(word).join('')
}

/** Read a word out of an `eth_call` result. `0x` means empty, which is zero. */
export function readUint(hex, index = 0) {
  const body = (hex || '').replace(/^0x/, '')
  const w = body.slice(index * 64, (index + 1) * 64)
  return w.length === 0 ? 0n : BigInt('0x' + w)
}

export function readBool(hex, index = 0) {
  return readUint(hex, index) !== 0n
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Decode an `eth_call` result that should be a string, tolerating both shapes
 * ERC-20s actually use.
 *
 * `name()` and `symbol()` are specified to return `string` and a large number of
 * deployed tokens return `bytes32` instead. The bytes32 case has to be padded
 * off a whole byte at a time: stripping `0+` from the hex eats half a byte
 * whenever the last character's low nibble is zero, so every symbol ending in
 * `p`, `` ` `` or `@` would lose its last letter and nothing would report an
 * error.
 */
export function decodeString(hex) {
  const body = (hex || '').replace(/^0x/, '')
  if (body.length === 0) return null

  // A `string` return leads with an offset word pointing past the head.
  if (body.length >= 128) {
    const offset = Number(BigInt('0x' + body.slice(0, 64))) * 2
    if (offset >= 64 && body.length >= offset + 64) {
      const length = Number(BigInt('0x' + body.slice(offset, offset + 64)))
      const start = offset + 64
      const bytes = body.slice(start, start + length * 2)
      if (bytes.length === length * 2 && isPrintableHex(bytes)) return hexToText(bytes)
    }
  }

  // Otherwise treat the whole word as a null-padded bytes32.
  const trimmed = body.slice(0, 64).replace(/(?:00)+$/, '')
  if (trimmed.length === 0) return ''
  return hexToText(trimmed)
}

function isPrintableHex(hex) {
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16)
    if (code === 0) return false
    if (code < 0x09 || (code > 0x0d && code < 0x20)) return false
  }
  return true
}

function hexToText(hex) {
  const bytes = []
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16)
    if (code === 0) break
    bytes.push(code)
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/**
 * One JSON-RPC call, trying each of the chain's endpoints in turn.
 *
 * Three attempts per endpoint with backoff. Public endpoints rate-limit without
 * warning and a chain that silently stops indexing is worse than one that fails
 * loudly, so the last error is rethrown rather than swallowed into an empty
 * result — an empty result here would look like "no locks", which is exactly
 * the wrong conclusion to draw quietly.
 */
export async function rpc(chainId, method, params, options = {}) {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`unknown chain ${chainId}`)
  const attempts = options.attempts ?? 3
  const timeout = options.timeout ?? 20_000

  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const url of chain.rpc) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(timeout),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        if (body.error) throw new Error(body.error.message)
        return body.result
      } catch (error) {
        lastError = error
      }
    }
    if (attempt < attempts - 1) await sleep(250 * 2 ** attempt)
  }
  throw new Error(`${chain.name} ${method} failed: ${lastError?.message}`)
}

/**
 * Many `eth_call`s in one request.
 *
 * Results come back positionally, and a JSON-RPC batch is allowed to answer out
 * of order, so they are re-sorted by id before being returned. A failed call
 * yields null in its slot rather than failing the batch: one unknown lock id in
 * a page of fifty should cost that one row, not the page — and a token that
 * does not implement `owner()` reverts exactly like an unknown lock does.
 *
 * `rpcBatch` exists because the endpoints differ: some public RPCs reject
 * batched `eth_call` with 429 while accepting single calls, and the official
 * endpoint rejects both from Cloudflare's egress. Ordering the batch-capable
 * endpoints first keeps the report service from spending its retries on
 * endpoints that will never answer a batch.
 */
export async function callMany(chainId, calls, options = {}) {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`unknown chain ${chainId}`)
  if (calls.length === 0) return []

  const payload = calls.map((c, i) => ({
    jsonrpc: '2.0',
    id: i,
    method: 'eth_call',
    params: [{ to: c.to, data: c.data }, c.block ?? 'latest'],
  }))

  const endpoints = chain.rpcBatch || chain.rpc
  const attempts = options.attempts ?? 3
  const timeout = options.timeout ?? 30_000

  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeout),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        if (!Array.isArray(body)) throw new Error('batch response was not a list')

        const out = new Array(calls.length).fill(null)
        for (const entry of body) {
          if (typeof entry.id !== 'number') continue
          out[entry.id] = entry.error ? null : entry.result
        }
        return out
      } catch (error) {
        lastError = error
      }
    }
    if (attempt < attempts - 1) await sleep(250 * 2 ** attempt)
  }
  throw new Error(`${chain.name} batch failed: ${lastError?.message}`)
}

export function getBlockNumber(chainId) {
  return rpc(chainId, 'eth_blockNumber', []).then((h) => Number(BigInt(h)))
}

export function getCode(chainId, address) {
  return rpc(chainId, 'eth_getCode', [address, 'latest'])
}

/**
 * Logs for one address over one block range.
 *
 * The range is the caller's problem, and it must come from the chain's
 * `logRange` — Robinhood Chain refuses anything over 500 blocks with an error
 * that reads like a transient failure and is not.
 */
export function getLogs(chainId, address, topics, fromBlock, toBlock) {
  return rpc(chainId, 'eth_getLogs', [
    {
      address,
      topics: [topics],
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16),
    },
  ])
}
