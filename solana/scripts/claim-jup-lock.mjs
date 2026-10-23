// 领取 Jupiter Lock 的 1 小时实验锁（到期后运行）。
//   node solana/scripts/claim-jup-lock.mjs --wait     # 等到 escrow 的 cliff 再领
//   node solana/scripts/claim-jup-lock.mjs            # 到期了就直接领
//
// 判据取链：escrow 余额减少、钱包 token 余额增加；把结果追加到 evidence 文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { ProxyAgent, fetch as ufetch } from '../../contracts/node_modules/undici/index.js';
import { makeSolana } from '../../app/solana-build.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const EV = path.join(ROOT, 'solana', '_live-test-evidence.json');
const evidence = JSON.parse(fs.readFileSync(EV, 'utf8'));
const WAIT = process.argv.includes('--wait');

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.USERPROFILE}/.config/solana/id.json`))));
const proxy = new ProxyAgent('http://127.0.0.1:12000');
const conn = new Connection('https://api.mainnet-beta.solana.com', {
  commitment: 'confirmed',
  fetch: (u, o) => ufetch(u, { ...o, dispatcher: proxy }),
});
const A = makeSolana({ ...(await import('@solana/web3.js')), Buffer });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escrow = new PublicKey(evidence.lock.escrow);
const mint = new PublicKey(evidence.mint);
const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

(async () => {
  console.log('escrow', evidence.lock.escrow, 'unlock', evidence.lock.unlockAtIso);
  if (WAIT) {
    for (;;) {
      const now = Number(await conn.getBlockTime(await conn.getSlot('confirmed')));
      const left = evidence.lock.unlockAt - now;
      if (left <= 5) break;
      console.log(`waiting ${left}s…`);
      await sleep(Math.min(left + 5, 300) * 1000);
    }
  }
  const info = await conn.getAccountInfo(escrow);
  if (!info) throw new Error('escrow account missing');
  const e = A.decodeJupEscrow(info.data);
  const now = Number(await conn.getBlockTime(await conn.getSlot('confirmed')));
  if (now < e.cliffTime) throw new Error(`not unlocked yet: ${e.cliffTime - now}s left`);

  const [escrowToken] = A.ata(escrow, mint, T22);
  const [recipientToken] = A.ata(kp.publicKey, mint, T22);
  const beforeEscrow = BigInt((await conn.getTokenAccountBalance(escrowToken)).value.amount);
  const beforeWallet = BigInt((await conn.getTokenAccountBalance(recipientToken)).value.amount);
  console.log('before: escrow', beforeEscrow.toString(), 'wallet', beforeWallet.toString());

  const ix = A.jupClaimV2Ix({
    escrow, tokenMint: mint, escrowToken,
    recipient: kp.publicKey, recipientToken, tokenProgram: T22,
    maxAmount: 2n ** 64n - 1n,
  });
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 30_000 }));
  tx.add(ix);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  console.log('claim sent', sig);
  for (let i = 0; i < 60; i++) {
    await sleep(1200);
    const s = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (s?.err) throw new Error('claim failed: ' + JSON.stringify(s.err));
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) break;
  }
  const afterEscrow = BigInt((await conn.getTokenAccountBalance(escrowToken)).value.amount);
  const afterWallet = BigInt((await conn.getTokenAccountBalance(recipientToken)).value.amount);
  console.log('after:  escrow', afterEscrow.toString(), 'wallet', afterWallet.toString());
  if (afterEscrow >= beforeEscrow) throw new Error('escrow balance did not decrease — claim did not move tokens');
  if (afterWallet <= beforeWallet) throw new Error('wallet balance did not increase');
  evidence.claim = {
    signature: sig, at: new Date().toISOString(),
    escrowBefore: beforeEscrow.toString(), escrowAfter: afterEscrow.toString(),
    walletBefore: beforeWallet.toString(), walletAfter: afterWallet.toString(),
  };
  fs.writeFileSync(EV, JSON.stringify(evidence, null, 2));
  console.log('✓ claimed; evidence updated');
})().catch((e) => { console.error('✗ ' + (e?.message || e)); process.exit(1); });
