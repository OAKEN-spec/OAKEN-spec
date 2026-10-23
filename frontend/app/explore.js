// OAKEN 平台层的共享数据模块 —— 发射台 / 活动流水 / 榜单 / 我的。
//
// 数据全部来自我们自己的 `/api/v1/*`（`src/upstream.mjs`）：那是抓取时刻的
// **公开列表快照**，一个字节都不是现编的。数字从哪来、是什么时候的，页面上说清楚，
// 不装成"实时" —— 这条纪律和锁那半边一致（[[fallback-that-looks-like-real-data]]）。
//
// 为什么列表一次拉全量（113 条）而不是交给服务端分页：
//   · 接口支持 `page`/`limit`，但**不支持搜索**，而搜索是这个页面最主要的东西；
//   · 113 条 × 一条几百字节 = 几十 KB，两个请求就拉完，之后筛选/排序/翻页都是本地算，
//     打字的时候不会一个字母一次请求。
//   · 分类（live/upcoming/filled）**必须按时钟现算** —— 源站自己的 `state` 字段
//     不是 live/upcoming/ended（见 upstream.mjs 里那段），照抄字段会把分类做错。

/** 快照里出现过的 EVM 链。非 EVM（Solana 501424 / TON -239）不列 —— 站点没有那些分支。 */
export const CHAINS = {
  1:     { slug: 'ethereum',  name: 'Ethereum',        native: 'ETH',  dp: 18, price: 'ethereum',      explorer: 'https://etherscan.io' },
  56:    { slug: 'bsc',       name: 'BNB Chain',       native: 'BNB',  dp: 18, price: 'binancecoin',   explorer: 'https://bscscan.com' },
  137:   { slug: 'polygon',   name: 'Polygon',         native: 'POL',  dp: 18, price: 'matic-network', explorer: 'https://polygonscan.com' },
  8453:  { slug: 'base',      name: 'Base',            native: 'ETH',  dp: 18, price: 'ethereum',      explorer: 'https://basescan.org' },
  43114: { slug: 'avalanche', name: 'Avalanche',       native: 'AVAX', dp: 18, price: 'avalanche-2',   explorer: 'https://snowtrace.io' },
  4663:  { slug: 'robinhood', name: 'Robinhood Chain', native: 'ETH',  dp: 18, price: 'ethereum',      explorer: 'https://robinhoodchain.blockscout.com' },
}

/** 我们自己的链 —— 列表里给它一个记号，不是特权，是"这条链上的东西本站能自己读"。 */
export const HOME_CHAIN = 4663

export const CHAIN_IDS = Object.keys(CHAINS).map(Number)

/** 非 EVM 平行线的 chainId，作为 `excludeChainIds[]` 发给接口。 */
const NON_EVM = [501424, -239]

export function chainOf(chainId) {
  return CHAINS[chainId] || { slug: String(chainId), name: `Chain ${chainId}`, native: '', dp: 18, price: null, explorer: '' }
}

/* ── 取数 ──────────────────────────────────────────────────────────────── */

async function apiGet(path) {
  const r = await fetch(path, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`${path} → ${r.status}`)
  return r.json()
}

/** 快照里全部 EVM 池。两个请求拉完，之后整页都从这份内存里筛。 */
let _pools = null
export async function allPools() {
  if (_pools) return _pools
  const qs = new URLSearchParams({ limit: '100' })
  for (const id of NON_EVM) qs.append('excludeChainIds[]', String(id))
  const first = await apiGet('/api/v1/market-flow/list?' + qs)
  let docs = first.docs || []
  for (let page = 2; page <= (first.totalPages || 1); page++) {
    docs = docs.concat((await apiGet(`/api/v1/market-flow/list?${qs}&page=${page}`)).docs || [])
  }
  _pools = docs
  return docs
}

/**
 * 列表页要的那一份：筛选 → 排序 → 全都在本地。
 *
 * 排序的默认是"刚开始/最近的在前"，但**募资速度**要用 `totalRaisedUsd` 而不是
 * `totalRaised` —— 列表混着六条链，`totalRaised` 各是本链货币（ETH/BNB/POL…），
 * 直接比大小会把 14 个 SOL 排在 13 个 BNB 前面，差两个数量级（upstream.mjs 里
 * 同一段注释，这里照它的口径来）。
 */
