/**
 * Live smoke test for the report builder.
 *
 *   node agent/test.mjs
 *
 * This reads Robinhood Chain, so it needs a working RPC from this machine.
 * It is deliberately not a mock: the report's value is that its numbers came
 * from the chain, and a fixture would not catch a changed selector or a
 * factory that stopped answering.
 */

import assert from 'node:assert/strict'
import { buildReport, buildPrelaunchReport, buildCurveReport, buildBondReport } from './report.mjs'

const OAKEN = '0x02b0de4c4d4a7416a3465126730df71a026d7bbb'
const CURVE_DEMO = '0x5eDa1a2d4Ac30B173729684FB96EdbCBcAB0730D'

const report = await buildReport(OAKEN)
assert.equal(report.kind, 'token-lock-report')
assert.equal(report.chain.id, 4663)
assert.equal(report.token.address, OAKEN)
assert.equal(report.token.symbol, 'OAKEN')
assert.ok(report.token.codeBytes > 0, 'OAKEN token must have runtime code')
assert.ok(report.locks.total >= 1, 'OAKEN token must have at least one OAKEN lock')
assert.ok(report.locks.totalRemaining && report.locks.totalRemaining !== '0', 'the lock must still hold tokens')
assert.ok(report.pons, 'OAKEN token must have a Pons record')
assert.equal(report.pons.phase, 0, 'the OAKEN curve should still be on phase 0')
assert.ok(Array.isArray(report.checks) && report.checks.length >= 7)
assert.ok(report.summary.includes('Robinhood Chain'))
assert.ok(report.summary.includes('OAKEN'))
console.log('PASS token report', {
  symbol: report.token.symbol,
  block: report.blockNumber,
  locks: report.locks.total,
  remaining: report.locks.totalRemainingHuman,
  pons: report.pons.phaseLabel,
  checks: report.checks.length,
  flags: report.checks.filter((check) => check.status === 'flag').length,
})

const empty = await buildReport('0x0000000000000000000000000000000000000001')
assert.equal(empty.token.codeBytes, 0)
assert.equal(empty.pons, null)
assert.ok(empty.checks.some((check) => check.key === 'contract' && check.status === 'flag'))
console.log('PASS empty address', { block: empty.blockNumber, checks: empty.checks.length })

const curve = await buildCurveReport(CURVE_DEMO)
assert.equal(curve.kind, 'curve-report')
assert.equal(curve.chain.id, 4663)
assert.equal(curve.curve.address, CURVE_DEMO.toLowerCase())
assert.ok(curve.token.symbol, 'the curve must return its token')
assert.ok(curve.curve.launchSupplyHuman, 'launch supply must be readable')
assert.ok(curve.curve.graduationThresholdHuman, 'the graduation line must be readable')
assert.ok(curve.curve.reserves, 'the curve reserves must be readable')
assert.ok(Array.isArray(curve.checks) && curve.checks.length >= 10)
assert.ok(curve.summary.includes('Robinhood Chain'))
assert.ok(curve.summary.includes('Curve'))
console.log('PASS curve report', {
  symbol: curve.token.symbol,
  status: curve.curve.statusLabel,
  sold: curve.curve.soldPctFormatted,
  raised: curve.curve.trackedQuoteHuman,
  line: curve.curve.graduationThresholdHuman,
  checks: curve.checks.length,
  flags: curve.checks.filter((check) => check.status === 'flag').length,
})

await assert.rejects(
  () => buildCurveReport(OAKEN),
  /not an OAKEN curve/,
  'a token address must be refused, not read as a curve',
)
console.log('PASS curve rejection')

const bond = await buildBondReport('OAKEN')
assert.equal(bond.kind, 'bond-health-report')
assert.ok(bond.bond.symbol)
assert.ok(bond.bond.supplyHuman, 'bond supply must be readable')
assert.ok(bond.bond.reservesHuman, 'bond reserves must be readable')
assert.ok(typeof bond.bond.solvent === 'boolean')
assert.ok(Array.isArray(bond.checks) && bond.checks.some((check) => check.key === 'solvency' || check.key === 'solvent'))
console.log('PASS bond report', {
  symbol: bond.bond.symbol,
  supply: bond.bond.supplyHuman,
  reserves: bond.bond.reservesHuman,
  nav: bond.bond.navFormatted,
  coverage: bond.bond.coverageFormatted,
  solvent: bond.bond.solvent,
  flags: bond.checks.filter((check) => check.status === 'flag').length,
})

const plan = await buildPrelaunchReport({
  token: OAKEN,
  lockAmount: 5_000_000,
  lockDays: 180,
  steps: 6,
  initialUnlockPct: 10,
  revocable: false,
})
assert.equal(plan.kind, 'prelaunch-review')
assert.equal(plan.plan.lockAmount, 5_000_000)
assert.ok(plan.plan.sharePct != null, 'the plan share of supply should be computed')
assert.ok(plan.checks.some((check) => check.key === 'lock_days'))
assert.ok(plan.checks.some((check) => check.key === 'revocable'))
console.log('PASS prelaunch report', {
  token: plan.token.symbol,
  share: plan.plan.sharePctFormatted,
  days: plan.plan.lockDays,
  flags: plan.checks.filter((check) => check.status === 'flag').length,
})

console.log('PASS all live report checks')
