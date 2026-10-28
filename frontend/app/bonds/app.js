// /app/ —— 申赎逻辑。
//
// 三件事值得先说清:
//
// ① **钱包是必须的。** 这一页不硬编码任何 RPC —— 读和写都走 `window.ethereum`。
//    多一个硬编码的公共 RPC 就多一个出网主机（而镜像有一张逐条审过的出站白名单），
//    也等于替访客决定用谁的节点。没钱包就明说。
//
// ② **写操作一律显式带 gasLimit。** 理由见 lib/wallet.js 的文件头 ——
//    这条链的 `eth_estimateGas` 会给你一个偏小的值，然后**静默** out of gas。
//
// ③ **赎回按钮在看得到的地方就画死。** 显示的是 `maxRedeemable()`（储备允许的
//    额度）而不是用户的余额 —— 票息没到账时余额是赎不出来的，给一个按不动的
//    大数字比给一个正确的数更糟。

import { CHAIN, CHAIN_ID, USDG, REWARD, BONDS, DECIMALS, SEL, STAKING_DURATION, BATCHER, V12 } from './lib/contracts.js?v=1228f70a'
import { encodeCall, uintAt, intAt, boolAt, addressAt, bytesAt, stringAt, parseUnits, formatUnits, pretty } from './lib/abi.js?v=0d2c4f03'
import * as W from './lib/wallet.js?v=cbc89658'
import { GOVERNANCE, TL, CALL_LABELS, TARGET_LABELS, NAV_SELECTOR } from './lib/governance.js'

const $ = (id) => document.getElementById(id)
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4)

let account = null
let chainOk = false
let current = BONDS[0]
let usdgDecimals = DECIMALS.usdg
let bondDecimals = DECIMALS.bond
const sym = () => 'a' + current.symbol
const ADMIN_SEL = '0xf851a440'
const TL_SCAN_CHUNK = 500
let tlTimer = null
let tlProposals = []
/// 这只债券的质押池。**没开质押的债券这里就是 undefined** —— 见渲染那一段。
const pool = () => current.staking
/// v1.2（2026-10-14）:赎回路由器。**没有 v1.2 部署时是 null** ——
/// 那时赎回退回直连金库（老路径），折扣那一行也就不显示。
const router = () => (V12 && V12.router) || null
/// 当前债券在路由里的下标。路由的五对三元组和 `BONDS` 是**同一个来源**
/// （都从 deployments.json 的键序生成），所以顺序天然一致 —— 但仍显式按 token 找，
/// 不靠"两边碰巧一样":找错一格就是"赎了另一只债券"，而那笔交易是成功的。
const pairIndex = () => BONDS.findIndex((b) => b.token.toLowerCase() === current.token.toLowerCase())

// ── 读 ────────────────────────────────────────────────────────────────────
const readUint = async (to, data) => uintAt(await W.call(to, data))
const readBool = async (to, data) => boolAt(await W.call(to, data))

const vault = (fn, args) => W.call(current.vault, encodeCall(SEL.vault[fn], args, fn === 'mint' || fn === 'redeem' ? ['uint256'] : []))
const tokenBal = (who) => readUint(current.token, encodeCall(SEL.bond.balanceOf, [who], ['address']))
const usdgBal = (who) => readUint(USDG, encodeCall(SEL.erc20.balanceOf, [who], ['address']))

async function nav() {
  try {
    // ⚠️ `latestRoundData` 在 **oracle** 上，不在 vault 上。
    //    第一版写成了 `vault('latestRoundData')` —— `SEL.vault` 里没有这个名字，
    //    于是每次都在这里抛，然后**每次都落进下面的"过期"分支**:
    //    页面看起来只是"报价过期了"，实际是**所有按钮全被禁用**，
    //    而控制台一条红字都没有（异常被这个 catch 吃掉了）。
    //    这个 bug 是 tools/app-e2e.js 抓到的 —— 判据是"点一次 Mint，看链上余额动不动"。
    const r = await W.call(current.oracle, encodeCall(SEL.oracle.latestRoundData))
    return { value: intAt(r, 1), updatedAt: uintAt(r, 3), stale: false }
  } catch (e) {
    // 过期时合约是 revert 的（不是回旧值）—— 这正是设计要的。
    // 界面上仍然把它读出来（peekUnsafe），但要**显式标红**，因为此刻申赎是停摆的。
    const r = await W.call(current.oracle, encodeCall(SEL.oracle.peekUnsafe))
    return { value: intAt(r, 1), updatedAt: uintAt(r, 2), stale: true }
  }
}

// ── 渲染 ──────────────────────────────────────────────────────────────────
function renderPills() {
  $('pills').innerHTML = ''
  for (const b of BONDS) {
    const el = document.createElement('button')
    el.className = 'pill'
    el.textContent = b.symbol
    el.setAttribute('aria-pressed', String(b.symbol === current.symbol))
    el.onclick = () => { current = b; renderPills(); refresh(); renderVisitor() }
    $('pills').appendChild(el)
  }
  $('mintSym').textContent = sym()
}

function setNotice(html) {
  const n = $('notice')
  if (!html) { n.hidden = true; return }
  n.hidden = false
  n.innerHTML = html
}

function status(msg, isErr = false) {
  const s = $('status')
  s.className = isErr ? 'err' : ''
  s.innerHTML = msg
}

