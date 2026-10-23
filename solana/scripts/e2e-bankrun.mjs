// 本地端到端：**进程内的 bank**（`solana-bankrun`）跑真的 SBF 字节码。
//
// 为什么不是 solana-test-validator：那东西在这台 Windows 上起不来（建符号链接要
// 开发者模式/管理员，报 1314）；为什么不是 `cargo test-sbf`：它的测试依赖里
// 有 `agave-precompiles → openssl-sys`，在 Git Bash 下要从源码编 OpenSSL，
// 缺 Perl 模块。bankrun 把同一个 bank 做成了 Node 包（预编译二进制），
// 既不起端口也不碰 openssl。
//
// 两个外部程序（SPL Token / ATA）是 `solana program dump` **从主网 dump 下来的真字节码** ——
// 我们程序里那些手写的 CPI 字节只有对着真程序跑才算验过。
//
// 用的是**页面那份**指令构造（`app/solana-build.js`）：所以这个脚本同时证明
// "页面和程序对协议的理解是同一份"。
//
//   node scripts/e2e-bankrun.mjs
import { start } from 'solana-bankrun';
import * as web3 from '@solana/web3.js';
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getMint,
  createAccount, createInitializeAccountInstruction, createMintToInstruction,
  TOKEN_PROGRAM_ID as SPL_TOKEN,
} from '@solana/spl-token';
import { makeSolana } from '../../frontend/app/solana-build.js';

