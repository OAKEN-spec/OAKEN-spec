// Oaken Lock 的 Solana 一侧：账户布局、指令编码、PDA 推导。
//
// **这个文件是三处共用的**：站上的页面、`solana/scripts/e2e.mjs`（本地验证器上的端到端）、
// 将来任何脚本。所以它做成了**依赖注入** —— 浏览器里传 `window.solanaWeb3`
// （我们 vendored 的 IIFE 包），Node 里传 `@solana/web3.js`。同一份字节布局只有一处实现，
// 而"测试和页面各写一份解析"正是那种会悄悄分叉、又只在线上才被看见的错误。
//
// 和 Rust 那边（`solana/program/src/state.rs`）的布局**逐字节对齐**：
//   offset  size  field
//   0       1     version
//   1       1     bump
//   2       8     id (u64 LE)
//   10      32    creator
//   42      32    beneficiary
//   74      32    mint
//   106     32    vault
//   138     8     amount
//   146     8     lock_date (i64)
//   154     8     unlock_date (i64)
//   162     8     claimed
//   170     1     revocable
//   171     1     renounced
//   172     1     revoked
//   173     3     （对齐填充）
//   176     64    label
//   ─────────────
//   240 总长

export const PROGRAM_ID = 'Co9ZnAVxX2siGThhjTpPgXPHYrCev1nrXFyGB1VcZcQW';
export const LOCK_SEED = 'lock';
export const CONFIG_SEED = 'config';
export const LOCK_LEN = 240;
export const CONFIG_LEN = 8;
export const LABEL_LEN = 64;
export const LAYOUT_VERSION = 1;

/** 指令 tag —— 和 `solana/program/src/instruction.rs` 里的 match 一一对应。 */
export const TAG = { createLock: 0, claim: 1, transferOwnership: 2, renounce: 3, revoke: 4 };

/**
 * 用一套 web3 绑定造出这个模块的全部 API。
 * @param {object} web3 `@solana/web3.js` 或浏览器的 `window.solanaWeb3`
 */
