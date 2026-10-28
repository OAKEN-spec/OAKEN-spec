/**
 * The optional narrative layer.
 *
 * The report itself is deterministic: every number is a contract read at a
 * stated block. An LLM is allowed to *phrase* those facts, never to add one.
 * The guard below is the whole point:
 *
 *   - the prompt gets a fact sheet, not the raw report;
 *   - the answer is thrown away if it contains any number that is not already
 *     in the fact sheet (comma/percent formatting is normalised, exponents are
 *     kept);
 *   - advice, predictions and security claims are rejected outright;
 *   - the canonical `summary` and `checks` remain the authoritative fields;
 *     `report.narrative` is additive and labelled as such in the UI.
 *
 * A failed narrative is not an error: the report is simply served without it.
 */

export const NARRATIVE_VERSION = 1
export const MAX_NARRATIVE = 900

const BANNED = /\b(guarantee[sd]?|risk[- ]free|scam|rug ?pull|recommend|should buy|should sell|price target|investment advice|guaranteed return)\b/i
/** A sentence that contradicts a flag is as wrong as an invented number. */
const CLAIMS_NO_FLAGS = /\b(no|zero) (flagged |active |open )?checks?\b|\bno flags?\b/i

function push(lines, label, value) {
  if (value == null) return
  const text = String(value).trim()
  if (!text || text === '—' || text === 'undefined' || text === 'null') return
  lines.push(`${label}: ${text}`)
}

/**
 * A compact fact sheet built from the report's already-formatted strings.
 * Using the report's own strings — not recomputing — means a number the model
 * echoes back is the same string the page shows.
 */
export function factsFor(report) {
  const lines = []
  const kind = report?.kind
  push(lines, 'Report kind', kind)
  push(lines, 'Chain', report?.chain ? `${report.chain.name} (${report.chain.id})` : null)
  push(lines, 'Block', report?.blockNumber)
  push(lines, 'Block time', report?.blockTimeIso)

  if (kind === 'bond-health-report') {
    const b = report.bond || {}
    push(lines, 'Bond name', b.name)
    push(lines, 'Bond symbol', b.symbol)
    push(lines, 'Bond supply', b.supplyHuman)
    push(lines, 'USDG reserves', b.reservesHuman)
    push(lines, 'NAV', b.navFormatted)
    push(lines, 'Reserve coverage', b.coverageFormatted)
    push(lines, 'Vault solvent', b.solvent)
    push(lines, 'Mint and redeem paused', b.paused)
    push(lines, 'Redeem fee', b.redeemFeeFormatted)
    push(lines, 'Staked bonds', b.stakingTotalHuman)
    push(lines, 'Instant USDG APR', b.apyUsdgFormatted)
    push(lines, 'OAKEN per bond per year', b.oakenPerBondYearFormatted)
  } else {
    const t = report?.token || {}
    push(lines, 'Token name', t.name)
    push(lines, 'Token symbol', t.symbol)
    push(lines, 'Token address', t.address)
    push(lines, 'Total supply', t.totalSupplyHuman)
    push(lines, 'Decimals', t.decimals)
    push(lines, 'Runtime code bytes', t.codeBytes)
    push(lines, 'Owner', t.owner || 'no non-zero owner() was read')
    push(lines, 'Paused', t.paused)
    push(lines, 'EIP-1967 proxy', t.proxy || 'none')

    if (kind === 'curve-report') {
      const c = report.curve || {}
      push(lines, 'Curve address', c.address)
      push(lines, 'Curve status', c.statusLabel)
      push(lines, 'Launch supply', c.launchSupplyHuman)
      push(lines, 'Reserved for the pool', c.reservedTokensHuman)
      push(lines, 'Sellable allocation', c.sellableTotalHuman)
      push(lines, 'Sold on the curve', `${c.soldHuman} (${c.soldPctFormatted})`)
      push(lines, 'Raised', `${c.trackedQuoteHuman} ETH (${c.raisePctFormatted} of the graduation line)`)
      push(lines, 'Graduation line', `${c.graduationThresholdHuman} ETH`)
      push(lines, 'Remaining to graduate', `${c.remainingToGraduateHuman} ETH`)
      push(lines, 'Protocol fee', c.fees?.feeFormatted)
      push(lines, 'Creator tax', c.fees?.creatorTaxFormatted)
      push(lines, 'Spot price', c.price?.spotFormatted ? `${c.price.spotFormatted} ETH` : null)
      push(lines, 'Spot price USD', c.estimates?.spotPriceUsdFormatted)
      push(lines, 'Implied FDV', c.price?.spotFdvFormatted ? `${c.price.spotFdvFormatted} ETH` : null)
      push(lines, 'Implied FDV USD', c.estimates?.spotFdvUsdFormatted)
      push(lines, 'Price basis', c.estimates?.basis)
    } else if (kind === 'prelaunch-review') {
      const p = report.plan || {}
      push(lines, 'Planned lock amount', p.lockAmountFormatted)
      push(lines, 'Planned share of supply', p.sharePctFormatted)
      push(lines, 'Planned lock days', p.lockDays)
      push(lines, 'Planned vesting steps', p.steps)
      push(lines, 'Planned initial unlock percent', p.initialUnlockPct)
      push(lines, 'Plan revocable', p.revocable)
    } else {
      const p = report.pons
      if (p) {
        push(lines, 'Pons phase', p.phaseLabel)
        push(lines, 'Pons pair', p.pairLabel)
        push(lines, 'Pons creator tax bps', p.creatorTaxBps)
        push(lines, 'Pons curve quote reserve', p.reserves?.quoteHumanFormatted)
        push(lines, 'Pons curve token reserve', p.reserves?.tokenHumanFormatted)
      }
    }

    const l = report.locks || {}
    push(lines, 'OAKEN locks total', l.total)
    push(lines, 'OAKEN locks active', l.active)
    push(lines, 'Tokens still locked', l.totalRemainingHuman)
    push(lines, 'Share of supply still locked', l.remainingPctFormatted)
    push(lines, 'Next unlock', l.nextUnlockIso)
  }

  const flags = (report?.checks || []).filter((check) => check.status === 'flag')
  push(lines, 'Flagged checks', flags.length ? flags.map((check) => check.label).join(', ') : 'none')
  if (report?.source?.status) push(lines, 'Sourcify status', report.source.status)
  return lines.join('\n')
}

