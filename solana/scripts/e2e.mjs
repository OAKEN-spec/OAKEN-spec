// 端到端：**建币 → 锁 → 到期前领被拒 → 到期领 → 转让 → 放弃 → 撤锁**。
//
// 判据全部取链：每一步之后重新读账户，断言的是链上的字节，不是脚本自己记的变量。
// 它用的是**页面那份**布局与指令实现（`public/app/solana.js`）—— 所以这个脚本同时
// 也是"页面和程序对同一份协议的理解一致"的证明。
//
//   node scripts/e2e.mjs                     # 本地验证器（需已带程序）
//   node scripts/e2e.mjs --start             # 自己起本地验证器（Windows 受权限限制，见 README）
//   RPC=https://api.devnet.solana.com node scripts/e2e.mjs
//                                            # devnet：用 ~/.config/solana/id.json 付款，不领水
//   PAYER_KEYPAIR=path node scripts/e2e.mjs  # 指定付款 keypair
//
// devnet 上需要：程序已部署、付款钱包里有约 0.2 SOL（三把锁的账户 rent 与手续费）。
// 脚本会从付款钱包给 beneficiary/heir 各转 0.05 SOL —— 它们要自己签领取/转让交易。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import * as web3 from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount } from '@solana/spl-token';
import { makeSolana } from '../../public/app/solana.js';

