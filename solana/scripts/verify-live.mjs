// 复跑真链实验的判据（只读）：pump mint、5U 买入、Jupiter 锁/领取、OAKEN Factory mint。
//   node solana/scripts/verify-live.mjs
// 退出码 0 = 全部对上；任何一条不对就 1。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
import { ProxyAgent, fetch as ufetch } from '../../contracts/node_modules/undici/index.js';
import { makeSolana } from '../../app/solana-build.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const proxy = new ProxyAgent('http://127.0.0.1:12000');
const conn = new Connection('https://api.mainnet-beta.solana.com', {
  commitment: 'confirmed', fetch: (u, o) => ufetch(u, { ...o, dispatcher: proxy }),
});
const A = makeSolana({ ...(await import('@solana/web3.js')), Buffer });
let ok = true;
const check = (name, pass, detail = '') => {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!pass) ok = false;
};
async function txOk(sig) {
  const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  return Boolean(t && !t.meta?.err);
}

const main = JSON.parse(fs.readFileSync(path.join(ROOT, 'solana', '_live-test-evidence.json'), 'utf8'));
const own = JSON.parse(fs.readFileSync(path.join(ROOT, 'solana', '_live-own-launch-evidence.json'), 'utf8'));

console.log('== pump.fun experiment ==');
check('create tx confirmed', await txOk(main.create.signature));
check('buy tx confirmed', await txOk(main.buy.signature));
check('lock tx confirmed', await txOk(main.lock.signature));
check('claim tx confirmed', await txOk(main.claim.signature));
const mintInfo = await conn.getAccountInfo(new PublicKey(main.mint));
check('pump mint exists', Boolean(mintInfo), main.mint);
const escrowInfo = await conn.getAccountInfo(new PublicKey(main.lock.escrow));
check('escrow exists', Boolean(escrowInfo), main.lock.escrow);
if (escrowInfo) {
  const e = A.decodeJupEscrow(escrowInfo.data);
  check('escrow recipient = wallet', e.recipient === main.wallet, e.recipient);
  check('escrow unlock time matches evidence', e.cliffTime === main.lock.unlockAt, new Date(e.cliffTime * 1000).toISOString());
  check('escrow totalClaimed = locked amount', e.totalClaimedAmount === BigInt(main.lock.amount), `${e.totalClaimedAmount}/${main.lock.amount}`);
}

console.log('\n== OAKEN Factory experiment ==');
check('mint tx confirmed', await txOk(own.transactions.mint));
check('metadata tx confirmed', await txOk(own.transactions.metadata));
const ownMintInfo = await conn.getAccountInfo(new PublicKey(own.mint));
check('own mint exists', Boolean(ownMintInfo), own.mint);
if (ownMintInfo) {
  const tag = ownMintInfo.data.readUInt32LE(0);
  check('mint authority revoked (COption tag 0)', tag === 0, 'tag=' + tag);
}
const md = await A.readMetadata(conn, new PublicKey(own.mint));
check('Metaplex name/symbol/uri match', Boolean(md) && md.name === own.name && md.symbol === own.symbol && md.uri === own.metadata,
  md ? `${md.name} ${md.symbol} ${md.uri}` : 'metadata missing');

console.log(ok ? '\n✓ live evidence verified' : '\n✗ live evidence mismatch');
process.exit(ok ? 0 : 1);