export function selectPools(rows, { filterBy = '', chainId = 0, sortBy = '', q = '', prices = null, now = Math.floor(Date.now() / 1000) } = {}) {
  let out = rows.slice()
  if (chainId) out = out.filter((r) => r.chainId === chainId)
  if (filterBy === 'live') out = out.filter((r) => statusOf(r.pool, now) === 'live')
  else if (filterBy === 'upcoming') out = out.filter((r) => statusOf(r.pool, now) === 'upcoming')
  /**
   * ⚠ **`ended` 和 `filled` 是同一个筛子**（2026-10-15 外部审计抓到）。
   * 列表页的标签发的是 `?filter=ended`（那是 URL 上给人读的词），而这里只认 `filled`
   * （源站语料里的词）—— 两个名字对不上，于是"Ended"那个标签**一个分支都不匹配**，
   * 点下去显示的是**全部**销售（看起来"筛选没生效"，其实是最糟的一种：它看着像在工作）。
   */
  else if (filterBy === 'filled' || filterBy === 'ended') out = out.filter((r) => statusOf(r.pool, now) === 'ended')

  if (q) {
    const needle = q.trim().toLowerCase()
    out = out.filter((r) => {
      const d = details(r.pool)
      return [r.token?.name, r.token?.symbol, r.token?.address, d.h, chainOf(r.chainId).name]
        .some((v) => String(v || '').toLowerCase().includes(needle))
    })
  }

  // 「募了多少」跨链比大小必须折成美元 —— 各链的 totalRaised 是本链货币，
  // 直接比数字会把 14 个 SOL 排在 13 个 BNB 前面（差两个数量级）。
  // 没价的排最后（-1），不猜。
  if (sortBy === 'raised') out.sort((a, b) => (raisedUsd(b, prices) ?? -1) - (raisedUsd(a, prices) ?? -1))
  else if (sortBy === 'speed') out.sort((a, b) => speed(b, now, prices) - speed(a, now, prices))
  else if (sortBy === 'ending') out.sort((a, b) => (Number(a.pool?.endTime) || 0) - (Number(b.pool?.endTime) || 0))
  else out.sort((a, b) => (Number(b.pool?.startTime) || 0) - (Number(a.pool?.startTime) || 0))

  return out
}

/** 每小时募了多少，**折成美元**（跨链排序，见上面 selectPools 的注释）。
 *  开盘不足一小时按一小时算，避免除零爆表；没有价目表就回 0（排最后，不猜）。 */
export function speed(row, now = Math.floor(Date.now() / 1000), prices = null) {
  const start = Number(row.pool?.startTime) || 0
  if (!start) return 0
  const meta = chainOf(row.chainId)
  const price = prices && meta.price ? prices[meta.price]?.usd : null
  if (!price) return 0
  const dp = Number(row.currency?.decimals ?? meta.dp)
  const raisedUsdValue = Number(raisedOf(row.pool)) / 10 ** dp * price
  return raisedUsdValue / Math.max((now - start) / 3600, 1 / 60)
}

export const feed = (limit = 40) => apiGet(`/api/v1/market-flow/feed?limit=${limit}`).catch(() => ({ docs: [] }))
export const liveNow = () => apiGet('/api/v1/market-flow/live').catch(() => null)
export const leaderboard = () => apiGet('/api/v1/leaderboard/list').catch(() => ({ docs: [] }))
export const leaderboardStats = () => apiGet('/api/v1/leaderboard/stats').catch(() => null)
/** coingecko id → usd。没有价就整段不显示美元，不折算、不估。 */
export const prices = () => apiGet('/api/v1/master_data/token_price').catch(() => ({}))

export function poolByAddress(rows, chainId, address) {
  const a = String(address || '').toLowerCase()
  return rows.find((r) => r.chainId === Number(chainId) && String(r.pool?.address || '').toLowerCase() === a) || null
}

/* ── 池子的读法 ────────────────────────────────────────────────────────── */

/** `poolDetails` 是一个**字符串化的 JSON**（源站就这么存的）—— 解不开当空对象，不猜。 */
export function details(pool) {
  try {
    const d = JSON.parse(pool?.poolDetails || '{}')
    return d && typeof d === 'object' ? d : {}
  } catch { return {} }
}

