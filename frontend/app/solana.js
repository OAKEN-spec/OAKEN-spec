// OAKEN 的 Solana 运行时：钱包、RPC、上传、三条写入路径。
//
// 与 `solana-build.js` 的分工：那边只造字节（纯函数、可测试），这边只做网络与钱包
// （会失败、要如实报错）。页面只 import 这一份。
//
// 三条写入路径：
//   1. 自有发射（OAKEN Factory）—— SPL Token + Metaplex，代币没有 mint 权限、没有 owner；
//   2. pump.fun 发射 —— `create_v2`，币进它的曲线，后续买卖在 pump.fun；
//   3. OAKEN Lock —— 我们的 Solana 锁程序（`solana/program/`），已部署主网、Authority none；
//      程序读不到时页面退回 Jupiter Lock，并如实说哪条路在用。
//
// ⚠ 这里**没有模拟数据**：读不到就回 null / 抛错，页面显示 `—` 或错误行。
import { makeSolana, OAKEN_PROGRAM_ID, JUP_LOCK_PROGRAM_ID, JUP_ESCROW_LEN,
  CURVE_SELLABLE, CURVE_RESERVED, CURVE_TOTAL_SUPPLY, CURVE_GRADUATION_LAMPORTS,
  CURVE_PROTOCOL_FEE_RECIPIENT, CURVE_MAX_CREATOR_FEE_BPS, CURVE_TOKEN_DECIMALS,
} from './solana-build.js';
import { makeSns, cleanLabel, NAME_TOKENIZER_ID } from './sns-build.js';
const WEB3 = typeof window !== 'undefined' ? window.solanaWeb3 : null;
export const SOL = {
  name: 'Solana',
  short: 'SOL',
  slug: 'solana',
  family: 'solana',
  id: 'solana',
  native: 'SOL',
  explorer: 'https://solscan.io',
};
export const RPC_URLS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://rpc.ankr.com/solana',
];
export const SOLSCAN = (path = '') => `https://solscan.io${path}`;
export const SOLSCAN_TX = (sig) => `https://solscan.io/tx/${sig}`;
export const SOLSCAN_TOKEN = (mint) => `https://solscan.io/token/${mint}`;

let _rpcUrl = null;
let _conn = null;
let _api = null;

/** 浏览器里必须在页面先加载 `/app/vendor/solana-web3.iife.min.js`。 */
export function available() { return Boolean(WEB3); }

function web3() {
  if (!WEB3) throw new Error('Solana support did not load — reload the page (Ctrl+F5).');
  return WEB3;
}

/** 指令构造器（纯函数那份）。 */
export function api() {
  if (!_api) _api = makeSolana(web3());
  return _api;
}

/** 带超时的 fetch：任何网络调用都有上限（这条是全站的规矩）。 */
function timedFetch(url, opts = {}, ms = 15000) {
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(ms)
    : undefined;
  return fetch(url, { ...opts, signal });
}

/**
 * 上传专用：大 body 的**第一次**请求偶尔被边缘/代理直接掐断（Chrome 报
 * `ERR_CONNECTION_CLOSED`/`Failed to fetch`），同一份 body 重发一次就过。
 * 只在网络层失败时重试；超时（AbortError）不重试。
 */
async function uploadFetch(url, opts = {}, ms = 30000) {
  try {
    return await timedFetch(url, opts, ms);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    await new Promise((r) => setTimeout(r, 400));
    return timedFetch(url, opts, ms);
  }
}

/**
 * 浏览器 → 我们自己的 RPC 代理（`/api/sol/rpc`）。
 *
 * 为什么需要：官方公共 RPC 对带 `Origin` 的浏览器请求回 **403 Access forbidden**
 * （连 getSlot 都一样；服务端/curl 正常）。代理只放行站点用到的方法，交易在浏览器里
 * 签好之后才进去，代理改不了它。
 *
 * 旧部署（没有这条路由）回 404/405 时退回直连，别把版本差变成"Solana 全坏"。
 */
async function rpcFetch(url, opts = {}) {
  const body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body || {});
  try {
    const r = await timedFetch('/api/sol/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: opts.signal,
    }, 25000);
    if (r.status === 404 || r.status === 405) return timedFetch(url, { ...opts, body }, 15000);
    return r;
  } catch {
    return timedFetch(url, { ...opts, body }, 15000);
  }
}

function makeConnection(url) {
  const w = web3();
  return new w.Connection(url, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 45000,
    fetch: rpcFetch,
  });
}

/** 当前 RPC 连接（第一次用的时候挑一个能应答的端点）。 */
export function connection() {
  if (_conn) return _conn;
  _conn = makeConnection(_rpcUrl || RPC_URLS[0]);
  return _conn;
}

/** 起点探测：谁先答应用谁；都不行就用第一个（失败时页面自己会报）。 */
export async function ready() {
  if (_rpcUrl) return _conn;
  for (const url of RPC_URLS) {
    try {
      const c = makeConnection(url);
      const slot = await c.getSlot();
      if (Number.isFinite(slot)) { _rpcUrl = url; _conn = c; return c; }
    } catch { /* 下一个 */ }
  }
  _rpcUrl = RPC_URLS[0];
  _conn = makeConnection(_rpcUrl);
  return _conn;
}

/** 换一个端点重试（读失败时的“Retry”走这里）。 */
export async function rotateRpc() {
  const i = RPC_URLS.indexOf(_rpcUrl || RPC_URLS[0]);
  const next = RPC_URLS[(i + 1) % RPC_URLS.length];
  _rpcUrl = next;
  _conn = makeConnection(next);
  return _conn;
}

/* ── 钱包 ─────────────────────────────────────────────────────────────── */

const WALLET_LS = 'oaken.solwallet';

function injected() {
  if (typeof window === 'undefined') return [];
  const out = [];
  const add = (key, name, p, href) => {
    if (p && p.publicKey !== undefined || (p && typeof p.connect === 'function')) out.push({ key, name, provider: p, href });
  };
  const phantom = window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null);
  add('phantom', 'Phantom', phantom, 'https://phantom.app/');
  const solflare = window.solflare || (window.solana?.isSolflare ? window.solana : null);
  add('solflare', 'Solflare', solflare, 'https://solflare.com/');
  const backpack = window.backpack || (window.solana?.isBackpack ? window.solana : null);
  add('backpack', 'Backpack', backpack, 'https://backpack.app/');
  const glow = window.glow || (window.solana?.isGlow ? window.solana : null);
  add('glow', 'Glow', glow, 'https://glow.app/');
  if (!out.length && window.solana && typeof window.solana.connect === 'function') {
    add('injected', 'Browser wallet', window.solana, '');
  }
  // 去重（同一个 provider 可能同时挂在 window.solana 和 window.phantom.solana 上）
  const seen = new Set();
  return out.filter((w) => { if (seen.has(w.provider)) return false; seen.add(w.provider); return true; });
}

