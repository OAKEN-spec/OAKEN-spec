/**
 * /agents — the free web beta of OAKEN Agent Reports.
 *
 * No wallet and no payment on the page itself. The page talks to the
 * same-origin proxy at /api/agents/*, which forwards to the report Worker and
 * adds the site key that keeps the web beta free. The direct API at
 * agents.oaken.one is paid in USDG over x402; a paid report carries its
 * settlement transaction, which is shown below.
 */

import { shell, onChainSwitch } from './oaken.js'

shell({ active: 'agents' })
onChainSwitch(() => { /* reports are chain-fixed; do not reload on a wallet chain switch */ })

const $ = (id) => document.getElementById(id)
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]))
const short = (value) => {
  const text = String(value || '')
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.slice(0, 6) + '…' + text.slice(-4) : text
}
const date = (value) => {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10)
}
const num = (value) => Number(value || 0).toLocaleString('en-US')
const dateTime = (value) => {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}
const blockStamp = (report) => `Read at block ${num(report.blockNumber)}${report.blockTimeIso ? ' · ' + dateTime(report.blockTimeIso) : ''}.`
const addrLinks = (value) => esc(value).replace(/\b0x[0-9a-fA-F]{40}\b/g, (m) => `<a class="mono" href="https://robinhoodchain.blockscout.com/address/${m}" target="_blank" rel="noopener">${m}</a>`)
const pill = (status) => {
  const label = status === 'pass' ? 'Pass' : status === 'flag' ? 'Flag' : status === 'info' ? 'Info' : 'Unknown'
  if (status === 'pass') return `<span class="pill ok">${label}</span>`
  if (status === 'flag') return `<span class="chip warn">${label}</span>`
  if (status === 'info') return `<span class="pill lock">${label}</span>`
  return `<span class="pill">${label}</span>`
}
const setStatus = (text) => { $('status').textContent = text }
const explorerToken = (address) => `https://robinhoodchain.blockscout.com/token/${address}`
const explorerAddress = (address) => `https://robinhoodchain.blockscout.com/address/${address}`

function switchKind(kind) {
  const target = ['token', 'prelaunch', 'curve', 'bond'].includes(kind) ? kind : 'token'
  for (const tab of document.querySelectorAll('#kind-tabs a')) {
    const on = tab.dataset.kind === target
    tab.classList.toggle('on', on)
    tab.setAttribute('aria-selected', on ? 'true' : 'false')
  }
  for (const name of ['token', 'prelaunch', 'curve', 'bond']) {
    const form = $(`form-${name}`)
    if (form) form.style.display = name === target ? '' : 'none'
  }
  return target
}

function stat(value, label) {
  return `<div><div class="v">${value}</div><div class="k">${label}</div></div>`
}

function panel(title, pillHtml, body) {
  return `
    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>${esc(title)}</h3>${pillHtml || ''}</div>
      <div class="body">${body}</div>
    </div>`
}

function checksPanel(checks) {
  const rows = (checks || []).map((check) => `
    <tr>
      <td>${esc(check.label)}</td>
      <td>${pill(check.status)}</td>
      <td class="muted">${esc(check.detail)}</td>
    </tr>`).join('')
  return `
    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>Checks</h3><span class="pill">${(checks || []).length}</span></div>
      <div class="body" style="padding:0">
        <table class="list">
          <thead><tr><th>Check</th><th>Status</th><th>What was read</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`
}

function locksPanel(locks, token) {
  const rows = (locks?.rows || []).map((lock) => `
    <tr>
      <td class="mono">${esc(lock.version)} / ${esc(lock.id)}</td>
      <td>${esc(lock.amountHuman || '—')}</td>
      <td>${esc(lock.remainingHuman || '—')}</td>
      <td>${esc(date(lock.endIso))}${lock.steps || lock.initialUnlockBps ? `<div class="muted" style="font-size:12px;margin-top:4px">${lock.steps ? `${num(lock.steps)} steps` : 'single'} · ${(Number(lock.initialUnlockBps || 0) / 100).toFixed(2)}% at start</div>` : ''}</td>
      <td>${lock.revocable ? '<span class="chip warn">revocable</span>' : '<span class="muted">no</span>'}</td>
      <td class="mono">${esc(short(lock.beneficiary) || '—')}</td>
    </tr>`).join('')
  return `
    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>OAKEN locks</h3><span class="pill">${num(locks?.total || 0)}</span></div>
      <div class="body" style="padding:0">
        ${rows ? `
        <table class="list">
          <thead><tr><th>Lock</th><th>Amount</th><th>Still locked</th><th>Unlock</th><th>Revocable</th><th>Beneficiary</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>` : `<p class="body muted" style="margin:0">No OAKEN lock was found for this token in v1–v4. A lock created directly against the vault is not indexed by the adapter.</p>`}
        ${locks?.remainingPctFormatted ? `<p class="hint" style="margin:0;padding:12px 22px;border-top:1px solid var(--line)">Still locked: ${esc(locks.remainingPctFormatted)} of total supply${locks.totalPctFormatted ? ` · ${esc(locks.totalPctFormatted)} locked in total` : ''}.</p>` : ''}
      </div>
    </div>`
}

