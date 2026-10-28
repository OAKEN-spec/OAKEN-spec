/**
 * OAKEN Agent Reports — deployed Worker.
 *
 * The same four report kinds as the local Node service (`agent/server.mjs`),
 * with the report index in a SQLite-backed Durable Object so every report keeps
 * a stable URL. Report generation stays on Cloudflare's edge deliberately: the
 * report service needs Robinhood Chain (4663) RPC, and the dedicated Worker
 * reaches it from Cloudflare egress. (The Pages Worker does not generate
 * reports; it proxies `/api/agents/*` here through AGENT_API_URL.)
 *
 * The beta is free. The x402/USDG path is the same code the Node service uses;
 * it stays off unless AGENT_FREE_BETA=0 and AGENT_PAY_TO + a facilitator key
 * are configured.
 */

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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-payment',
  'access-control-expose-headers': 'x-payment-response',
  'cache-control': 'no-store',
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', ...extra },
  })
}

function reportsStub(env) {
  return env.REPORTS.get(env.REPORTS.idFromName('index'))
}

async function indexOp(env, op, data = {}) {
  const res = await reportsStub(env).fetch('https://reports.internal/op', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, ...data }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body?.error || `report index ${res.status}`)
  return body
}

function clientIp(request) {
  const direct = request.headers.get('cf-connecting-ip')
  if (direct) return direct.trim()
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return 'unknown'
}

async function readJson(request) {
  const body = await request.text()
  if (body.length > MAX_BODY) throw new Error('request body too large')
  if (!body) return {}
  try { return JSON.parse(body) } catch { throw new Error('request body is not valid JSON') }
}

function makeReport(body, freeBeta, env) {
  return (async () => {
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

    const id = crypto.randomUUID()
    const createdAt = new Date()
    report.id = id
    report.createdAt = createdAt.toISOString()
    report.beta = {
      free: freeBeta,
      price: priceFor(kind),
      asset: ASSET,
      network: NETWORK,
      networkCaip2: NETWORK_CAIP2,
      note: freeBeta
        ? 'Free on the OAKEN web beta. Direct API reports are paid in USDG over x402.'
        : 'Paid report; settlement is verified against the x402 challenge.',
    }

    /* The narrative is optional and additive. `generateNarrative` returns null
       when the model is unavailable, gives advice, or writes a number that is
       not in the fact sheet. A null narrative is not an error. */
    if (body.narrative !== false && env.AGENT_NARRATIVE !== '0' && env.AI) {
      const model = env.AGENT_NARRATIVE_MODEL || '@cf/meta/llama-3.1-8b-instruct'
      let raw = ''
      const narrative = await generateNarrative(report, {
        model,
        runModel: async (prompt) => {
          try {
            raw = await runWorkersAi(prompt, env, model)
            return raw
          } catch (error) {
            console.log('narrative model error:', String(error?.message || error).slice(0, 160))
            throw error
          }
        },
      })
      if (narrative) {
        report.narrative = narrative
        console.log('narrative ok:', narrative.text.length, 'chars')
      } else {
        console.log('narrative skipped:', raw ? `${raw.length} chars from the model` : 'model returned nothing')
      }
    }

    return report
  })()
}