export function wallets() { return injected(); }

function pickProvider(key) {
  const list = injected();
  if (!key) return list[0] || null;
  return list.find((w) => w.key === key) || list[0] || null;
}

const listeners = new Map();
export function onSolWallet(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt)?.delete(fn);
}
function emit(evt, value) { for (const fn of listeners.get(evt) || []) { try { fn(value); } catch { /* 页面自己的错 */ } } }

let _active = null;   // { key, name, provider }
let _address = null;

export function address() { return _address; }

function setAddress(a) {
  const next = a ? String(a) : null;
  if (next === _address) return;
  _address = next;
  emit('accounts', next);
}

/** 恢复上次连接（只读，不弹窗）。 */
export async function restore() {
  const key = (() => { try { return localStorage.getItem(WALLET_LS); } catch { return null; } })();
  const w = pickProvider(key);
  if (!w || !key) return null;
  try {
    const res = await w.provider.connect({ onlyIfTrusted: true });
    const pk = res?.publicKey || w.provider.publicKey;
    if (!pk) return null;
    _active = w;
    setAddress(pk.toBase58 ? pk.toBase58() : String(pk));
    bind(w.provider);
    return _address;
  } catch { return null; }
}

function bind(provider) {
  if (!provider || provider.__oakenBound) return;
  provider.__oakenBound = true;
  provider.on?.('accountChanged', (pk) => {
    setAddress(pk ? (pk.toBase58 ? pk.toBase58() : String(pk)) : null);
  });
  provider.on?.('disconnect', () => { _active = null; setAddress(null); emit('disconnect'); });
}

/** 连接（会弹钱包）。`key` 来自 `wallets()`。 */
export async function connect(key = null) {
  const w = pickProvider(key);
  if (!w) {
    const err = new Error('No Solana wallet found in this browser. Install Phantom or Solflare, then reload.');
    err.code = 'NO_SOL_WALLET';
    throw err;
  }
  const res = await w.provider.connect();
  const pk = res?.publicKey || w.provider.publicKey;
  if (!pk) throw new Error('The wallet connected but returned no address — try again.');
  _active = w;
  try { localStorage.setItem(WALLET_LS, w.key); } catch { /* private mode */ }
  bind(w.provider);
  setAddress(pk.toBase58 ? pk.toBase58() : String(pk));
  return _address;
}

export async function disconnect() {
  try { await _active?.provider?.disconnect?.(); } catch { /* 钱包自己可能不实现 */ }
  _active = null;
  setAddress(null);
  try { localStorage.removeItem(WALLET_LS); } catch { /* private mode */ }
}

/** 人类可读的钱包错误（4001/用户拒绝/余额不足/区块哈希过期）。 */
export function humanize(e) {
  const msg = String(e?.message || e || '');
  if (/User rejected|rejected the request|4001/i.test(msg)) return 'You rejected the request in your wallet.';
  if (/insufficient|0x1$/i.test(msg)) return 'Not enough SOL to pay the network fee and rent for this transaction.';
  if (/blockhash|not confirmed|expired/i.test(msg)) return 'The network took too long to confirm — nothing was lost. Try again.';
  if (/no record of a prior credit|AccountNotFound/i.test(msg)) return 'That wallet has no SOL yet — it needs a little SOL for fees.';
  if (/already in use|already initialized/i.test(msg)) return 'That account already exists on-chain.';
  if (/Simulation failed|Transaction simulation failed/i.test(msg)) return msg.replace(/^.*?Simulation failed[:\s]*/i, 'The chain refused it: ').slice(0, 220);
  return msg.slice(0, 240) || 'The wallet returned an unknown error.';
}

/* ── 读链 ─────────────────────────────────────────────────────────────── */

export async function balance() {
  if (!_address) return null;
  const c = await ready();
  return c.getBalance(api().web3.PublicKey ? new (api().web3.PublicKey)(_address) : _address);
}

export function lamportsToSol(v) { return Number(v || 0) / 1e9; }

/** "0.01" → 10000000n。只接受非负十进制；超过 9 位小数直接拒绝（不静默截断）。 */
export function solToLamports(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || !/^\d*\.?\d*$/.test(s) || s === '.') throw new Error('That is not an amount.');
  const [a, b = ''] = s.split('.');
  if (b.length > 9) throw new Error('SOL has at most 9 decimal places.');
  return BigInt((a || '0') + b.padEnd(9, '0'));
}

export function shortAddr(a, n = 4) {
  if (!a) return '—';
  return `${a.slice(0, n)}…${a.slice(-4)}`;
}

/** SOL/USD 现价。拿不到就 null（页面写 `—`，不编一个数）。 */
export async function solPriceUsd() {
  for (const url of [
    'https://api.coinbase.com/v2/prices/SOL-USD/spot',
    'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
  ]) {
    try {
      const r = await timedFetch(url, { headers: { accept: 'application/json' } }, 8000);
      if (!r.ok) continue;
      const j = await r.json();
      const v = Number(j?.data?.amount ?? j?.solana?.usd);
      if (Number.isFinite(v) && v > 0) return v;
    } catch { /* 下一个 */ }
  }
  return null;
}

/* ── SNS 名字解析 ────────────────────────────────────────────────────────
 *
 * 页面上的受益人/接收地址可以直接填 `alice.sns`。顺序照 SNS：
 * tokenized owner（NFT 持有人）→ SOL record → 注册表 owner。
 * 只处理 `.sns` / `.sol` 后缀；普通地址返回 `null`，调用方保持原值。
 */
export function isSolanaAddress(v) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(v || '').trim());
}