function ponsPanel(pons, token) {
  if (!pons) {
    return panel('Pons launch', '<span class="pill">Not found</span>', '<p class="muted" style="margin:0">The Pons factory did not return a launch record for this address. It may have launched elsewhere.</p>')
  }
  const rows = [
    ['Phase', pons.phaseLabel],
    ['Pair', pons.pairLabel],
    ['Curve reserves', pons.reserves ? `${pons.reserves.quoteHumanFormatted} ${pons.pairLabel} / ${pons.reserves.tokenHumanFormatted || '?'} ${token?.symbol || 'tokens'}` : 'not on the curve'],
    ['Tokens per quote', pons.reserves?.tokensPerQuoteFormatted || '—'],
    ['Quote-side value', pons.estimates?.quoteUsdFormatted || '—'],
    ['Implied FDV', pons.estimates?.fdvUsdFormatted || '—'],
    ['Price basis', pons.estimates?.basis || '—'],
    ['Creator tax', `${num(pons.creatorTaxBps || 0)} bps`],
    ['Buyback', pons.buybackEnabled ? 'enabled' : 'not enabled'],
    ['Deployer', short(pons.deployer)],
  ].map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')
  return `
    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>Pons launch</h3><span class="pill lock">${esc(pons.phaseLabel)}</span></div>
      <div class="body" style="padding:0"><table class="list"><tbody>${rows}</tbody></table></div>
    </div>`
}

function narrativePanel(report) {
  if (!report.narrative?.text) return ''
  return `
    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>Narrative</h3><span class="pill lock">AI · numbers checked</span></div>
      <div class="body">
        <p class="muted" style="max-width:72ch;margin:0">${esc(report.narrative.text)}</p>
        <p class="hint" style="margin:12px 0 0">Generated from this report's fact sheet. Every number in it also appears above; a number that was not in the fact sheet would have dropped the whole paragraph. The summary and checks are the authoritative fields.</p>
      </div>
    </div>`
}

function sourcesPanel(report) {
  const rows = (report.sources || []).map((source) => `
    <tr><td class="muted">${esc(source.label)}</td><td class="mono">${addrLinks(source.value)}</td></tr>`).join('')
  return `
    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>Sources</h3></div>
      <div class="body" style="padding:0"><table class="list"><tbody>${rows}</tbody></table></div>
      <div class="body"><p class="hint" style="margin:0">${esc(report.disclaimer || '')}</p></div>
    </div>`
}

