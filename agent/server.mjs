/**
 * OAKEN Agent Reports — local HTTP service.
 *
 *   node agent/server.mjs           # listens on 127.0.0.1:8870
 *
 * Four report kinds share one index:
 *   token      — a token, its OAKEN locks (v1–v4), and its Pons state
 *   prelaunch  — a user-provided lock plan against the token's on-chain facts
 *   curve      — an OAKEN Curve v5 launch, its token and its progress
 *   bond       — the OAKEN bond vault, NAV oracle and staking pool
 *
 * The beta is free. The x402/USDG path is implemented (see x402.mjs) and is
 * enabled only when AGENT_FREE_BETA=0 and AGENT_PAY_TO + a facilitator key are
 * configured. Reports are stored in SQLite so a report has a stable URL.
 */

import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { buildReport, buildPrelaunchReport, buildCurveReport, buildBondReport, CHAIN_ID, DISCLAIMER } from './report.mjs'
import { generateNarrative } from './narrative.mjs'
import { ASSET, MAX_BODY, QUESTS, identityOf, normalizeKind, priceFor, summaryOf } from './core.mjs'
import {
  buildRequirements,
  buildPaymentRequired,
  verifyPayment,
  settlePayment,
  encodePaymentResponse,
  reasonText,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  NETWORK,
  NETWORK_CAIP2,
  USDG,
} from './x402.mjs'
import { rpc } from '../src/rpc.mjs'
import { BONDS as OAKEN_BONDS } from '../frontend/app/bonds/lib/contracts.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.AGENT_PORT || 8870)
const HOST = process.env.AGENT_HOST || '127.0.0.1'
const DB_PATH = process.env.AGENT_DB || path.join(here, 'data', 'reports.db')
const FREE_BETA = process.env.AGENT_FREE_BETA !== '0'
const PAY_TO = process.env.AGENT_PAY_TO || ''
const PAID_MODE = !FREE_BETA
const PAYMENT_READY = PAID_MODE && /^0x[0-9a-fA-F]{40}$/.test(PAY_TO)
const NARRATIVE_URL = process.env.AGENT_LLM_URL || ''
const NARRATIVE_KEY = process.env.AGENT_LLM_KEY || ''
const NARRATIVE_MODEL = process.env.AGENT_LLM_MODEL || 'llama-3.1-8b-instruct'
const NARRATIVE_ON = process.env.AGENT_NARRATIVE !== '0' && Boolean(NARRATIVE_URL)

function resourceUrl(req, pathname) {
  const proto = req.headers['x-forwarded-proto'] || 'http'
  return `${proto}://${req.headers.host || 'localhost'}${pathname}`
}

mkdirSync(path.dirname(DB_PATH), { recursive: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL;')
db.exec('PRAGMA busy_timeout = 5000;')
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id          TEXT PRIMARY KEY,
    chain_id    INTEGER NOT NULL,
    token       TEXT NOT NULL,
    symbol      TEXT,
    name        TEXT,
    created_at  INTEGER NOT NULL,
    block_number INTEGER,
    report      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reports_by_created ON reports (created_at DESC);
  CREATE INDEX IF NOT EXISTS reports_by_token_time ON reports (chain_id, token, created_at DESC);
`)
const insert = db.prepare(`
  INSERT INTO reports (id, chain_id, token, symbol, name, created_at, block_number, report)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
const selectOne = db.prepare('SELECT report FROM reports WHERE id = ?')
const selectRecent = db.prepare(`
  SELECT id, token, symbol, name, created_at, block_number, report
  FROM reports ORDER BY created_at DESC LIMIT ?
`)
const selectFresh = db.prepare(`
  SELECT report FROM reports
  WHERE chain_id = ? AND token = ? AND created_at >= ?
  ORDER BY created_at DESC LIMIT 1
`)

const buckets = new Map()
function rateLimited(ip) {
  const now = Date.now()
  const bucket = buckets.get(ip) || { start: now, count: 0 }
  if (now - bucket.start > 60_000) {
    bucket.start = now
    bucket.count = 0
  }
  bucket.count++
  buckets.set(ip, bucket)
  if (buckets.size > 2000) {
    for (const [key, entry] of buckets) {
      if (now - entry.start > 60_000) buckets.delete(key)
    }
  }
  return bucket.count > 12
}

function cors(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-payment',
    'access-control-expose-headers': 'x-payment-response',
    'cache-control': 'no-store',
    ...extra,
  }
}

function send(res, status, body, extra = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, cors({ 'content-type': 'application/json; charset=utf-8', ...extra }))
  res.end(payload)
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY) throw new Error('request body too large')
  }
  if (!body) return {}
  try { return JSON.parse(body) } catch { throw new Error('request body is not valid JSON') }
}