export async function resolveName(input) {
  const raw = String(input || '').trim();
  if (!/\.(sns|sol)$/i.test(raw)) return null;
  const clean = cleanLabel(raw);
  if (clean.error) throw new Error(clean.error);
  const w = web3();
  const Sn = makeSns(w);
  const c = await ready();
  const key = Sn.nameAccount(clean.label);
  const info = await c.getAccountInfo(key);
  if (!info) throw new Error('No ' + clean.label + '.sns name is registered.');
  const reg = Sn.decodeRegistry(info.data);
  let owner = reg.owner;
  let tokenized = false;
  if (owner === NAME_TOKENIZER_ID) {
    tokenized = true;
    const mint = Sn.domainMint(key);
    const mintInfo = await c.getAccountInfo(mint).catch(() => null);
    if (mintInfo) {
      const largest = await c.getTokenLargestAccounts(mint).catch(() => null);
      const acct = largest?.value?.[0]?.address;
      if (acct) {
        const ai = await c.getAccountInfo(new w.PublicKey(acct)).catch(() => null);
        if (ai && ai.data.length >= 64) owner = new w.PublicKey(ai.data.subarray(32, 64)).toBase58();
      }
    }
  }
  let source = 'registry owner';
  let address = owner;
  try {
    const recInfo = await c.getAccountInfo(Sn.recordAccount(clean.label, 'SOL'));
    if (recInfo) {
      const rec = Sn.decodeRecord(recInfo.data);
      if (rec.content && rec.content.length === 32) {
        address = new w.PublicKey(rec.content).toBase58();
        source = 'SOL record';
      }
    }
  } catch { /* no SOL record */ }
  return { address, name: clean.label, source, owner, tokenized };
}

export async function programLive() {
  try {
    const c = await ready();
    const info = await c.getAccountInfo(new (api().web3.PublicKey)(OAKEN_PROGRAM_ID));
    return Boolean(info && info.executable);
  } catch { return false; }
}

/** 读一个 mint 的精度/供应量（SPL 字节，不依赖额外库）。 */
export async function readMint(mint) {
  const c = await ready();
  return api().readMint(c, mint);
}

/** Metaplex 里的 name/symbol/uri。 */
export async function readMetadata(mint) {
  const c = await ready();
  return api().readMetadata(c, mint);
}

/** 某个钱包在一个 mint 下的余额（base units 字符串）。没有账户就是 '0'。 */
export async function tokenBalance(mint, owner = _address) {
  if (!owner) return '0';
  const c = await ready();
  const A = api();
  const [address] = A.ata(new (web3().PublicKey)(owner), new (web3().PublicKey)(String(mint)));
  try {
    const r = await c.getTokenAccountBalance(address, 'confirmed');
    return String(r?.value?.amount ?? '0');
  } catch { return '0'; }
}

/** 集群的当前时间（Unix 秒）。读不到就用本机时间，并让页面标注。 */
export async function clusterNow() {
  try {
    const c = await ready();
    const slot = await c.getSlot('confirmed');
    const t = await c.getBlockTime(slot);
    if (Number.isFinite(t)) return { now: Number(t), local: false };
  } catch { /* 落到本机时钟 */ }
  return { now: Math.floor(Date.now() / 1000), local: true };
}

/** 我名下的锁：先读计数器，再逐把读 PDA（最多 200 把，避免一页打爆 RPC）。 */
export async function myLocks(who = _address, { cap = 200 } = {}) {
  if (!who) return [];
  const c = await ready();
  const A = api();
  const next = await A.readNextId(c);
  const n = Math.min(next, cap);
  const ids = Array.from({ length: n }, (_, i) => i);
  const out = [];
  for (let i = 0; i < ids.length; i += 12) {
    const slice = ids.slice(i, i + 12);
    const rows = await Promise.all(slice.map(async (id) => {
      try {
        const l = await A.readLock(c, id);
        if (!l) return null;
        if (String(l.creator) !== String(who) && String(l.beneficiary) !== String(who)) return null;
        return l;
      } catch { return null; }
    }));
    out.push(...rows.filter(Boolean));
  }
  return out.sort((a, b) => Number(b.id) - Number(a.id));
}

/** 一把锁 + 代币信息 + 可领数量。 */
export async function lockDetail(id) {
  const c = await ready();
  const A = api();
  const l = await A.readLock(c, id);
  if (!l) return null;
  const [mintInfo, meta] = await Promise.all([
    A.readMint(c, l.mint).catch(() => null),
    A.readMetadata(c, l.mint).catch(() => null),
  ]);
  const now = Math.floor(Date.now() / 1000);
  return { ...l, mintInfo, meta, claimable: A.claimable(l, now), now };
}

/* ── 上传（图片 + 元数据）──────────────────────────────────────────── */

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || '').replace(/^data:[^;]+;base64,/, ''));
    r.onerror = () => reject(new Error('Could not read that file.'));
    r.readAsDataURL(file);
  });
}

/** 图片 → `/i/<id>.<ext>` 的绝对 URL。复用站点已有的图床。 */
export async function uploadImage(file) {
  if (!file) return null;
  if (file.size > 3 * 1024 * 1024) throw new Error('Image is over 3 MB — pick a smaller one.');
  const type = file.type;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) throw new Error('Use PNG, JPEG, WebP or GIF.');
  const data = await fileToBase64(file);
  const r = await uploadFetch('/api/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    /* Solana 的元数据（pump.fun / Metaplex）由别人的索引器直接取，必须是公开地址；
       本地站点据此把图同时存一份到线上图床（服务端会返回 absolute）。 */
    body: JSON.stringify({ data, type, public: true }),
  }, 30000);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.url) throw new Error(j?.error || 'Image upload failed.');
  return j.absolute || new URL(j.url, location.origin).toString();
}

/** 元数据 JSON → `/m/<id>.json` 的绝对 URL（自有工厂和 pump 都吃这个 URI）。 */
export async function uploadMetadata(meta) {
  const r = await uploadFetch('/api/meta', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...meta, public: true }),
  }, 30000);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.url) throw new Error(j?.error || 'Metadata upload failed.');
  return { uri: j.absolute || new URL(j.url, location.origin).toString(), id: j.id || null };
}

/* ── 发交易 ───────────────────────────────────────────────────────────── */

function latest(conn) {
  return conn.getLatestBlockhash('confirmed');
}

/**
 * 签并发一笔。`signers` 是本地 Keypair（例如新 mint 的 keypair）；
 * 钱包自己的签名由 provider 加。
 */