export function kyc(pool) {
  try {
    const d = JSON.parse(pool?.kycDetails || '{}')
    return d && typeof d === 'object' ? d : {}
  } catch { return {} }
}

/** 时钟分类。和接口同一口径（upstream.mjs 的 isLive/isUpcoming）。 */
export function statusOf(pool, now = Math.floor(Date.now() / 1000)) {
  const s = Number(pool?.startTime) || 0
  const e = Number(pool?.endTime) || 0
  if (!s) return 'unknown'
  if (now < s) return 'upcoming'
  if (e && now > e) return 'ended'
  return 'live'
}

/**
 * 硬顶就是硬顶，**只有它存在时才谈"完成了百分之多少"**。
 *
 * 第一版拿 `hardCap ?? softCap` 当分母，榜单上立刻出现「2958.1%」这种行：
 * 语料里 15 条 v35 的池子没有 hardCap，而 raised 早就超过软顶（软顶是"最低募集额"，
 * 不是目标），拿它当分母算出来的数字是**错的语义**，只是看起来像进度。
 * 量过：74/95 有硬顶，且没有一条 raised > hardCap；没有硬顶的那些里 10 条 raised > softCap。
 * 所以：没有硬顶 = 没有百分比（页面上写清楚为什么），而不是换一个分母硬凑。
 */
export function hardCapOf(pool) {
  const v = pool?.hardCap
  if (v === null || v === undefined || v === '') return null
  try { const b = BigInt(v); return b > 0n ? b : null } catch { return null }
}

export function softCapOf(pool) {
  const v = pool?.softCap
  if (v === null || v === undefined || v === '') return null
  try { const b = BigInt(v); return b > 0n ? b : null } catch { return null }
}

export function raisedOf(pool) {
  const v = pool?.totalRaised
  if (v === null || v === undefined || v === '') return 0n
  try { return BigInt(v) } catch { return 0n }
}

/** 进度百分比（硬顶口径）。没有硬顶 → null。超过 100 是真的会发生的，不肉眼截断。 */
export function pctOf(pool) {
  const t = hardCapOf(pool)
  if (!t) return null
  const r = raisedOf(pool)
  return Number((r * 10000n) / t) / 100
}

/** USD 估值：拿本链货币价折算；价表里没有这条链就回 null（整行不显示美元）。 */
export function raisedUsd(row, pricesMap) {
  if (!pricesMap) return null
  const meta = chainOf(row.chainId)
  const p = meta.price ? pricesMap[meta.price]?.usd : null
  if (!p) return null
  const dp = Number(row.currency?.decimals ?? meta.dp)
  return Number(raisedOf(row.pool)) / 10 ** dp * p
}

/* ── 格式化 ────────────────────────────────────────────────────────────── */

/** 别人的字符串进我们的 HTML —— 一律先过这一道（代币名/简介是第三方的字节）。 */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** BigInt/十进制字符串 → 带千分位的短数字。null → —（不编）。 */
export function amount(v, dp = 18, max = 2) {
  if (v === null || v === undefined || v === '') return '—'
  let s
  try { s = fmtUnits(typeof v === 'bigint' ? v : BigInt(v), dp) } catch { return '—' }
  const [i, f = ''] = s.split('.')
  const cut = f.slice(0, max).replace(/0+$/, '')
  const n = Number(i)
  const head = Number.isFinite(n) ? n.toLocaleString('en-US') : i
  return cut ? `${head}.${cut}` : head
}

/** 自己展开，不引 ethers —— 这几个页面不加载 500 KB 的库，读的也不是链。 */
function fmtUnits(v, dp) {
  const neg = v < 0n
  const a = (neg ? -v : v).toString().padStart(dp + 1, '0')
  const i = a.slice(0, a.length - dp)
  const f = a.slice(a.length - dp)
  return `${neg ? '-' : ''}${i}${f ? '.' + f : ''}`
}