export function makeSolana(web3) {
  const { PublicKey, TransactionInstruction, SystemProgram, Connection } = web3;
  const programId = new PublicKey(PROGRAM_ID);
  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

  const u64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const i64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(n));
    return b;
  };

  /** 计数器 PDA。 */
  const configPda = () => PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], programId);

  /** 一把锁的 PDA（种子是 `["lock", id]`，id 是小端 8 字节）。 */
  const lockPda = (id) => PublicKey.findProgramAddressSync([Buffer.from(LOCK_SEED), u64(id)], programId);

  /** 金库：锁 PDA 名下的 ATA。 */
  const vaultAta = (lockKey, mint) =>
    PublicKey.findProgramAddressSync(
      [lockKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ATA_PROGRAM_ID,
    );

  /** 任意钱包在某个 mint 下的 ATA。 */
  const ata = (wallet, mint) =>
    PublicKey.findProgramAddressSync(
      [wallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ATA_PROGRAM_ID,
    );

  /* ── 指令 ────────────────────────────────────────────────────────────
   * 账户顺序就是协议，和 processor.rs 每个函数头上的那一段必须一致。 */

  const createLockIx = ({ id, amount, unlockDate, revocable, label }, keys, program = programId) => {
    const data = Buffer.concat([
      Buffer.from([TAG.createLock]),
      u64(id),
      u64(amount),
      i64(unlockDate),
      Buffer.from([revocable ? 1 : 0]),
      labelBytes(label),
    ]);
    return new TransactionInstruction({ programId: program, keys, data });
  };

  /**
   * CreateLock 的账户表（顺序即协议）：
   * 0 payer/creator(签名,写) 1 beneficiary(读) 2 mint(读) 3 source(写) 4 lock(写)
   * 5 vault(写) 6 config(写) 7 rent 8 clock 9 token 10 ata 11 system
   */
  const createLockKeys = ({ payer, beneficiary, mint, source, lock, vault, config }) => [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: beneficiary, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    // ⚠ source 是**代币账户**（通常是 ATA），它不可能签名 —— 签名的是 payer
    // （source 的持有者）。程序里 transfer_checked 的 authority 传的也是 payer。
    // 第一版把这里写成 true，等于要求 ATA 自己签名；这个程序从没上过链，所以一直没暴露。
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: lock, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  /**
   * Claim 的账户表：
   * 0 lock(读) 1 vault(写) 2 mint(读) 3 destination(写) 4 payer(签名,写)
   * 5 token 6 ata 7 system 8 clock
   */
  const claimKeys = ({ lock, vault, mint, destination, payer }) => [
    { pubkey: lock, isSigner: false, isWritable: false },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isSigner: false, isWritable: false },
  ];

  const claimIx = (keys) =>
    new TransactionInstruction({ programId, keys, data: Buffer.from([TAG.claim]) });

  const transferIx = ({ lock, beneficiary, newBeneficiary }) =>
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: lock, isSigner: false, isWritable: true },
        { pubkey: beneficiary, isSigner: true, isWritable: false },
        { pubkey: newBeneficiary, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([TAG.transferOwnership]), newBeneficiary.toBuffer()]),
    });

  const renounceIx = ({ lock, beneficiary }) =>
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: lock, isSigner: false, isWritable: true },
        { pubkey: beneficiary, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([TAG.renounce]),
    });

  const revokeIx = ({ lock, creator, vault, mint, destination }) =>
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: lock, isSigner: false, isWritable: true },
        { pubkey: creator, isSigner: true, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isSigner: false, isWritable: false },
      ],
      data: Buffer.from([TAG.revoke]),
    });

  /* ── 读 ────────────────────────────────────────────────────────────── */

  /** 账户字节 → 一把锁。长度不对就抛（不猜、不截断）。 */
  const decodeLock = (data) => {
    if (!data || data.length !== LOCK_LEN) throw new Error(`lock 账户长度是 ${data ? data.length : 0}，期望 ${LOCK_LEN}`);
    const pk = (at) => new PublicKey(data.subarray(at, at + 32));
    const end = data.indexOf(0, 176);
    return {
      version: data[0],
      bump: data[1],
      id: BigInt(data.readBigUInt64LE(2)),
      creator: pk(10).toBase58(),
      beneficiary: pk(42).toBase58(),
      mint: pk(74).toBase58(),
      vault: pk(106).toBase58(),
      amount: BigInt(data.readBigUInt64LE(138)),
      lockDate: Number(data.readBigInt64LE(146)),
      unlockDate: Number(data.readBigInt64LE(154)),
      claimed: BigInt(data.readBigUInt64LE(162)),
      revocable: data[170] === 1,
      renounced: data[171] === 1,
      revoked: data[172] === 1,
      label: data.subarray(176, end === -1 ? 176 + LABEL_LEN : end).toString('utf8'),
    };
  };

  /**
   * 读一把锁。**账户不存在**回 null（不是回一把"空的锁"）—— 页面据此显示
   * "没有这把锁"，而不是显示一堆 0。
   */
  const readLock = async (connection, id) => {
    const [pda] = lockPda(id);
    const info = await connection.getAccountInfo(pda);
    if (!info) return null;
    if (!info.owner.equals(programId)) throw new Error('这个地址上的账户不属于 Oaken Lock 程序');
    return { address: pda.toBase58(), ...decodeLock(info.data) };
  };

  /**
   * 读一个 mint 的精度与供应量。**自己解字节**，不装 spl-token：
   * SPL Mint 的布局是 `[COption<authority> 36B][supply u64][decimals u8]`，
   * 精度在偏移 44 —— 和 Rust 那边 `mint_decimals()` 是同一个偏移。
   */
  const readMint = async (connection, mint) => {
    const info = await connection.getAccountInfo(new PublicKey(mint));
    if (!info || info.data.length < 82) return null;
    return {
      decimals: info.data[44],
      supply: info.data.readBigUInt64LE(36),
      owner: info.owner.toBase58(),
    };
  };

  /** 下一个 id（计数器账户还没建就是 0）。 */
  const readNextId = async (connection) => {
    const [pda] = configPda();
    const info = await connection.getAccountInfo(pda);
    if (!info || info.data.length !== CONFIG_LEN) return 0;
    return Number(info.data.readBigUInt64LE(0));
  };

  /** 现在能领多少 —— 和 Rust 的 `Lock::claimable` 是同一套判断，页面直接读它。 */
  const claimable = (lock, nowSeconds = Math.floor(Date.now() / 1000)) => {
    if (!lock || lock.renounced || lock.revoked) return 0n;
    if (nowSeconds < lock.unlockDate) return 0n;
    return lock.amount - lock.claimed;
  };

  return {
    web3, programId, TOKEN_PROGRAM_ID, ATA_PROGRAM_ID,
    configPda, lockPda, vaultAta, ata, Connection,
    createLockIx, createLockKeys, claimIx, claimKeys, transferIx, renounceIx, revokeIx,
    decodeLock, readLock, readNextId, readMint, claimable,
  };
}

/** 标签补到 64 字节（Rust 那边也是这个规则：长了截断，短了补零）。 */
export function labelBytes(label) {
  const out = Buffer.alloc(LABEL_LEN);
  Buffer.from(String(label || ''), 'utf8').copy(out, 0, 0, LABEL_LEN);
  return out;
}