export async function send(instructions, { signers = [], units = 400000, microLamports = 20000, onStep } = {}) {
  const w = web3();
  const A = api();
  if (!_address || !_active) throw Object.assign(new Error('Connect a Solana wallet first.'), { code: 'NO_WALLET' });
  const c = await ready();
  onStep?.('building');
  const tx = new w.Transaction();
  const budget = A.budgetIxs({ units, microLamports });
  for (const ix of [...budget, ...instructions]) tx.add(ix);
  tx.feePayer = new w.PublicKey(_address);
  const bh = await latest(c);
  tx.recentBlockhash = bh.blockhash;
  for (const s of signers) tx.partialSign(s);
  onStep?.('signing');
  const provider = _active.provider;
  let signed;
  if (typeof provider.signTransaction === 'function') {
    signed = await provider.signTransaction(tx);
  } else if (typeof provider.signAndSendTransaction === 'function') {
    // 少数钱包只有这个；它自己发，我们只等确认
    onStep?.('sending');
    const res = await provider.signAndSendTransaction(tx);
    const sig = res?.signature || res;
    await confirm(c, sig);
    onStep?.('done', sig);
    return sig;
  } else {
    throw new Error('This wallet cannot sign transactions in the browser.');
  }
  onStep?.('sending');
  const sig = await c.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });
  onStep?.('sent', sig);
  await confirm(c, sig);
  onStep?.('done', sig);
  return sig;
}

async function confirm(conn, sig) {
  /**
   * 用 **轮询 `getSignatureStatuses`**，不用 `connection.confirmTransaction`：
   * 后者（web3 1.99）默认走 WebSocket 订阅，而公共 RPC 的 ws 端点经常被代理/网络挡掉 ——
   * 表现是交易已经上链、页面永远停在 "waiting for the block…"。轮询只走 HTTP，和别处一致。
   */
  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const r = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const s = r?.value?.[0];
      last = s || last;
      if (s?.err) throw new Error(`The transaction failed on-chain: ${JSON.stringify(s.err).slice(0, 160)}`);
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return;
      if (s && s.confirmations === null && !s.err) return;   // 老 RPC 对 finalized 的写法
    } catch (e) {
      if (/failed on-chain/.test(String(e?.message))) throw e;
      // 读状态失败就再试一轮；不把网络抖动当成交易失败
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error('The transaction was sent but not confirmed within 90 seconds. Check the signature on Solscan before retrying — it may still land.');
}

/* ── 自有发射 ─────────────────────────────────────────────────────────── */

/**
 * OAKEN Factory（Solana）：固定供应、无 owner、无 mint 权限。
 *
 * 两步：
 *   tx1 建 mint + 用户 ATA + 铸全部供应；
 *   tx2 写 Metaplex 元数据 + 永久吊销 mint 权限 + 一段 memo。
 * 拆两步的原因很朴素：一条 legacy 交易只有 1232 字节，建账户和写元数据塞在一起
 * 会超；拆开还让失败时停在"币已建、元数据没写"这种可重试的位置，而不是全回滚。
 */
export async function launchOwn({
  name, symbol, decimals = 6, supply, imageUrl = '', imageFile = null,
  description = '', website = '', twitter = '', telegram = '',
  onStep,
}) {
  if (!_address) throw Object.assign(new Error('Connect a Solana wallet first.'), { code: 'NO_WALLET' });
  const w = web3();
  const A = api();
  const c = await ready();
  const nm = String(name || '').trim();
  const sy = String(symbol || '').trim().toUpperCase();
  if (!nm || nm.length > 32) throw new Error('Name must be 1–32 characters.');
  if (!sy || sy.length > 10) throw new Error('Symbol must be 1–10 characters.');
  const dec = Number(decimals);
  if (![6, 9].includes(dec)) throw new Error('Decimals must be 6 or 9.');
  const whole = Number(supply);
  if (!(whole > 0) || !Number.isFinite(whole)) throw new Error('Supply must be a positive number.');
  const amount = BigInt(Math.round(whole * 10 ** dec));
  if (amount <= 0n || amount > 2n ** 64n - 1n) throw new Error('Supply is out of range.');

  onStep?.('upload');
  let image = String(imageUrl || '').trim();
  if (imageFile) image = await uploadImage(imageFile);
  const meta = {
    name: nm, symbol: sy, description: String(description || '').slice(0, 1000),
    image, website: website || '', twitter: twitter || '', telegram: telegram || '',
    showName: true, createdOn: 'oaken.one', standard: 'SPL',
  };
  const { uri } = await uploadMetadata(meta);

  const mintKp = w.Keypair.generate();
  const mint = mintKp.publicKey;
  const owner = new w.PublicKey(_address);
  const userAta = A.ata(owner, mint)[0];
  const rent = await c.getMinimumBalanceForRentExemption(82);

  onStep?.('create');
  const tx1 = [
    A.createMintAccountIx({ payer: owner, mint, lamports: rent }),
    A.initializeMint2Ix({ mint, decimals: dec, mintAuthority: owner }),
    A.createAtaIdempotentIx({ payer: owner, address: userAta, owner, mint }),
    A.mintToIx({ mint, destination: userAta, authority: owner, amount }),
  ];
  const sig1 = await send(tx1, { signers: [mintKp], units: 300000, microLamports: 30000, onStep });

  onStep?.('metadata');
  const [metadata] = A.metadataPda(mint);
  const tx2 = [
    A.createMetadataV3Ix({
      metadata, mint, mintAuthority: owner, payer: owner, updateAuthority: owner,
      name: nm, symbol: sy, uri, isMutable: false,
    }),
    A.setAuthorityIx({ mint, currentAuthority: owner, authorityType: 0, newAuthority: null }),
    A.memoIx(`OAKEN Factory · ${sy} · fixed supply · no mint authority`),
  ];
  let sig2 = null;
  let metadataError = null;
  try {
    sig2 = await send(tx2, { units: 300000, microLamports: 30000, onStep });
  } catch (e) {
    metadataError = humanize(e);
  }

  return {
    family: 'solana', route: 'own', mint: mint.toBase58(), name: nm, symbol: sy,
    decimals: dec, supply: amount.toString(), uri,
    signature: sig1, metadataSignature: sig2,
    metadataError, readOnlyMint: false,
  };
}

/* ── pump.fun ─────────────────────────────────────────────────────────── */

/**
 * pump.fun 发射：一条 `create_v2`。币的后续买卖、毕业、费用都由 pump.fun 的
 * 程序/曲线负责；我们只把"创建"这一笔编码对。
 *
 * `buyLamports > 0` 时，**同一笔交易**里再加一条 `buy_exact_quote_in_v3`：
 * 先建 mint → 建用户的 Token-2022 ATA → 用固定数量的 SOL 首买。这样创建和首买
 * 之间没有空档（否则会被夹在中间买走），而且任何一步失败整笔回滚。
 */
