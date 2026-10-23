// 真链验证 OAKEN Factory（Solana 自有发射）：SPL mint + Metaplex 元数据 + 吊销 mint 权限。
//   node solana/scripts/live-own-launch.mjs
// 判据取链：mint 账户存在、mint authority 为 None、Metaplex 的 name/symbol/uri 逐字读回。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { ProxyAgent, fetch as ufetch } from '../../contracts/node_modules/undici/index.js';
import { makeSolana } from '../../app/solana-build.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const IMG_ENDPOINT = 'https://oaken-img.littelcasey2932001.workers.dev';
const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const IMG_KEY = /^OAKEN_IMG_KEY=(.+)$/m.exec(envText)?.[1]?.trim();

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.USERPROFILE}/.config/solana/id.json`))));
const proxy = new ProxyAgent('http://127.0.0.1:12000');
const conn = new Connection('https://api.mainnet-beta.solana.com', {
  commitment: 'confirmed',
  fetch: (u, o) => ufetch(u, { ...o, dispatcher: proxy }),
});
const A = makeSolana({ ...(await import('@solana/web3.js')), Buffer });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(ixs, signers, units = 350_000) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 40_000 }));
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(kp, ...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  console.log('  sent', sig, tx.serialize().length, 'B');
  for (let i = 0; i < 60; i++) {
    await sleep(1200);
    const s = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (s?.err) throw new Error('tx failed: ' + JSON.stringify(s.err));
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return sig;
  }
  throw new Error('not confirmed: ' + sig);
}

(async () => {
  console.log('== OAKEN Factory live test ==');
  const bal = await conn.getBalance(kp.publicKey);
  console.log('wallet', kp.publicKey.toBase58(), (bal / 1e9).toFixed(6), 'SOL');
  if (bal < 10_000_000) throw new Error('need at least 0.01 SOL');

  const file = fs.readFileSync(path.join(ROOT, 'public', 'logo512.png'));
  const ir = await ufetch(`${IMG_ENDPOINT}/put`, {
    dispatcher: proxy, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-oaken-key': IMG_KEY },
    body: JSON.stringify({ data: file.toString('base64'), type: 'image/png' }),
  });
  const ij = await ir.json();
  const image = `${IMG_ENDPOINT}/i/${ij.id}`;
  const mr = await ufetch(`${IMG_ENDPOINT}/put-meta`, {
    dispatcher: proxy, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-oaken-key': IMG_KEY },
    body: JSON.stringify({
      name: 'Oaken Factory Test', symbol: 'OAKF', description: 'OAKEN Factory live test — fixed supply, mint authority revoked.',
      image, website: 'https://oaken.one', twitter: 'https://x.com/oakenhood', showName: true, createdOn: 'oaken.one', standard: 'SPL',
    }),
  });
  const mj = await mr.json();
  const uri = `${IMG_ENDPOINT}/m/${mj.id}.json`;
  console.log('image', image);
  console.log('metadata', uri);

  const name = 'Oaken Factory Test';
  const symbol = 'OAKF';
  const decimals = 6;
  const supply = 1_000_000n * 10n ** 6n;
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const owner = kp.publicKey;
  const userAta = A.ata(owner, mint)[0];
  const rent = await conn.getMinimumBalanceForRentExemption(82);

  console.log('— tx1: mint + ATA + supply');
  const sig1 = await send([
    A.createMintAccountIx({ payer: owner, mint, lamports: rent }),
    A.initializeMint2Ix({ mint, decimals, mintAuthority: owner }),
    A.createAtaIdempotentIx({ payer: owner, address: userAta, owner, mint }),
    A.mintToIx({ mint, destination: userAta, authority: owner, amount: supply }),
  ], [mintKp], 300_000);

  console.log('— tx2: Metaplex metadata + revoke mint authority');
  const [metadata] = A.metadataPda(mint);
  const sig2 = await send([
    A.createMetadataV3Ix({
      metadata, mint, mintAuthority: owner, payer: owner, updateAuthority: owner,
      name, symbol, uri, isMutable: false,
    }),
    A.setAuthorityIx({ mint, currentAuthority: owner, authorityType: 0, newAuthority: null }),
    A.memoIx(`OAKEN Factory · ${symbol} · fixed supply · no mint authority`),
  ], [], 350_000);

  // 判据取链
  const mintInfo = await conn.getAccountInfo(mint);
  if (!mintInfo) throw new Error('mint account missing');
  const mintAuthTag = mintInfo.data.readUInt32LE(0);
  if (mintAuthTag !== 0) throw new Error('mint authority is still set: tag ' + mintAuthTag);
  const metaInfo = await conn.getAccountInfo(metadata);
  if (!metaInfo) throw new Error('metadata account missing');
  const md = await A.readMetadata(conn, mint);
  if (!md) throw new Error('metadata could not be decoded');
  if (md.name !== name || md.symbol !== symbol || md.uri !== uri) throw new Error('metadata mismatch: ' + JSON.stringify(md));
  const balAfter = await conn.getBalance(kp.publicKey);

  const ev = {
    at: new Date().toISOString(), network: 'mainnet-beta', factory: 'OAKEN Factory (SPL + Metaplex)',
    wallet: owner.toBase58(), mint: mint.toBase58(), name, symbol, decimals, supply: supply.toString(),
    metadata: uri, image, transactions: { mint: sig1, metadata: sig2 },
    checks: { mintAuthority: 'revoked', metadata: md }, costSol: ((bal - balAfter) / 1e9).toFixed(6),
  };
  fs.writeFileSync(path.join(ROOT, 'solana', '_live-own-launch-evidence.json'), JSON.stringify(ev, null, 2));
  console.log('✓ mint', mint.toBase58());
  console.log('  solscan', `https://solscan.io/token/${mint.toBase58()}`);
  console.log('  metadata', md.name, md.symbol, md.uri);
  console.log('  mint authority revoked; cost', ev.costSol, 'SOL');
})().catch((e) => { console.error('✗ ' + (e?.message || e)); process.exit(1); });