async function runWorkersAi(prompt, env, model) {
  const out = await env.AI.run(model, {
    messages: [
      {
        role: 'system',
        content: 'You write neutral, factual prose for an on-chain reading aid. Never add a number that is not in the facts. Never give advice, a prediction, or a security score.',
      },
      { role: 'user', content: prompt },
    ],
    max_tokens: 320,
    temperature: 0.15,
  })
  /* Text-generation models answer `{ response }`; OpenAI-compatible chat
     models answer `{ choices: [{ message: { content } }] }`. Support both and
     say the shape out loud when neither is present — otherwise a model swap
     looks like "the narrative silently stopped". */
  const text = out?.response
    || out?.result?.response
    || out?.choices?.[0]?.message?.content
    || out?.result?.choices?.[0]?.message?.content
    || ''
  if (!text) console.log('narrative model shape:', JSON.stringify(out).slice(0, 300))
  return text
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const pathname = url.pathname
    const started = Date.now()

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    /* The web page is free during the beta; the direct API is paid. The Pages
       proxy adds `x-oaken-site-key` server-side (never exposed to the browser),
       so a request through oaken.one is free and a request to
       agents.oaken.one directly is an x402 challenge. */
    const configuredPaid = env.AGENT_FREE_BETA === '0'
    const siteKey = request.headers.get('x-oaken-site-key')
    const siteFree = Boolean(env.AGENT_SITE_KEY) && siteKey === env.AGENT_SITE_KEY
    const FREE_BETA = !configuredPaid || siteFree
    const PAID_MODE = !FREE_BETA
    const PAY_TO = env.AGENT_PAY_TO || ''
    const PAYMENT_READY = PAID_MODE && /^0x[0-9a-fA-F]{40}$/.test(PAY_TO)

    const respond = (response) => {
      if (pathname.startsWith('/api/')) {
        console.log(`${request.method} ${pathname} ${response.status} ${Date.now() - started}ms`)
      }
      return response
    }

    if (pathname === '/api/agents/healthz' && request.method === 'GET') {
      let blockNumber = null
      let rpcOk = false
      try {
        blockNumber = Number(BigInt(await rpc(CHAIN_ID, 'eth_blockNumber', [], { timeout: 10_000, attempts: 2 })))
        rpcOk = true
      } catch { rpcOk = false }
      return respond(json(rpcOk ? 200 : 503, {
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
      }))
    }

    if (pathname === '/api/agents/quests' && request.method === 'GET') {
      return respond(json(200, {
        quests: QUESTS.map((quest) => ({
          ...quest,
          asset: ASSET,
          network: NETWORK,
          networkCaip2: NETWORK_CAIP2,
          freeBeta: FREE_BETA,
          paymentRequired: PAID_MODE,
        })),
        disclaimer: DISCLAIMER,
      }))
    }

    if (pathname === '/api/agents/quote' && request.method === 'GET') {
      let kind
      try { kind = normalizeKind(url.searchParams.get('kind') || 'token') } catch (error) {
        return respond(json(400, { error: String(error.message || error) }))
      }
      const quest = QUESTS.find((entry) => entry.kind === kind)
      if (!PAID_MODE) {
        return respond(json(200, {
          freeBeta: true,
          quest,
          asset: ASSET,
          network: NETWORK,
          networkCaip2: NETWORK_CAIP2,
          note: 'The paid x402 mode is implemented but disabled in this beta.',
        }))
      }
      if (!PAYMENT_READY) {
        return respond(json(503, {
          error: 'payment not configured',
          detail: 'Set AGENT_PAY_TO and AGENT_FACILITATOR_KEY, or keep AGENT_FREE_BETA=1.',
        }))
      }
      const requirements = buildRequirements({
        price: quest.price,
        payTo: PAY_TO,
        resource: url.origin + '/api/agents/report',
        description: quest.description,
      })
      return respond(json(402, buildPaymentRequired(requirements)))
    }

    if (pathname === '/api/agents/report' && request.method === 'POST') {
      try {
        const rate = await indexOp(env, 'rate', { ip: clientIp(request) })
        if (rate.limited) {
          return respond(json(429, { error: 'Too many reports from this address. Try again in a minute.' }))
        }

        const body = await readJson(request)
        if (body.chainId != null && Number(body.chainId) !== CHAIN_ID) {
          return respond(json(400, { error: 'This beta only reads Robinhood Chain (4663).' }))
        }
        const kind = normalizeKind(body.kind)

        /* A report generated in the last minute is reused instead of re-reading
           the same contracts. Prelaunch is excluded because its plan is an input;
           a curve is excluded because its state changes with every trade.
           A cached report is a stored report: it needs no new payment. */
        if (body.fresh !== true && kind !== 'prelaunch' && kind !== 'curve') {
          const bondAllowed = kind !== 'bond' || String(body.symbol || 'OAKEN').toLowerCase() === 'oaken'
          const cacheToken = kind === 'bond'
            ? (bondAllowed ? OAKEN_BONDS[0].token : null)
            : String(body.token || '').toLowerCase()
          if (cacheToken) {
            const cutoff = Math.floor(Date.now() / 1000) - 60
            const hit = await indexOp(env, 'fresh', { token: cacheToken, cutoff })
            if (hit.report) {
              try {
                const cached = JSON.parse(hit.report)
                cached.reused = true
                return respond(json(200, { ok: true, report: cached, reused: true }, { 'x-oaken-reused': '1' }))
              } catch { /* fall through and regenerate */ }
            }
          }
        }

        if (PAID_MODE) {
          if (!PAYMENT_READY) {
            return respond(json(503, {
              error: 'payment not configured',
              detail: 'Set AGENT_PAY_TO and AGENT_FACILITATOR_KEY, or keep AGENT_FREE_BETA=1.',
            }))
          }
          const quest = QUESTS.find((entry) => entry.kind === kind)
          const requirements = buildRequirements({
            price: quest.price,
            payTo: PAY_TO,
            resource: url.origin + '/api/agents/report',
            description: quest.description,
          })
          const header = request.headers.get(PAYMENT_HEADER)
          if (!header) {
            return respond(json(402, buildPaymentRequired(requirements, 'X-PAYMENT header is required')))
          }
          const verification = await verifyPayment(header, requirements)
          if (!verification.isValid) {
            return respond(json(402, buildPaymentRequired(requirements, reasonText(verification.invalidReason))))
          }
          const report = await makeReport(body, FREE_BETA, env)
          const settlement = await settlePayment(verification.payload, {
            privateKey: env.AGENT_FACILITATOR_KEY,
            rpcUrl: env.AGENT_RHC_RPC,
          })
          if (!settlement.success) {
            return respond(json(502, {
              error: reasonText(settlement.errorReason),
              detail: settlement.detail || null,
              payer: settlement.payer || verification.payer,
            }))
          }
          report.payment = {
            required: true,
            status: 'paid',
            network: settlement.network,
            transaction: settlement.transaction,
            payer: settlement.payer,
            asset: USDG,
          }
          await storeReport(env, report)
          return respond(json(200, { ok: true, report }, {
            [PAYMENT_RESPONSE_HEADER]: encodePaymentResponse(settlement),
          }))
        }

        const report = await makeReport(body, FREE_BETA, env)
        await storeReport(env, report)
        return respond(json(200, { ok: true, report }))
      } catch (error) {
        const message = String(error?.message || error)
        const status = /failed:|timeout|HTTP 5|fetch/i.test(message) ? 502 : 400
        console.error(`agent report failed (${status}): ${message}`)
        return respond(json(status, { error: message }))
      }
    }

    if (pathname === '/api/agents/reports' && request.method === 'GET') {
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || 20)))
      const { rows } = await indexOp(env, 'recent', { limit })
      return respond(json(200, { reports: rows.map(summaryOf) }))
    }

    const match = /^\/api\/agents\/report\/([0-9a-f-]{36})$/.exec(pathname)
    if (match && request.method === 'GET') {
      const { report } = await indexOp(env, 'get', { id: match[1] })
      if (!report) return respond(json(404, { error: 'Report not found.' }))
      try {
        return respond(json(200, { report: JSON.parse(report) }))
      } catch {
        return respond(json(500, { error: 'Stored report is not valid JSON.' }))
      }
    }

    return respond(json(404, { error: 'Not found.' }))
  },
}