export async function launchPump({
  name, symbol, imageUrl = '', imageFile = null, description = '',
  website = '', twitter = '', telegram = '', buyLamports = 0n, onStep,
}) {
  if (!_address) throw Object.assign(new Error('Connect a Solana wallet first.'), { code: 'NO_WALLET' });
  const w = web3();
  const A = api();
  const nm = String(name || '').trim();
  const sy = String(symbol || '').trim().toUpperCase();
  if (!nm || nm.length > 32) throw new Error('Name must be 1–32 characters.');
  if (!sy || sy.length > 10) throw new Error('Symbol must be 1–10 characters.');
  if (buyLamports < 0n) throw new Error('The buy amount cannot be negative.');

  onStep?.('upload');
  let image = String(imageUrl || '').trim();
  if (imageFile) image = await uploadImage(imageFile);
  const { uri } = await uploadMetadata({
    name: nm, symbol: sy, description: String(description || '').slice(0, 1000),
    image, website: website || '', twitter: twitter || '', telegram: telegram || '',
    showName: true, createdOn: 'pump.fun',
  });

  const mintKp = w.Keypair.generate();
  const owner = new w.PublicKey(_address);
  const ixs = [A.pumpCreateV2Ix({ mint: mintKp.publicKey, user: owner, name: nm, symbol: sy, uri })];
  if (buyLamports > 0n) {
    /* buy_exact_quote_in_v3 要求用户的 base ATA 已存在；create_v2 不会建它。 */
    ixs.push(A.createAtaIdempotentIx({
      payer: owner,
      address: A.ata(owner, mintKp.publicKey, A.token2022)[0],
      owner,
      mint: mintKp.publicKey,
      tokenProgram: A.token2022,
    }));
    ixs.push(A.pumpBuyExactQuoteV3Ix({ mint: mintKp.publicKey, user: owner, quoteIn: buyLamports }));
  }
  onStep?.('create');
  const sig = await send(ixs, { signers: [mintKp], units: buyLamports > 0n ? 600000 : 300000, microLamports: 50000, onStep });
  return {
    family: 'solana', route: 'pump', mint: mintKp.publicKey.toBase58(), name: nm, symbol: sy,
    uri, signature: sig, buyLamports: buyLamports.toString(),
  };
}

/* ── OAKEN Curve（Solana）──────────────────────────────────────────────── */

function curveHuman(raw, decimals = CURVE_TOKEN_DECIMALS, maxFrac = 2) {
  const n = Number(raw) / 10 ** Number(decimals);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
  return n.toLocaleString('en-US', { maximumFractionDigits: Math.max(maxFrac, 4) });
}

/** The program is built and tested but not deployed; the page must say so. */
export async function solanaCurveLive() {
  try {
    const c = await ready();
    return await api().curveProgramLive(c);
  } catch { return false; }
}

export async function curveInfo(curveAddress) {
  const w = web3();
  const A = api();
  const c = await ready();
  const deployed = await A.curveProgramLive(c);
  if (!deployed) return { deployed: false, address: String(curveAddress || '') };
  const state = await A.readCurve(c, curveAddress);
  if (!state) throw new Error('No account at that address on Solana.');
  const mintKey = new w.PublicKey(state.mint);
  const [mintInfo, meta] = await Promise.all([
    A.readMint(c, mintKey).catch(() => null),
    A.readMetadata(c, mintKey).catch(() => null),
  ]);
  const decimals = mintInfo?.decimals ?? CURVE_TOKEN_DECIMALS;
  const sold = state.realToken <= CURVE_SELLABLE ? CURVE_SELLABLE - state.realToken : 0n;
  const soldPct = CURVE_SELLABLE > 0n ? Number((sold * 1_000_000n) / CURVE_SELLABLE) / 10_000 : 0;
  let balance = null;
  if (_address) {
    try {
      const r = await c.getTokenAccountBalance(A.ata(new w.PublicKey(_address), mintKey)[0]);
      balance = BigInt(r.value.amount);
    } catch { balance = null; }
  }
  const supply = mintInfo?.supply ?? CURVE_TOTAL_SUPPLY;
  return {
    deployed: true,
    ...state,
    mintInfo,
    meta,
    decimals,
    name: meta?.name || 'OAKEN Curve token',
    symbol: meta?.symbol || 'TOKEN',
    totalSupply: supply,
    totalSupplyHuman: curveHuman(supply, decimals, 2),
    reservedHuman: curveHuman(CURVE_RESERVED, decimals, 2),
    sellableHuman: curveHuman(CURVE_SELLABLE, decimals, 2),
    sold,
    soldHuman: curveHuman(sold, decimals, 2),
    soldPct,
    soldPctFormatted: soldPct.toFixed(2) + '%',
    raiseSol: Number(state.realSol) / 1e9,
    raiseSolFormatted: (Number(state.realSol) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 }),
    thresholdSol: Number(CURVE_GRADUATION_LAMPORTS) / 1e9,
    thresholdSolFormatted: (Number(CURVE_GRADUATION_LAMPORTS) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 }),
    status: state.graduated ? 'graduated' : state.completed ? 'ready' : 'curve',
    statusLabel: state.graduated ? 'Graduated' : state.completed ? 'Ready to graduate' : 'On the curve',
    balance,
    balanceHuman: balance == null ? null : curveHuman(balance, decimals, 4),
    solVault: A.curveSolVault(mintKey)[0].toBase58(),
    pumpAuthority: A.curvePumpAuthority(mintKey)[0].toBase58(),
    owner: _address,
  };
}

