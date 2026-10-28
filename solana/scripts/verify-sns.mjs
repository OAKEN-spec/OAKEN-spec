// Read back an `.sns` name, its reverse lookup, a record and the wallet's primary
// domain. Read-only unless `--evidence` is passed (then it updates the live E2E
// evidence file with the post-state).
//
//   node solana/scripts/verify-sns.mjs [--name=oaken-sns] [--evidence]
import fs from 'node:fs';
import { Connection, Keypair } from '@solana/web3.js';
import { makeSns, fmtSol } from '../../app/sns-build.js';

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const RPC = arg('rpc', 'https://solana-rpc.publicnode.com');
const NAME = String(arg('name', 'oaken-sns')).trim().toLowerCase();
const WRITE = process.argv.includes('--evidence');
const EVIDENCE = new URL('../_live-sns-evidence.json', import.meta.url);
const conn = new Connection(RPC, 'confirmed');
const S = makeSns({ ...(await import('@solana/web3.js')), Buffer });
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(`${process.env.USERPROFILE}/.config/solana/id.json`, 'utf8'),
)));

function decodeReverse(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = dv.getUint32(96, true);
  return Buffer.from(data.subarray(100, 100 + len)).toString('utf8').replace(/^\u0000/, '');
}

const out = {};
const check = (name, ok, detail = '') => {
  out[name] = { ok: Boolean(ok), detail: String(detail) };
  console.log((ok ? '✓' : '✗') + ' ' + name + (detail ? '  ' + detail : ''));
};

const nameKey = S.nameAccount(NAME);
const reverseKey = S.reverseAccount(nameKey);
const nameInfo = await conn.getAccountInfo(nameKey);
const revInfo = await conn.getAccountInfo(reverseKey);
const reg = nameInfo ? S.decodeRegistry(nameInfo.data) : null;
const rev = revInfo ? decodeReverse(revInfo.data) : null;
const recKey = S.recordAccount(NAME, 'bio');
const recInfo = await conn.getAccountInfo(recKey);
const rec = recInfo ? S.decodeRecord(recInfo.data) : null;
const primaryKey = S.primaryAccount(kp.publicKey);
const priInfo = await conn.getAccountInfo(primaryKey);
const pri = priInfo ? S.decodePrimary(priInfo.data) : null;
const bal = await conn.getBalance(kp.publicKey);

check('name account exists', Boolean(nameInfo), nameKey.toBase58());
check('owner is the wallet', reg?.owner === kp.publicKey.toBase58(), reg?.owner || '');
check('parent is the SNS root', reg?.parent === '58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx', reg?.parent || '');
check('reverse stores the label', rev === NAME, String(rev));
check('bio record exists', Boolean(recInfo), recKey.toBase58());
check('bio record content matches', /OAKEN/.test(String(rec?.text)), JSON.stringify(rec?.text || ''));
check('primary account exists', Boolean(priInfo), primaryKey.toBase58());
check('primary points at this name', pri?.nameAccount === nameKey.toBase58(), pri?.nameAccount || '');
console.log('balance', fmtSol(bal));

if (WRITE) {
  const ev = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8'));
  ev.state.reverseLabel = rev;
  ev.state.record = rec?.text;
  ev.state.primaryNameAccount = pri?.nameAccount;
  ev.balance.after = bal.toString();
  for (const [name, r] of Object.entries(out)) {
    const hit = ev.checks.find((c) => c.name.startsWith(name.slice(0, 14)));
    if (hit) { hit.ok = r.ok; hit.detail = r.detail; }
  }
  // The original run decoded the reverse account at the wrong offset; replace
  // that one check even if the prefix lookup above missed it.
  const bad = ev.checks.find((c) => c.name === 'reverse lookup stores the label');
  if (bad) { bad.ok = out['reverse stores the label'].ok; bad.detail = out['reverse stores the label'].detail; }
  fs.writeFileSync(EVIDENCE, JSON.stringify(ev, null, 2) + '\n');
  console.log('evidence updated', EVIDENCE.pathname);
}
if (Object.values(out).some((x) => !x.ok)) process.exit(1);