function tokenFactsPanel(token) {
  const selectors = Object.entries(token.selectors || {}).filter(([, on]) => on).map(([key]) => key).join(', ') || 'none found'
  const rows = [
    ['Name', esc(token.name || '—')],
    ['Symbol', esc(token.symbol || '—')],
    ['Address', addrLinks(token.address || '—')],
    ['Total supply', esc(token.totalSupplyHuman ? `${token.totalSupplyHuman} ${token.symbol || ''}`.trim() : 'unreadable')],
    ['Decimals', esc(token.decimals == null ? 'unreadable' : String(token.decimals))],
    ['Runtime code', esc(token.codeBytes ? `${num(token.codeBytes)} bytes` : 'none')],
    ['EIP-1967 proxy', token.proxy ? addrLinks(token.proxy) : 'empty'],
    ['Owner / admin', token.owner ? addrLinks(token.owner) : 'no non-zero owner() was read'],
    ['Common selectors', esc(selectors)],
  ].map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="mono">${v}</td></tr>`).join('')
  return `
    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>Token facts</h3></div>
      <div class="body" style="padding:0"><table class="list"><tbody>${rows}</tbody></table></div>
    </div>`
}

function renderTokenReport(report) {
  const token = report.token || {}
  const locks = report.locks || {}
  const checks = report.checks || []
  const flagCount = checks.filter((check) => check.status === 'flag').length
  const title = token.name && token.symbol && token.name.toLowerCase() !== token.symbol.toLowerCase()
    ? `${token.name} · ${token.symbol}`
    : (token.name || token.symbol || 'Token')

  return `
    <div class="panel" style="margin-top:28px">
      <div class="head">
        <h3>${esc(title)}</h3>
        <span class="pill">${esc(short(token.address))}</span>
        ${flagCount ? `<span class="chip warn">${flagCount} flag${flagCount === 1 ? '' : 's'}</span>` : '<span class="pill ok">No flags</span>'}
      </div>
      <div class="body">
        <p class="muted" style="max-width:72ch">${esc(report.summary || '')}</p>
        <div class="stats" style="margin-top:22px">
          ${stat(num(locks.total || 0), 'OAKEN locks · v1–v4')}
          ${stat(esc(locks.totalRemainingHuman || '—'), `Still locked${token.symbol ? ' · ' + esc(token.symbol) : ''}`)}
          ${stat(esc(date(locks.nextUnlockIso)), 'Next unlock')}
          ${stat(report.pons ? esc(report.pons.phase === 0 ? 'On curve' : report.pons.phase === 1 ? 'Swept' : report.pons.phase === 2 ? 'V4 pool' : report.pons.phase === 3 ? 'Rescued' : 'Read') : '—', 'Pons')}
        </div>
        <p class="hint">${esc(blockStamp(report))} ${esc(report.beta?.note || '')}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
          <a class="btn btn-s" href="${esc(explorerToken(token.address || ''))}" target="_blank" rel="noopener">Token on Blockscout ↗</a>
          <a class="btn btn-s" href="https://sourcify.dev/#/lookup/${esc(token.address || '')}" target="_blank" rel="noopener">Sourcify ↗</a>
          <a class="btn btn-s" href="/locks/robinhood/${esc(token.address || '')}">OAKEN token page</a>
          <a class="btn btn-s" href="/verify">Verify it yourself</a>
        </div>
      </div>
    </div>
    ${checksPanel(checks)}
    ${locksPanel(locks, token)}
    ${ponsPanel(report.pons, token)}
    ${tokenFactsPanel(token)}
    ${sourcesPanel(report)}`
}

function renderCurveReport(report) {
  const token = report.token || {}
  const curve = report.curve || {}
  const checks = report.checks || []
  const flagCount = checks.filter((check) => check.status === 'flag').length
  const sym = token.symbol || 'tokens'
  const title = token.name && token.symbol && token.name.toLowerCase() !== token.symbol.toLowerCase()
    ? `${token.name} · ${token.symbol}`
    : (token.name || token.symbol || 'Token')
  const eth = (value) => (value == null ? 'unreadable' : `${value} ETH`)
  const usd = (value) => (value ? value : null)
  const join = (main, extra) => [main, extra].filter(Boolean).join(' · ')

  const stats = curve.graduated
    ? [
      stat('Graduated', 'Curve status'),
      stat(esc(curve.launchSupplyHuman || '—'), `Launch supply · ${sym}`),
      stat(esc(curve.reservedTokensHuman || '—'), 'Reserved for the pool'),
      stat(esc(curve.graduationThresholdHuman || '—'), 'Graduation line · ETH'),
    ]
    : [
      stat(esc(curve.soldPctFormatted || '—'), 'Sold on the curve'),
      stat(esc(curve.trackedQuoteHuman || '—'), 'Raised · ETH'),
      stat(esc(curve.raisePctFormatted || '—'), 'To graduation line'),
      stat(esc(curve.statusLabel || '—'), 'Status'),
    ]

  const stateRows = [
    ['Status', curve.statusLabel || '—'],
    ['Curve', curve.address],
    ['Token', curve.token],
    ['Creator', curve.creator || '—'],
    ['Creator fee recipient', curve.creatorFeeRecipient || '—'],
    ['Launched', curve.launchedAtIso ? dateTime(curve.launchedAtIso) : '—'],
    ['Launch supply', curve.launchSupplyHuman ? `${curve.launchSupplyHuman} ${sym}` : 'unreadable'],
    ['Reserved for the pool', curve.reservedTokensHuman ? `${curve.reservedTokensHuman} ${sym}` : 'unreadable'],
    ['Sellable allocation', curve.sellableTotalHuman ? `${curve.sellableTotalHuman} ${sym}` : 'unreadable'],
    ['Sold', curve.soldHuman ? `${curve.soldHuman} ${sym} (${curve.soldPctFormatted || '?'})` : 'unreadable'],
    ['Raised', curve.trackedQuoteHuman ? `${curve.trackedQuoteHuman} ETH (${curve.raisePctFormatted || '?'} of the line)` : 'unreadable'],
    ['Graduation line', eth(curve.graduationThresholdHuman)],
    ['Remaining to graduate', curve.graduated ? 'graduated' : eth(curve.remainingToGraduateHuman)],
    ['Tracked tokens', curve.trackedTokensHuman ? `${curve.trackedTokensHuman} ${sym}` : 'unreadable'],
    ['Virtual tokens', curve.virtualTokensHuman ? `${curve.virtualTokensHuman} ${sym}` : '—'],
    ['Phantom quote', curve.phantomQuoteHuman ? `${curve.phantomQuoteHuman} ETH` : '—'],
    ['Reserves', curve.reserves ? `${curve.reserves.quoteReserveHuman} ETH / ${curve.reserves.tokenReserveHuman || '?'} ${sym}` : 'unreadable'],
  ]
  const priceRows = [
    ['Spot price', join(eth(curve.price?.spotFormatted), usd(curve.estimates?.spotPriceUsdFormatted))],
    ['Implied FDV (spot)', join(eth(curve.price?.spotFdvFormatted), usd(curve.estimates?.spotFdvUsdFormatted))],
    ['Real price (raised ÷ sold)', eth(curve.price?.realFormatted)],
    ['Real FDV', join(eth(curve.price?.realFdvFormatted), usd(curve.estimates?.realFdvUsdFormatted))],
    ['Quote-side value', curve.estimates?.quoteUsdFormatted || 'unreadable'],
    ['Price basis', curve.estimates?.basis || '—'],
  ]
  const feeRows = [
    ['Protocol fee', curve.fees?.feeFormatted || 'unreadable'],
    ['Creator tax', curve.fees?.creatorTaxFormatted || 'unreadable'],
    ['Protocol share', curve.fees?.protocolShareFormatted || 'unreadable'],
    ['Snipe tax', curve.fees?.snipeTaxSeconds == null ? '—' : `${(Number(curve.fees.snipeTaxStartBps || 0) / 100).toFixed(0)}% for ${curve.fees.snipeTaxSeconds}s`],
    ['Pending creator fees', curve.balances?.pendingCreatorFeesHuman ? `${curve.balances.pendingCreatorFeesHuman} ETH` : '—'],
    ['Protocol fees pending', curve.balances?.protocolFeeBalanceHuman ? `${curve.balances.protocolFeeBalanceHuman} ETH` : '—'],
    ['Creator fees pending', curve.balances?.creatorFeeBalanceHuman ? `${curve.balances.creatorFeeBalanceHuman} ETH` : '—'],
    ['Creator tax balance', curve.balances?.creatorTaxBalanceHuman ? `${curve.balances.creatorTaxBalanceHuman} ETH` : '—'],
    ['Snipe tax balance', curve.balances?.snipeTaxBalanceHuman ? `${curve.balances.snipeTaxBalanceHuman} ETH` : '—'],
  ]
  const rowTable = (rows, linkKeys = new Set()) => rows.map(([k, v]) => {
    const value = v == null ? '—' : String(v)
    return `<tr><td class="muted">${esc(k)}</td><td class="mono">${linkKeys.has(k) ? addrLinks(value) : esc(value)}</td></tr>`
  }).join('')

  return `
    <div class="panel" style="margin-top:28px">
      <div class="head">
        <h3>${esc(title)} · Curve launch</h3>
        <span class="pill">${esc(short(curve.address))}</span>
        ${flagCount ? `<span class="chip warn">${flagCount} flag${flagCount === 1 ? '' : 's'}</span>` : '<span class="pill ok">No flags</span>'}
      </div>
      <div class="body">
        <p class="muted" style="max-width:72ch">${esc(report.summary || '')}</p>
        <div class="stats" style="margin-top:22px">${stats.join('')}</div>
        <p class="hint">${esc(blockStamp(report))} ${esc(report.beta?.note || '')}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
          <a class="btn btn-s" href="/curve/robinhood/${esc(curve.address || '')}">Open the curve</a>
          <a class="btn btn-s" href="${esc(explorerToken(token.address || ''))}" target="_blank" rel="noopener">Token on Blockscout ↗</a>
          <a class="btn btn-s" href="https://sourcify.dev/#/lookup/${esc(curve.address || '')}" target="_blank" rel="noopener">Curve source ↗</a>
          <a class="btn btn-s" href="/verify">Verify it yourself</a>
        </div>
      </div>
    </div>
    ${checksPanel(checks)}
    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>Curve state</h3><span class="pill">${esc(curve.statusLabel || '—')}</span></div>
      <div class="body" style="padding:0"><table class="list"><tbody>${rowTable(stateRows, new Set(['Curve', 'Token', 'Creator', 'Creator fee recipient']))}</tbody></table></div>
    </div>
    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>Price and implied value</h3></div>
      <div class="body" style="padding:0"><table class="list"><tbody>${rowTable(priceRows)}</tbody></table></div>
    </div>
    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>Fees and balances</h3></div>
      <div class="body" style="padding:0"><table class="list"><tbody>${rowTable(feeRows)}</tbody></table></div>
    </div>
    ${locksPanel(report.locks || {}, token)}
    ${tokenFactsPanel(token)}
    ${sourcesPanel(report)}`
}

function renderPrelaunchReport(report) {
  const token = report.token || {}
  const locks = report.locks || {}
  const plan = report.plan || {}
  const checks = report.checks || []
  const flagCount = checks.filter((check) => check.status === 'flag').length
  const planRows = [
    ['Planned lock', `${plan.lockAmountFormatted || '—'} ${token.symbol || 'tokens'}`],
    ['Share of supply', plan.sharePctFormatted || 'unreadable'],
    ['Duration', `${plan.lockDays} days · ends ${date(plan.endIso)}`],
    ['Vesting', plan.steps === 0 ? 'one terminal unlock' : `${plan.steps} steps`],
    ['Initial unlock', `${plan.initialUnlockPct}%`],
    ['Revocable', plan.revocable ? 'yes — creator can revoke' : 'no'],
    ['Source', plan.source || 'user-provided plan'],
  ].map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')

  return `
    <div class="panel" style="margin-top:28px">
      <div class="head">
        <h3>Pre-launch review · ${esc(token.symbol || token.name || 'Token')}</h3>
        <span class="pill">${esc(short(token.address))}</span>
        ${flagCount ? `<span class="chip warn">${flagCount} flag${flagCount === 1 ? '' : 's'}</span>` : '<span class="pill ok">No flags</span>'}
      </div>
      <div class="body">
        <p class="muted" style="max-width:72ch">${esc(report.summary || '')}</p>
        <div class="stats" style="margin-top:22px">
          ${stat(esc(plan.lockAmountFormatted || '—'), 'Planned lock')}
          ${stat(esc(plan.sharePctFormatted || '—'), 'Of total supply')}
          ${stat(`${num(plan.lockDays)}d`, 'Lock duration')}
          ${stat(`${num(plan.initialUnlockPct)}%`, 'Initial unlock')}
        </div>
        <p class="hint">${esc(blockStamp(report))} ${esc(report.beta?.note || '')}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
          <a class="btn btn-s" href="/locks/create">Open the lock form</a>
          <a class="btn btn-s" href="https://sourcify.dev/#/lookup/${esc(token.address || '')}" target="_blank" rel="noopener">Sourcify ↗</a>
          <a class="btn btn-s" href="/locks/robinhood/${esc(token.address || '')}">Token page</a>
          <a class="btn btn-s" href="/verify">Verify it yourself</a>
        </div>
      </div>
    </div>

    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>The plan (user-provided)</h3><span class="pill">Not on-chain</span></div>
      <div class="body" style="padding:0"><table class="list"><tbody>${planRows}</tbody></table></div>
    </div>

    ${checksPanel(checks)}
    ${locksPanel(locks, token)}
    ${ponsPanel(report.pons, token)}
    ${tokenFactsPanel(token)}
    ${sourcesPanel(report)}`
}

function renderBondReport(report) {
  const bond = report.bond || {}
  const checks = report.checks || []
  const flagCount = checks.filter((check) => check.status === 'flag').length
  const factRows = [
    ['Bond token', bond.token],
    ['Vault', bond.vault],
    ['NAV oracle', bond.oracle],
    ['Staking', bond.staking],
    ['Supply', bond.supplyHuman ? `${bond.supplyHuman} ${bond.symbol || ''}`.trim() : 'unreadable'],
    ['USDG reserves', bond.reservesHuman ? `${bond.reservesHuman} USDG` : 'unreadable'],
    ['NAV', bond.navFormatted || 'unreadable'],
    ['Reserve coverage', bond.coverageFormatted || 'unreadable'],
    ['Backing per bond', bond.backingPerBond != null ? '$' + bond.backingPerBond.toFixed(6) : 'unreadable'],
    ['Vault solvent', bond.solvent == null ? 'unreadable' : bond.solvent ? 'yes' : 'no'],
    ['Mint / redeem paused', bond.paused == null ? 'unreadable' : bond.paused ? 'yes' : 'no'],
    ['Redeem fee', bond.redeemFeeFormatted || 'unreadable'],
    ['1 bond redeems for', bond.redeemOneBondUsdgHuman ? `${bond.redeemOneBondUsdgHuman} USDG` : 'unreadable'],
    ['1 USDG mints', bond.mintOneUsdgBondsHuman ? `${bond.mintOneUsdgBondsHuman} bond${bond.mintOneUsdgBondsHuman === '1' ? '' : 's'}` : 'unreadable'],
    ['Mint cap', bond.mintCapHuman || bond.mintCap || 'unreadable'],
    ['NAV oracle price', bond.oraclePrice != null ? '$' + Number(bond.oraclePrice).toFixed(4) : 'unreadable'],
    ['NAV oracle updated', bond.oracleUpdatedAt || 'unreadable'],
    ['Oracle stale', bond.oracleStale == null ? 'unreadable' : bond.oracleStale ? 'yes' : 'no'],
    ['Staked', bond.stakingTotalHuman ? `${bond.stakingTotalHuman} ${bond.symbol || ''}`.trim() : 'unreadable'],
    ['Staking APR (instant)', bond.apyUsdgFormatted || 'not funded'],
    ['OAKEN per bond / yr', bond.oakenPerBondYearFormatted || 'not funded'],
    ['Reward duration', bond.rewardDurationDays != null ? `${bond.rewardDurationDays} days` : 'unreadable'],
    ['Reward stream ends', bond.stakingFinishIso || '—'],
    ['Reward stream left', bond.streamRemaining || 'no active stream / unreadable'],
  ]
  const linkKeys = new Set(['Bond token', 'Vault', 'NAV oracle', 'Staking'])
  const rows = factRows.map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="mono">${linkKeys.has(k) ? addrLinks(v) : esc(v)}</td></tr>`).join('')

  return `
    <div class="panel" style="margin-top:28px">
      <div class="head">
        <h3>${esc(bond.name || 'OAKEN Bond')} · ${esc(bond.symbol || '')}</h3>
        <span class="pill">${esc(short(bond.token))}</span>
        ${flagCount ? `<span class="chip warn">${flagCount} flag${flagCount === 1 ? '' : 's'}</span>` : '<span class="pill ok">No flags</span>'}
      </div>
      <div class="body">
        <p class="muted" style="max-width:72ch">${esc(report.summary || '')}</p>
        <div class="stats" style="margin-top:22px">
          ${stat(esc(bond.supplyHuman || '—'), 'Bonds outstanding')}
          ${stat(esc(bond.reservesHuman || '—'), 'USDG reserves')}
          ${stat(esc(bond.navFormatted || '—'), 'NAV')}
          ${stat(esc(bond.coverageFormatted || '—'), 'Reserve coverage')}
        </div>
        <p class="hint">${esc(blockStamp(report))} ${esc(report.beta?.note || '')}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
          <a class="btn btn-s" href="/bonds">Open the bond market</a>
          <a class="btn btn-s" href="${esc(explorerAddress(bond.vault || ''))}" target="_blank" rel="noopener">Vault on Blockscout ↗</a>
          <a class="btn btn-s" href="https://sourcify.dev/#/lookup/${esc(bond.vault || '')}" target="_blank" rel="noopener">Vault source ↗</a>
          <a class="btn btn-s" href="/verify">Verify it yourself</a>
        </div>
      </div>
    </div>
    ${checksPanel(checks)}
    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>Bond facts</h3></div>
      <div class="body" style="padding:0"><table class="list"><tbody>${rows}</tbody></table></div>
    </div>
    ${sourcesPanel(report)}`
}