/** Launch on the OAKEN Curve in one transaction: mint + metadata + optional first buy. */
export async function launchCurve({
  name, symbol, description = '', imageUrl = '', imageFile = null,
  creatorFeeBps = 5, buyLamports = 0n, onStep,
}) {
  if (!_address) throw Object.assign(new Error('Connect a Solana wallet first.'), { code: 'NO_WALLET' });
  const w = web3();
  const A = api();
  if (!(await solanaCurveLive())) {
    throw new Error('The OAKEN Curve program is not deployed on mainnet yet. Nothing was sent.');
  }
  const nm = String(name || '').trim();
  const sy = String(symbol || '').trim().toUpperCase();
  if (!nm || nm.length > 32) throw new Error('Name must be 1–32 characters.');
  if (!sy || sy.length > 10) throw new Error('Symbol must be 1–10 characters.');
  const fee = Number(creatorFeeBps);
  if (!Number.isInteger(fee) || fee < 0 || fee > CURVE_MAX_CREATOR_FEE_BPS) {
    throw new Error(`Creator fee must be 0–${CURVE_MAX_CREATOR_FEE_BPS} bps.`);
  }

  onStep?.('upload');
  let image = String(imageUrl || '').trim();
  if (imageFile) image = await uploadImage(imageFile);
  const { uri } = await uploadMetadata({
    name: nm, symbol: sy, description: String(description || '').slice(0, 1000),
    image, showName: true, createdOn: 'oaken.one', standard: 'SPL',
  });

  const mintKp = w.Keypair.generate();
  const owner = new w.PublicKey(_address);
  const protocol = new w.PublicKey(CURVE_PROTOCOL_FEE_RECIPIENT);
  const ixs = [A.createCurveWithMetadataIx({
    creator: owner,
    mint: mintKp.publicKey,
    protocolFeeRecipient: protocol,
    creatorFeeRecipient: owner,
    creatorFeeBps: fee,
    name: nm,
    symbol: sy,
    uri,
  })];
  const firstBuy = BigInt(buyLamports || 0n);
  if (firstBuy > 0n) {
    const ownerAta = A.ata(owner, mintKp.publicKey)[0];
    ixs.push(A.createAtaIdempotentIx({
      payer: owner, address: ownerAta, owner, mint: mintKp.publicKey,
    }));
    ixs.push(A.curveBuyIx({
      buyer: owner,
      mint: mintKp.publicKey,
      buyerAta: ownerAta,
      protocolFeeRecipient: protocol,
      creatorFeeRecipient: owner,
      amountIn: firstBuy,
      minTokensOut: 0n,
    }));
  }
  onStep?.('create');
  const sig = await send(ixs, {
    signers: [mintKp],
    units: firstBuy > 0n ? 800_000 : 600_000,
    microLamports: 50_000,
    onStep,
  });
  return {
    family: 'solana', route: 'curve',
    mint: mintKp.publicKey.toBase58(),
    curve: A.curvePda(mintKp.publicKey)[0].toBase58(),
    name: nm, symbol: sy, uri,
    buyLamports: firstBuy.toString(),
    signature: sig,
  };
}

export async function curveBuy({ curve, lamports, minTokensOut = 0n, onStep }) {
  if (!_address) throw Object.assign(new Error('Connect a Solana wallet first.'), { code: 'NO_WALLET' });
  const w = web3();
  const A = api();
  const c = await ready();
  const state = await A.readCurve(c, curve);
  if (!state) throw new Error('No curve at that address on Solana.');
  if (state.graduated || state.completed) throw new Error('The curve is complete; there is nothing left to buy.');
  const amount = BigInt(lamports);
  if (amount <= 0n) throw new Error('Enter an amount first.');
  const owner = new w.PublicKey(_address);
  const mintKey = new w.PublicKey(state.mint);
  const buyerAta = A.ata(owner, mintKey)[0];
  return send([
    A.createAtaIdempotentIx({ payer: owner, address: buyerAta, owner, mint: mintKey }),
    A.curveBuyIx({
      buyer: owner,
      mint: mintKey,
      buyerAta,
      protocolFeeRecipient: new w.PublicKey(state.protocolFeeRecipient),
      creatorFeeRecipient: new w.PublicKey(state.creatorFeeRecipient),
      amountIn: amount,
      minTokensOut: BigInt(minTokensOut || 0n),
    }),
  ], { units: 350_000, microLamports: 50_000, onStep });
}

export async function curveSell({ curve, amount, minSolOut = 0n, onStep }) {
  if (!_address) throw Object.assign(new Error('Connect a Solana wallet first.'), { code: 'NO_WALLET' });
  const w = web3();
  const A = api();
  const c = await ready();
  const state = await A.readCurve(c, curve);
  if (!state) throw new Error('No curve at that address on Solana.');
  if (state.graduated || state.completed) throw new Error('The curve is complete; there is nothing left to sell.');
  const raw = BigInt(amount);
  if (raw <= 0n) throw new Error('Enter an amount first.');
  const owner = new w.PublicKey(_address);
  const mintKey = new w.PublicKey(state.mint);
  const sellerAta = A.ata(owner, mintKey)[0];
  const info = await c.getAccountInfo(sellerAta);
  if (!info) throw new Error('You do not hold that token in this wallet.');
  return send([
    A.curveSellIx({
      seller: owner,
      mint: mintKey,
      sellerAta,
      protocolFeeRecipient: new w.PublicKey(state.protocolFeeRecipient),
      creatorFeeRecipient: new w.PublicKey(state.creatorFeeRecipient),
      amountIn: raw,
      minSolOut: BigInt(minSolOut || 0n),
    }),
  ], { units: 250_000, microLamports: 50_000, onStep });
}

/** Graduate into PumpSwap (locked LP) by default; the vault path is the fallback. */
export async function curveGraduate({ curve, pumpSwap = true, onStep }) {
  if (!_address) throw Object.assign(new Error('Connect a Solana wallet first.'), { code: 'NO_WALLET' });
  const w = web3();
  const A = api();
  const c = await ready();
  const state = await A.readCurve(c, curve);
  if (!state) throw new Error('No curve at that address on Solana.');
  if (state.graduated) throw new Error('This curve has already graduated.');
  if (!state.completed) throw new Error('The curve is not complete yet.');
  const owner = new w.PublicKey(_address);
  const mintKey = new w.PublicKey(state.mint);
  const ix = pumpSwap
    ? A.curveGraduatePumpSwapIx({ payer: owner, mint: mintKey })
    : A.curveGraduateIx({ payer: owner, mint: mintKey });
  return send([ix], {
    units: pumpSwap ? 1_200_000 : 400_000,
    microLamports: 50_000,
    onStep,
  });
}

/* ── Jupiter Lock（第三方；链上已部署）────────────────────────────────────
 *
 * 为什么页面上还有这条路：OAKEN 自己的锁程序已经部署在主网（Authority none），
 * 是页面的默认路线；Jupiter Lock 作为**第三方**备选保留 —— 程序可升级，
 * 页面必须如实写，不能借用 OAKEN 的“没有 owner”话术。
 */

export async function jupLive() {
  try {
    const c = await ready();
    const info = await c.getAccountInfo(new (api().web3.PublicKey)(JUP_LOCK_PROGRAM_ID));
    return Boolean(info && info.executable);
  } catch { return false; }
}

