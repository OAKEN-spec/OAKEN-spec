// OAKEN Names — the `.sns` (Solana) half of /names.
//
// Loaded on demand the first time the Solana tab is selected: the page fetches
// the Solana web3 IIFE + Buffer polyfill, then imports this module. The `.hood`
// half stays untouched in names.html and keeps using the EVM wallet.
//
// Everything here reads from the chain through the site's `/api/sol/rpc` proxy
// (the official RPC 403s browser Origins). The only precomputed data is the
// browse index and the recent-registrations list, both built by
// `tools/names/update-sns-index.mjs`; exact lookups, owners, prices, records and
// the primary name are live reads.
import {
  makeSns, cleanLabel, priceUsd, fmtUsd, fmtSol, humanizeSnsError,
  RECORD_MAP, NAME_TOKENIZER_ID,
} from './sns-build.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const short = (a, n = 4) => (a ? String(a).slice(0, n) + '…' + String(a).slice(-4) : '—');
const timeAgo = (sec) => {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - Number(sec || 0));
  if (!d) return 'just now';
  if (d < 60) return d + 's ago';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 86400 * 30) return Math.floor(d / 86400) + 'd ago';
  return new Date(Number(sec) * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

const FIELDS = [
  ['url', 'Website', 'https://…'],
  ['avatar', 'Avatar', 'https://… image URL'],
  ['description', 'Bio', 'A line about you'],
  ['twitter', 'X / Twitter', '@handle or URL'],
  ['github', 'GitHub', 'username or URL'],
  ['telegram', 'Telegram', '@handle or URL'],
  ['discord', 'Discord', 'invite or username'],
  ['email', 'Email', 'you@example.com'],
];

let S = null;
let sol = null;
let booted = false;
let booting = null;
let walletAddr = null;
let stats = null;
let namesIndex = null;
let indexLoading = null;
let browseShown = 60;
let busy = false;
const st = { label: '', key: null, reg: null, owner: null, tokenized: false, records: {}, primary: null, quote: null };

/* ── boot / wallet ────────────────────────────────────────────────────── */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

export async function boot() {
  if (booted) return;
  if (booting) return booting;
  booting = (async () => {
    try {
      if (!window.solanaWeb3) await loadScript('/app/vendor/oaken-buffer.iife.min.js');
      if (!window.solanaWeb3) await loadScript('/app/vendor/solana-web3.iife.min.js');
      if (!window.solanaWeb3) throw new Error('The Solana library did not load — reload the page (Ctrl+F5).');
      S = makeSns(window.solanaWeb3);
      sol = await import('./solana.js');
      await sol.ready();
    } catch (e) {
      renderBootError(e);
      booted = true;
      return;
    }
    bind();
    await paintWallet();
    loadStats().catch(() => {});
    loadRecent().catch(() => {});
    try {
      const a = await sol.restore();
      if (a) { walletAddr = a; await paintWallet(); loadMine().catch(() => {}); }
    } catch { /* restore is best-effort */ }
    sol.onSolWallet('accounts', async (a) => {
      walletAddr = a || null;
      await paintWallet();
      loadMine().catch(() => {});
      if (st.label) search(st.label, { scroll: false }).catch(() => {});
    });
    const q = new URLSearchParams(location.search).get('q');
    if (q) { $('sns-q').value = q; search(q).catch(() => {}); }
    booted = true;
    reveal();
  })();
  return booting;
}

export function activate() {
  boot().catch(() => {});
  reveal();
  if (walletAddr) loadMine().catch(() => {});
}

function renderBootError(e) {
  const host = $('sns-result');
  if (host) {
    host.innerHTML = `<div class="panel"><div class="body"><b style="color:var(--bad)">The Solana runtime did not start.</b>
      <p class="muted" style="margin:10px 0 0">${esc(e?.message || e)}</p>
      <p class="hint" style="margin:10px 0 0">The .hood tab is unaffected. Reload with Ctrl+F5; if it persists, tell us the line above.</p></div></div>`;
  }
  setStatus('Solana runtime did not start', 'bad');
}

function reveal() {
  requestAnimationFrame(() => {
    document.querySelectorAll('#ns-sns .reveal').forEach((el) => el.classList.add('in'));
  });
}

async function paintWallet() {
  const btn = $('sns-connect');
  const panel = $('sns-walletpanel');
  if (!btn || !panel) return;
  if (!walletAddr) {
    btn.hidden = false;
    btn.textContent = 'Connect a Solana wallet';
    panel.innerHTML = '';
    return;
  }
  btn.hidden = true;
  panel.innerHTML = `<div class="walletrow" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <span class="addr" style="font:12px/1.4 ui-monospace,Consolas,monospace;color:var(--parch)">${esc(walletAddr)}</span>
    <span class="hint" id="sns-walletbal">Reading balance…</span>
    <button class="btn btn-s" type="button" id="sns-disconnect">Disconnect</button>
    <a class="btn btn-s" href="https://solscan.io/account/${esc(walletAddr)}" target="_blank" rel="noopener">Solscan ↗</a>
  </div>`;
  $('sns-disconnect').onclick = async () => {
    try { await sol.disconnect(); } catch { /* ignore */ }
    walletAddr = null;
    await paintWallet();
    renderMineSignedOut();
  };
  try {
    const bal = await sol.balance();
    const el = $('sns-walletbal');
    if (el) el.textContent = bal == null ? '—' : fmtSol(bal);
  } catch {
    const el = $('sns-walletbal');
    if (el) el.textContent = 'balance unavailable';
  }
}

function walletChoices() {
  const list = sol.wallets();
  if (!list.length) {
    return `<div class="note" style="border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;color:var(--muted);font-size:13.5px;line-height:1.7">
      No Solana wallet found in this browser. Install
      <a href="https://phantom.app/" target="_blank" rel="noopener">Phantom</a> or
      <a href="https://solflare.com/" target="_blank" rel="noopener">Solflare</a>, then reload.
      On a phone, open this page inside the wallet's own browser.
    </div>`;
  }
  return `<div class="walletbtns" style="display:flex;gap:8px;flex-wrap:wrap">${list.map((w) => `
    <button class="btn btn-p" type="button" data-wallet="${esc(w.key)}">${esc(w.name)}</button>`).join('')}</div>`;
}

async function connectFlow() {
  const panel = $('sns-walletpanel');
  const list = sol.wallets();
  if (list.length === 1) return doConnect(list[0].key);
  if (panel) {
    panel.innerHTML = walletChoices();
    panel.querySelectorAll('[data-wallet]').forEach((b) => { b.onclick = () => doConnect(b.dataset.wallet); });
  }
  if (!list.length) setStatus('No Solana wallet found', 'bad');
}

async function doConnect(key) {
  try {
    setStatus('Waiting for your wallet…');
    const addr = await sol.connect(key);
    if (!addr) { setStatus('No wallet selected', 'bad'); return; }
    walletAddr = addr;
    await paintWallet();
    await loadMine();
    if (st.label) await search(st.label, { scroll: false });
    setStatus('Connected');
  } catch (e) {
    setStatus(humanizeSnsError(e), 'bad');
    const panel = $('sns-walletpanel');
    if (panel) panel.innerHTML = `<div class="hint" style="color:var(--bad)">${esc(humanizeSnsError(e))}</div>`;
  }
}

/* ── shared UI ────────────────────────────────────────────────────────── */

function setStatus(text, kind) {
  const el = $('sns-plate-status-text');
  const dot = document.querySelector('#sns-plate-status .pdot');
  if (el) el.textContent = text;
  const box = $('sns-plate-status');
  if (box) {
    box.classList.toggle('bad', kind === 'bad');
    box.classList.toggle('ok', kind === 'ok');
  }
  if (dot) dot.style.background = kind === 'bad' ? 'var(--bad)' : kind === 'ok' ? 'var(--ok)' : '';
}

function setPlate(label) {
  const el = $('sns-plate-label');
  if (el) el.textContent = label || 'your name';
  const name = $('sns-plate-name');
  if (name && label) {
    name.classList.remove('tick');
    void name.offsetWidth;
    name.classList.add('tick');
  }
}

function showResult(html) {
  const host = $('sns-result');
  if (host) host.innerHTML = html;
  reveal();
}

function errorPanel(what, e, retry) {
  const msg = humanizeSnsError(e);
  showResult(`<div class="panel"><div class="body">
    <b style="color:var(--bad)">Could not read ${esc(what)}.</b>
    <p class="muted" style="margin:10px 0 0">${esc(msg)}</p>
    <button class="btn btn-s" type="button" id="sns-retry" style="margin-top:14px">Retry</button>
  </div></div>`);
  $('sns-retry').onclick = retry;
}

/* ── search ──────────────────────────────────────────────────────────── */

async function search(input, { scroll = true } = {}) {
  if (!S || !sol) { await boot(); if (!S) return; }
  const rawInput = String(input ?? '').trim();
  // `.sol` is the legacy suffix. Do not silently register the `.sns` twin:
  // show what the user typed and offer the current TLD explicitly.
  if (/\.sol$/i.test(rawInput)) {
    const label = cleanLabel(rawInput).label || rawInput.replace(/\.sol$/i, '');
    setPlate(label);
    setStatus('.sol is legacy — SNS now issues .sns', 'bad');
    showResult(`<div class="panel reveal"><div class="body">
      <b style="color:var(--parch)">SNS now issues <span class="mono">.sns</span> names.</b>
      <p class="muted" style="margin:10px 0 0">You typed <span class="mono">${esc(rawInput)}</span>.
        <span class="mono">.sol</span> is the legacy suffix; it is being migrated and may resolve elsewhere.
        This page registers <b>${esc(label)}.sns</b>.</p>
      <button class="btn btn-p" type="button" id="sns-continue" style="margin-top:14px">Continue with ${esc(label)}.sns</button>
    </div></div>`);
    $('sns-continue').onclick = () => { if ($('sns-q')) $('sns-q').value = label; search(label); };
    return;
  }
  const clean = cleanLabel(input);
  if (clean.error) {
    setPlate('');
    setStatus(clean.error, 'bad');
    showResult(`<div class="panel"><div class="body muted">${esc(clean.error)}</div></div>`);
    return;
  }
  const label = clean.label;
  st.label = label;
  st.quote = null;
  st.reg = null;
  st.records = {};
  st.primary = null;
  setPlate(label);
  setStatus('Reading the chain…');
  const host = $('sns-result');
  if (host) host.innerHTML = '<div class="panel"><div class="body muted">Reading the name account, the price feed and the rent…</div></div>';
  const conn = await sol.ready();
  const key = S.nameAccount(label);
  st.key = key;
  try {
    const [info, pythInfo, nameRent, reverseRent] = await Promise.all([
      conn.getAccountInfo(key),
      conn.getAccountInfo(S.pythFeed()).catch(() => null),
      conn.getMinimumBalanceForRentExemption(96).catch(() => null),
      conn.getMinimumBalanceForRentExemption(107).catch(() => null),
    ]);
    if (!info) {
      const quote = await quoteFor(label, pythInfo);
      await renderAvailable({ label, key, quote, pythInfo, nameRent, reverseRent });
    } else {
      const reg = S.decodeRegistry(info.data);
      let owner = reg.owner;
      let tokenized = false;
      if (reg.owner === NAME_TOKENIZER_ID) {
        tokenized = true;
        owner = (await tokenOwnerOf(key)) || reg.owner;
      }
      const records = await readRecords(label).catch(() => ({}));
      const primary = await readPrimary(owner).catch(() => null);
      await renderTaken({ label, key, reg, owner, tokenized, records, primary });
    }
    if (scroll) $('sns-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    setStatus('Could not read the chain', 'bad');
    errorPanel('that name', e, () => search(label));
  }
}

async function quoteFor(label, pythInfo) {
  const usd = priceUsd(label);
  let live = null;
  let lamports = null;
  if (pythInfo?.data) {
    try {
      const p = S.parsePyth(pythInfo.data);
      live = { price: Number(p.price) * 10 ** p.exponent, exponent: p.exponent, at: p.publishTime };
      lamports = S.quoteLamports(label, p);
    } catch { /* fall through to the API */ }
  }
  if (lamports == null) {
    const price = await sol.solPriceUsd().catch(() => null);
    if (price) {
      live = { price, at: Math.floor(Date.now() / 1000), fallback: true };
      lamports = BigInt(Math.ceil((usd / price) * 1e9 * 1.03));
    }
  }
  return { usd, lamports, live };
}

async function tokenOwnerOf(nameKey) {
  try {
    const w = window.solanaWeb3;
    const mint = S.domainMint(nameKey);
    const info = await (await sol.ready()).getAccountInfo(mint);
    if (!info) return null;
    const largest = await (await sol.ready()).getTokenLargestAccounts(mint);
    const acct = largest?.value?.[0]?.address;
    if (!acct) return null;
    const ai = await (await sol.ready()).getAccountInfo(new w.PublicKey(acct));
    if (!ai || ai.data.length < 64) return null;
    return new w.PublicKey(ai.data.subarray(32, 64)).toBase58();
  } catch { return null; }
}

async function readRecords(label) {
  const conn = await sol.ready();
  const keys = FIELDS.map(([k]) => S.recordAccount(label, RECORD_MAP[k]));
  const infos = await conn.getMultipleAccountsInfo(keys);
  const out = {};
  infos.forEach((info, i) => {
    if (!info) return;
    try {
      const r = S.decodeRecord(info.data);
      if (r.text) out[FIELDS[i][0]] = r.text;
    } catch { /* not a record */ }
  });
  return out;
}

async function readPrimary(owner) {
  try {
    const conn = await sol.ready();
    const key = S.primaryAccount(owner);
    const info = await conn.getAccountInfo(key);
    if (!info) return null;
    const dec = S.decodePrimary(info.data);
    const rev = await readReverseLabel(dec.nameAccount);
    return { nameAccount: dec.nameAccount, label: rev };
  } catch { return null; }
}

/** Reverse accounts are name-registry accounts: 96-byte header, then the borsh string. */
function reverseLabel(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = dv.getUint32(96, true);
  return new TextDecoder().decode(data.subarray(100, 100 + len)).replace(/^\u0000/, '');
}

async function readReverseLabel(nameAccount) {
  try {
    const conn = await sol.ready();
    const key = S.reverseAccount(nameAccount);
    const info = await conn.getAccountInfo(key);
    if (!info) return null;
    return reverseLabel(info.data) || null;
  } catch { return null; }
}

/* ── result: available ───────────────────────────────────────────────── */

async function renderAvailable({ label, key, quote, pythInfo, nameRent, reverseRent }) {
  const rent = (Number(nameRent || 0) + Number(reverseRent || 0));
  const rentTxt = rent ? fmtSol(rent) : '~0.0023 SOL';
  const liveTxt = quote.live
    ? `SOL/USD ${quote.live.price.toFixed(2)} (${quote.live.fallback ? 'price API' : 'Pyth, on-chain'} · ${new Date(quote.live.at * 1000).toISOString().slice(11, 16)} UTC)`
    : 'price feed did not answer';
  const payTxt = quote.lamports != null ? fmtSol(quote.lamports) : '—';
  setStatus('Available · ' + fmtUsd(quote.usd), 'ok');
  const sub = $('sns-plate-sub');
  if (sub) sub.textContent = 'Nobody has taken this name — the price is SNS\'s one-off fee, paid in SOL.';

  const needsWallet = !walletAddr;
  showResult(`<div class="panel reveal">
    <div class="head">
      <span class="pill ok">AVAILABLE</span>
      <h3 style="font-size:24px;word-break:break-all">${esc(label)}<span style="color:var(--gold)">.sns</span></h3>
      <span class="muted" style="margin-left:auto;font-size:13px">One-off price, no renewal.</span>
    </div>
    <div class="body">
      <div class="nlay">
        <div>
          <div class="eyebrow">What the chain will charge</div>
          <table class="nprice" style="margin-top:10px">
            <tr><td>SNS price (${esc(String(priceUsd(label)))} USD)</td><td><b style="color:var(--gold)">${fmtUsd(quote.usd)}</b></td></tr>
            <tr><td>Paid in SOL at execution</td><td>≈ ${esc(payTxt)} <span class="hint">(wrapped; the remainder is returned)</span></td></tr>
            <tr><td>Account rent (name + reverse)</td><td>${esc(rentTxt)} <span class="hint">(stays in your accounts)</span></td></tr>
            <tr><td>OAKEN fee</td><td>$0</td></tr>
          </table>
          <div class="hint" style="margin-top:10px">${esc(liveTxt)}. The quote wraps a 3% buffer; the registrar charges the live
            rate and the wrapped-SOL account is closed in the same transaction, so any excess comes straight back.</div>
        </div>
        <div>
          <div class="eyebrow">What you get</div>
          <div class="note" style="margin-top:10px;border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;color:var(--muted);font-size:13px;line-height:1.6">
            A name account on Solana owned by your wallet, plus a reverse lookup so wallets can show
            <span class="mono">${esc(label)}.sns</span> instead of the address. One purchase, no expiry, no renewal.
            Records and a primary name are separate, free transactions you sign later.
          </div>
          <div style="margin-top:14px">
            <div class="hint" style="margin:0 0 8px">Registration is one transaction. A name can be taken between your
              search and your signature — there is no commit-reveal on this registrar.</div>
            <button class="btn btn-p" type="button" id="sns-reg" style="width:100%" ${busy ? 'disabled' : ''}>${needsWallet ? 'Connect a Solana wallet' : 'Register this name'}</button>
            <div class="hint" id="sns-payline" style="margin-top:10px"></div>
          </div>
        </div>
      </div>
      <div class="err" id="sns-regerr" role="alert" aria-live="assertive"></div>
    </div>
  </div>`);
  const btn = $('sns-reg');
  if (needsWallet) btn.onclick = () => connectFlow();
  else btn.onclick = () => registerName(label);
  if (walletAddr) {
    sol.balance().then((bal) => {
      const line = $('sns-payline');
      if (!line) return;
      const need = Number(quote.lamports || 0) + rent + 1_000_000;
      if (bal == null) { line.textContent = 'Balance unavailable — your wallet will show the amount before you sign.'; return; }
      line.innerHTML = bal >= need
        ? `Balance ${esc(fmtSol(bal))} — enough for this.`
        : `<span style="color:var(--bad)">Balance ${esc(fmtSol(bal))} — this needs about ${esc(fmtSol(need))} (price + rent + fee buffer).</span>`;
    }).catch(() => {});
  }
}

/* ── result: taken ───────────────────────────────────────────────────── */

async function renderTaken({ label, key, reg, owner, tokenized, records, primary }) {
  const isMine = Boolean(walletAddr && owner && owner === walletAddr);
  const isPrimary = Boolean(primary && primary.nameAccount === key.toBase58());
  const recEntries = Object.entries(records);
  setStatus('Registered · ' + short(owner), 'ok');
  const sub = $('sns-plate-sub');
  if (sub) sub.textContent = isMine ? 'This name is yours. Set it as primary, or write records below.' : 'This name is already registered.';
  showResult(`<div class="panel reveal">
    <div class="head">
      <span class="pill">REGISTERED</span>
      <h3 style="font-size:24px;word-break:break-all">${esc(label)}<span style="color:var(--gold)">.sns</span></h3>
      ${isMine ? '<span class="pill ok">YOURS</span>' : ''}
      ${isPrimary ? '<span class="pill lock">PRIMARY</span>' : ''}
      <span class="muted" style="margin-left:auto;font-size:13px">${tokenized ? 'Tokenized name' : 'No expiry'}</span>
    </div>
    <div class="body">
      <div class="nlay">
        <div>
          <div class="eyebrow">Owner${tokenized ? ' (NFT holder)' : ''}</div>
          <div class="mono" style="margin-top:8px;word-break:break-all">${esc(owner)}</div>
          <div class="hint" style="margin-top:8px">Name account <span class="mono">${esc(key.toBase58())}</span> ·
            <a href="https://solscan.io/account/${esc(key.toBase58())}" target="_blank" rel="noopener">Solscan ↗</a></div>
          ${primary && primary.label ? `<div class="hint" style="margin-top:6px">Primary name of this wallet: <b>${esc(primary.label)}.sns</b></div>` : ''}
          <div class="hint" style="margin-top:10px">${isMine ? 'You hold this name. Everything below is optional and free — you only pay the network fee (and a small rent for a new record account).' : 'Connect the owner wallet to change anything. OAKEN cannot move or recover a name.'}</div>
          ${isMine ? `<div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-p" type="button" id="sns-primary">${isPrimary ? 'Already primary' : 'Set as primary'}</button>
            <button class="btn btn-s" type="button" id="sns-copy">Copy address</button>
          </div>` : ''}
          <div class="err" id="sns-actionerr" role="alert" aria-live="assertive" style="margin-top:10px"></div>
        </div>
        <div>
          <div class="eyebrow">Records on this name</div>
          ${recEntries.length ? `<table class="nprice" style="margin-top:10px">${recEntries.map(([k, v]) => {
            const f = FIELDS.find((x) => x[0] === k);
            const safe = /^https?:\/\//i.test(v) && (k === 'url' || k === 'avatar');
            return `<tr><td>${esc(f ? f[1] : k)}</td><td style="word-break:break-all">${safe ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v)}</td></tr>`;
          }).join('')}</table>` : '<div class="hint" style="margin-top:10px">No records yet.</div>'}
          <div class="hint" style="margin-top:10px">Records are public text stored on the name's record accounts. Wallets that support SNS read them.</div>
        </div>
      </div>
      ${isMine ? `<div style="margin-top:22px">
        <div class="eyebrow">Edit records</div>
        <div class="hint" style="margin:6px 0 12px">Each row is its own transaction. A new record pays a small rent; editing an existing one does not grow the account unless the text gets longer.</div>
        <div class="nrec-edit" style="display:grid;grid-template-columns:160px 1fr auto;gap:10px;align-items:center">
          ${FIELDS.map(([k, name, ph]) => `<label class="hint" for="sns-rec-${k}">${esc(name)}</label>
            <input class="i" id="sns-rec-${k}" placeholder="${esc(ph)}" value="${esc(records[k] || '')}" autocomplete="off" spellcheck="false">
            <button class="btn btn-s" type="button" data-rec="${k}">Save</button>`).join('')}
        </div>
      </div>` : ''}
    </div>
  </div>`);

  if (isMine) {
    const primaryBtn = $('sns-primary');
    if (primaryBtn) primaryBtn.onclick = () => setPrimary(label, isPrimary);
    const copyBtn = $('sns-copy');
    if (copyBtn) copyBtn.onclick = () => copyText(walletAddr, copyBtn);
    document.querySelectorAll('#sns-result [data-rec]').forEach((b) => {
      b.onclick = () => saveRecord(label, b.dataset.rec, b);
    });
  }
}

/* ── writes ──────────────────────────────────────────────────────────── */

async function registerName(label) {
  if (busy) return;
  const errBox = $('sns-regerr');
  const btn = $('sns-reg');
  if (!walletAddr) { await connectFlow(); return; }
  busy = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  if (errBox) errBox.textContent = '';
  try {
    const conn = await sol.ready();
    const pyth = await conn.getAccountInfo(S.pythFeed()).catch(() => null);
    if (!pyth) throw new Error('The on-chain SOL price feed did not answer. Try again in a moment.');
    const p = S.parsePyth(pyth.data);
    const lamports = S.quoteLamports(label, p);
    const [nRent, rRent] = await Promise.all([
      conn.getMinimumBalanceForRentExemption(96).catch(() => 0),
      conn.getMinimumBalanceForRentExemption(107).catch(() => 0),
    ]);
    const bal = await sol.balance();
    const need = Number(lamports) + Number(nRent) + Number(rRent) + 1_000_000;
    if (bal == null) throw new Error('Could not read your balance.');
    if (bal < need) throw new Error(`Not enough SOL: this needs about ${fmtSol(need)} and the wallet has ${fmtSol(bal)}.`);
    const ixs = S.registerIxs({ buyer: walletAddr, label, lamports });
    let lastSig = null;
    const sig = await sol.send(ixs, {
      units: 250000,
      onStep: (step, s) => {
        if (s) lastSig = s;
        const line = $('sns-payline');
        if (!line) return;
        const labelTxt = step === 'signing' ? 'Waiting for your wallet…'
          : step === 'sending' ? 'Sending the transaction…'
            : step === 'sent' ? 'Sent — waiting for the block…'
              : step === 'done' ? 'Registered.' : 'Preparing…';
        line.innerHTML = esc(labelTxt) + (lastSig ? ` <a href="${esc(sol.SOLSCAN_TX(lastSig))}" target="_blank" rel="noopener">Solscan ↗</a>` : '');
      },
    });
    if (btn) btn.textContent = 'Registered';
    await search(label, { scroll: false });
    loadMine().catch(() => {});
    loadRecent().catch(() => {});
    loadStats().catch(() => {});
    return sig;
  } catch (e) {
    const msg = humanizeSnsError(e);
    if (errBox) errBox.textContent = msg;
    if (btn) { btn.disabled = false; btn.textContent = 'Register this name'; }
    setStatus('Registration failed', 'bad');
    return null;
  } finally {
    busy = false;
  }
}

async function saveRecord(label, key, btn) {
  const rec = RECORD_MAP[key];
  const input = $('sns-rec-' + key);
  const value = input ? input.value.trim() : '';
  const errBox = $('sns-actionerr');
  if (errBox) errBox.textContent = '';
  if (!value) { if (errBox) errBox.textContent = 'Enter a value first. Clearing a record is not supported here.'; return; }
  if (key === 'avatar' && !/^https?:\/\//i.test(value)) { if (errBox) errBox.textContent = 'Avatar must be an https:// image URL.'; return; }
  if (key === 'url' && !/^https?:\/\//i.test(value)) { if (errBox) errBox.textContent = 'Website must start with https://.'; return; }
  const exists = Boolean(st.records?.[key]);
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await sol.send([S.recordIx({
      label, record: rec, value, owner: walletAddr, payer: walletAddr, exists,
    })], { units: 200000 });
    st.records[key] = value;
    if (errBox) errBox.innerHTML = 'Saved <span class="hint">(' + esc(key) + ')</span>.';
    btn.textContent = 'Saved';
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Save'; }, 1200);
  } catch (e) {
    if (errBox) errBox.textContent = humanizeSnsError(e);
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function setPrimary(label, already) {
  const errBox = $('sns-actionerr');
  const btn = $('sns-primary');
  if (already) return;
  if (errBox) errBox.textContent = '';
  if (btn) { btn.disabled = true; btn.textContent = 'Waiting for your wallet…'; }
  try {
    await sol.send([S.primaryIx({ label, owner: walletAddr })], { units: 120000 });
    if (errBox) errBox.innerHTML = 'Primary name set.';
    if (btn) btn.textContent = 'Already primary';
    loadMine().catch(() => {});
  } catch (e) {
    if (errBox) errBox.textContent = humanizeSnsError(e);
    if (btn) { btn.disabled = false; btn.textContent = 'Set as primary'; }
  }
}

async function copyText(text, btn) {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = old; }, 1200);
}

/* ── my names ────────────────────────────────────────────────────────── */

function renderMineSignedOut() {
  const host = $('sns-mine-out');
  if (!host) return;
  host.innerHTML = `<div class="panel"><div class="body">
    <p class="muted" style="margin:0 0 12px">Connect a Solana wallet to see the .sns names it holds. OAKEN reads them
      from the chain; it never sees your keys.</p>
    <button class="btn btn-p" type="button" id="sns-mine-connect">Connect a Solana wallet</button>
  </div></div>`;
  $('sns-mine-connect').onclick = () => connectFlow();
}

let mineSeq = 0;
async function loadMine() {
  const host = $('sns-mine-out');
  if (!host) return;
  if (!walletAddr) { renderMineSignedOut(); return; }
  const seq = ++mineSeq;
  host.innerHTML = '<div class="panel"><div class="body muted">Reading the names this wallet holds…</div></div>';
  let data;
  try {
    const r = await fetch('/api/sol/sns/owned?owner=' + encodeURIComponent(walletAddr), { signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('The name index answered ' + r.status + '.');
    data = await r.json();
    if (data.error) throw new Error(data.error);
  } catch (e) {
    if (seq !== mineSeq) return;
    host.innerHTML = `<div class="panel"><div class="body">
      <b style="color:var(--bad)">Could not list the names for this wallet.</b>
      <p class="muted" style="margin:10px 0 0">${esc(humanizeSnsError(e))}</p>
      <p class="hint" style="margin:8px 0 0">Exact lookups still work: search a name above. The portfolio needs an
        index RPC that supports <span class="mono">getProgramAccounts</span>.</p>
      <button class="btn btn-s" type="button" id="sns-mine-retry" style="margin-top:14px">Retry</button>
    </div></div>`;
    $('sns-mine-retry').onclick = () => loadMine();
    return;
  }
  if (seq !== mineSeq) return;
  const primary = await readPrimary(walletAddr).catch(() => null);
  let names = [];
  if (Array.isArray(data.accounts) && data.accounts.length) {
    // GPA gave us the name accounts. The label lives in each name's reverse
    // account, whose address we derive here (the server does not carry a PDA impl).
    names = await labelsForAccounts(data.accounts);
  } else if (Array.isArray(data.names)) {
    names = data.names.map((n) => ({
      name: n.name,
      account: S.nameAccount(n.name).toBase58(),
      owner: walletAddr,
      time: n.time,
    }));
  }
  if (seq !== mineSeq) return;
  const note = data.complete === false
    ? `<div class="hint" style="margin:10px 0 0;color:var(--warn)">This list is partial: the RPC could not enumerate every
        name for this wallet (${esc(data.mode === 'history' ? 'recent registrations only' : 'index unavailable')}).</div>`
    : '';
  if (!names.length) {
    host.innerHTML = `<div class="panel"><div class="body">
      <p class="muted" style="margin:0 0 12px">No .sns names found for ${esc(short(walletAddr))}.</p>
      <button class="btn btn-p" type="button" id="sns-mine-search">Search a name</button>
      ${note}
    </div></div>`;
    $('sns-mine-search').onclick = () => { $('sns-q').focus(); $('sns-registry').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    return;
  }
  host.innerHTML = `<div class="nrecent">${names.map((n) => `
    <a href="#sns-registry" data-sns="${esc(n.name)}">
      <span class="nm">${esc(n.name)}<i>.sns</i></span>
      <span class="meta">${esc(n.owner || walletAddr)}</span>
      ${primary && primary.nameAccount === n.account ? '<span class="meta" style="color:var(--gold)">PRIMARY</span>' : ''}
    </a>`).join('')}</div>
    <div class="hint" style="margin-top:10px">${names.length} name${names.length === 1 ? '' : 's'}${data.complete === false ? ' (partial)' : ''}.
      Owners read live; tokenized names are held by the NFT and are not listed here.</div>${note}`;
  bindSnsLinks(host);
}

/** name accounts → { name, account, owner } via each name's reverse lookup. */
async function labelsForAccounts(accounts) {
  const w = window.solanaWeb3;
  const conn = await sol.ready();
  const keys = accounts.map((a) => S.reverseAccount(new w.PublicKey(a)));
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk).catch(() => []);
    infos.forEach((info, j) => {
      if (!info) return;
      try {
        const text = reverseLabel(info.data);
        if (text) out.push({ name: text, account: accounts[i + j], owner: walletAddr });
      } catch { /* not a reverse account */ }
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ── recent / stats / browse ─────────────────────────────────────────── */

async function loadStats() {
  try {
    const r = await fetch('/app/sns-stats.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('stats ' + r.status);
    stats = await r.json();
    const total = Number(stats.names || 0);
    if ($('sns-total')) $('sns-total').textContent = total ? total.toLocaleString('en-US') : '—';
    if ($('sns-new24')) $('sns-new24').textContent = stats.last24h != null ? String(stats.last24h) : '—';
    if ($('sns-pricefrom')) $('sns-pricefrom').textContent = '$20';
    if ($('sns-index-note')) {
      $('sns-index-note').textContent = total
        ? `Snapshot ${new Date(stats.generatedAt).toISOString().slice(0, 10)} · ${total.toLocaleString('en-US')} labels · owners read live`
        : 'Snapshot unavailable — exact lookups and registration still work.';
    }
    const input = $('sns-browse-input');
    if (input && total) input.placeholder = `Filter ${total.toLocaleString('en-US')} names…`;
  } catch {
    if ($('sns-index-note')) $('sns-index-note').textContent = 'Snapshot unavailable — exact lookups and registration still work.';
  }
}

async function loadRecent() {
  const host = $('sns-recent');
  if (!host) return;
  host.innerHTML = '<div class="hint">Reading the snapshot…</div>';
  try {
    const r = await fetch('/app/sns-recent.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('recent ' + r.status);
    const data = await r.json();
    const items = (data.names || []).slice(0, 24);
    if (!items.length) {
      host.innerHTML = '<div class="hint">No registrations have gone through the .sns registrar yet.</div>';
      return;
    }
    host.innerHTML = items.map((x) => `
      <a href="#sns-registry" data-sns="${esc(x.name)}">
        <span class="nm">${esc(x.name)}<i>.sns</i></span>
        <span class="meta">${esc(short(x.buyer || '—'))} · ${esc(timeAgo(x.time))}</span>
      </a>`).join('');
    bindSnsLinks(host);
    if ($('sns-recent-note')) {
      $('sns-recent-note').textContent = `Registrations that went through the .sns registrar · snapshot ${new Date(data.generatedAt).toISOString().slice(0, 10)}. `
        + 'The registry predates it; older names are in Browse.';
    }
  } catch (e) {
    host.innerHTML = `<div class="hint" style="color:var(--bad)">Could not read the recent snapshot (${esc(e.message)}).</div>`;
  }
}

function bindSnsLinks(scope) {
  scope.querySelectorAll('[data-sns]').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const name = a.dataset.sns;
      if ($('sns-q')) $('sns-q').value = name;
      search(name);
    });
  });
}

async function loadIndex() {
  if (namesIndex) return namesIndex;
  if (indexLoading) return indexLoading;
  const out = $('sns-browse-out');
  const btn = $('sns-browse-open');
  if (out) out.innerHTML = '<div class="hint">Loading the index (about 5 MB, one time)…</div>';
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  indexLoading = (async () => {
    const r = await fetch('/app/sns-names.txt', { signal: AbortSignal.timeout(90000) });
    if (!r.ok) throw new Error('index ' + r.status);
    const text = await r.text();
    namesIndex = text.split('\n').filter(Boolean);
    return namesIndex;
  })().finally(() => { indexLoading = null; });
  try {
    await indexLoading;
    const input = $('sns-browse-input');
    if (input) input.disabled = false;
    if ($('sns-browse-more')) $('sns-browse-more').disabled = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Index loaded'; }
    if ($('sns-browse-note')) $('sns-browse-note').textContent = `${namesIndex.length.toLocaleString('en-US')} labels. Owners are read live for the rows shown.`;
    await renderBrowse();
    return namesIndex;
  } catch (e) {
    if (out) out.innerHTML = `<div class="hint" style="color:var(--bad)">Could not load the index: ${esc(e.message)}</div>`;
    if (btn) { btn.disabled = false; btn.textContent = 'Load the index'; }
    return null;
  }
}

function browseMatches() {
  const q = String($('sns-browse-input')?.value || '').trim().toLowerCase();
  if (!namesIndex) return [];
  if (!q) return namesIndex.slice(0, browseShown);
  const out = [];
  for (let i = 0; i < namesIndex.length && out.length < browseShown; i++) {
    if (namesIndex[i].includes(q)) out.push(namesIndex[i]);
  }
  return out;
}

async function renderBrowse() {
  const out = $('sns-browse-out');
  if (!out || !namesIndex) return;
  const labels = browseMatches();
  if (!labels.length) {
    out.innerHTML = '<div class="hint">Nothing matches that filter.</div>';
    return;
  }
  out.innerHTML = '<div class="hint">Reading owners…</div>';
  let owners = [];
  try {
    const conn = await sol.ready();
    const keys = labels.map((l) => S.nameAccount(l));
    const infos = await conn.getMultipleAccountsInfo(keys);
    owners = infos.map((info) => {
      if (!info) return null;
      try { return S.decodeRegistry(info.data).owner; } catch { return null; }
    });
  } catch { owners = labels.map(() => null); }
  out.innerHTML = labels.map((l, i) => `
    <a href="#sns-registry" data-sns="${esc(l)}">
      <span class="nm">${esc(l)}<i>.sns</i></span>
      <span class="meta">${owners[i] ? esc(short(owners[i])) : 'not registered (snapshot stale?)'}</span>
    </a>`).join('');
  bindSnsLinks(out);
  const more = $('sns-browse-more');
  if (more) more.disabled = labels.length < browseShown;
}

async function randomBrowse() {
  if (!namesIndex) { const ok = await loadIndex(); if (!ok) return; }
  const host = $('sns-browse-out');
  browseShown = 60;
  const picked = [];
  const seen = new Set();
  while (picked.length < 60 && seen.size < 400) {
    const i = Math.floor(Math.random() * namesIndex.length);
    if (seen.has(i)) continue;
    seen.add(i);
    picked.push(namesIndex[i]);
  }
  if (host) host.innerHTML = '<div class="hint">Reading owners…</div>';
  try {
    const conn = await sol.ready();
    const infos = await conn.getMultipleAccountsInfo(picked.map((l) => S.nameAccount(l)));
    const owners = infos.map((info) => {
      if (!info) return null;
      try { return S.decodeRegistry(info.data).owner; } catch { return null; }
    });
    host.innerHTML = picked.map((l, i) => `
      <a href="#sns-registry" data-sns="${esc(l)}">
        <span class="nm">${esc(l)}<i>.sns</i></span>
        <span class="meta">${owners[i] ? esc(short(owners[i])) : 'not registered (snapshot stale?)'}</span>
      </a>`).join('');
    bindSnsLinks(host);
  } catch (e) {
    if (host) host.innerHTML = `<div class="hint" style="color:var(--bad)">Could not read owners: ${esc(e.message)}</div>`;
  }
}

/* ── bindings ────────────────────────────────────────────────────────── */

function bind() {
  const go = $('sns-go');
  const q = $('sns-q');
  if (go) go.onclick = () => { if (q) search(q.value); };
  if (q) {
    q.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); search(q.value); } });
    q.addEventListener('input', () => {
      const clean = cleanLabel(q.value);
      if (clean.label !== q.value.trim().toLowerCase()) {
        // Strip a pasted `.sns` suffix, but leave `.sol` visible so the search
        // can explain that it is the legacy TLD instead of silently selling .sns.
        if (/\.sns$/i.test(q.value.trim())) q.value = clean.label;
      }
      if (!clean.label) { setPlate(''); setStatus('Search a name'); }
      else { setPlate(clean.label); setStatus('Press Search to check'); }
    });
  }
  const connect = $('sns-connect');
  if (connect) connect.onclick = () => connectFlow();
  const mineRefresh = $('sns-mine-refresh');
  if (mineRefresh) mineRefresh.onclick = async () => {
    mineRefresh.disabled = true; mineRefresh.textContent = 'Reading…';
    try { await loadMine(); } finally { mineRefresh.disabled = false; mineRefresh.textContent = 'Refresh'; }
  };
  const recentRefresh = $('sns-recent-refresh');
  if (recentRefresh) recentRefresh.onclick = async () => {
    recentRefresh.disabled = true; recentRefresh.textContent = 'Reading…';
    try { await loadRecent(); } finally { recentRefresh.disabled = false; recentRefresh.textContent = 'Refresh'; }
  };
  const open = $('sns-browse-open');
  if (open) open.onclick = () => loadIndex();
  const more = $('sns-browse-more');
  if (more) more.onclick = () => { browseShown += 60; renderBrowse(); };
  const filter = $('sns-browse-input');
  if (filter) {
    let t = null;
    filter.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { browseShown = 60; renderBrowse(); }, 220);
    });
  }
  const random = $('sns-random');
  if (random) random.onclick = () => randomBrowse();
}