async function makeReport(body) {
  const kind = normalizeKind(body.kind)
  let report
  if (kind === 'token') {
    report = await buildReport(body.token)
  } else if (kind === 'prelaunch') {
    report = await buildPrelaunchReport(body)
  } else if (kind === 'curve') {
    report = await buildCurveReport(body.address || body.curve || body.token)
  } else {
    report = await buildBondReport(body.symbol || 'OAKEN')
  }

  const id = randomUUID()
  const createdAt = new Date()
  report.id = id
  report.createdAt = createdAt.toISOString()
  report.beta = {
    free: FREE_BETA,
    price: priceFor(kind),
    asset: ASSET,
    network: NETWORK,
    networkCaip2: NETWORK_CAIP2,
    note: FREE_BETA
      ? 'Free on the OAKEN web beta. Direct API reports are paid in USDG over x402.'
      : 'Paid report; settlement is verified against the x402 challenge.',
  }

  /* Optional, additive, guarded: see agent/narrative.mjs. `null` means the
     model was unavailable or the answer contained a number that is not in the
     fact sheet; the report is served unchanged. */
  if (body.narrative !== false && NARRATIVE_ON) {
    const narrative = await generateNarrative(report, {
      model: NARRATIVE_MODEL,
      runModel: runNodeModel,
    })
    if (narrative) report.narrative = narrative
  }
  return report
}