const S = makeSolana(web3);
const { Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = web3;

let ok = 0, bad = 0;
const check = (label, got, want) => {
  const pass = String(got) === String(want);
  if (pass) ok++; else bad++;
  console.log(`  ${pass ? '✓' : '✗'} ${label}${pass ? '' : `   期望 ${want}，拿到 ${got}`}`);
};

(async () => {
  const ctx = await start([
    { name: 'oaken_lock', programId: S.oaken },
    { name: 'spl_token', programId: SPL_TOKEN },
    { name: 'spl_associated_token_account', programId: S.ataProgram },
  ], []);

  const payer = Keypair.generate();
  ctx.setAccount(payer.publicKey, {
    lamports: 100 * LAMPORTS_PER_SOL,
    data: Buffer.alloc(0),
    owner: SystemProgram.programId,
    executable: false,
  });

  const send = async (ixs, signers = []) => {
    const { blockhash } = await ctx.banksClient.getLatestBlockhash();
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payer.publicKey });
    for (const ix of ixs) tx.add(ix);
    tx.sign(payer, ...signers);
    return ctx.banksClient.processTransaction(tx);
  };

  const tokenAmount = async (addr) => BigInt(await getAccount(ctx.banksClient, addr).then((a) => a.amount));

  console.log('\n① 准备（真 SPL Token 程序）');
  const mint = await createMint(ctx.banksClient, payer, payer.publicKey, null, 6);   // 6 位小数，故意不用 9/18
  const payerAta = await getOrCreateAssociatedTokenAccount(ctx.banksClient, payer, mint, payer.publicKey);
  const total = 1_000_000_000n;
  await mintTo(ctx.banksClient, payer, mint, payerAta.address, payer, total);
  check('付款人拿到代币', await tokenAmount(payerAta.address), total);
  check('mint 精度是 6', (await getMint(ctx.banksClient, mint)).decimals, 6);
  check('下一个 id 是 0', await S.readNextId(ctx.banksClient), 0);

  console.log('\n② CreateLock');
  const id = await S.readNextId(ctx.banksClient);
  const [lockPda] = S.lockPda(id);
  const [vault] = S.ata(lockPda, mint);
  const [config] = S.configPda();
  const amount = 400_000_000n;
  const unlock = Math.floor(Date.now() / 1000) + 3600;

  await send([S.createLockIx(
    { id, amount, unlockDate: unlock, revocable: false, label: 'Team' },
    S.createLockKeys({
      payer: payer.publicKey, beneficiary: payer.publicKey, mint,
      source: payerAta.address, lock: lockPda, vault, config,
    }),
  )]);

  const lock = await S.readLock(ctx.banksClient, id);
  check('锁存在，id 对', lock.id, BigInt(id));
  check('金额记的是真值', lock.amount, amount);
  check('标签', lock.label, 'Team');
  check('标的 mint', lock.mint, mint.toBase58());
  check('不可撤', lock.revocable, false);
  check('金库真的收到币', await tokenAmount(vault), amount);
  check('付款人少了这么多', await tokenAmount(payerAta.address), total - amount);
  check('计数器 +1', await S.readNextId(ctx.banksClient), 1);

  console.log('\n③ 到期前 claim（应当失败）');
  const dest = S.ata(payer.publicKey, mint)[0];
  let early = false;
  try {
    await send([S.claimIx(S.claimKeys({ lock: lockPda, vault, mint, destination: dest, payer: payer.publicKey }))]);
  } catch { early = true; }
  check('没到期领不出来', early, true);
  check('失败的那笔没动钱', await tokenAmount(vault), amount);

  console.log('\n④ 到期后 claim');
  // 同一段到期逻辑，只是日期在过去 —— 再造一把（本地 bank 里没有"拨块时间"的接口）
  const id2 = await S.readNextId(ctx.banksClient);
  const [lockB] = S.lockPda(id2);
  const [vaultB] = S.ata(lockB, mint);
  await send([S.createLockIx(
    { id: id2, amount, unlockDate: Math.floor(Date.now() / 1000) - 1, revocable: false, label: 'Advisors' },
    S.createLockKeys({
      payer: payer.publicKey, beneficiary: payer.publicKey, mint,
      source: payerAta.address, lock: lockB, vault: vaultB, config,
    }),
  )]);
  check('第二把已到期', (await S.readLock(ctx.banksClient, id2)).unlockDate < Math.floor(Date.now() / 1000), true);

  await send([S.claimIx(S.claimKeys({ lock: lockB, vault: vaultB, mint, destination: dest, payer: payer.publicKey }))]);
  check('受益人拿到币', await tokenAmount(dest), amount);
  check('金库空了', await tokenAmount(vaultB), 0n);
  check('claimed 记账', (await S.readLock(ctx.banksClient, id2)).claimed, amount);

  let twice = false;
  try {
    await send([S.claimIx(S.claimKeys({ lock: lockB, vault: vaultB, mint, destination: dest, payer: payer.publicKey }))]);
  } catch { twice = true; }
  check('领不了第二次', twice, true);

  console.log('\n⑤ 转让与放弃');
  const heir = Keypair.generate();
  await send([S.transferIx({ lock: lockB, beneficiary: payer.publicKey, newBeneficiary: heir.publicKey })]);
  check('受益人换了', (await S.readLock(ctx.banksClient, id2)).beneficiary, heir.publicKey.toBase58());

  let outsider = false;
  try {
    await send([S.transferIx({ lock: lockB, beneficiary: payer.publicKey, newBeneficiary: payer.publicKey })]);
  } catch { outsider = true; }
  check('前任受益人转不动了', outsider, true);

  await send([S.renounceIx({ lock: lockPda, beneficiary: payer.publicKey })]);
  check('renounced 记上了', (await S.readLock(ctx.banksClient, id)).renounced, true);
  check('放弃之后可领额是 0', S.claimable(await S.readLock(ctx.banksClient, id)), 0n);

  console.log('\n⑥ 撤锁');
  let nonRevocable = false;
  try {
    await send([S.revokeIx({ lock: lockPda, creator: payer.publicKey, vault, mint, destination: payerAta.address })]);
  } catch { nonRevocable = true; }
  check('没声明 revocable 的撤不动', nonRevocable, true);

  const id3 = await S.readNextId(ctx.banksClient);
  const [lockC] = S.lockPda(id3);
  const [vaultC] = S.ata(lockC, mint);
  await send([S.createLockIx(
    { id: id3, amount, unlockDate: Math.floor(Date.now() / 1000) + 3600, revocable: true, label: 'Marketing' },
    S.createLockKeys({
      payer: payer.publicKey, beneficiary: payer.publicKey, mint,
      source: payerAta.address, lock: lockC, vault: vaultC, config,
    }),
  )]);
  const beforeRevoke = await tokenAmount(payerAta.address);
  await send([S.revokeIx({ lock: lockC, creator: payer.publicKey, vault: vaultC, mint, destination: payerAta.address })]);
  check('币退回来了', (await tokenAmount(payerAta.address)) - beforeRevoke, amount);
  const c = await S.readLock(ctx.banksClient, id3);
  check('revoked 记上了', c.revoked, true);
  check('撤了之后可领额是 0', S.claimable(c), 0n);

  console.log(`\n${bad === 0 ? `✓ 全部通过（${ok} 条）` : `✗ ${bad} 条没过（通过 ${ok}）`}`);
  process.exitCode = bad === 0 ? 0 : 1;
})().catch((e) => { console.error('✗ ' + (e.message || e)); process.exit(1); });