/** 用 Jupiter Lock 建一个一次性到期的锁。amount 是 base units（字符串/BigInt）。 */
export async function jupCreateLock({
  mint, amount, unlockDate, beneficiary = null, onStep,
}) {
  if (!_address) throw Object.assign(new Error('Connect a Solana wallet first.'), { code: 'NO_WALLET' });
  const w = web3();
  const A = api();
  const c = await ready();
  if (!(await jupLive())) throw new Error('Jupiter Lock is not reachable on Solana right now.');
  const mk = new w.PublicKey(String(mint).trim());
  const info = await A.readMint(c, mk);
  if (!info) throw new Error('No SPL token at that address on Solana.');
  const tokenProgram = info.isToken2022 ? new w.PublicKey(A.token2022.toBase58()) : new w.PublicKey(A.token.toBase58());
  const raw = BigInt(String(amount));
  if (raw < 2n) throw new Error('Amount is too small to lock.');
  const until = Math.floor(Number(unlockDate));
  const { now } = await clusterNow();
  if (!(until > now + 30)) throw new Error('Unlock date must be at least 30 seconds in the future.');

  const payer = new w.PublicKey(_address);
  const benef = beneficiary ? new w.PublicKey(String(beneficiary).trim()) : payer;
  const [senderToken] = A.ata(payer, mk);
  const src = await c.getAccountInfo(senderToken);
  if (!src) throw new Error('You do not hold that token in this wallet.');

  const baseKp = w.Keypair.generate();
  const [escrow] = A.jupEscrowPda(baseKp.publicKey);
  const [escrowToken] = A.ata(escrow, mk, tokenProgram);
  // 到期一次释放：cliff 那一秒放 amount-1，1 秒后放最后 1 个最小单位。
  const ix = A.jupCreateLockV2Ix({
    base: baseKp.publicKey, escrow, tokenMint: mk, escrowToken,
    sender: payer, senderToken, recipient: benef,
    tokenProgram,
    vestingStartTime: now, cliffTime: until, frequency: 1,
    cliffUnlockAmount: raw - 1n, amountPerPeriod: 1n, numberOfPeriod: 1n,
    updateRecipientMode: 0, cancelMode: 0,
  });
  // ⚠ Jupiter 要求 escrow 的 token account **先存在**（程序里 AccountNotInitialized 3012）：
  //   先建 ATA（幂等），再建 escrow。第一版漏了这一步，链上模拟直接拒绝。
  const createAta = A.createAtaIdempotentIx({
    payer, address: escrowToken, owner: escrow, mint: mk, tokenProgram,
  });
  const sig = await send([createAta, ix], { signers: [baseKp], units: 450000, microLamports: 30000, onStep });
  return { backend: 'jupiter', escrow: escrow.toBase58(), base: baseKp.publicKey.toBase58(), signature: sig };
}

/** 直接读一个 Jupiter escrow（不依赖钱包历史；任何人的锁都可以按地址打开）。 */
export async function jupLockDetail(address) {
  const w = web3();
  const A = api();
  const c = await ready();
  const key = new w.PublicKey(String(address).trim());
  const info = await c.getAccountInfo(key);
  if (!info) throw new Error('No account at that address on Solana.');
  if (!info.owner.equals(new w.PublicKey(JUP_LOCK_PROGRAM_ID))) throw new Error('That account is not a Jupiter Lock escrow.');
  const e = A.decodeJupEscrow(info.data);
  const mk = new w.PublicKey(e.mint);
  const [mintInfo, meta] = await Promise.all([
    A.readMint(c, mk).catch(() => null),
    A.readMetadata(c, mk).catch(() => null),
  ]);
  return { backend: 'jupiter', address: key.toBase58(), role: 'escrow', ...e, mintInfo, meta };
}

/** 我作为 sender 或 recipient 的 Jupiter escrows。 */
export async function jupMyLocks(who = _address) {
  if (!who) return [];
  const A = api();
  const out = new Map();
  const collect = (pubkey, raw) => {
    const e = A.decodeJupEscrow(raw);
    out.set(pubkey, { backend: 'jupiter', address: pubkey, role: 'wallet', ...e });
  };

  /**
   * 1) 走我们自己的 Worker 代理。浏览器直接对官方公共 RPC 调 `getProgramAccounts`
   *    会回 403（带 Origin 的请求被拒），而服务端正常 —— 所以读锁走 `/api/sol/locks`。
   */
  let proxyError = null;
  try {
    const r = await timedFetch('/api/sol/locks?address=' + encodeURIComponent(String(who)), {}, 30000);
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(j?.error || ('lock lookup answered ' + r.status));
    for (const row of j?.locks || []) {
      try { collect(row.pubkey, A.Buffer.from(row.data, 'base64')); } catch { /* 单条解不出来就跳过 */ }
    }
    const list = [...out.values()].sort((a, b) => b.cliffTime - a.cliffTime);
    list.scan = j?.scan || null;
    return list;
  } catch (e) { proxyError = e; }

  /**
   * 2) 代理也不通时，退回直连，并**逐个端点试**。全失败就抛 —— 不能把"读不到"
   *    显示成"没有锁"（这是这个项目最贵的一类错）。
   */
  let last = proxyError;
  for (const url of RPC_URLS) {
    try {
      const c = makeConnection(url);
      const programId = new (web3().PublicKey)(JUP_LOCK_PROGRAM_ID);
      for (const [offset, label] of [[8, 'recipient'], [72, 'creator']]) {
        const rows = await c.getProgramAccounts(programId, {
          filters: [
            { dataSize: JUP_ESCROW_LEN },
            { memcmp: { offset, bytes: String(who) } },
          ],
        });
        for (const r of rows) {
          try { collect(r.pubkey.toBase58(), r.account.data); } catch { /* 单条跳过 */ }
        }
      }
      return [...out.values()].sort((a, b) => b.cliffTime - a.cliffTime);
    } catch (e) { last = e; }
  }
  throw new Error('Could not read Jupiter locks: ' + String(last?.message || last || 'no endpoint answered'));
}