/** Strip addresses before looking for numbers: every hex chunk is digits. */
function stripAddresses(text) {
  return String(text || '').replace(/0x[0-9a-fA-F]{40}/g, ' address ')
}

/**
 * Canonical numeric tokens. `58,925.10` and `58925.1` are the same number;
 * `1.68020e-9` stays an exponent; `%` is dropped because the fact sheet often
 * carries the unit in the label.
 */
export function numericTokens(text) {
  const out = []
  const re = /\d[\d,]*(?:\.\d+)?(?:[eE][+-]?\d+)?%?/g
  for (const match of stripAddresses(text).matchAll(re)) {
    const raw = match[0].replace(/,/g, '').replace(/%$/, '')
    const n = Number(raw)
    if (Number.isFinite(n)) out.push(String(n))
  }
  return out
}

export function cleanNarrative(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^[#>*\-\s]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Returns the guarded narrative, or null. Never throws for a bad answer.
 */
export function guardNarrative(text, report, model = null, now = new Date()) {
  const clean = cleanNarrative(text)
  if (!clean || clean.length > MAX_NARRATIVE) return null
  if (!/^[A-Za-z0-9]/.test(clean)) return null
  if (BANNED.test(clean)) return null
  const flagCount = (report?.checks || []).filter((check) => check.status === 'flag').length
  if (flagCount > 0 && CLAIMS_NO_FLAGS.test(clean)) return null
  const facts = factsFor(report)
  const allowed = new Set(numericTokens(facts))
  for (const token of numericTokens(clean)) {
    if (!allowed.has(token)) return null
  }
  return {
    text: clean,
    model: model || null,
    version: NARRATIVE_VERSION,
    factsChecked: true,
    generatedAt: now.toISOString(),
  }
}

export function narrativePrompt(report) {
  return `Write a neutral 3-4 sentence narrative about the on-chain reading below.

Rules:
- Use ONLY the facts listed. Do not add, round, estimate or recompute any number.
- Reuse every number you mention exactly as written in the facts.
- No advice, prediction, price target, security score, or claim that anything is safe.
- If "Flagged checks" is not "none", mention that at least one check is flagged. Never say there are no flags.
- Call it a reading, not an audit.
- Plain English, no markdown, no lists, 120 words maximum.

FACTS
${factsFor(report)}`
}

/**
 * `runModel(prompt)` is supplied by the caller (Workers AI in the Worker, an
 * OpenAI-compatible endpoint in the Node service, a fake in tests).
 */
export async function generateNarrative(report, { runModel, model = null, now = new Date() } = {}) {
  if (typeof runModel !== 'function') return null
  let text
  try {
    text = await runModel(narrativePrompt(report))
  } catch {
    return null
  }
  return guardNarrative(text, report, model, now)
}