async function storeReport(env, report) {
  const who = identityOf(report)
  await indexOp(env, 'store', {
    row: {
      id: report.id,
      chain_id: CHAIN_ID,
      token: who.token,
      symbol: who.symbol || null,
      name: who.name || null,
      created_at: Math.floor(new Date(report.createdAt).getTime() / 1000),
      block_number: report.blockNumber,
      report: JSON.stringify(report),
    },
  })
}

/**
 * The report index.
 *
 * SQLite-backed so a report URL survives restarts and deployments. One
 * instance (`index`) holds the whole beta index; writes are small and the
 * service caps the table at 500 rows.
 */
export class ReportsDO {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    this.sql = ctx.storage.sql
    this.buckets = new Map()
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
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
      `)
      this.sql.exec('CREATE INDEX IF NOT EXISTS reports_by_created ON reports (created_at DESC);')
      this.sql.exec('CREATE INDEX IF NOT EXISTS reports_by_token_time ON reports (chain_id, token, created_at DESC);')
    })
  }

  async fetch(request) {
    let payload
    try { payload = await request.json() } catch { return json(400, { error: 'bad index request' }) }

    switch (payload.op) {
      case 'rate': {
        const now = Date.now()
        const key = String(payload.ip || 'unknown')
        const bucket = this.buckets.get(key) || { start: now, count: 0 }
        if (now - bucket.start > 60_000) {
          bucket.start = now
          bucket.count = 0
        }
        bucket.count++
        this.buckets.set(key, bucket)
        if (this.buckets.size > 2000) {
          for (const [ip, entry] of this.buckets) {
            if (now - entry.start > 60_000) this.buckets.delete(ip)
          }
        }
        return json(200, { limited: bucket.count > 12 })
      }

      case 'fresh': {
        const rows = this.sql.exec(
          'SELECT report FROM reports WHERE chain_id = ? AND token = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1',
          CHAIN_ID, String(payload.token || '').toLowerCase(), Number(payload.cutoff || 0),
        ).toArray()
        return json(200, { report: rows[0]?.report || null })
      }

      case 'get': {
        const rows = this.sql.exec('SELECT report FROM reports WHERE id = ?', String(payload.id || '')).toArray()
        return json(200, { report: rows[0]?.report || null })
      }

      case 'recent': {
        const limit = Math.max(1, Math.min(50, Number(payload.limit || 20)))
        const rows = this.sql.exec(
          'SELECT id, token, symbol, name, created_at, block_number, report FROM reports ORDER BY created_at DESC LIMIT ?',
          limit,
        ).toArray()
        return json(200, { rows })
      }

      case 'store': {
        const row = payload.row || {}
        this.sql.exec(
          'INSERT INTO reports (id, chain_id, token, symbol, name, created_at, block_number, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          row.id, CHAIN_ID, row.token, row.symbol, row.name, row.created_at, row.block_number, row.report,
        )
        this.sql.exec('DELETE FROM reports WHERE id NOT IN (SELECT id FROM reports ORDER BY created_at DESC LIMIT 500)')
        return json(200, { ok: true })
      }

      default:
        return json(400, { error: `unknown index op ${payload.op}` })
    }
  }
}