async function refresh() {
  if (!account || !chainOk) return
  $('visitor').hidden = true        // 连上了就把'访客那一块'收起来（它显示的是池子的公开状态）
  $('panels').hidden = false
  $('stats').hidden = false
  const [n, bal, ub, res, max, paxHex, supplyHex] = await Promise.all([
    nav(), tokenBal(account), usdgBal(account), vault('reserves'),
    // ⚠️ `maxRedeemable()` 会读净值：**报价一过期它就 revert**。
    //    不接住的话，这一句会把整个 `Promise.all` 掀掉 → `refresh()` 在中途抛出 →
    //    **页面什么都不渲染**（余额、按钮、质押面板全是空的），
    //    而下面那条写着"报价过期"的提示**永远显示不出来** —— 代码在，路径走不到。
    //    这个形状正是这个项目最警惕的:守卫永远不响，于是"没报错"被当成"没问题"。
    //    实测触发:本地链把时间往前推 15 天，重新加载页面（keeper 停摆 24 小时以上同理）。
    vault('maxRedeemable').then((v) => (v === null ? null : uintAt(v))).catch(() => null),
    vault('paused'),
    readUint(current.token, encodeCall(SEL.bond.totalSupply)).catch(() => null),
  ])
  // ⚠️ **必须解码成布尔。** `vault('paused')` 回的是 `'0x000…000'` 这个**字符串**，
  //    而它在 JS 里**恒为真** —— 于是页面每次都认为"已暂停"、所有按钮禁用，
  //    而控制台一条红字都没有（既没抛错，也没走到任何 catch）。
  //    这个 bug 是 tools/app-e2e.js 抓到的，判据是"点一次 Mint，看链上余额动不动"。
  const pax = boolAt(paxHex)
  usdgDecimals = await readUint(USDG, encodeCall(SEL.erc20.decimals)).then(Number)
  bondDecimals = await readUint(current.token, encodeCall(SEL.bond.decimals)).then(Number)

  // ⚠️ 用 pretty 而不是 formatUnits:后者会去掉尾零（1.00000000 → "1"），
  //    而净值这个数**小数位是有意义的** —— 显示成 "1" 看不出它精确到哪一位。
  $('sNav').textContent = (pax ? '⏸ ' : '') + pretty(n.value, DECIMALS.feed, 4) + ' USDG'
  $('sBal').textContent = pretty(bal, bondDecimals, 4) + ' ' + sym()
  $('sUsdg').textContent = pretty(ub, usdgDecimals, 2)
  $('sReserves').textContent = pretty(res, usdgDecimals, 2)
  // 报价过期时读不出来 —— 如实说，而不是印一个 0（0 和"真的赎不了"长得一样）
  $('sMax').textContent = max === null ? '— price stale' : pretty(max, bondDecimals, 4) + ' ' + sym()
  const supply = supplyHex === null ? null : BigInt(supplyHex)
  const reserves = typeof res === 'string' ? BigInt(res) : null
  $('sSupply').textContent = supply === null ? '—' : pretty(supply, bondDecimals, 4) + ' ' + sym()
  let coverage = null
  if (supply !== null && supply > 0n && reserves !== null) {
    coverage = (Number(reserves) / 10 ** usdgDecimals) / (Number(supply) / 10 ** bondDecimals) * 100
  }
  $('sColl').textContent = coverage === null ? '—' : coverage.toFixed(1) + '%'
  $('coverageBox').hidden = false
  $('covPct').textContent = coverage === null ? '—' : coverage.toFixed(1) + '%'
  $('covBar').style.width = Math.min(coverage === null ? 0 : coverage, 100).toFixed(1) + '%'
  $('covBar').className = coverage === null ? '' : (coverage >= 100 ? '' : coverage >= 90 ? 'warn' : 'bad')
  const lockHref = '/locks/create?token=' + current.token + (bal > 0n ? '&amount=' + formatUnits(bal, bondDecimals) : '')
  if ($('lockBond')) $('lockBond').href = lockHref

  const warns = []
  if (pax) warns.push('This bond is <b>paused</b> — mint and redeem are disabled. Nothing else is affected.')
  if (n.stale) warns.push('The price is <b>stale</b> (last update ' + new Date(Number(n.updatedAt) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC). Mint and redeem will revert until the keeper publishes again.')
  if (max !== null && bal > max) warns.push('You hold more bonds than the vault can currently redeem (' + pretty(max, bondDecimals, 4) + '). That is the current USDG reserves in the vault — see below.')
  setNotice(warns.length ? warns.join('<br>') : '')

  $('mintIn').value = ''
  $('redeemIn').value = ''
  $('mintOut').textContent = '—'
  $('redeemOut').textContent = '—'
  $('redeemFee').textContent = ''
  $('mintGo').disabled = pax || n.stale
  $('redeemGo').disabled = pax || n.stale

  // 质押那一段跟着一起刷（NAV 要用来把池子折算成美元口径）
  await refreshStake(n.value)
}

// ── 预览 ──────────────────────────────────────────────────────────────────
async function previewMint() {
  const v = $('mintIn').value.trim()
  $('mintOut').textContent = '—'
  if (!v || !chainOk) return
  try {
    const amount = parseUnits(v, usdgDecimals)
    if (amount === 0n) return
    const out = uintAt(await vault('bondOutFor', [amount]))
    $('mintOut').textContent = pretty(out, bondDecimals, 6)
  } catch (e) { $('mintOut').textContent = '—' }
}

async function previewRedeem() {
  const v = $('redeemIn').value.trim()
  $('redeemOut').textContent = '—'
  $('redeemFee').textContent = ''
  if (!v || !chainOk) return
  try {
    const amount = parseUnits(v, bondDecimals)
    if (amount === 0n) return
    const net = uintAt(await vault('usdgOutFor', [amount]))
    const gross = uintAt(await W.call(current.vault, encodeCall(SEL.vault.price)))
    const feeBps = uintAt(await vault('redeemFeeBps'))
    const g = (amount * gross) / (10n ** 20n)
    const fee = g - net
    // v1.2:经路由赎回时，**在该债券池有质押**的人当场拿回一半手续费。
    // 数字向合约要（`rebateFor`），不在页面里自己乘 50% —— 乘错了没人看得出来。
    let rebate = 0n
    if (router() && account && pairIndex() >= 0) {
      try {
        rebate = uintAt(await W.call(router(), encodeCall(SEL.router.rebateFor,
          [BigInt(pairIndex()), account, amount], ['uint256', 'address', 'uint256'])))
      } catch (e) { rebate = 0n }
    }
    $('redeemOut').textContent = pretty(net, usdgDecimals, 6)
    const parts = []
    if (fee > 0n) parts.push('fee ' + pretty(fee, usdgDecimals, 6) + ' USDG')
    if (rebate > 0n) parts.push(pretty(rebate, usdgDecimals, 6) + ' back — staker rebate')
    $('redeemFee').textContent = parts.length ? '(' + parts.join(' · ') + ')' : ''
  } catch (e) { $('redeemOut').textContent = '—' }
}

// ── 写 ────────────────────────────────────────────────────────────────────
// ⚠️ 状态行这两句是**用户看得见的文案**（页面上其余全英文）—— 原先写的是
//    `提交:` / `已上链`。改字面前先想清楚:**有四个脚本拿这两句话当等待条件**
//    （tools/app-e2e.js、tools/app-mainnet-write.cjs、tools/app-stake-live.cjs、
//    _vid/cap*.js），改这里就必须同步改它们，否则下一轮它们等的是永不出现的字。
async function waitIt(hash, label) {
  status(label + ' submitted: ' + hash)
  await W.waitForReceipt(hash)
  const link = CHAIN.explorer ? ' — <a href="' + CHAIN.explorer + '/tx/' + hash + '" target="_blank" rel="noopener">' + short(hash) + '</a>' : ''
  status(label + ' on-chain' + link)
}

// ⚠️ **空输入不能抛。** 第一版四个动作都是 `parseUnits($(…).value.trim(), …)` 直接写在
//    函数顶上（try 之外）—— 输入框空的时候它抛的是**未捕获的 promise rejection**
//    （onclick 挂的是 async 函数），页面上一条红字都没有、按钮看起来是坏的。
//    实测（2026-10-11 真链）:`Uncaught (in promise) 不是合法的数字: `，栈停在 doRedeem ——
//    那一轮正好撞上 refresh() 在点击之前把输入框清空了。
//    现在空/非法一律回 0n，由调用方给一句提示。
const amountOf = (id, decimals) => {
  const v = $(id).value.trim()
  if (!v) return 0n
  try { return parseUnits(v, decimals) } catch { return 0n }
}

async function doMint() {
  const amount = amountOf('mintIn', usdgDecimals)
  if (amount <= 0n) { status('Enter an amount first.', true); return }
  $('mintGo').disabled = true
  try {
    const allowed = uintAt(await W.call(USDG, encodeCall(SEL.erc20.allowance, [account, current.vault], ['address', 'address'])))
    if (allowed < amount) {
      status('Approving USDG…')
      const h = await W.send(account, USDG, encodeCall(SEL.erc20.approve, [current.vault, (1n << 256n) - 1n], ['address', 'uint256']))
      await waitIt(h, 'Approve')
    }
    const h2 = await W.send(account, current.vault, encodeCall(SEL.vault.mint, [amount]))
    await waitIt(h2, 'Mint')
    await refresh()
  } catch (e) {
    status(W.readableError(e), true)
  } finally {
    $('mintGo').disabled = false
  }
}

async function doRedeem() {
  const amount = amountOf('redeemIn', bondDecimals)
  if (amount <= 0n) { status('Enter an amount first.', true); return }
  $('redeemGo').disabled = true
  try {
    // v1.2:有路由就走路由 —— 折扣（质押者当场返一半手续费）只在它那里发生。
    // 没有路由的部署（v12 之前）退回直连金库，行为和老版本一字不差。
    const viaRouter = router() && pairIndex() >= 0
    if (viaRouter) {
      // 路由要先把债券拉过去 —— 授权对象是**路由**，不是金库。
      // ⚠️ 这两个是不同的 spender:给金库授权过的人，走路由仍会 needs approval。
      const allowed = uintAt(await W.call(current.token,
        encodeCall(SEL.bond.allowance, [account, router()], ['address', 'address'])))
      if (allowed < amount) {
        status('Approving bonds…')
        const ha = await W.send(account, current.token, encodeCall(SEL.bond.approve, [router(), (1n << 256n) - 1n], ['address', 'uint256']))
        await waitIt(ha, 'Approve')
      }
      const h = await W.send(account, router(), encodeCall(SEL.router.redeem, [BigInt(pairIndex()), amount], ['uint256', 'uint256']))
      await waitIt(h, 'Redeem')
    } else {
      const h = await W.send(account, current.vault, encodeCall(SEL.vault.redeem, [amount]))
      await waitIt(h, 'Redeem')
    }
    await refresh()
  } catch (e) {
    const msg = String(e && e.message || e)
    status(/InsufficientReserves/.test(msg)
      ? 'The chain rejected it: not enough reserves. The vault does not hold enough USDG reserves right now — this redemption cannot settle.'
      : W.readableError(e), true)
  } finally {
    $('redeemGo').disabled = false
  }
}

// ── 质押 ──────────────────────────────────────────────────────────────────
//
// 两条奖励流:0 号是 **USDG**（这只债券金库的赎回费），1 号是 **REWARD**（国库注资）。
// 收益率**只按"已经真的打进池子的钱 ÷ 现在真的质押着的量"算** —— 池子是空的、
// 或者预算发完了，显示的就是 0 / not funded。这里不写任何"目标年化"，
// 因为合约里根本没有那个东西:它一分钱都印不出来。
//
// ⚠️ v1.1 起"两条流"读的是 `snapshot()` 的**固定字段**（rateUsdg=第 4 个字、
//    rateReward=第 5 个…）—— 索引不再由调用方传，而是**合约 struct 的字段顺序**。
//    拼错位不会报错，只会显示另一个数（都是合法数字），所以这里按注释逐位对齐。
//    以前那两个 `REWARD_USDG = 0 / REWARD_OAK = 1` 的常量随之下线了。
const SECONDS_PER_YEAR = 31536000

// ⚠️ 两个 helper 分清楚:`sCall` 回**原始 hex**（多返回值要自己按字取），
//    `sRead` 直接把第 0 个字解成 BigInt。
//    第一版只有 `sRead`，而 `readPool` 里又写了一次 `uintAt(st0, 0)` ——
//    对**已经是 BigInt 的东西**再解一次。症状是页面抛
//    「返回值没有第 0 个字」（BigInt 的字符串不够 64 个字符，切不出一个字），
//    而那一下正好落在 `refresh()` 的中途 → 整个质押面板停在 `—`、
//    链上一切正常、控制台一条红字都没有。
const sCall = (fn, args = [], types = []) => W.call(pool(), encodeCall(SEL.staking[fn], args, types))
const sRead = (fn, args = [], types = []) => sCall(fn, args, types).then(uintAt)

async function readPool() {
  if (!pool()) return null
  // v1.1:**一个 `snapshot(account)` 读全**（12 个静态返回值 = 12 个字，按位取）。
  // 这里原来是 12 个 view 拼成的 Promise.all —— 页面的读走用户自己的钱包，
  // 本来就是串行限流的，12 个来回要等好几秒；而且其中任何一个 revert
  // （比如报价过期）都会把整块 UI 掀掉。少一次调用，就少一处能坏的地方。
  // ⚠️ 顺序是**合约 struct 的字段顺序**，改合约要跟着改这里（gen-app 生成的
  //    只有选择器，没有字段名 —— 拼错位不会报错，只会显示另一个数）。
  const hex = await sCall('snapshot', [account], ['address'])
  return {
    total: uintAt(hex, 0),
    mine: uintAt(hex, 1),
    claimU: uintAt(hex, 2),
    claimA: uintAt(hex, 3),
    rateU: uintAt(hex, 4),
    rateA: uintAt(hex, 5),
    queuedU: uintAt(hex, 6),
    queuedA: uintAt(hex, 7),
    // ⚠️ 刚落进池子、还没被 `sync()` 记进账的手续费。用户看得到，
    //    下一次 stake/withdraw/claim 会顺手把它接进流里（都是自动的）。
    unsynced: uintAt(hex, 8),
    unsyncedA: uintAt(hex, 9),
    finishU: uintAt(hex, 10),
  }
}

// ── 跨池（批量合约）───────────────────────────────────────────────────────
// 五个池子的事一次办完的入口。合约地址写死在批量合约里面（见 StakingBatcher.sol），
// 所以页面这里只是"转发一下"。没部署批量合约（BATCHER 为 null）时，
// 整块跨池的 UI 直接不出现 —— 页面照旧可用，只是没有"一共"那几个数。
const bCall = (fn, args = [], types = []) => W.call(BATCHER, encodeCall(SEL.batcher[fn], args, types))

async function readOverview() {
  if (!BATCHER || !account) return null
  const hex = await bCall('overview', [account], ['address'])
  return {
    total: uintAt(hex, 0),
    mine: uintAt(hex, 1),
    claimU: uintAt(hex, 2),
    claimA: uintAt(hex, 3),
    claimablePools: uintAt(hex, 4),
  }
}

/// 年化。**这是"按现在这笔预算、现在这个池子"年化出来的瞬时值**，不是承诺。
/// USDG 那条能算成百分比（两边都是美元口径）;REWARD 那条**只能按"每张债券每年多少枚"**
/// 说 —— REWARD 没有美元计价，把它折算成百分比就是在暗示一个不存在的汇率。
///
/// ⚠️ `decimals` 是**奖励币自己的**小数位，不能省:速率是"最小单位/秒"。
///    6 位的 USDG 少除一个 1e6，年化就差 100 万倍（而它看起来仍然像个正常的百分比）。
function annualise(rate, stake, decimals) {
  if (rate === 0n || stake === 0n) return null
  const perSec = Number(rate) / 1e18 / Math.pow(10, decimals)
  return perSec * SECONDS_PER_YEAR / (Number(stake) / 1e18)
}

function pct(x) { return x === null ? null : (x * 100).toFixed(2) + '%' }

async function refreshStake(navValue) {
  const head = $('stakeHead'), lede = $('stakeLede'), panels = $('stakePanels')
  const stats = $('stakeStats'), fine = $('stakeFine'), pend = $('stakePending')

  if (!pool()) {
    // 这只债券没开质押 —— 明说，而不是画一个按不动的按钮
    head.hidden = false; lede.hidden = true; panels.hidden = true; stats.hidden = true; fine.hidden = true; pend.hidden = true
    head.textContent = 'STAKE'
    pend.hidden = false
    pend.innerHTML = 'Staking is not open for <b>' + current.symbol + '</b> yet.'
    await refreshAll()
    return
  }

  head.hidden = false; lede.hidden = false; panels.hidden = false; stats.hidden = false; fine.hidden = false; pend.hidden = true

  const p = await readPool()
  const tvlUsdg = (Number(p.total) / 1e18) * (Number(navValue) / 1e8)

  // USDG:池子现值是美元口径，所以能算成百分比。
  // ⚠️ **速率是"代币最小单位/秒"，不是"USDG/秒"** —— `rate` 是 `总额(6 位整数) × 1e18 / 周期`。
  //    少除那个 10^decimals 的话年化会正好大 100 万倍（实测 1.22% 显示成 1216666.67%）——
  //    和 BondVault 那条"10¹² 倍"是同一个形状，只是这次错 10⁶。
  //    所以下面**按 decimals 现算**，不写死 1e6。
  const usdgPerSec = Number(p.rateU) / 1e18 / Math.pow(10, usdgDecimals)
  const usdgPerYear = usdgPerSec * SECONDS_PER_YEAR
  const apyU = tvlUsdg > 0 && usdgPerYear > 0 ? usdgPerYear / tvlUsdg : null
  // REWARD:每张债券每年多少枚（不折算成钱 —— 它没有美元计价，
  // 折成百分比就是在暗示一个不存在的汇率）
  const perBondA = annualise(p.rateA, p.total, DECIMALS.reward)

  $('sPool').textContent = pretty(p.total, bondDecimals, 2) + ' ' + sym()
  $('sStaked').textContent = pretty(p.mine, bondDecimals, 4) + ' ' + sym()
  $('sClaim').textContent = pretty(p.claimU, usdgDecimals, 6) + ' USDG + ' + pretty(p.claimA, DECIMALS.reward, 4) + ' OAKEN'
  $('sPendingUsdg').textContent = pretty(p.claimU, usdgDecimals, 6) + ' USDG'
  $('sPendingOaken').textContent = pretty(p.claimA, DECIMALS.reward, 4) + ' OAKEN'
  $('sApyUsdg').textContent = (apyU === null ? 'not funded' : pct(apyU) + ' / yr') +
    (p.queuedU > 0n ? ' · ' + pretty(p.queuedU, usdgDecimals, 6) + ' queued' : '')
  $('sApyAur').textContent = (perBondA === null ? 'not funded' : perBondA.toFixed(4) + ' / bond / yr') +
    (p.queuedA > 0n ? ' · ' + pretty(p.queuedA, DECIMALS.reward, 2) + ' queued' : '')

  $('stakeApy').textContent = apyU === null && perBondA === null
    ? 'no rewards funded yet'
    : (apyU !== null ? pct(apyU) + ' / yr in USDG' : perBondA.toFixed(4) + ' OAKEN / bond / yr')
  $('claimOut').textContent = pretty(p.claimU, usdgDecimals, 6) + ' USDG + ' + pretty(p.claimA, DECIMALS.reward, 4) + ' OAKEN'
  $('stakeIn').value = ''
  $('unstakeIn').value = ''

  // ⚠️ v1.2（2026-10-14）起，"还没进发放流的钱"有**两段**:
  //    赎回费先进**分流器**（金库的 feeRecipient 指着它），拆完才进池子;
  //    进池子之后还要 `sync()` 才算"入账"。只看池子的话，赎回完页面会说
  //    "钱已经到账了"，而它其实还趴在前一段 —— 反方向也一样（只看到池子那半）。
  let unsplit = 0n
  if (V12 && V12.splitters && V12.splitters[current.symbol]) {
    try {
      unsplit = uintAt(await W.call(USDG, encodeCall(SEL.erc20.balanceOf, [V12.splitters[current.symbol]], ['address'])))
    } catch (e) { unsplit = 0n }
  }
  const owedBits = []
  if (unsplit > 0n) owedBits.push('<b>' + pretty(unsplit, usdgDecimals, 6) + ' USDG</b> (sitting in the fee splitter)')
  if (p.unsynced > 0n) owedBits.push('<b>' + pretty(p.unsynced, usdgDecimals, 6) + ' USDG</b>')
  if (p.unsyncedA > 0n) owedBits.push('<b>' + pretty(p.unsyncedA, DECIMALS.reward, 4) + ' OAK</b>')
  if (owedBits.length) {
    pend.hidden = false
    pend.innerHTML = owedBits.join(' and ') + ' has not entered the reward stream yet — a redemption fee arrived. ' +
      'Any stake, unstake or claim folds the pool side in.' +
      (unsplit > 0n ? ' <button class="btn ghost tiny" id="splitGo">Split it</button>' : '') +
      ' <button class="btn ghost tiny" id="syncGo">Sync</button>'
    $('syncGo').onclick = doSync
    if (unsplit > 0n) $('splitGo').onclick = doSplit
  }

  await refreshAll()
}

/// 跨池那一段（批量合约一次读完）。⚠️ **单独走一条路**:它坏了不该把质押面板掀掉 ——
/// 它是附加信息，不是主路径。读不出来时**明说**（'unavailable'），不印 0 ——
/// 0 和"真的没有"长得一模一样（这条规矩这个项目吃过好几次）。
async function refreshAll() {
  const el = $('allStats'), btn = $('claimAllGo')
  // 治理面板跟着一起刷（它和跨池总览一样，都是"多读几处"的只读块）。
  // ⚠️ 不 await 失败就吞 —— 治理读挂了不能连累申赎那几个数。
  refreshGov().catch(() => {})
  refreshGovernance().catch(() => {})
  if (!BATCHER || !account || !chainOk) { el.hidden = true; btn.hidden = true; return }
  let o = null
  try { o = await readOverview() } catch (e) { o = null }
  el.hidden = false
  if (o === null) {
    $('sAllPool').textContent = '—'
    $('sAllMine').textContent = '—'
    $('sAllClaim').textContent = 'unavailable'
    btn.hidden = true
    return
  }
  $('sAllPool').textContent = pretty(o.total, bondDecimals, 2)
  $('sAllMine').textContent = pretty(o.mine, bondDecimals, 4)
  $('sAllClaim').textContent = pretty(o.claimU, usdgDecimals, 6) + ' USDG + ' + pretty(o.claimA, DECIMALS.reward, 4) + ' OAKEN'
  // 只在**真的有东西可领**时才给这个按钮 —— 没东西可领时点它是一笔白花 gas 的空交易，
  // 页面不该提供那个按钮（合约那边 claimAll 也会自己跳过空池子，两边同一条规矩）。
  btn.hidden = o.claimablePools === 0n
  btn.textContent = 'Claim all — ' + o.claimablePools.toString() + (o.claimablePools === 1n ? ' bond has' : ' bonds have') + ' rewards'
}

/// v1.2:把分流器里的费拆开（质押池一半 / 国库一半），再顺手 sync 一下池子 ——
/// 一次点击把"未拆"和"未入账"两段都推干净。`split()` 谁都能叫（合约里就是一道除法）。
async function doSplit() {
  if (!V12 || !V12.splitters || !V12.splitters[current.symbol]) return
  try {
    await waitIt(await W.send(account, V12.splitters[current.symbol], encodeCall(SEL.splitter.split)), 'Split')
    if (pool()) {
      try { await waitIt(await W.send(account, pool(), encodeCall(SEL.staking.sync)), 'Sync') } catch (e) { /* 入账那步失败不影响拆分本身 */ }
    }
    await refresh()
  } catch (e) { status(W.readableError(e), true) }
}

async function doSync() {
  try {
    await waitIt(await W.send(account, pool(), encodeCall(SEL.staking.sync)), 'Sync')
    await refresh()
  } catch (e) { status(W.readableError(e), true) }
}

async function doStake() {
  const amount = amountOf('stakeIn', bondDecimals)
  if (amount <= 0n) { status('Enter an amount first.', true); return }
  $('stakeGo').disabled = true
  try {
    // 授权的是**债券**（质押物），不是 USDG —— 申赎那边授权的是 USDG，别抄错
    const allowed = uintAt(await W.call(current.token, encodeCall(SEL.bond.allowance, [account, pool()], ['address', 'address'])))
    if (allowed < amount) {
      status('Approving the bond…')
      await waitIt(await W.send(account, current.token,
        encodeCall(SEL.bond.approve, [pool(), (1n << 256n) - 1n], ['address', 'uint256'])), 'Approve')
    }
    await waitIt(await W.send(account, pool(), encodeCall(SEL.staking.stake, [amount])), 'Stake')
    await refresh()
  } catch (e) {
    status(W.readableError(e), true)
  } finally {
    $('stakeGo').disabled = false
  }
}

async function doUnstake() {
  const amount = amountOf('unstakeIn', bondDecimals)
  if (amount <= 0n) { status('Enter an amount first.', true); return }
  $('unstakeGo').disabled = true
  try {
    await waitIt(await W.send(account, pool(), encodeCall(SEL.staking.withdraw, [amount])), 'Unstake')
    await refresh()
  } catch (e) {
    const msg = String(e && e.message || e)
    status(/InsufficientStake/.test(msg) ? 'The chain rejected it: that is more than you have staked.' : W.readableError(e), true)
  } finally {
    $('unstakeGo').disabled = false
  }
}

async function doClaim() {
  $('claimGo').disabled = true
  try {
    const p = await readPool()
    if (p.claimU === 0n && p.claimA === 0n) { status('There is nothing to claim right now.'); return }
    await waitIt(await W.send(account, pool(), encodeCall(SEL.staking.getReward)), 'Claim')
    await refresh()
  } catch (e) {
    status(W.readableError(e), true)
  } finally {
    $('claimGo').disabled = false
  }
}

/// 一键全领:**一笔交易**把五只债券上的奖励都领掉（走批量合约的 claimAll）。
/// 钱只会进调用者自己的账 —— 批量合约只是个转发器，见 StakingBatcher.sol。
async function doClaimAll() {
  $('claimAllGo').disabled = true
  try {
    const o = await readOverview()
    if (!o || o.claimablePools === 0n) { status('There is nothing to claim right now.'); return }
    await waitIt(await W.send(account, BATCHER, encodeCall(SEL.batcher.claimAll)), 'Claim all')
    await refresh()
  } catch (e) {
    status(W.readableError(e), true)
  } finally {
    $('claimAllGo').disabled = false
  }
}

/// 全退:解押这只债券的全部质押 + 把两条流的奖励一起领掉（合约里的 `exit()`）。
/// 没有锁定期，所以这一步永远是安全的 —— 一次点击回到"什么都没质押"的状态。
async function doExit() {
  let p = null
  try { p = await readPool() } catch (e) { /* 读不出来也让它去链上试 */ }
  if (p && p.mine === 0n && p.claimU === 0n && p.claimA === 0n) {
    status('Nothing staked and nothing to claim on ' + current.symbol + '.')
    return
  }
  $('exitGo').disabled = true
  try {
    await waitIt(await W.send(account, pool(), encodeCall(SEL.staking.exit)), 'Exit')
    await refresh()
  } catch (e) {
    status(W.readableError(e), true)
  } finally {
    $('exitGo').disabled = false
  }
}

// ── 治理（v1.2，2026-10-14）────────────────────────────────────────────────
//
// 三段:投票权（xOAK 存/取）、提案列表（投票/排队/执行）、新提案。
// 链上的形状（合约见 bond/contracts/Poll.sol、Timelock.sol）:
//   提案 = **一笔具体调用**（target + calldata），不是一句口号;
//   通过 → enqueue 进 Timelock → 等 timelock.delay()（48h）→ 谁都能 execute。
//
// ⚠️ 为什么要有 xOAK 这一层:REWARD 本身**没有检查点**（不是 ERC20Votes），
//    直接按当下余额投票 = "投完立刻转走"能在同一个块里刷票。
//    xOAK 存进去才产生**快照可查**的票（`getPastVotes`），提案那一刻的权重
//    从此不再变。页面上的"你的票"显示的是**提案快照时的权重**，不是当下余额。
//
// ⚠️ 读不到就写 unavailable，别画一个看起来能点的默认值。
const POLL_STATE = ['Active', 'Defeated', 'Succeeded', 'Queued', 'Executed']
const POLL_STATE_CLASS = ['', 'bad', 'good', 'good', 'done']

const xCall = (fn, args = [], types = []) => W.call(V12.xOak, encodeCall(SEL.xOak[fn], args, types))
const pCall = (fn, args = [], types = []) => W.call(V12.poll, encodeCall(SEL.poll[fn], args, types))

async function refreshGov(navValue) {
  const head = $('govHead'), lede = $('govLede')
  if (!V12) { head.hidden = true; lede.hidden = true; $('govPanels').hidden = true; $('govStats').hidden = true; $('govList').hidden = true; return }
  head.hidden = false; lede.hidden = false
  if (!account || !chainOk) { $('govPanels').hidden = true; $('govStats').hidden = true; $('govList').hidden = true; return }
  $('govPanels').hidden = false; $('govStats').hidden = false; $('govList').hidden = false

  // 投票权
  const [xBal, xTotal] = await Promise.all([
    xCall('balanceOf', [account], ['address']).then(uintAt),
    xCall('totalSupply').then(uintAt),
  ])
  $('gMine').textContent = pretty(xBal, DECIMALS.reward, 2) + ' xOAK'
  $('gTotal').textContent = pretty(xTotal, DECIMALS.reward, 2)
  $('gDelay').textContent = (Number(V12.timelockDelaySec) / 3600) + 'h'
  $('gQuorum').textContent = (Number(V12.quorumBps) / 100) + '% of votes'

  // 提案列表（倒序:新的在上面）
  const count = Number(await pCall('proposalCount').then(uintAt))
  const list = $('govList')
  list.innerHTML = ''
  if (!count) {
    list.innerHTML = '<p class="muted">No proposals yet.</p>'
  }
  for (let id = count - 1; id >= 0; id--) {
    let raw
    try { raw = await pCall('proposalAt', [BigInt(id)]) } catch (e) { continue }
    const target = addressAt(raw, 0)
    const data = bytesAt(raw, 1)
    const desc = stringAt(raw, 2)
    const forV = uintAt(raw, 5)
    const againstV = uintAt(raw, 6)
    const eta = uintAt(raw, 7)
    const st = Number(await pCall('state', [BigInt(id)]).then(uintAt))
    const mine = uintAt(await pCall('voted', [BigInt(id), account], ['uint256', 'address']))
    const weight = uintAt(await pCall('weightOf', [BigInt(id), account], ['uint256', 'address']))

    const card = document.createElement('div')
    card.className = 'prop'
    const etaTxt = eta > 0n ? ' · executes after ' + new Date(Number(eta) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : ''
    card.innerHTML =
      '<div class="propTop"><span class="mono propId">#' + id + '</span>' +
      '<span class="mono propState ' + POLL_STATE_CLASS[st] + '">' + POLL_STATE[st] + '</span></div>' +
      '<p class="propDesc">' + escapeHtml(desc) + '</p>' +
      '<p class="fine mono propMeta">' + escapeHtml(target) + ' · ' + escapeHtml(data.slice(0, 10)) + '… · ' +
      pretty(forV, DECIMALS.reward, 0) + ' for / ' + pretty(againstV, DECIMALS.reward, 0) + ' against' + etaTxt + '</p>'
    const actions = document.createElement('div')
    actions.className = 'propActions'
    if (st === 0 && mine === 0n) {
      actions.appendChild(mkBtn('Vote for', 'btn ghost', async () => { await govTx(pCall, 'vote', [BigInt(id), 1n], ['uint256', 'uint8'], 'Vote') }))
      actions.appendChild(mkBtn('Vote against', 'btn ghost', async () => { await govTx(pCall, 'vote', [BigInt(id), 2n], ['uint256', 'uint8'], 'Vote') }))
    }
    if (st === 0) actions.appendChild(mkBtn('weight ' + pretty(weight, DECIMALS.reward, 2), 'btn ghost', null, true))
    if (st === 2) actions.appendChild(mkBtn('Enqueue', 'btn', async () => { await govTx(pCall, 'enqueue', [BigInt(id)], ['uint256'], 'Enqueue') }))
    if (st === 3) actions.appendChild(mkBtn('Execute', 'btn', async () => { await govTx(pCall, 'execute', [BigInt(id)], ['uint256'], 'Execute') }))
    if (actions.children.length) card.appendChild(actions)
    list.appendChild(card)
  }

  // 新提案的预设下拉（填 target+data 用;description 由人写）
  const sel = $('propPreset')
  if (!sel.dataset.filled) {
    sel.dataset.filled = '1'
    for (const b of BONDS) {
      const o = document.createElement('option')
      o.value = b.symbol
      o.textContent = 'set redeem fee — ' + b.symbol
      sel.appendChild(o)
    }
    const oc = document.createElement('option')
    oc.value = '__custom'
    oc.textContent = 'custom (raw target + calldata)'
    sel.appendChild(oc)
    sel.onchange = fillPreset
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function mkBtn(text, cls, onclick, disabled = false) {
  const b = document.createElement('button')
  b.textContent = text
  b.className = cls
  b.disabled = disabled
  b.onclick = onclick
  return b
}

/// 预设:把"改某只债券的赎回费率"编码成 target + calldata。
/// 费率取当前值（不替人做决定）—— 想改多少，人自己在 calldata 里改。
async function fillPreset() {
  const v = $('propPreset').value
  if (v === '__custom') { $('propTarget').value = ''; $('propData').value = ''; return }
  const b = BONDS.find((x) => x.symbol === v)
  if (!b) return
  try {
    const [feeBps, cap] = await Promise.all([
      W.call(b.vault, encodeCall(SEL.vault.redeemFeeBps)).then(uintAt),
      W.call(b.vault, encodeCall(SEL.vault.mintCap)).then(uintAt),
    ])
    const splitter = V12.splitters[b.symbol]
    $('propTarget').value = b.vault
    $('propData').value = encodeCall(SEL.vault.setParams, [feeBps, cap, splitter], ['uint256', 'uint256', 'address'])
    $('propDesc').value = 'Set ' + b.symbol + ' redeem fee to ' + feeBps + ' bps (edit the calldata to change)'
  } catch (e) { status(W.readableError(e), true) }
}

async function govTx(call, fn, args, types, label) {
  try {
    const h = await W.send(account, V12.poll, encodeCall(SEL.poll[fn], args, types))
    await waitIt(h, label)
    await refreshGov()
  } catch (e) { status(W.readableError(e), true) }
}

async function doXDeposit() {
  const amount = amountOf('xIn', DECIMALS.reward)
  if (amount <= 0n) { status('Enter an amount first.', true); return }
  $('xDepGo').disabled = true
  try {
    const allowed = uintAt(await W.call(REWARD, encodeCall(SEL.reward.allowance, [account, V12.xOak], ['address', 'address'])))
    if (allowed < amount) {
      status('Approving OAKEN…')
      const ha = await W.send(account, REWARD, encodeCall(SEL.reward.approve, [V12.xOak, (1n << 256n) - 1n], ['address', 'uint256']))
      await waitIt(ha, 'Approve')
    }
    const h = await W.send(account, V12.xOak, encodeCall(SEL.xOak.deposit, [amount]))
    await waitIt(h, 'Deposit')
    await refreshGov()
  } catch (e) { status(W.readableError(e), true) } finally { $('xDepGo').disabled = false }
}

async function doXWithdraw() {
  const amount = amountOf('xIn', DECIMALS.reward)
  if (amount <= 0n) { status('Enter an amount first.', true); return }
  $('xWitGo').disabled = true
  try {
    const h = await W.send(account, V12.xOak, encodeCall(SEL.xOak.withdraw, [amount]))
    await waitIt(h, 'Withdraw')
    await refreshGov()
  } catch (e) { status(W.readableError(e), true) } finally { $('xWitGo').disabled = false }
}

async function doPropose() {
  const target = $('propTarget').value.trim()
  const data = $('propData').value.trim()
  const desc = $('propDesc').value.trim()
  if (!target || !data || !desc) { status('Proposal needs a target, calldata and a description.', true); return }
  $('propGo').disabled = true
  try {
    // ⚠️ 投的是**这笔调用本身** —— target 和 calldata 直接进链，页面不改一个字。
    const h = await W.send(account, V12.poll, encodeCall(SEL.poll.propose, [target, data, desc], ['address', 'bytes', 'string']))
    await waitIt(h, 'Propose')
    $('propDesc').value = ''
    await refreshGov()
  } catch (e) { status(W.readableError(e), true) } finally { $('propGo').disabled = false }
}

// ── 访客视图（没钱包 / 没连上）────────────────────────────────────────────
//
// 这一页的读**只走 `window.ethereum`**（文件头 ①）—— 没钱包就一个数都读不到，
// 于是没连钱包的人看到的是一整页 `—`（那看起来像坏了）。
// 池子的**公开**数据（总量、两条流的速率、预算余额、NAV）本来就不需要钱包，
// 所以它走**站上自己的**同源端点 `/api/pools` —— worker / serve.js 那边真去链上读，
// 实现只有一份（`tools/lib/pool-api.js`，构建时原样内联进 worker）。
//
// ⚠️ 端点回的是**原始 hex**（池子 12 个字 / NAV 那 5 个字），解码还是用这一页既有的
//    `uintAt` / `intAt` —— 全站只有一份解码实现，端点那边一个字都不解。
// ⚠️ 这块显示的是**池子**的状态，**不是"你的仓位"** —— 后者只有你自己的钱包读得到。
// ⚠️ 读不出来时**明说 unavailable**，不印 0（0 和"真的没有"长得一模一样）。
const visitorState = { data: null, failed: false }

async function loadVisitor() {
  if (account && chainOk) { $('visitor').hidden = true; return }
  try {
    const r = await fetch('/api/pools', { cache: 'no-store' })
    visitorState.data = await r.json()
    visitorState.failed = !r.ok || !visitorState.data || !Array.isArray(visitorState.data.bonds)
  } catch (e) {
    visitorState.data = null
    visitorState.failed = true
  }
  renderVisitor()
}

function renderVisitor() {
  const box = $('visitor')
  if (account && chainOk) { box.hidden = true; return }   // 连上了 —— 那一半是给"读不到链"的人看的
  box.hidden = false
  // 两种"没连上"要分开说（2026-10-12）:**装了钱包但没连**是"点一下连接"，
  // **根本没有钱包**是"你得先有个钱包" —— 后者在手机上多半是"用钱包 App 内置浏览器打开"，
  // 而原来两种都只写一句 "install an EIP-1193 wallet"，手机用户看到等于没说出路。
  $('visitorLede').innerHTML = W.hasWallet()
    ? 'This page talks to the chain <b>through your wallet</b> — connect one to mint, redeem and stake. '
      + 'Below is the <b>public</b> state of the bond, read live from Robinhood Chain.'
    : '<b>No wallet detected.</b> On desktop, install <b>MetaMask</b>, <b>OKX</b> or any EIP-1193 '
      + 'wallet and reload; on a phone, open this page inside your wallet app\'s built-in browser. '
      + 'Below is the <b>public</b> state of the bond, read live from Robinhood Chain — looking needs no wallet.'
  const rows = ['vNav', 'vPool', 'vUsdg', 'vAur', 'vAll', 'vReserves', 'vSupply', 'vCoverage']
  /// 已烧 = 1e9 − 总供应（载荷里那个字）。读不到写 '—'，不印 0。
  const setBurned = (d) => {
    const hex = d && d.rewardSupply
    if (typeof hex !== 'string' || hex.length < 2 + 64) { $('vBurn').textContent = '—'; return }
    const sup = BigInt(hex)
    const total = 10n ** 27n                     // 10 亿 × 1e18
    $('vBurn').textContent = sup >= total ? '0' : pretty(total - sup, DECIMALS.reward, 2) + ' OAKEN'
  }
  if (visitorState.failed || !visitorState.data) {
    for (const id of rows) $(id).textContent = '—'
    setBurned(null)
    $('visitorFine').innerHTML = 'Public bond data is <b>unavailable</b> right now. '
      + 'This does not affect connecting your wallet and using the app.'
    return
  }
  const d = visitorState.data
  const entry = (d.bonds || []).find((b) => b.symbol === current.symbol) || null
  const hasSnap = entry && typeof entry.snapshot === 'string' && entry.snapshot.length >= 2 + 64 * 12
  if (!hasSnap) {
    for (const id of rows) $(id).textContent = '—'
    setBurned(d)
    $('visitorFine').innerHTML = 'No public data for <b>' + current.symbol + '</b> yet'
      + (entry && entry.error ? ' (' + entry.error + ')' : '') + '.'
    return
  }
  const total = uintAt(entry.snapshot, 0)
  const rateU = uintAt(entry.snapshot, 4)
  const queuedA = uintAt(entry.snapshot, 7)
  const finishA = uintAt(entry.snapshot, 10)
  const nav = (entry.round && entry.round.length >= 2 + 64 * 3) ? intAt(entry.round, 1) : null
  const navUpdated = (entry.round && entry.round.length >= 2 + 64 * 4) ? uintAt(entry.round, 3) : null

  $('vNav').textContent = nav === null ? '—' : pretty(nav, DECIMALS.feed, 4) + ' USDG'
  $('vPool').textContent = pretty(total, DECIMALS.bond, 2) + ' a' + current.symbol
  // ⚠️ 年化要**分母**（池子的美元现值）。池子空着就没有分母 —— 那时如实说
  //    "no stakers yet"，而不是印一个除不出来的百分比。
  const tvlUsdg = nav === null ? 0 : (Number(total) / 1e18) * (Number(nav) / 1e8)
  const perSec = Number(rateU) / 1e18 / Math.pow(10, DECIMALS.usdg)
  const apyU = (tvlUsdg > 0 && perSec > 0) ? (perSec * SECONDS_PER_YEAR / tvlUsdg) : null
  $('vUsdg').textContent = rateU === 0n
    ? 'no fees yet'
    : (apyU === null ? 'no stakers yet' : pct(apyU) + ' / yr')
  $('vAur').textContent = queuedA === 0n
    ? 'not funded'
    : pretty(queuedA, DECIMALS.reward, 2) + (finishA > 0n ? ' · until ' + shortDate(finishA) : '')
  // 跨池合计（五个池子的公开总量加起来 —— 本地算，不用再多一个端点字段）
  let all = 0n, missing = 0
  for (const b of d.bonds) {
    if (typeof b.snapshot === 'string' && b.snapshot.length >= 2 + 64) all += uintAt(b.snapshot, 0)
    else missing++
  }
  $('vAll').textContent = all === 0n ? 'nothing staked yet' : pretty(all, DECIMALS.bond, 2)
  const vResv = d.vaultReserves != null ? BigInt(d.vaultReserves) : null
  const vSupply = d.bondSupply != null ? BigInt(d.bondSupply) : null
  $('vReserves').textContent = vResv === null ? '—' : pretty(vResv, DECIMALS.usdg, 2) + ' USDG'
  $('vSupply').textContent = vSupply === null ? '—' : pretty(vSupply, DECIMALS.bond, 4) + ' a' + current.symbol
  const vCov = (vResv !== null && vSupply !== null && vSupply > 0n)
    ? (Number(vResv) / 10 ** DECIMALS.usdg) / (Number(vSupply) / 10 ** DECIMALS.bond) * 100
    : null
  $('vCoverage').textContent = vCov === null ? '—' : vCov.toFixed(1) + '%'
  setBurned(d)

  const asOf = d.at ? new Date(d.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—'
  $('visitorFine').innerHTML = 'Public data read live from Robinhood Chain &mdash; <b>as of ' + asOf + '</b>. '
    + 'Mint, redeem and stake all need your wallet.'
    + (missing ? ' (' + missing + ' pool' + (missing > 1 ? 's' : '') + ' unavailable)' : '')
    + (navUpdated ? ' NAV last published ' + shortDate(navUpdated) + '.' : '')
}

/// 链上时间戳（秒）→ "2026-11-10 14:44 UTC"。只在访客那一块用。
function shortDate(sec) {
  return new Date(Number(sec) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}


// ── 链上历史（构建期快照；连钱包的实时仓位仍走上面的 refresh）────────────
const txHref = (h) => 'https://robinhoodchain.blockscout.com/tx/' + h
const histEmpty = (id, cols) => { const el = $(id); if (el) el.innerHTML = '<tr><td colspan="' + cols + '" class="tr-s">No events yet.</td></tr>' }
async function loadHistory() {
  try {
    const r = await fetch('/api/pools', { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('pools ' + r.status);
    const d = await r.json();
    const h = d.history || {};
    const nav = Array.isArray(h.nav) ? h.nav : [];
    const spark = $('navSparkLine');
    if (spark && nav.length >= 2) {
      const vals = nav.slice().reverse().slice(-40).map((x) => Number(BigInt(x.answer)) / 1e8);
      const min = Math.min(...vals), max = Math.max(...vals);
      const span = Math.max(max - min, 0.0001);
      spark.setAttribute('points', vals.map((v, i) =>
        (i / (vals.length - 1) * 320).toFixed(1) + ',' + (44 - ((v - min) / span) * 40).toFixed(1)).join(' '));
      $('navSpark').style.display = 'block';
    } else if ($('navSpark')) $('navSpark').style.display = 'none';
    const rewards = Array.isArray(h.rewards) ? h.rewards : [];
    const flows = Array.isArray(h.flows) ? h.flows : [];
    $('navHist').innerHTML = nav.length ? nav.map((x) =>
      '<tr><td>#' + x.round + '</td><td class="num">' + pretty(BigInt(x.answer), DECIMALS.feed, 4) + ' USDG</td><td>' + shortDate(x.updatedAt) + '</td></tr>').join('') : '';
    if (!nav.length) histEmpty('navHist', 3);
    $('rewardHist').innerHTML = rewards.length ? rewards.map((x) =>
      '<tr><td>' + (x.index === 0 ? 'USDG' : 'OAKEN') + '</td><td class="num">' + pretty(BigInt(x.amount), x.index === 0 ? DECIMALS.usdg : DECIMALS.reward, 4) + '</td><td>' + shortDate(x.finish) + '</td><td class="job"><a href="' + txHref(x.tx) + '" target="_blank" rel="noopener">' + short(x.tx) + '</a></td></tr>').join('') : '';
    if (!rewards.length) histEmpty('rewardHist', 4);
    $('flowHist').innerHTML = flows.length ? flows.map((x) =>
      '<tr><td>' + (x.kind === 'mint' ? 'Mint' : 'Redeem') + '</td><td class="num">' + pretty(BigInt(x.usdg), DECIMALS.usdg, 4) + '</td><td class="num">' + pretty(BigInt(x.bond), DECIMALS.bond, 4) + '</td><td>' + shortDate(x.at) + '</td><td class="job"><a href="' + txHref(x.tx) + '" target="_blank" rel="noopener">' + short(x.tx) + '</a></td></tr>').join('') : '';
    if (!flows.length) histEmpty('flowHist', 5);
  } catch (e) {
    histEmpty('navHist', 3); histEmpty('rewardHist', 4); histEmpty('flowHist', 5);
    $('historyLede').textContent = 'History is unavailable right now. Positions above are still read from your wallet.';
  }
}


// ── Governance / Timelock ─────────────────────────────────────────────────
// The timelock is deployed with the Safe as proposer/canceller. Until the
// Safe signs the migration batch, admin still points at the Safe; the panel
// says so instead of pretending the timelock is live.
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec))
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  if (d) return d + 'd ' + h + 'h'
  if (h) return h + 'h ' + m + 'm'
  return m + 'm ' + (sec % 60) + 's'
}

function initGovernance() {
  const g = GOVERNANCE
  $('tlSafe').textContent = short(g.safe)
  $('tlSafe').href = g.safeUrl
  $('tlAddr').textContent = short(g.timelock)
  $('tlAddr').href = g.timelockUrl
  $('tlDelay').textContent = (g.timelockDelaySec / 3600) + 'h'
  $('tlRefresh').onclick = () => refreshGovernance(true)
}

async function refreshGovernance(force = false) {
  /* Visitors get a public, build-time snapshot first; a connected wallet then
     refreshes the queue live. The snapshot is regenerated after each queue /
     execute (tools/bonds/snapshot-timelock.mjs) and is labelled as such. */
  let pub = null
  try {
    const r = await fetch('/api/timelock', { cache: 'no-store' })
    if (r.ok) pub = await r.json()
  } catch (e) { /* fall back to the live wallet path below */ }
  if (pub && pub.timelock) {
    $('tlSafe').textContent = short(pub.safe)
    $('tlSafe').href = GOVERNANCE.safeUrl
    $('tlAddr').textContent = short(pub.timelock)
    $('tlAddr').href = GOVERNANCE.timelockUrl
    $('tlDelay').textContent = (Number(pub.delay) / 3600) + 'h'
    $('tlStatus').textContent = pub.status === 'ACTIVE' ? 'ACTIVE · TIMELOCK' : 'MIGRATION PENDING'
    $('tlStatus').className = pub.status === 'ACTIVE' ? 'ok' : 'warn'
    tlProposals = (pub.proposals || []).map((p) => ({ id: p.id, target: p.target, eta: p.eta, data: p.data }))
    renderTimelockProposals()
    const stamp = pub.at ? String(pub.at).slice(0, 16).replace('T', ' ') + ' UTC' : 'build time'
    $('tlNote').innerHTML = 'Public snapshot as of ' + stamp + '. Connect a wallet for the live queue.'
  }
  if (!account || !chainOk) {
    if (!pub) {
      $('tlStatus').textContent = 'CONNECT WALLET'
      $('tlStatus').className = 'warn'
      $('tlList').textContent = 'Connect a wallet to read the Timelock queue.'
    }
    return
  }
  try {
    const admins = await Promise.all([GOVERNANCE.oracle, GOVERNANCE.vault, GOVERNANCE.staking].map((a) =>
      W.call(a, ADMIN_SEL).then((r) => addressAt(r)).catch(() => null)))
    const active = admins.every((a) => a && a.toLowerCase() === GOVERNANCE.timelock.toLowerCase())
    $('tlStatus').textContent = active ? 'ACTIVE · TIMELOCK' : 'MIGRATION PENDING'
    $('tlStatus').className = active ? 'ok' : 'warn'
    $('tlNote').innerHTML = active
      ? 'Live wallet read. NAV and parameter changes execute only after the ' + (GOVERNANCE.timelockDelaySec / 3600) + 'h delay; anyone can execute a queued change once ready.'
      : 'The Timelock is deployed, but the Safe must sign the five-call migration batch before it controls admin. <a href="' + GOVERNANCE.safeUrl + '" target="_blank" rel="noopener">Open the Safe</a>.'
  } catch (e) {
    $('tlStatus').textContent = 'READ FAILED'
    $('tlStatus').className = 'warn'
  }
  try {
    await loadTimelockProposals(force)
    renderTimelockProposals()
  } catch (e) {
    if (!pub) $('tlList').textContent = 'Timelock queue unavailable: ' + String(e.message || e).slice(0, 140)
    else $('tlNote').innerHTML = 'Showing the public snapshot; the live wallet queue is unavailable right now.'
  }
}

async function loadTimelockProposals(force) {
  const latest = await W.blockNumber()
  const stored = Number(localStorage.getItem('oaken.bonds.tl.from') || GOVERNANCE.timelockDeployBlock)
  let from = force ? GOVERNANCE.timelockDeployBlock : stored
  if (!from || from < GOVERNANCE.timelockDeployBlock || from > latest) from = GOVERNANCE.timelockDeployBlock
  const MAX_CHUNKS = 40
  if (latest - from > MAX_CHUNKS * TL_SCAN_CHUNK) from = latest - MAX_CHUNKS * TL_SCAN_CHUNK
  const chunks = []
  for (let b = from; b <= latest; b += TL_SCAN_CHUNK) chunks.push(b)
  const found = new Map()
  // Five concurrent getLogs calls: the first scan covers ~15k blocks in a few
  // seconds instead of one request per 500-block slice. The RPC tolerates this;
  // six or ten also worked in the pool reader.
  for (let i = 0; i < chunks.length; i += 5) {
    const wave = await Promise.all(chunks.slice(i, i + 5).map((b) => W.getLogs(GOVERNANCE.timelock, b, [TL.queuedTopic])))
    for (const logs of wave) for (const log of logs) {
      try {
        const id = log.topics[1]
        const target = addressAt(log.data, 0)
        const eta = Number(uintAt(log.data, 1))
        const data = bytesAt(log.data, 2)
        found.set(id, { id, target, eta, data })
      } catch (e) { /* a malformed or removed log must not kill the list */ }
    }
  }
  /**
   * The log scan only reaches back MAX_CHUNKS × TL_SCAN_CHUNK blocks. A proposal
   * queued earlier than that (the first NAV sat ~70k blocks back) would silently
   * vanish — the connected view said "No pending changes" while the public
   * snapshot still showed it. So keep whatever the snapshot listed and verify
   * every id on-chain: `etaOf(id)` is 0 once it has executed or been cancelled.
   */
  const merged = new Map()
  for (const p of tlProposals) merged.set(p.id, p)
  for (const [id, p] of found) merged.set(id, p)
  const stillQueued = await Promise.all([...merged.keys()].map((id) =>
    W.call(GOVERNANCE.timelock, TL.etaOf + id.slice(2)).then((r) => uintAt(r)).catch(() => null)))
  ;[...merged.keys()].forEach((id, i) => { if (stillQueued[i] === 0n) merged.delete(id) })
  localStorage.setItem('oaken.bonds.tl.from', String(latest + 1))
  tlProposals = [...merged.values()]
}

function renderTimelockProposals() {
  const host = $('tlList')
  if (!tlProposals.length) {
    host.textContent = 'No pending changes.'
    if (tlTimer) { clearInterval(tlTimer); tlTimer = null }
    return
  }
  tlProposals.sort((a, b) => a.eta - b.eta)
  host.innerHTML = tlProposals.map((p) => {
    const sel = p.data.slice(0, 10)
    let label = CALL_LABELS[sel] || 'CONTRACT CALL'
    if (sel === NAV_SELECTOR) {
      try { label = 'NAV UPDATE → ' + pretty(intAt(p.data.slice(10), 0), DECIMALS.feed, 4) + ' USDG' } catch (e) {}
    }
    const target = TARGET_LABELS[p.target.toLowerCase()] || short(p.target)
    const when = new Date(p.eta * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    return '<div class="tlItem" data-eta="' + p.eta + '" data-id="' + p.id + '">'
      + '<div class="t"><b>' + label + '</b><span>' + target + ' · ' + when + '</span></div>'
      + '<div class="meta">id ' + short(p.id) + ' · calldata ' + short(p.data) + '</div>'
      + '<div class="meta">status: <span class="count">—</span></div>'
      + '<button class="btn ghost" type="button" disabled>Execute</button></div>'
  }).join('')
  for (const el of host.querySelectorAll('.tlItem')) {
    const p = tlProposals.find((x) => x.id === el.dataset.id)
    el.querySelector('button').onclick = () => executeTimelock(p)
  }
  updateTimelockCountdowns()
  if (tlTimer) clearInterval(tlTimer)
  tlTimer = setInterval(updateTimelockCountdowns, 1000)
}

function updateTimelockCountdowns() {
  const now = Math.floor(Date.now() / 1000)
  for (const el of document.querySelectorAll('.tlItem')) {
    const eta = Number(el.dataset.eta)
    const count = el.querySelector('.count')
    const btn = el.querySelector('button')
    if (!count) continue
    if (now >= eta) {
      count.textContent = 'READY — anyone can execute'
      count.style.color = 'var(--ok)'
      btn.disabled = false
    } else {
      count.textContent = 'queued — ' + fmtDur(eta - now)
      count.style.color = ''
      btn.disabled = true
    }
  }
}

async function executeTimelock(p) {
  if (!p) return
  if (!account) { connect(); return }
  try {
    status('Executing Timelock proposal…')
    const h = await W.send(account, GOVERNANCE.timelock,
      encodeCall(TL.execute, [p.target, p.data, p.eta], ['address', 'bytes', 'uint256']))
    await waitIt(h, 'Execute')
    await refreshGovernance(true)
  } catch (e) {
    status(W.readableError(e), true)
  }
}

// ── 钱包 ──────────────────────────────────────────────────────────────────
function renderNet() {
  const el = $('net')
  if (!W.hasWallet()) { el.textContent = 'no wallet found'; el.className = 'net'; return }
  if (chainOk) { el.textContent = CHAIN.name + ' · ' + CHAIN_ID; el.className = 'net'; return }
  // ⚠️ **装了钱包但还没连 ≠ 网络不对** —— 这时候根本还没问过它在哪条链上。
  // 第一版两种都写 "wrong network — click connect"，钱包矩阵（tools/app-wallets.js）
  // 一注入 MetaMask 就报红字，看起来像"站不认钱包"。分开说:
  // 没连 → "wallet found · click connect"（中性样式）;连上但链不对 → 才是 wrong network。
  const connected = !!account
  el.textContent = connected ? 'wrong network — click connect' : 'wallet found · click connect'
  el.className = connected ? 'net bad' : 'net'
}

async function connect() {
  if (!W.hasWallet()) {
    setNotice('This page needs an <b>EIP-1193 wallet</b> (MetaMask, Rabby, anything that injects <code>window.ethereum</code>). It talks to the chain only through your wallet — there is no RPC baked into the page.')
    return
  }
  try {
    const accs = await W.connect()
    account = accs[0]
    const id = await W.chainId()
    if (id !== CHAIN_ID) {
      chainOk = false
      renderNet()
      setNotice('Your wallet is on chain <b>' + id + '</b>. Switch to <b>' + CHAIN.name + ' (' + CHAIN_ID + ')</b>.')
      $('connect').textContent = 'Switch network'
      $('connect').onclick = async () => {
        try { await W.switchChain(CHAIN, CHAIN_ID); await connect() } catch (e) { status(W.readableError(e), true) }
      }
      return
    }
    chainOk = true
    renderNet()
    setNotice('')
    $('connect').textContent = short(account)
    $('connect').onclick = null
    await refresh()
  } catch (e) {
    status(W.readableError(e), true)
  }
}

// ── 起 ────────────────────────────────────────────────────────────────────
// 站上那几条债券深链（原站是 `app.etherfuse.com/bonds/EUROB`）在构建时被改写成
// `/app/#EUROB`（见 lib/url-rewrites.js）。所以这里要认这个锚点。
{
  const want = decodeURIComponent(location.hash.replace(/^#/, '')).toUpperCase()
  const hit = BONDS.find((b) => b.symbol === want)
  if (hit) current = hit
}

renderPills()
renderNet()
$('connect').onclick = connect
$('mintIn').oninput = previewMint
$('redeemIn').oninput = previewRedeem
$('mintGo').onclick = doMint
$('redeemGo').onclick = doRedeem
$('stakeGo').onclick = doStake
$('unstakeGo').onclick = doUnstake
$('claimGo').onclick = doClaim
$('claimAllGo').onclick = doClaimAll
$('exitGo').onclick = doExit
$('stakeMax').onclick = async () => { $('stakeIn').value = formatUnits(await tokenBal(account), bondDecimals) }
$('unstakeMax').onclick = async () => { $('unstakeIn').value = formatUnits(await sRead('stakedOf', [account], ['address']), bondDecimals) }
$('mintMax').onclick = async () => { $('mintIn').value = formatUnits(await usdgBal(account), usdgDecimals); previewMint() }
// ── 治理（v1.2）────────────────────────────────────────────────────────────
// ⚠️ V12 为 null（这条链没部署 v1.2）时**不挂**这些 handler —— 留着的话
//    点下去会走到 `V12.xOak` 上抛 TypeError，而页面看起来只是"点了没反应"。
if (V12) {
  $('xDepGo').onclick = doXDeposit
  $('xWitGo').onclick = doXWithdraw
  $('propGo').onclick = doPropose
  $('xMax').onclick = async () => {
    // MAX 两个输入框共用:存入用 REWARD 余额，取出用 xOAK 余额 ——
    // 由焦点在哪个框决定（两个框是同一个 id 前缀，见 HTML 的注释）。
    $('xIn').value = formatUnits(await readUint(REWARD, encodeCall(SEL.reward.balanceOf, [account], ['address'])), DECIMALS.reward)
  }
  $('xMaxW').onclick = async () => {
    $('xIn').value = formatUnits(await xCall('balanceOf', [account], ['address']).then(uintAt), DECIMALS.reward)
  }
}
$('redeemMax').onclick = async () => {
  const max = await vault('maxRedeemable')
  const bal = await tokenBal(account)
  $('redeemIn').value = formatUnits(bal < max ? bal : max, bondDecimals)
  previewRedeem()
}

if (W.hasWallet()) {
  window.ethereum.on && window.ethereum.on('accountsChanged', () => location.reload())
  window.ethereum.on && window.ethereum.on('chainChanged', () => location.reload())
  // 已经授权过的话直接连（不再弹窗）
  // 已经授权过就直接连;没授权（或者没钱包）就先给访客那一块 —— 否则页面是一片 '—'
  W.accounts().then((a) => { a && a.length ? connect() : loadVisitor() })
} else {
  renderNet()
  loadVisitor()
}
initGovernance()
refreshGovernance().catch(() => {})
$('mintTry').onclick = () => { $('mintIn').value = '1'; previewMint() }
loadHistory()