function renderReport(report) {
  const body = report.kind === 'prelaunch-review'
    ? renderPrelaunchReport(report)
    : report.kind === 'bond-health-report'
      ? renderBondReport(report)
      : report.kind === 'curve-report'
        ? renderCurveReport(report)
        : renderTokenReport(report)
  const toolbar = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:24px">
      <a class="btn btn-s" href="/agents">New report</a>
      <button class="btn btn-s" type="button" id="copy-report">Copy link</button>
      <button class="btn btn-s" type="button" id="fresh-report">Read fresh</button>
      <span class="pill" title="The report is pinned to this block">block ${num(report.blockNumber)}</span>
      ${report.payment?.transaction
        ? `<a class="pill" href="https://robinhoodchain.blockscout.com/tx/${esc(report.payment.transaction)}" target="_blank" rel="noopener" title="Settled in USDG over x402">paid · ${esc(short(report.payment.transaction))} ↗</a>`
        : ''}
      ${report.reused ? '<span class="pill">cached</span>' : ''}
    </div>`
  const who = report.kind === 'bond-health-report'
    ? (report.bond?.name || report.bond?.symbol || 'Bond')
    : (report.token?.symbol || report.token?.name || 'Token')
  document.title = report.kind === 'prelaunch-review'
    ? `Pre-launch review · ${who} · OAKEN`
    : report.kind === 'curve-report'
      ? `Curve launch · ${who} · OAKEN`
      : `${who} report · OAKEN`
  $('report').innerHTML = toolbar + body + narrativePanel(report)
  const copy = $('copy-report')
  if (copy) copy.addEventListener('click', () => copyReportLink(copy, report))
  const fresh = $('fresh-report')
  if (fresh) fresh.addEventListener('click', () => freshReport(report, fresh))
  $('report').scrollIntoView({ behavior: 'smooth', block: 'start' })
  return report
}

async function copyReportLink(button, report) {
  const url = `${location.origin}/agents?report=${encodeURIComponent(report.id)}`
  const old = button.textContent
  try {
    await navigator.clipboard.writeText(url)
    button.textContent = 'copied ✓'
  } catch {
    button.textContent = 'copy failed'
  }
  setTimeout(() => { button.textContent = old }, 1600)
}

function freshReport(report, button) {
  if (report.kind === 'prelaunch-review') {
    requestReport({
      kind: 'prelaunch',
      token: report.token?.address,
      lockAmount: report.plan?.lockAmount,
      lockDays: report.plan?.lockDays,
      steps: report.plan?.steps,
      initialUnlockPct: report.plan?.initialUnlockPct,
      revocable: report.plan?.revocable,
      fresh: true,
    }, button, 'Reading a fresh pre-launch review…')
    return
  }
  if (report.kind === 'bond-health-report') {
    requestReport({ kind: 'bond', symbol: 'OAKEN', fresh: true }, button, 'Reading a fresh bond report…')
    return
  }
  if (report.kind === 'curve-report') {
    requestReport({ kind: 'curve', address: report.curve?.address, fresh: true }, button, 'Reading a fresh curve report…')
    return
  }
  requestReport({ kind: 'token', token: report.token?.address, fresh: true }, button, 'Reading a fresh token report…')
}

function showLoading(label) {
  $('report').innerHTML = `
    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>${esc(label)}</h3><span class="pill lock">Reading</span></div>
      <div class="body">
        <div class="skel-bar" style="width:62%;margin:2px 0 12px"></div>
        <div class="skel-bar" style="width:88%;margin:2px 0 8px"></div>
        <div class="skel-bar" style="width:74%;margin:2px 0"></div>
        <p class="hint" style="margin-top:16px">Robinhood Chain reads run on the report service; a fresh report can take a few seconds.</p>
      </div>
    </div>`
  $('report').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function showError(message, onRetry) {
  $('report').innerHTML = `
    <div class="panel" style="margin-top:28px">
      <div class="head"><h3>Report did not run</h3><span class="chip warn">Error</span></div>
      <div class="body">
        <p class="muted" style="margin:0">${esc(message)}</p>
        ${onRetry ? '<button class="btn btn-s" id="retry-report" type="button" style="margin-top:14px">Retry</button>' : ''}
      </div>
    </div>`
  const retry = $('retry-report')
  if (retry && onRetry) retry.addEventListener('click', onRetry)
}

function applyReportToForm(report) {
  if (report.kind === 'prelaunch-review') {
    switchKind('prelaunch')
    $('ptoken').value = report.token?.address || $('ptoken').value
    $('pamount').value = report.plan?.lockAmount ?? $('pamount').value
    $('pdays').value = report.plan?.lockDays ?? $('pdays').value
    $('psteps').value = report.plan?.steps ?? $('psteps').value
    $('pinitial').value = report.plan?.initialUnlockPct ?? $('pinitial').value
    $('prevocable').checked = Boolean(report.plan?.revocable)
    return
  }
  if (report.kind === 'bond-health-report') {
    switchKind('bond')
    if (report.bond?.symbol) $('bsymbol').value = 'OAKEN'
    return
  }
  if (report.kind === 'curve-report') {
    switchKind('curve')
    $('curveaddr').value = report.curve?.address || $('curveaddr').value
    return
  }
  switchKind('token')
  $('token').value = report.token?.address || $('token').value
}

async function requestReport(body, button, pendingText) {
  const original = button.textContent
  button.disabled = true
  button.textContent = 'Reading…'
  setStatus(pendingText)
  showLoading('Reading the chain…')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  let ticks = 0
  const tick = setInterval(() => {
    ticks += 1
    setStatus(`${pendingText} (${ticks}s)`)
  }, 1000)
  try {
    const response = await fetch('/api/agents/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data || !data.report) {
      throw new Error(data?.error || `The report service answered HTTP ${response.status}.`)
    }
    renderReport(data.report)
    applyReportToForm(data.report)
    history.replaceState(null, '', `/agents?report=${encodeURIComponent(data.report.id)}`)
    setStatus(data.reused
      ? `Reused a stored report from block ${num(data.report.blockNumber)}${data.report.blockTimeIso ? ' · ' + dateTime(data.report.blockTimeIso) : ''} — click Read fresh for a new read.`
      : `Report stored · block ${num(data.report.blockNumber)}${data.report.blockTimeIso ? ' · ' + dateTime(data.report.blockTimeIso) : ''} · ${String(data.report.kind).replaceAll('-', ' ')}.`)
    loadRecent()
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'The read timed out after 120s. The service may be waiting on the Robinhood Chain RPC — try again.'
      : String(error?.message || error)
    showError(message, () => requestReport(body, button, pendingText))
    setStatus('The report did not run. Nothing was stored.')
  } finally {
    clearTimeout(timeout)
    clearInterval(tick)
    button.disabled = false
    button.textContent = original
  }
}

function runToken() {
  const token = String($('token').value || '').trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    setStatus('Send a token address: 0x followed by 40 hex characters.')
    return
  }
  requestReport({ kind: 'token', token }, $('run-token'), 'Reading the token, its OAKEN locks, and the Pons factory at the latest block…')
}

function runPrelaunch() {
  const token = String($('ptoken').value || '').trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    setStatus('Send a token address: 0x followed by 40 hex characters in the pre-launch form.')
    return
  }
  const lockAmount = Number($('pamount').value)
  const lockDays = Number($('pdays').value)
  if (!Number.isFinite(lockAmount) || lockAmount <= 0) {
    setStatus('Enter how many tokens you plan to lock.')
    return
  }
  requestReport({
    kind: 'prelaunch',
    token,
    lockAmount,
    lockDays,
    steps: Number($('psteps').value || 0),
    initialUnlockPct: Number($('pinitial').value || 0),
    revocable: $('prevocable').checked,
  }, $('run-prelaunch'), 'Reading the token facts, then comparing them with your plan…')
}

function runBond() {
  const symbol = String($('bsymbol').value || 'OAKEN')
  requestReport({ kind: 'bond', symbol }, $('run-bond'), 'Reading the bond vault, NAV oracle and staking pool at the latest block…')
}

function runCurve() {
  const address = String($('curveaddr').value || '').trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    setStatus('Send a curve address: 0x followed by 40 hex characters.')
    return
  }
  requestReport({ kind: 'curve', address }, $('run-curve'), 'Reading the curve, its token, and the locks around it at the latest block…')
}

async function loadReport(id) {
  setStatus('Loading the stored report…')
  showLoading('Loading the stored report…')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(`/api/agents/report/${encodeURIComponent(id)}`, { signal: controller.signal })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data || !data.report) throw new Error(data?.error || `HTTP ${response.status}`)
    renderReport(data.report)
    applyReportToForm(data.report)
    setStatus(`Stored report from block ${num(data.report.blockNumber)}${data.report.blockTimeIso ? ' · ' + dateTime(data.report.blockTimeIso) : ''}.`)
    loadRecent()
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Loading the stored report timed out. Try again.'
      : `Could not load that report: ${String(error?.message || error)}`
    showError(message, () => loadReport(id))
    setStatus('Could not load the stored report.')
  } finally {
    clearTimeout(timeout)
  }
}

async function loadRecent() {
  const body = $('recent').querySelector('tbody')
  try {
    const response = await fetch('/api/agents/reports?limit=15')
    const data = await response.json().catch(() => null)
    if (!response.ok || !data) throw new Error(`HTTP ${response.status}`)
    const rows = Array.isArray(data.reports) ? data.reports : []
    $('recent-count').textContent = String(rows.length)
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5" style="padding:18px 22px"><span class="muted">No reports yet. Run the first one above.</span></td></tr>'
      return
    }
    body.innerHTML = rows.map((row) => `
      <tr data-report="${esc(row.id)}" tabindex="0" role="button" aria-label="Open ${esc(row.kindLabel || "report")} for ${esc(row.symbol || "token")}" style="cursor:pointer">
        <td><b>${esc(row.kindLabel || 'Report')}</b><br><span class="muted">${esc(row.symbol || 'TOKEN')} <span class="mono">${esc(short(row.token))}</span></span></td>
        <td>${esc(row.title || row.symbol || '—')}</td>
        <td>${esc(date(row.createdAt))}</td>
        <td>${row.flags ? `<span class="chip warn">${num(row.flags)}</span>` : '<span class="pill ok">0</span>'}</td>
        <td class="muted">${esc(row.curveStatus || row.ponsPhase || '')}</td>
      </tr>`).join('')
    for (const tr of body.querySelectorAll('tr[data-report]')) {
      const open = () => {
        const id = tr.getAttribute('data-report')
        history.replaceState(null, '', `/agents?report=${encodeURIComponent(id)}`)
        loadReport(id)
      }
      tr.addEventListener('click', open)
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() }
      })
    }
  } catch (error) {
    $('recent-count').textContent = '—'
    body.innerHTML = `<tr><td colspan="5" style="padding:18px 22px"><span class="muted">Could not read the report index: ${esc(String(error?.message || error))}</span></td></tr>`
  }
}

document.querySelectorAll('#kind-tabs a').forEach((tab) => {
  tab.addEventListener('click', (event) => {
    event.preventDefault()
    switchKind(tab.dataset.kind)
    document.title = 'Agent Reports · OAKEN'
    setStatus('Pick a report above. Nothing is signed and no wallet is needed in this beta.')
  })
})
document.querySelectorAll('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    const [initial, cycle, pct] = String(button.dataset.preset || '').split(',').map(Number)
    if (![initial, cycle, pct].every(Number.isFinite)) return
    const steps = pct > 0 ? Math.ceil((100 - initial) / pct) : 0
    $('pinitial').value = initial
    $('psteps').value = steps
    $('pdays').value = cycle * steps
    switchKind('prelaunch')
    setStatus(`Preset applied: ${initial}% at start, ${steps} step${steps === 1 ? '' : 's'} of ${pct}% every ${cycle} days. Edit any field before running.`)
  })
})
$('run-token').addEventListener('click', runToken)
$('run-prelaunch').addEventListener('click', runPrelaunch)
$('run-curve').addEventListener('click', runCurve)
$('run-bond').addEventListener('click', runBond)
$('token').addEventListener('keydown', (event) => { if (event.key === 'Enter') runToken() })
$('ptoken').addEventListener('keydown', (event) => { if (event.key === 'Enter') runPrelaunch() })
$('curveaddr').addEventListener('keydown', (event) => { if (event.key === 'Enter') runCurve() })

const params = new URLSearchParams(location.search)
const reportId = params.get('report')
const presetToken = params.get('token')
const presetKind = params.get('kind')

if (presetToken && /^0x[0-9a-fA-F]{40}$/.test(presetToken)) {
  $('token').value = presetToken
  $('ptoken').value = presetToken
  setStatus('Token prefilled from the token page. Run a report when ready.')
}
if (presetKind === 'prelaunch' || presetKind === 'bond' || presetKind === 'token' || presetKind === 'curve') switchKind(presetKind)

if (reportId) loadReport(reportId)
else loadRecent()