async function runNodeModel(prompt) {
  const res = await fetch(NARRATIVE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(NARRATIVE_KEY ? { authorization: `Bearer ${NARRATIVE_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: NARRATIVE_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You write neutral, factual prose for an on-chain reading aid. Never add a number that is not in the facts. Never give advice, a prediction, or a security score.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 320,
      temperature: 0.15,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`narrative model HTTP ${res.status}`)
  const body = await res.json()
  return body?.choices?.[0]?.message?.content || body?.response || ''
}

function storeReport(report) {
  const who = identityOf(report)
  insert.run(
    report.id,
    CHAIN_ID,
    who.token,
    who.symbol || null,
    who.name || null,
    Math.floor(new Date(report.createdAt).getTime() / 1000),
    report.blockNumber,
    JSON.stringify(report),
  )
  // Keep the local index bounded; the report URLs are stable, but the beta
  // does not need an unbounded SQLite file.
  db.exec('DELETE FROM reports WHERE id NOT IN (SELECT id FROM reports ORDER BY created_at DESC LIMIT 500)')
}

let activeBuilds = 0
const buildQueue = []
async function withBuildSlot(fn) {
  if (activeBuilds >= 2) await new Promise((resolve) => buildQueue.push(resolve))
  activeBuilds += 1
  try {
    return await fn()
  } finally {
    activeBuilds -= 1
    const next = buildQueue.shift()
    if (next) next()
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname
  const started = Date.now()
  res.on('finish', () => {
    if (pathname.startsWith('/api/')) console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`)
  })

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors())
    return res.end()
  }

  if (pathname === '/api/agents/healthz' && req.method === 'GET') {
    let blockNumber = null
    let rpcOk = false
    try {
      blockNumber = Number(BigInt(await rpc(CHAIN_ID, 'eth_blockNumber', [], { timeout: 10_000, attempts: 2 })))
      rpcOk = true
    } catch { rpcOk = false }
    return send(res, rpcOk ? 200 : 503, {
      ok: rpcOk,
      service: 'oaken-agent',
      chainId: CHAIN_ID,
      blockNumber,
      freeBeta: FREE_BETA,
      paidMode: PAID_MODE,
      paymentReady: PAYMENT_READY,
      asset: ASSET,
      network: NETWORK,
      networkCaip2: NETWORK_CAIP2,
    })
  }

  if (pathname === '/api/agents/quests' && req.method === 'GET') {
    return send(res, 200, {
      quests: QUESTS.map((quest) => ({
        ...quest,
        asset: ASSET,
        network: NETWORK,
        networkCaip2: NETWORK_CAIP2,
        freeBeta: FREE_BETA,
        paymentRequired: PAID_MODE,
      })),
      disclaimer: DISCLAIMER,
    })
  }

  if (pathname === '/api/agents/quote' && req.method === 'GET') {
    let kind
    try { kind = normalizeKind(url.searchParams.get('kind') || 'token') } catch (error) {
      return send(res, 400, { error: String(error.message || error) })
    }
    const quest = QUESTS.find((entry) => entry.kind === kind)
    if (!PAID_MODE) {
      return send(res, 200, {
        freeBeta: true,
        quest,
        asset: ASSET,
        network: NETWORK,
        networkCaip2: NETWORK_CAIP2,
        note: 'The paid x402 mode is implemented but disabled in this beta.',
      })
    }
    if (!PAYMENT_READY) {
      return send(res, 503, {
        error: 'payment not configured',
        detail: 'Set AGENT_PAY_TO and AGENT_FACILITATOR_KEY, or keep AGENT_FREE_BETA=1.',
      })
    }
    const requirements = buildRequirements({
      price: quest.price,
      payTo: PAY_TO,
      resource: resourceUrl(req, '/api/agents/report'),
      description: quest.description,
    })
    return send(res, 402, buildPaymentRequired(requirements))
  }

  if (pathname === '/api/agents/report' && req.method === 'POST') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'
    if (rateLimited(ip)) return send(res, 429, { error: 'Too many reports from this address. Try again in a minute.' })
    try {
      const body = await readJson(req)
      if (body.chainId != null && Number(body.chainId) !== CHAIN_ID) {
        return send(res, 400, { error: 'This beta only reads Robinhood Chain (4663).' })
      }
      const kind = normalizeKind(body.kind)

      /* A report generated in the last minute is reused instead of re-reading
         the same contracts. Prelaunch is excluded because its plan is an input.
         A cached report is a stored report: it needs no new payment. */
      if (body.fresh !== true && kind !== 'prelaunch' && kind !== 'curve') {
        const bondAllowed = kind !== 'bond' || String(body.symbol || 'OAKEN').toLowerCase() === 'oaken'
        const cacheToken = kind === 'bond'
          ? (bondAllowed ? OAKEN_BONDS[0].token : null)
          : String(body.token || '').toLowerCase()
        if (cacheToken) {
          const cutoff = Math.floor(Date.now() / 1000) - 60
          const row = selectFresh.get(CHAIN_ID, cacheToken, cutoff)
          if (row) {
            try {
              const cached = JSON.parse(row.report)
              cached.reused = true
              return send(res, 200, { ok: true, report: cached, reused: true }, { 'x-oaken-reused': '1' })
            } catch { /* fall through and regenerate */ }
          }
        }
      }

      if (PAID_MODE) {
        if (!PAYMENT_READY) {
          return send(res, 503, {
            error: 'payment not configured',
            detail: 'Set AGENT_PAY_TO and AGENT_FACILITATOR_KEY, or keep AGENT_FREE_BETA=1.',
          })
        }
        const quest = QUESTS.find((entry) => entry.kind === kind)
        const requirements = buildRequirements({
          price: quest.price,
          payTo: PAY_TO,
          resource: resourceUrl(req, '/api/agents/report'),
          description: quest.description,
        })
        const header = req.headers[PAYMENT_HEADER.toLowerCase()]
        if (!header) {
          return send(res, 402, buildPaymentRequired(requirements, 'X-PAYMENT header is required'))
        }
        const verification = await verifyPayment(header, requirements)
        if (!verification.isValid) {
          return send(res, 402, buildPaymentRequired(requirements, reasonText(verification.invalidReason)))
        }
        const report = await withBuildSlot(() => makeReport(body))
        const settlement = await settlePayment(verification.payload)
        if (!settlement.success) {
          return send(res, 502, {
            error: reasonText(settlement.errorReason),
            detail: settlement.detail || null,
            payer: settlement.payer || verification.payer,
          })
        }
        report.payment = {
          required: true,
          status: 'paid',
          network: settlement.network,
          transaction: settlement.transaction,
          payer: settlement.payer,
          asset: USDG,
        }
        storeReport(report)
        return send(res, 200, { ok: true, report }, {
          [PAYMENT_RESPONSE_HEADER]: encodePaymentResponse(settlement),
        })
      }

      const report = await withBuildSlot(() => makeReport(body))
      storeReport(report)
      return send(res, 200, { ok: true, report })
    } catch (error) {
      const message = String(error?.message || error)
      const status = /failed:|timeout|HTTP 5|fetch/i.test(message) ? 502 : 400
      console.error(`agent report failed (${status}): ${message}`)
      return send(res, status, { error: message })
    }
  }

  if (pathname === '/api/agents/reports' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || 20)))
    const rows = selectRecent.all(limit)
    return send(res, 200, { reports: rows.map(summaryOf) })
  }

  const match = /^\/api\/agents\/report\/([0-9a-f-]{36})$/.exec(pathname)
  if (match && req.method === 'GET') {
    const row = selectOne.get(match[1])
    if (!row) return send(res, 404, { error: 'Report not found.' })
    try {
      return send(res, 200, { report: JSON.parse(row.report) })
    } catch {
      return send(res, 500, { error: 'Stored report is not valid JSON.' })
    }
  }

  return send(res, 404, { error: 'Not found.' })
})

server.listen(PORT, HOST, () => {
  console.log(`oaken-agent listening on http://${HOST}:${PORT}`)
  console.log(`  chain    ${CHAIN_ID} (Robinhood Chain)`)
  console.log(`  database ${DB_PATH}`)
  console.log(`  reports  ${QUESTS.map((quest) => `${quest.kind} (${quest.price} USDG)`).join(', ')}`)
  console.log(`  payment  ${FREE_BETA ? 'free beta' : PAYMENT_READY ? `paid · payTo ${PAY_TO}` : 'paid mode but AGENT_PAY_TO is missing'}`)
  console.log(`  narrative ${NARRATIVE_ON ? `on · ${NARRATIVE_MODEL}` : 'off (set AGENT_LLM_URL to enable)'}`)
})