export function usd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(n < 10 ? 2 : 0)}`
}

export function day(ts) {
  const t = Number(ts) * 1000
  if (!t || !Number.isFinite(t)) return '—'
  return new Date(t).toISOString().slice(0, 10)
}

/** 相对时间：还没到的说 in …，过去的说 … ago。 */
export function when(ts, now = Math.floor(Date.now() / 1000)) {
  const t = Number(ts) || 0
  if (!t) return '—'
  const d = Math.abs(t - now)
  const unit = d >= 86400 * 2 ? `${Math.round(d / 86400)}d`
    : d >= 7200 ? `${Math.round(d / 3600)}h`
    : d >= 120 ? `${Math.round(d / 60)}m` : 'moments'
  return t > now ? `in ${unit}` : `${unit} ago`
}

/* ── 页面小块 ──────────────────────────────────────────────────────────── */

/** 代币标识：取符号头两个字母刻一枚**字母章**。
 *  不挂源站图床（photos.pinksale.finance）—— 挂着别人的 CDN 既慢又是"这是抄来的"的告示，
 *  字母章在同一套色里长得统一。*/
export function monogram(symbol) {
  const s = String(symbol || '?').replace(/[^A-Za-z0-9]/g, '')
  return (s.slice(0, 2) || '?').toUpperCase()
}

export function bar(pct) {
  const w = pct === null ? 0 : Math.max(0, Math.min(100, pct))
  const tone = pct !== null && pct >= 100 ? 'ok' : 'gold'
  return `<div class="bar"><i class="${tone}" style="width:${w.toFixed(1)}%"></i></div>`
}

export function statusPill(pool, now = Math.floor(Date.now() / 1000)) {
  const s = statusOf(pool, now)
  if (s === 'live') return '<span class="pill lock"><span class="dot"></span>live</span>'
  if (s === 'upcoming') return '<span class="pill">upcoming</span>'
  if (s === 'ended') return '<span class="pill ok">ended</span>'
  return '<span class="pill">—</span>'
}

export function chainChip(chainId) {
  const meta = chainOf(chainId)
  const ours = chainId === HOME_CHAIN
  return `<span class="chip${ours ? ' ours' : ''}" title="${esc(meta.name)}">${esc(meta.name)}</span>`
}

/** `/launchpads/<chain>/<address>` —— 和锁那边 `/locks/robinhood/record/7` 同一个形状。 */
export function poolHref(row) {
  return `/launchpads/${chainOf(row.chainId).slug}/${row.pool?.address}`
}

export function shortAddr(a, n = 4) {
  const s = String(a || '')
  return s.length > 12 ? `${s.slice(0, 2 + n)}…${s.slice(-4)}` : (s || '—')
}

/* ── 收藏与最近浏览 ──────────────────────────────────────────────────────
 *
 * 只活在这台浏览器的 localStorage 里：没有账号、不上报、换台机器就没了。
 * 页面上说得明白（/me 那块），免得有人以为"我收藏的东西你们记着"。
 */
const LS_SAVED = 'oaken.saved.v1'
const LS_RECENT = 'oaken.recent.v1'

function readLs(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
function writeLs(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* 隐私模式写不进去 —— 那就不记，别抛 */ }
}

/** 列表/详情都存这一条：够画一行，也够点回那一页。 */
export function poolEntry(row) {
  return {
    chainId: row.chainId,
    address: row.pool?.address,
    name: row.token?.name || row.token?.symbol || 'Sale',
    symbol: row.token?.symbol || '',
    at: Date.now(),
  }
}

export function getSaved() { return readLs(LS_SAVED) }
export function isSaved(chainId, address) {
  const a = String(address || '').toLowerCase()
  return getSaved().some((x) => x.chainId === Number(chainId) && String(x.address || '').toLowerCase() === a)
}
/** 存/取消。返回**存完之后**是不是收藏状态。 */
export function toggleSaved(entry) {
  const a = String(entry.address || '').toLowerCase()
  const list = getSaved().filter((x) => !(x.chainId === Number(entry.chainId) && String(x.address || '').toLowerCase() === a))
  const nowSaved = list.length === getSaved().length
  if (nowSaved) list.unshift({ ...entry, at: Date.now() })
  writeLs(LS_SAVED, list.slice(0, 50))
  return nowSaved
}

export function getRecent() { return readLs(LS_RECENT) }
export function pushRecent(entry) {
  const a = String(entry.address || '').toLowerCase()
  const list = getRecent().filter((x) => !(x.chainId === Number(entry.chainId) && String(x.address || '').toLowerCase() === a))
  list.unshift({ ...entry, at: Date.now() })
  writeLs(LS_RECENT, list.slice(0, 12))
}