const RPC = process.env.RPC || 'http://127.0.0.1:8899';
const LOCAL = /127\.0\.0\.1|localhost/.test(RPC);
const S = makeSolana(web3);
const { Keypair, Connection, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = web3;

let ok = 0, bad = 0;
const check = (label, got, want) => {
  const pass = String(got) === String(want);
  if (pass) ok++; else bad++;
  console.log(`  ${pass ? '✓' : '✗'} ${label}${pass ? '' : `   期望 ${want}，拿到 ${got}`}`);
};

async function startValidator() {
  const so = new URL('../target/deploy/oaken_lock.so', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  console.log('起本地验证器（带程序）…');
  const proc = spawn('solana-test-validator', [
    '--bpf-program', S.programId.toBase58(), so, '--reset', '--quiet',
  ], { stdio: 'ignore', detached: false, shell: process.platform === 'win32' });
  return proc;
}

async function waitForRpc(conn, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { await conn.getVersion(); return true; } catch { await sleep(1000); }
  }
  return false;
}

(async () => {
  let validator = null;
  if (process.argv.includes('--start')) validator = await startValidator();
  const conn = new Connection(RPC, 'confirmed');
  if (!(await waitForRpc(conn))) { console.error('✗ 本地验证器没起来（RPC ' + RPC + '）'); process.exit(1); }

  try {
    /* ── 准备：付款账户、一个 6 位小数的代币 ─────────────────────────── */
    console.log('\n① 准备');
    let payer;
    if (LOCAL && !process.env.PAYER_KEYPAIR) {
      payer = Keypair.generate();
      await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 5 * LAMPORTS_PER_SOL));
    } else {
      const kpPath = process.env.PAYER_KEYPAIR || path.join(os.homedir(), '.config', 'solana', 'id.json');
      payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, 'utf8'))));
      console.log('  付款账户 ' + payer.publicKey.toBase58() + '（' + kpPath + '）');
      const bal = await conn.getBalance(payer.publicKey);
      console.log('  余额 ' + (bal / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
      if (bal < 0.15 * LAMPORTS_PER_SOL) {
        console.error('  ✗ 余额不够：devnet 上三把锁约 0.05–0.1 SOL；再留 0.1 给 beneficiary/heir');
        process.exit(1);
      }
    }
    check('付款账户有币', (await conn.getBalance(payer.publicKey)) > 0, true);
    const fund = async (to, sol = 0.05) => {
      await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({
        fromPubkey: payer.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL),
      })), [payer]);
    };

    // 6 位小数：故意不用 18 —— 精度换算的坑只在位数不是 18 的时候才露头
    const mint = await createMint(conn, payer, payer.publicKey, null, 6);
    const payerAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
    const total = 1_000_000_000n;                       // 1000.000000
    await mintTo(conn, payer, mint, payerAta.address, payer.publicKey, total);
    check('付款人拿到代币', (await getAccount(conn, payerAta.address)).amount, total);

    const beneficiary = Keypair.generate();
    await fund(beneficiary.publicKey);                 // 它要自己签 claim/transfer/renounce
    const [config] = S.configPda();
    /* 本地校验器一般从 0 开始，但 devnet 上程序可能已经跑过 —— 判据用**起点**，不写死 0。 */
    const startId = await S.readNextId(conn);
    console.log('  当前下一个 id：' + startId);
    check('计数器读得到', startId >= 0n, true);

    /* ── 建一把锁（未来到期，不可撤）──────────────────────────────────── */
    console.log('\n② CreateLock');
    const id = startId;
    const [lockPda] = S.lockPda(id);
    const [vault] = S.vaultAta(lockPda, mint);
    const amount = 400_000_000n;
    const unlockDate = Math.floor(Date.now() / 1000) + 3600;

    const createIx = S.createLockIx(
      { id, amount, unlockDate, revocable: false, label: 'Team' },
      S.createLockKeys({
        payer: payer.publicKey, beneficiary: beneficiary.publicKey, mint,
        source: payerAta.address, lock: lockPda, vault, config,
      }),
    );
    await sendAndConfirmTransaction(conn, new Transaction().add(createIx), [payer]);

    const lock = await S.readLock(conn, id);
    check('锁存在且 id 对', lock.id, BigInt(id));
    check('金额记的是真值', lock.amount, amount);
    check('受益人', lock.beneficiary, beneficiary.publicKey.toBase58());
    check('标签', lock.label, 'Team');
    check('不可撤', lock.revocable, false);
    check('金库真的收到了币', (await getAccount(conn, vault)).amount, amount);
    check('付款人少了这么多', (await getAccount(conn, payerAta.address)).amount, total - amount);

    /* ── 到期前领：必须被拒 ──────────────────────────────────────────── */
    console.log('\n③ 到期前 claim（应当失败）');
    const dest = S.ata(beneficiary.publicKey, mint);
    const claimIx = S.claimIx(S.claimKeys({
      lock: lockPda, vault, mint, destination: dest[0], payer: beneficiary.publicKey,
    }));
    let rejected = false;
    try {
      await sendAndConfirmTransaction(conn, new Transaction().add(claimIx), [beneficiary]);
    } catch { rejected = true; }
    check('没到期领不出来', rejected, true);
    check('金库里的币没动', (await getAccount(conn, vault)).amount, amount);

    /* ── 拨表到期，再领 ─────────────────────────────────────────────── */
    console.log('\n④ 到期后 claim');
    // 本地验证器上没法直接拨块时间，但可以把"到期时间"当作判断依据的那一侧拨过去：
    // 直接用同一个程序再建一把**已经到期**的锁（unlockDate = now - 1），
    // 这两把锁互不影响，而到期判断走的是同一段代码。
    const id2 = await S.readNextId(conn);
    const [lockPda2] = S.lockPda(id2);
    const [vault2] = S.vaultAta(lockPda2, mint);
    const createIx2 = S.createLockIx(
      { id: id2, amount, unlockDate: Math.floor(Date.now() / 1000) - 1, revocable: false, label: 'Advisors' },
      S.createLockKeys({
        payer: payer.publicKey, beneficiary: beneficiary.publicKey, mint,
        source: payerAta.address, lock: lockPda2, vault: vault2, config,
      }),
    );
    await sendAndConfirmTransaction(conn, new Transaction().add(createIx2), [payer]);
    check('第二把锁已到期', (await S.readLock(conn, id2)).unlockDate < Math.floor(Date.now() / 1000), true);

    const dest2 = S.ata(beneficiary.publicKey, mint);
    // 由**第三方**提交（payer 付 gas），币必须进受益人
    await sendAndConfirmTransaction(conn, new Transaction().add(S.claimIx(S.claimKeys({
      lock: lockPda2, vault: vault2, mint, destination: dest2[0], payer: payer.publicKey,
    }))), [payer]);
    check('受益人拿到了', (await getAccount(conn, dest2[0])).amount, amount);
    check('金库空了', (await getAccount(conn, vault2)).amount, 0n);
    check('claimed 记账', (await S.readLock(conn, id2)).claimed, amount);

    let doubleClaim = false;
    try {
      await sendAndConfirmTransaction(conn, new Transaction().add(S.claimIx(S.claimKeys({
        lock: lockPda2, vault: vault2, mint, destination: dest2[0], payer: beneficiary.publicKey,
      }))), [beneficiary]);
    } catch { doubleClaim = true; }
    check('领不了第二次', doubleClaim, true);

    /* ── 转让 / 放弃 ────────────────────────────────────────────────── */
    console.log('\n⑤ 转让与放弃');
    const heir = Keypair.generate();
    await fund(heir.publicKey);
    await sendAndConfirmTransaction(conn, new Transaction().add(S.transferIx({
      lock: lockPda2, beneficiary: beneficiary.publicKey, newBeneficiary: heir.publicKey,
    })), [beneficiary]);
    check('受益人换了', (await S.readLock(conn, id2)).beneficiary, heir.publicKey.toBase58());

    let outsiderTransfer = false;
    try {
      await sendAndConfirmTransaction(conn, new Transaction().add(S.transferIx({
        lock: lockPda2, beneficiary: beneficiary.publicKey, newBeneficiary: beneficiary.publicKey,
      })), [beneficiary]);
    } catch { outsiderTransfer = true; }
    check('前任受益人转不动了', outsiderTransfer, true);

    await sendAndConfirmTransaction(conn, new Transaction().add(S.renounceIx({
      lock: lockPda, beneficiary: beneficiary.publicKey,
    })), [beneficiary]);
    check('renounced 记上了', (await S.readLock(conn, id)).renounced, true);

    /* ── 撤锁：只有声明可撤的才撤得动 ───────────────────────────────── */
    console.log('\n⑥ 撤锁');
    let revokeNonRevocable = false;
    try {
      await sendAndConfirmTransaction(conn, new Transaction().add(S.revokeIx({
        lock: lockPda, creator: payer.publicKey, vault, mint,
        destination: payerAta.address,
      })), [payer]);
    } catch { revokeNonRevocable = true; }
    check('不可撤的锁撤不动', revokeNonRevocable, true);

    const id3 = await S.readNextId(conn);
    const [lockPda3] = S.lockPda(id3);
    const [vault3] = S.vaultAta(lockPda3, mint);
    await sendAndConfirmTransaction(conn, new Transaction().add(S.createLockIx(
      { id: id3, amount, unlockDate: Math.floor(Date.now() / 1000) + 3600, revocable: true, label: 'Marketing' },
      S.createLockKeys({
        payer: payer.publicKey, beneficiary: beneficiary.publicKey, mint,
        source: payerAta.address, lock: lockPda3, vault: vault3, config,
      }),
    )), [payer]);

    const before = (await getAccount(conn, payerAta.address)).amount;
    await sendAndConfirmTransaction(conn, new Transaction().add(S.revokeIx({
      lock: lockPda3, creator: payer.publicKey, vault: vault3, mint, destination: payerAta.address,
    })), [payer]);
    check('币退回来了', (await getAccount(conn, payerAta.address)).amount - before, amount);
    check('revoked 记上了', (await S.readLock(conn, id3)).revoked, true);
    check('撤了之后一分也领不出来', S.claimable(await S.readLock(conn, id3)), 0n);

    /* ── 计数器 ─────────────────────────────────────────────────────── */
    console.log('\n⑦ 计数器');
    check('下一个 id', await S.readNextId(conn), startId + 3n);

    console.log(`\n${bad === 0 ? `✓ 全部通过（${ok} 条）` : `✗ ${bad} 条没过（通过 ${ok}）`}`);
    process.exitCode = bad === 0 ? 0 : 1;
  } finally {
    if (validator) {
      try { validator.kill(); } catch { /* 已经退了 */ }
    }
  }
})().catch((e) => { console.error('✗ ' + (e.message || e)); process.exit(1); });
