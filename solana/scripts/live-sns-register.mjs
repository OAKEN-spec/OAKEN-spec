// Live `.sns` E2E on Solana mainnet: register a name, write a record, set it as
// primary — all signed by ~/.config/solana/id.json. Judgement is read back from
// the chain; the evidence file stores the transactions and the post-state.
//
//   node solana/scripts/live-sns-register.mjs [--name=oaken-sns] [--dry]
//
// This spends real SOL: a 5+ character name is $20 at the Pyth rate, plus rent
// for the name/reverse accounts and the record account. The caller funds the
// wallet first.
import fs from 'node:fs';
import { Connection, Keypair, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { makeSns, priceUsd, fmtSol } from '../../app/sns-build.js';

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const RPC = arg('rpc', 'https://solana-rpc.publicnode.com');
const NAME = String(arg('name', 'oaken-sns')).trim().toLowerCase();
const DRY = process.argv.includes('--dry');
const EVIDENCE = new URL('../_live-sns-evidence.json', import.meta.url);
const SOLSCAN = (p) => `https://solscan.io${p}`;

const conn = new Connection(RPC, 'confirmed');
const S = makeSns({ ...(await import('@solana/web3.js')), Buffer });
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(`${process.env.USERPROFILE}/.config/solana/id.json`, 'utf8'),
)));

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log((ok ? '✓' : '✗') + ' ' + name + (detail ? '  ' + detail : ''));
};

async function confirm(sig, ms = 90000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => null);
    const s = st?.value?.[0];
    if (s?.err) throw new Error(`on-chain failure: ${JSON.stringify(s.err).slice(0, 160)}`);
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return s;
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error('not confirmed within 90s — check the signature on Solscan before retrying: ' + sig);
}

async function send(ixs, units = 250000) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 }));
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });
  await confirm(sig);
  return sig;
}

function decodeReverse(data) {
  // Full name-registry account: 96-byte header, then the borsh string.
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = dv.getUint32(96, true);
  return Buffer.from(data.subarray(100, 100 + len)).toString('utf8').replace(/^\u0000/, '');
}

(async () => {
  console.log(`wallet ${kp.publicKey.toBase58()} · name ${NAME}.sns · RPC ${RPC}`);
  const before = await conn.getBalance(kp.publicKey);
  console.log(`balance ${fmtSol(before)}`);
  const nameKey = S.nameAccount(NAME);
  const reverseKey = S.reverseAccount(nameKey);
  const existing = await conn.getAccountInfo(nameKey);
  if (existing) { console.error(`✗ ${NAME}.sns is already registered (${nameKey.toBase58()})`); process.exit(1); }

  const feed = await conn.getAccountInfo(S.pythFeed());
  if (!feed) { console.error('✗ price feed account did not answer'); process.exit(1); }
  const pyth = S.parsePyth(feed.data);
  const lamports = S.quoteLamports(NAME, pyth);
  const usd = priceUsd(NAME);
  console.log(`quote $${usd} at SOL/USD ${(Number(pyth.price) * 10 ** pyth.exponent).toFixed(4)} → ${fmtSol(lamports)} wrapped (+3% buffer)`);

  if (before < lamports + 5_000_000n) {
    console.error(`✗ not enough SOL: need ~${fmtSol(lamports + 5_000_000n)}, have ${fmtSol(before)}`);
    process.exit(1);
  }
  if (DRY) { console.log('(--dry: not sending)'); return; }

  /* ── 1. register ─────────────────────────────────────────────────────── */
  console.log('\n① register');
  const regSig = await send(S.registerIxs({ buyer: kp.publicKey, label: NAME, lamports }), 250000);
  const regInfo = await conn.getAccountInfo(nameKey);
  const reg = regInfo ? S.decodeRegistry(regInfo.data) : null;
  const revInfo = await conn.getAccountInfo(reverseKey);
  const revLabel = revInfo ? decodeReverse(revInfo.data) : null;
  check('name account exists', Boolean(regInfo), nameKey.toBase58());
  check('name account is owned by the wallet', reg?.owner === kp.publicKey.toBase58(), reg?.owner || '');
  check('name account parent is the SNS root', reg?.parent === '58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx', reg?.parent || '');
  check('reverse lookup stores the label', revLabel === NAME, String(revLabel));

  /* ── 2. record ───────────────────────────────────────────────────────── */
  console.log('\n② record');
  const recValue = "OAKEN's .sns name — registered live on Solana.";
  const recKey = S.recordAccount(NAME, 'bio');
  const recExists = Boolean(await conn.getAccountInfo(recKey));
  const recSig = await send([S.recordIx({
    label: NAME, record: 'bio', value: recValue, owner: kp.publicKey, payer: kp.publicKey, exists: recExists,
  })], 200000);
  const recInfo = await conn.getAccountInfo(recKey);
  const rec = recInfo ? S.decodeRecord(recInfo.data) : null;
  check('record account exists', Boolean(recInfo), recKey.toBase58());
  check('record content matches', rec?.text === recValue, JSON.stringify(rec?.text || ''));

  /* ── 3. primary ──────────────────────────────────────────────────────── */
  console.log('\n③ primary');
  const primaryKey = S.primaryAccount(kp.publicKey);
  const priSig = await send([S.primaryIx({ label: NAME, owner: kp.publicKey })], 120000);
  const priInfo = await conn.getAccountInfo(primaryKey);
  const pri = priInfo ? S.decodePrimary(priInfo.data) : null;
  check('primary account exists', Boolean(priInfo), primaryKey.toBase58());
  check('primary points at this name', pri?.nameAccount === nameKey.toBase58(), pri?.nameAccount || '');

  const after = await conn.getBalance(kp.publicKey);
  const cost = before - after;
  console.log(`\nbalance ${fmtSol(before)} → ${fmtSol(after)}  (cost ${fmtSol(cost)})`);

  const evidence = {
    at: new Date().toISOString(),
    network: 'mainnet-beta',
    wallet: kp.publicKey.toBase58(),
    name: `${NAME}.sns`,
    nameAccount: nameKey.toBase58(),
    reverseAccount: reverseKey.toBase58(),
    recordAccount: recKey.toBase58(),
    primaryAccount: primaryKey.toBase58(),
    quote: { usd, solUsd: Number(pyth.price) * 10 ** pyth.exponent, wrappedLamports: lamports.toString() },
    transactions: { register: regSig, record: recSig, primary: priSig },
    state: {
      owner: reg?.owner,
      parent: reg?.parent,
      reverseLabel: revLabel,
      record: rec?.text,
      primaryNameAccount: pri?.nameAccount,
    },
    balance: { before: before.toString(), after: after.toString(), costLamports: cost.toString() },
    checks,
    links: {
      register: SOLSCAN('/tx/' + regSig),
      record: SOLSCAN('/tx/' + recSig),
      primary: SOLSCAN('/tx/' + priSig),
      account: SOLSCAN('/account/' + nameKey.toBase58()),
    },
  };
  fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  console.log('\nregister', evidence.links.register);
  console.log('record  ', evidence.links.record);
  console.log('primary ', evidence.links.primary);
  console.log('account ', evidence.links.account);
  console.log('evidence', EVIDENCE.pathname);

  if (checks.some((c) => !c.ok)) process.exit(1);
})().catch((e) => { console.error('✗ ' + (e?.message || e)); process.exit(1); });