/** Jupiter escrow 现在能领多少。 */
export function jupClaimable(e, now = Math.floor(Date.now() / 1000)) {
  if (!e || e.cancelledAt) return 0n;
  let unlocked = 0n;
  if (now >= e.cliffTime) {
    unlocked = e.cliffUnlockAmount;
    if (e.frequency > 0 && e.amountPerPeriod > 0n) {
      // ⚠ `numberOfPeriod` 是从链上解的 **BigInt**；Math.min(BigInt, number) 会直接抛
      // "Cannot convert a BigInt value to a number" —— 而它只在**到期之后**才走到这一行，
      // 所以到期前页面一直好好的，到期那一刻列表才红。
      const elapsed = BigInt(Math.max(0, Math.floor((now - e.cliffTime) / e.frequency)));
      const periods = elapsed < e.numberOfPeriod ? elapsed : e.numberOfPeriod;
      unlocked += e.amountPerPeriod * periods;
    }
  }
  const claimable = unlocked - e.totalClaimedAmount;
  return claimable > 0n ? claimable : 0n;
}

/** 从 Jupiter escrow 领取（recipient 签名）。 */
export async function jupClaim({ escrow, mint, onStep }) {
  if (!_address) throw Object.assign(new Error('Connect a Solana wallet first.'), { code: 'NO_WALLET' });
  const w = web3();
  const A = api();
  const c = await ready();
  const escrowKey = new w.PublicKey(String(escrow).trim());
  const info = await c.getAccountInfo(escrowKey);
  if (!info) throw new Error('That Jupiter escrow does not exist.');
  const e = A.decodeJupEscrow(info.data);
  const recipient = new w.PublicKey(_address);
  if (e.recipient !== _address) throw new Error('Only the recipient can claim this escrow.');
  const mk = new w.PublicKey(String(mint || e.mint));
  const mi = await A.readMint(c, mk).catch(() => null);
  const tokenProgram = e.tokenProgramFlag === 1 || mi?.isToken2022 ? A.token2022 : A.token;
  const [escrowToken] = A.ata(escrowKey, mk, tokenProgram);
  const [recipientToken] = A.ata(recipient, mk, tokenProgram);
  const maxAmount = 2n ** 64n - 1n;
  const ix = A.jupClaimV2Ix({
    escrow: escrowKey, tokenMint: mk, escrowToken, recipient, recipientToken, tokenProgram, maxAmount,
  });
  return send([ix], { units: 300000, microLamports: 30000, onStep });
}

/* ── OAKEN Lock（Solana）──────────────────────────────────────────────── */

/** 建锁。程序不在链上时抛一句人话（页面据此不摆按钮）。 */
export async function lockToken({
  mint, amount, unlockDate, revocable = false, beneficiary = null, label = '', onStep,
}) {
  if (!_address) throw Object.assign(new Error('Connect a Solana wallet first.'), { code: 'NO_WALLET' });
  const w = web3();
  const A = api();
  const c = await ready();
  if (!(await programLive())) {
    throw new Error('The OAKEN Lock program did not answer on Solana right now — nothing was sent.');
  }
  const mk = new w.PublicKey(String(mint).trim());
  const info = await A.readMint(c, mk);
  if (!info) throw new Error('No SPL token at that address on Solana.');
  if (info.isToken2022) throw new Error('This lock program supports classic SPL tokens only.');
  const raw = BigInt(String(amount));
  if (raw <= 0n) throw new Error('Amount must be positive.');
  const now = Math.floor(Date.now() / 1000);
  const until = Math.floor(Number(unlockDate));
  if (!(until > now + 30)) throw new Error('Unlock date must be at least 30 seconds in the future.');

  const payer = new w.PublicKey(_address);
  const benef = beneficiary ? new w.PublicKey(String(beneficiary).trim()) : payer;
  const id = await A.readNextId(c);
  const [lock] = A.lockPda(id);
  const [config] = A.configPda();
  const [source] = A.ata(payer, mk);
  const [vault] = A.ata(lock, mk);
  const src = await c.getAccountInfo(source);
  if (!src) throw new Error('You do not hold that token in this wallet.');
  const ix = A.createLockIx(
    { id, amount: raw, unlockDate: until, revocable: Boolean(revocable), label: String(label || '') },   // createLockIx truncates by UTF-8 bytes
    A.createLockKeys({ payer, beneficiary: benef, mint: mk, source, lock, vault, config }),
  );
  const sig = await send([ix], { units: 400000, microLamports: 30000, onStep });
  return { id, lock: lock.toBase58(), signature: sig };
}

/** 领取（到期后任何人可提交，币只进受益人的 ATA）。 */
export async function claimLock(id, onStep) {
  const w = web3();
  const A = api();
  const c = await ready();
  const l = await A.readLock(c, id);
  if (!l) throw new Error('That lock does not exist.');
  const payer = new w.PublicKey(_address);
  const benef = new w.PublicKey(l.beneficiary);
  const [destination] = A.ata(benef, new w.PublicKey(l.mint));
  const keys = A.claimKeys({
    lock: new w.PublicKey(l.address), vault: new w.PublicKey(l.vault),
    mint: new w.PublicKey(l.mint), destination, payer, beneficiary: benef,
  });
  return send([A.claimIx(keys)], { units: 300000, microLamports: 30000, onStep });
}

export async function revokeLock(id, onStep) {
  const w = web3();
  const A = api();
  const c = await ready();
  const l = await A.readLock(c, id);
  if (!l) throw new Error('That lock does not exist.');
  const creator = new w.PublicKey(_address);
  const mint = new w.PublicKey(l.mint);
  const [destination] = A.ata(creator, mint);
  const ix = A.revokeIx({
    lock: new w.PublicKey(l.address), creator, vault: new w.PublicKey(l.vault), mint, destination,
  });
  return send([ix], { units: 300000, microLamports: 30000, onStep });
}

export async function transferLock(id, newBeneficiary, onStep) {
  const w = web3();
  const A = api();
  const c = await ready();
  const l = await A.readLock(c, id);
  if (!l) throw new Error('That lock does not exist.');
  const ix = A.transferIx({
    lock: new w.PublicKey(l.address),
    beneficiary: new w.PublicKey(_address),
    newBeneficiary: new w.PublicKey(String(newBeneficiary).trim()),
  });
  return send([ix], { units: 200000, microLamports: 30000, onStep });
}

export async function renounceLock(id, onStep) {
  const w = web3();
  const A = api();
  const c = await ready();
  const l = await A.readLock(c, id);
  if (!l) throw new Error('That lock does not exist.');
  const ix = A.renounceIx({
    lock: new w.PublicKey(l.address), beneficiary: new w.PublicKey(_address),
  });
  return send([ix], { units: 200000, microLamports: 30000, onStep });
}
