/**
 * Pieces both report servers share: the catalogue, the kind/price mapping, and
 * the summary shape that the index and the page read.
 *
 * The Node service (`agent/server.mjs`) and the deployed Worker
 * (`agent/worker.mjs`) must answer the same shapes — the page does not know
 * which one produced a report.
 */

export const ASSET = 'USDG'

export const QUESTS = [
  {
    id: 'token-lock-report',
    kind: 'token',
    name: 'Token + lock report',
    description: 'Read a Robinhood Chain token, its OAKEN locks (v1–v4), and its Pons launch state. Every number is pinned to a block.',
    price: '0.02',
  },
  {
    id: 'prelaunch-review',
    kind: 'prelaunch',
    name: 'Pre-launch review',
    description: 'Compare a planned lock against the token’s on-chain facts. The plan is user-provided; the token facts are read from the chain.',
    price: '0.05',
  },
  {
    id: 'curve-report',
    kind: 'curve',
    name: 'Curve launch report',
    description: 'Read an OAKEN Curve v5 launch: supply, sellable allocation, progress to graduation, fees, reserves and the token behind it — all at one block.',
    price: '0.02',
  },
  {
    id: 'bond-health-report',
    kind: 'bond',
    name: 'Bond health report',
    description: 'Read the OAKEN bond vault, its NAV oracle, redemption parameters and staking pool at one block.',
    price: '0.02',
  },
]

export const KIND_LABEL = {
  'token-lock-report': 'Token + locks',
  'prelaunch-review': 'Pre-launch review',
  'curve-report': 'Curve launch',
  'bond-health-report': 'Bond health',
}

export function normalizeKind(value) {
  const requested = String(value || 'token').toLowerCase()
  if (requested === 'token' || requested === 'token-lock-report') return 'token'
  if (requested === 'prelaunch' || requested === 'prelaunch-review') return 'prelaunch'
  if (requested === 'curve' || requested === 'curve-report') return 'curve'
  if (requested === 'bond' || requested === 'bond-health-report') return 'bond'
  throw new Error(`Unknown report kind "${requested}". Use token, prelaunch, curve or bond.`)
}

export function priceFor(kind) {
  return QUESTS.find((quest) => quest.kind === kind)?.price || '0.02'
}

export function identityOf(report) {
  if (report.kind === 'bond-health-report') {
    return { token: report.bond.token, symbol: report.bond.symbol, name: report.bond.name }
  }
  if (report.kind === 'curve-report') {
    return { token: report.curve.token, symbol: report.token.symbol, name: report.token.name }
  }
  return { token: report.token.address, symbol: report.token.symbol, name: report.token.name }
}

export function summaryOf(row) {
  let report = null
  try { report = JSON.parse(row.report) } catch { report = null }
  const checks = report?.checks || []
  const kind = report?.kind || 'token-lock-report'
  const curveStatus = report?.kind === 'curve-report' ? (report.curve?.statusLabel || null) : null
  return {
    id: row.id,
    kind,
    kindLabel: KIND_LABEL[kind] || kind,
    title: report?.kind === 'bond-health-report'
      ? (report.bond?.name || report.bond?.symbol || row.name || row.symbol)
      : (report?.token?.name || report?.token?.symbol || row.name || row.symbol),
    token: row.token,
    symbol: row.symbol,
    name: row.name,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    blockNumber: row.block_number,
    blockTimeIso: report?.blockTimeIso || null,
    flags: checks.filter((check) => check.status === 'flag').length,
    passes: checks.filter((check) => check.status === 'pass').length,
    locks: report?.locks?.total ?? null,
    ponsPhase: report?.pons?.phaseLabel ?? null,
    curveStatus,
    payment: report?.payment || null,
    url: `/agents?report=${row.id}`,
  }
}

/** Requests are capped so a malformed body cannot turn into an allocation. */
export const MAX_BODY = 16_384
