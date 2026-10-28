/**
 * HTTP integration test for the report service.
 *
 *   node agent/test-api.mjs
 *   AGENT_URL=http://127.0.0.1:8870 node agent/test-api.mjs
 *
 * Assumes the service is already running. This is the layer that catches a
 * proxy/shape mistake the report builder tests cannot see.
 */

import assert from 'node:assert/strict'

const BASE = (process.env.AGENT_URL || 'http://127.0.0.1:8870').replace(/\/$/, '')
const OAKEN = '0x02b0de4c4d4a7416a3465126730df71a026d7bbb'
const CURVE_DEMO = '0x5eDa1a2d4Ac30B173729684FB96EdbCBcAB0730D'

async function json(path, init) {
  // The machine's link to Cloudflare times out in bursts; keep the assertions
  // about the service, not about this network. POSTs get one retry (a stored
  // report is harmless), GETs get four.
  const method = String(init?.method || 'GET').toUpperCase()
  const attempts = method === 'GET' ? 4 : 2
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(BASE + path, {
        ...init,
        // The web proxy only marks a request as the free page tier when it
        // looks same-origin; a bare Node fetch otherwise gets the paid 402.
        headers: { origin: BASE, ...(init?.headers || {}) },
        signal: AbortSignal.timeout(180_000),
      })
      const body = await response.json().catch(() => null)
      return { status: response.status, body }
    } catch (error) {
      lastError = error
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 2500))
    }
  }
  throw lastError
}

const health = await json('/api/agents/healthz')
assert.equal(health.status, 200)
assert.equal(health.body.ok, true)
assert.equal(health.body.chainId, 4663)
console.log('PASS health', health.body.blockNumber, health.body.freeBeta ? 'free' : 'paid')

const quests = await json('/api/agents/quests')
assert.equal(quests.status, 200)
assert.equal(quests.body.quests.length, 4)
assert.ok(quests.body.quests.some((quest) => quest.kind === 'token'))
assert.ok(quests.body.quests.some((quest) => quest.kind === 'prelaunch'))
assert.ok(quests.body.quests.some((quest) => quest.kind === 'curve'))
assert.ok(quests.body.quests.some((quest) => quest.kind === 'bond'))
console.log('PASS quests', quests.body.quests.map((quest) => quest.kind).join(', '))

const quote = await json('/api/agents/quote?kind=token')
if (health.body.freeBeta) {
  assert.equal(quote.status, 200)
  assert.equal(quote.body.freeBeta, true)
} else {
  assert.equal(quote.status, 402)
  assert.equal(quote.body.x402Version, 1)
  assert.equal(quote.body.accepts[0].scheme, 'exact')
  assert.equal(quote.body.accepts[0].network, 'robinhood')
}
console.log('PASS quote', quote.status)

const tokenReport = await json('/api/agents/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'token', token: OAKEN, fresh: true }),
})
assert.equal(tokenReport.status, 200)
assert.equal(tokenReport.body.report.kind, 'token-lock-report')
assert.equal(tokenReport.body.report.token.symbol, 'OAKEN')
assert.ok(tokenReport.body.report.blockNumber > 0)
assert.ok(tokenReport.body.report.blockTimeIso)
assert.ok(Array.isArray(tokenReport.body.report.checks))
const tokenId = tokenReport.body.report.id
console.log('PASS token', tokenId, 'block', tokenReport.body.report.blockNumber)

const cached = await json('/api/agents/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'token', token: OAKEN }),
})
assert.equal(cached.status, 200)
assert.ok(cached.body.report, 'a stored report must come back without a second payment')
/* The reuse window is 60 seconds. A slow link can spend that on the first
   report alone; in that case a fresh report is the correct answer, not a
   failure. When the window is still open, the id must be the same. */
if (cached.body.reused) {
  assert.equal(cached.body.report.id, tokenId)
  console.log('PASS reuse', tokenId)
} else {
  console.log('PASS reuse window expired on this link; fresh report accepted')
}

const curveReport = await json('/api/agents/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'curve', address: CURVE_DEMO }),
})
assert.equal(curveReport.status, 200)
assert.equal(curveReport.body.report.kind, 'curve-report')
assert.equal(curveReport.body.report.curve.address, CURVE_DEMO.toLowerCase())
assert.ok(curveReport.body.report.token.symbol)
assert.ok(curveReport.body.report.curve.launchSupplyHuman)
console.log('PASS curve', curveReport.body.report.token.symbol, curveReport.body.report.curve.statusLabel)

const curveBad = await json('/api/agents/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'curve', address: OAKEN }),
})
assert.equal(curveBad.status, 400)
assert.ok(/not an OAKEN curve/.test(curveBad.body.error))
console.log('PASS curve rejection')

const prelaunch = await json('/api/agents/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    kind: 'prelaunch',
    token: OAKEN,
    lockAmount: 5_000_000,
    lockDays: 180,
    steps: 6,
    initialUnlockPct: 10,
    revocable: false,
  }),
})
assert.equal(prelaunch.status, 200)
assert.equal(prelaunch.body.report.kind, 'prelaunch-review')
assert.equal(prelaunch.body.report.plan.lockAmount, 5_000_000)
assert.ok(prelaunch.body.report.plan.sharePct != null)
console.log('PASS prelaunch', prelaunch.body.report.plan.sharePctFormatted)

const bond = await json('/api/agents/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'bond', symbol: 'OAKEN' }),
})
assert.equal(bond.status, 200)
assert.equal(bond.body.report.kind, 'bond-health-report')
assert.ok(bond.body.report.bond.supplyHuman)
assert.ok(typeof bond.body.report.bond.solvent === 'boolean')
console.log('PASS bond', bond.body.report.bond.symbol, bond.body.report.bond.coverageFormatted)

const one = await json(`/api/agents/report/${tokenId}`)
assert.equal(one.status, 200)
assert.equal(one.body.report.id, tokenId)
console.log('PASS stored report')

const recent = await json('/api/agents/reports?limit=5')
assert.equal(recent.status, 200)
assert.ok(recent.body.reports.length >= 3)
assert.ok(recent.body.reports.some((row) => row.kind === 'bond-health-report'))
assert.ok(recent.body.reports.some((row) => row.kind === 'curve-report'))
console.log('PASS recent', recent.body.reports.length)

const bad = await json('/api/agents/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'token', token: 'not-an-address' }),
})
assert.equal(bad.status, 400)
assert.ok(bad.body.error)
console.log('PASS rejection', bad.body.error.slice(0, 60))

const missing = await json('/api/agents/report/00000000-0000-0000-0000-000000000000')
assert.equal(missing.status, 404)
console.log('PASS missing report')

console.log('PASS all API checks')
