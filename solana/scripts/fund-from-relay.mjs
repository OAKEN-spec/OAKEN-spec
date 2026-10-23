// 把 4663 上的 ETH 经 Relay（intents）换成 Solana 的 SOL。
//
//   node solana/scripts/fund-from-relay.mjs --dry          # 只报价，不发
//   node solana/scripts/fund-from-relay.mjs                # 默认 0.0045 ETH
//   node solana/scripts/fund-from-relay.mjs 0.003
//
// 用的是 **legacy 钥匙**（`DEPLOYER_KEY_LEGACY_4663`，4663 上余额比现役部署钥匙多），
// 收款人是 `~/.config/solana/id.json` 的地址。判据取对手链余额 —— Relay 状态说 success
// 不等于钱到了。
//
// ⚠ 4663 的交易必须显式给 gasLimit（估算不可靠）；Relay API 走**直连**（走系统代理
//   反而在 TLS 握手阶段被 reset，2026-10-20 实测）。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ProxyAgent, fetch as ufetch } from '../../contracts/node_modules/undici/index.js';

const require_ = createRequire(import.meta.url);
const { ethers } = require_('../../contracts/node_modules/ethers');

const ROOT = new URL('../../', import.meta.url);
const RELAY = 'https://api.relay.link';
const RPC_4663 = 'https://rpc.mainnet.chain.robinhood.com';
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const DEST_CHAIN = 792703809;              // Relay 的 Solana mainnet
const ZERO = '0x0000000000000000000000000000000000000000';
const SOL_MINT = '11111111111111111111111111111111';
const DRY = process.argv.includes('--dry');
const amountEth = Number(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '0.0045');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envText = fs.readFileSync(new URL('.env', ROOT), 'utf8');
const legacyKey = /^DEPLOYER_KEY_LEGACY_4663=(.+)$/m.exec(envText)?.[1]?.trim();
if (!legacyKey) { console.error('✗ .env 里没有 DEPLOYER_KEY_LEGACY_4663'); process.exit(1); }

const solKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.USERPROFILE}/.config/solana/id.json`))));
const solAddress = solKp.publicKey.toBase58();

const ethProvider = new ethers.JsonRpcProvider(RPC_4663, 4663, { staticNetwork: true });
const ethWallet = new ethers.Wallet(legacyKey, ethProvider);

const proxy = new ProxyAgent('http://127.0.0.1:12000');
const solConn = new Connection(SOLANA_RPC, {
  commitment: 'confirmed',
  fetch: (u, o) => ufetch(u, { ...o, dispatcher: proxy }),
});

(async () => {
  console.log(`桥        4663 → Solana   ${amountEth} ETH`);
  const evmBalance = await ethProvider.getBalance(ethWallet.address);
  const solBefore = await solConn.getBalance(solKp.publicKey);
  console.log(`EVM 钱包  ${ethWallet.address}   ${ethers.formatEther(evmBalance)} ETH`);
  console.log(`SOL 钱包  ${solAddress}   ${(solBefore / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  if (evmBalance < ethers.parseEther(String(amountEth))) { console.error('✗ EVM 余额不够'); process.exit(1); }

  const body = {
    user: ethWallet.address,
    recipient: solAddress,
    originChainId: 4663,
    destinationChainId: DEST_CHAIN,
    originCurrency: ZERO,
    destinationCurrency: SOL_MINT,
    amount: ethers.parseEther(String(amountEth)).toString(),
    tradeType: 'EXACT_INPUT',
  };
  const qr = await fetch(`${RELAY}/quote/v2`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const quote = await qr.json();
  if (!qr.ok) { console.error('✗ 报价失败：', JSON.stringify(quote).slice(0, 300)); process.exit(1); }
  const out = quote.details?.currencyOut;
  console.log(`报价      到手 ${out?.amountFormatted} ${out?.currency?.symbol}   冲击 ${quote.details?.totalImpact?.percent}%   ${quote.details?.timeEstimate}s`);
  const items = (quote.steps || []).flatMap((s) => s.items || []);
  if (items.length !== 1) { console.error(`✗ 这一步有 ${items.length} 条交易，脚本只处理 1 条`); process.exit(1); }
  const item = items[0];
  const requestId = new URL(`${RELAY}${item.check.endpoint}`).searchParams.get('requestId');
  console.log(`存款合约  ${item.data.to}   值 ${item.data.value}   requestId ${requestId}`);
  if (DRY) { console.log('（--dry：只报价，不发）'); return; }

  const tx = await ethWallet.sendTransaction({
    to: item.data.to, data: item.data.data, value: BigInt(item.data.value), gasLimit: 600_000n,
  });
  console.log(`已发      ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`已上块    ${rc.blockNumber}   gasUsed ${rc.gasUsed}`);

  process.stdout.write('等 Solana 到账');
  let status = 'pending';
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    process.stdout.write('.');
    try {
      const s = await (await fetch(`${RELAY}/intents/status/v3?requestId=${requestId}`)).json();
      status = s.status;
      if (status === 'success' || status === 'failure' || status === 'refund') break;
    } catch { /* 抖动重试 */ }
  }
  console.log(`\n状态      ${status}`);
  if (status !== 'success') { console.error('✗ 没到 success —— 去 relay.link 查 requestId：' + requestId); process.exit(1); }
  const solAfter = await solConn.getBalance(solKp.publicKey);
  console.log(`到手      ${((solAfter - solBefore) / LAMPORTS_PER_SOL).toFixed(6)} SOL（余额 ${(solAfter / LAMPORTS_PER_SOL).toFixed(6)}）`);
  if (solAfter <= solBefore) { console.error('✗ 状态 success 但余额没涨 —— 别信状态，信余额'); process.exit(1); }
})().catch((e) => { console.error('✗ ' + (e?.message || e)); process.exit(1); });
