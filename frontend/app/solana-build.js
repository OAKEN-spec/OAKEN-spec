// OAKEN 的 Solana 指令构造层 —— **纯函数，不碰网络、不碰钱包**。
//
// 这一份是**页面和测试共用**的实现：浏览器里传 `window.solanaWeb3`，Node 里传
// `solana/node_modules/@solana/web3.js`。字节布局、账户顺序、PDA 种子都只在这里写一次；
// 测试拿 `@solana/spl-token`、官方 `@pump-fun/pump-sdk` 生成的指令逐字节对账。
//
// 为什么不用 Anchor / 不把 SDK 打进浏览器：
//   · 自有发射 = SPL Token + Metaplex 两套**已经在链上的**程序，指令都很短；
//   · pump.fun 的 createV2 只有一条指令，账户表在它的 IDL 里是公开的；
//   · 一条指令的字节比一整个框架更容易让人读懂、也更容易在测试里钉死。
//
// ⚠ 这里的账户顺序**就是协议**。改顺序 = 改协议，测试会立刻红。

/* ── 程序地址（都是链上既有的公开程序）──────────────────────────────────── */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const METAPLEX_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const RENT_SYSVAR_ID = 'SysvarRent111111111111111111111111111111111';
export const CLOCK_SYSVAR_ID = 'SysvarC1ock11111111111111111111111111111111';

/* Oaken Lock 程序（src 在 `solana/program/`，地址来自 program-keypair.json） */
export const OAKEN_PROGRAM_ID = 'Co9ZnAVxX2siGThhjTpPgXPHYrCev1nrXFyGB1VcZcQW';
export const LOCK_SEED = 'lock';
export const CONFIG_SEED = 'config';
export const LOCK_LEN = 240;
export const CONFIG_LEN = 8;
export const LABEL_LEN = 64;
export const TAG = { createLock: 0, claim: 1, transferOwnership: 2, renounce: 3, revoke: 4 };

/* pump.fun（官方 IDL 的常量；2026-10 的 @pump-fun/pump-sdk@4.2.0） */
export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_MAYHEM_PROGRAM_ID = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';
export const PUMP_FEE_PROGRAM_ID = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';

/* Jupiter Lock（第三方、链上已部署的 vesting 程序）。用于 Solana 的“锁一小时”实验；
 * 它的升级权不归我们，页面必须如实写这一条。 */
export const JUP_LOCK_PROGRAM_ID = 'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn';
export const JUP_LOCK_CREATE_DISC = [23, 100, 197, 94, 222, 153, 38, 90];
export const JUP_LOCK_CLAIM_DISC = [62, 198, 214, 193, 213, 159, 108, 210];
export const JUP_LOCK_CREATE_V2_DISC = [181, 155, 104, 183, 182, 128, 35, 47];
export const JUP_LOCK_CLAIM_V2_DISC = [229, 87, 46, 162, 21, 157, 231, 114];
export const JUP_ESCROW_LEN = 296;
export const JUP_ESCROW_DISC = [244, 119, 183, 4, 73, 116, 135, 195];

/** pump createV2 的 8 字节 Anchor discriminator —— 来自它自己的 IDL，不是猜的。 */
export const PUMP_CREATE_V2_DISC = [214, 144, 76, 236, 95, 139, 49, 180];

/* pump.fun 首买（buy_exact_quote_in_v3）：一条 17 账户的指令，按**花费多少 SOL**买，
 * 而不是按"买多少枚"。IDL 的 discriminator 与链上真实交易逐字节对上（见 _look/_pump-disc-base58.cjs）。 */
export const PUMP_BUY_EXACT_QUOTE_V3_DISC = [225, 247, 80, 30, 213, 179, 132, 136];
export const PUMP_FEE_CONFIG = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';
/** 8 个 buyback 收款钱包之一（官方 FEE_RECIPIENTS.md；SOL 交易传钱包本身）。 */
export const PUMP_BUYBACK_RECIPIENT = 'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * 造出一整套指令构造器。
 * @param {object} web3 `@solana/web3.js` 或浏览器的 `window.solanaWeb3`
 */
export function makeSolana(web3) {
  const {
    PublicKey, TransactionInstruction, SystemProgram, Connection,
  } = web3;
  // 浏览器那份 IIFE 把 Buffer 也导出了；Node 里是全局的。
  const Buf = web3.Buffer || (typeof Buffer !== 'undefined' ? Buffer : null);
  if (!Buf) throw new Error('solana build: no Buffer implementation');

  const pk = (v) => (v instanceof PublicKey ? v : new PublicKey(String(v)));
  const token = pk(TOKEN_PROGRAM_ID);
  const token2022 = pk(TOKEN_2022_PROGRAM_ID);
  const ataProgram = pk(ATA_PROGRAM_ID);
  const metaplex = pk(METAPLEX_PROGRAM_ID);
  const system = pk(SYSTEM_PROGRAM_ID);
  const rent = pk(RENT_SYSVAR_ID);
  const clock = pk(CLOCK_SYSVAR_ID);
  const oaken = pk(OAKEN_PROGRAM_ID);
  const pump = pk(PUMP_PROGRAM_ID);
  const mayhem = pk(PUMP_MAYHEM_PROGRAM_ID);
  const jup = pk(JUP_LOCK_PROGRAM_ID);

  const buf = (u8s) => Buf.from(u8s);
  const u64le = (n) => {
    const b = Buf.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const i64le = (n) => {
    const b = Buf.alloc(8);
    b.writeBigInt64LE(BigInt(n));
    return b;
  };
  const u16le = (n) => {
    const b = Buf.alloc(2);
    b.writeUInt16LE(Number(n));
    return b;
  };
  const u32le = (n) => {
    const b = Buf.alloc(4);
    b.writeUInt32LE(Number(n));
    return b;
  };
  const borshString = (s) => {
    const raw = Buf.from(String(s ?? ''), 'utf8');
    return Buf.concat([u32le(raw.length), raw]);
  };
  /** Borsh 的 Option：1 字节 0/1，Some 时后面跟值。 */
  const option = (value, encode) => (value == null ? buf([0]) : Buf.concat([buf([1]), encode(value)]));

  /** PDA 帮助函数（返回 [address, bump]）。 */
  const findPda = (seeds, program) => PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === 'string' ? Buf.from(s, 'utf8') : s)),
    program,
  );

  /** 任意 owner 在某个 mint 下的 ATA。 */
  const ata = (owner, mint, tokenProgram = token) => findPda(
    [pk(owner).toBuffer(), pk(tokenProgram).toBuffer(), pk(mint).toBuffer()],
    ataProgram,
  );

  /* ── SPL Token ─────────────────────────────────────────────────────── */

  /** 建 mint 账户（System Program 的 createAccount）。 */
  const createMintAccountIx = ({ payer, mint, lamports, space = 82, programId = token }) => SystemProgram.createAccount({
    fromPubkey: pk(payer),
    newAccountPubkey: pk(mint),
    // ⚠ buffer-layout 的 u64 编码只吃 number（BigInt 会在 divmodInt64 里混型抛错）。
    // rent 的 82 字节账户在一百万 lamports 量级，Number 精确。
    lamports: Number(lamports),
    space: Number(space),
    programId: pk(programId),
  });

  /**
   * InitializeMint2（tag 20）：
   * `[20][decimals u8][mint_authority 32B][freeze COption 1B(+32B)]`
   */
  const initializeMint2Ix = ({ mint, decimals, mintAuthority, freezeAuthority = null, programId = token }) => new TransactionInstruction({
    programId: pk(programId),
    keys: [{ pubkey: pk(mint), isSigner: false, isWritable: true }],
    data: Buf.concat([
      buf([20]),
      buf([Number(decimals) & 0xff]),
      pk(mintAuthority).toBuffer(),
      option(freezeAuthority, (x) => pk(x).toBuffer()),
    ]),
  });

  /** CreateIdempotent（ATA，tag 1）。 */
  const createAtaIdempotentIx = ({ payer, address, owner, mint, tokenProgram = token }) => new TransactionInstruction({
    programId: ataProgram,
    keys: [
      { pubkey: pk(payer), isSigner: true, isWritable: true },
      { pubkey: pk(address), isSigner: false, isWritable: true },
      { pubkey: pk(owner), isSigner: false, isWritable: false },
      { pubkey: pk(mint), isSigner: false, isWritable: false },
      { pubkey: system, isSigner: false, isWritable: false },
      { pubkey: pk(tokenProgram), isSigner: false, isWritable: false },
    ],
    data: buf([1]),
  });

  /** MintTo（tag 7）：`[7][amount u64]`。 */
  const mintToIx = ({ mint, destination, authority, amount, programId = token }) => new TransactionInstruction({
    programId: pk(programId),
    keys: [
      { pubkey: pk(mint), isSigner: false, isWritable: true },
      { pubkey: pk(destination), isSigner: false, isWritable: true },
      { pubkey: pk(authority), isSigner: true, isWritable: false },
    ],
    data: Buf.concat([buf([7]), u64le(amount)]),
  });

  /** SetAuthority（tag 6）：`[6][type u8][new COption]`。type 0 = MintTokens。 */
  const setAuthorityIx = ({
    mint, currentAuthority, authorityType = 0, newAuthority = null, programId = token,
  }) => new TransactionInstruction({
    programId: pk(programId),
    keys: [
      { pubkey: pk(mint), isSigner: false, isWritable: true },
      { pubkey: pk(currentAuthority), isSigner: true, isWritable: false },
    ],
    data: Buf.concat([
      buf([6, Number(authorityType) & 0xff]),
      option(newAuthority, (x) => pk(x).toBuffer()),
    ]),
  });

  /* ── Metaplex Token Metadata ───────────────────────────────────────── */

  const metadataPda = (mint) => findPda(['metadata', metaplex.toBuffer(), pk(mint).toBuffer()], metaplex);

  /**
   * CreateMetadataAccountV3（datasize：disc 33 + DataV2 + isMutable + collectionDetails）。
   *
   * 账户顺序（mpl-token-metadata 的 kinobi 生成物）：
   *   0 metadata(写) 1 mint 2 mintAuthority(签名) 3 payer(签名,写) 4 updateAuthority
   *   5 system 6 rent
   */
  const createMetadataV3Ix = ({
    metadata, mint, mintAuthority, payer, updateAuthority, name, symbol, uri,
    sellerFeeBasisPoints = 0, isMutable = false,
  }) => {
    const data = Buf.concat([
      buf([33]),
      borshString(name),
      borshString(symbol),
      borshString(uri),
      u16le(sellerFeeBasisPoints),
      buf([0]),            // creators: None
      buf([0]),            // collection: None
      buf([0]),            // uses: None
      buf([isMutable ? 1 : 0]),
      buf([0]),            // collectionDetails: None
    ]);
    return new TransactionInstruction({
      programId: metaplex,
      keys: [
        { pubkey: pk(metadata), isSigner: false, isWritable: true },
        { pubkey: pk(mint), isSigner: false, isWritable: false },
        { pubkey: pk(mintAuthority), isSigner: true, isWritable: false },
        { pubkey: pk(payer), isSigner: true, isWritable: true },
        { pubkey: pk(updateAuthority), isSigner: false, isWritable: false },
        { pubkey: system, isSigner: false, isWritable: false },
        { pubkey: rent, isSigner: false, isWritable: false },
      ],
      data,
    });
  };

  /** 一段链上 memo —— 给自有发射留一条可读的出处（可选）。 */
  const memoIx = (text) => new TransactionInstruction({
    programId: pk(MEMO_PROGRAM_ID),
    keys: [],
    data: Buf.from(String(text || '').slice(0, 200), 'utf8'),
  });

  /** 计算预算：上限 + 一点优先费（不设的话大交易会默认 200k CU 被掐）。 */
  const budgetIxs = ({ units = 400000, microLamports = 20000 } = {}) => {
    const { ComputeBudgetProgram } = web3;
    if (!ComputeBudgetProgram) return [];
    return [
      ComputeBudgetProgram.setComputeUnitLimit({ units: Number(units) }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(microLamports) }),
    ];
  };

  /* ── Oaken Lock（程序在 solana/program/）────────────────────────────── */

  const configPda = () => findPda([CONFIG_SEED], oaken);
  const lockPda = (id) => findPda([LOCK_SEED, u64le(id)], oaken);

  const createLockIx = ({ id, amount, unlockDate, revocable, label }, keys, program = oaken) => {
    const labelRaw = Buf.alloc(LABEL_LEN);
    Buf.from(String(label || ''), 'utf8').copy(labelRaw, 0, 0, LABEL_LEN);
    return new TransactionInstruction({
      programId: program,
      keys,
      data: Buf.concat([
        buf([TAG.createLock]), u64le(id), u64le(amount), i64le(unlockDate),
        buf([revocable ? 1 : 0]), labelRaw,
      ]),
    });
  };

  /**
   * 账户表（顺序即协议）：
   * 0 payer/creator(签名,写) 1 beneficiary 2 mint 3 source(写) 4 lock(写)
   * 5 vault(写) 6 config(写) 7 rent 8 clock 9 token 10 ata 11 system
   * ⚠ source 是代币账户，不能签名 —— 签名的是 payer。
   */
  const createLockKeys = ({
    payer, beneficiary, mint, source, lock, vault, config,
  }) => [
    { pubkey: pk(payer), isSigner: true, isWritable: true },
    { pubkey: pk(beneficiary), isSigner: false, isWritable: false },
    { pubkey: pk(mint), isSigner: false, isWritable: false },
    { pubkey: pk(source), isSigner: false, isWritable: true },
    { pubkey: pk(lock), isSigner: false, isWritable: true },
    { pubkey: pk(vault), isSigner: false, isWritable: true },
    { pubkey: pk(config), isSigner: false, isWritable: true },
    { pubkey: rent, isSigner: false, isWritable: false },
    { pubkey: clock, isSigner: false, isWritable: false },
    { pubkey: token, isSigner: false, isWritable: false },
    { pubkey: ataProgram, isSigner: false, isWritable: false },
    { pubkey: system, isSigner: false, isWritable: false },
  ];

  const claimKeys = ({
    lock, vault, mint, destination, payer, beneficiary,
  }) => [
    /* claim 会把 claimed 写回锁账户 —— 这里必须是可写，只读会得到
       "instruction modified data of a read-only account"（2026-10-23 E2E）。 */
    { pubkey: pk(lock), isSigner: false, isWritable: true },
    { pubkey: pk(vault), isSigner: false, isWritable: true },
    { pubkey: pk(mint), isSigner: false, isWritable: false },
    { pubkey: pk(destination), isSigner: false, isWritable: true },
    { pubkey: pk(payer), isSigner: true, isWritable: true },
    /* ATA 程序建账户时要把 owner 作为账户传进来；owner = 受益人。
       少了这一项，CPI 会引用一个交易里不存在的账户（unknown account）——
       2026-10-23 第一次真 E2E 抓到的就是这条。 */
    { pubkey: pk(beneficiary), isSigner: false, isWritable: false },
    { pubkey: token, isSigner: false, isWritable: false },
    { pubkey: ataProgram, isSigner: false, isWritable: false },
    { pubkey: system, isSigner: false, isWritable: false },
    { pubkey: clock, isSigner: false, isWritable: false },
  ];

  const claimIx = (keys) => new TransactionInstruction({
    programId: oaken, keys, data: buf([TAG.claim]),
  });

  const transferIx = ({ lock, beneficiary, newBeneficiary }) => new TransactionInstruction({
    programId: oaken,
    keys: [
      { pubkey: pk(lock), isSigner: false, isWritable: true },
      { pubkey: pk(beneficiary), isSigner: true, isWritable: false },
      { pubkey: pk(newBeneficiary), isSigner: false, isWritable: false },
    ],
    data: Buf.concat([buf([TAG.transferOwnership]), pk(newBeneficiary).toBuffer()]),
  });

  const renounceIx = ({ lock, beneficiary }) => new TransactionInstruction({
    programId: oaken,
    keys: [
      { pubkey: pk(lock), isSigner: false, isWritable: true },
      { pubkey: pk(beneficiary), isSigner: true, isWritable: false },
    ],
    data: buf([TAG.renounce]),
  });

  const revokeIx = ({
    lock, creator, vault, mint, destination,
  }) => new TransactionInstruction({
    programId: oaken,
    keys: [
      { pubkey: pk(lock), isSigner: false, isWritable: true },
      { pubkey: pk(creator), isSigner: true, isWritable: false },
      { pubkey: pk(vault), isSigner: false, isWritable: true },
      { pubkey: pk(mint), isSigner: false, isWritable: false },
      { pubkey: pk(destination), isSigner: false, isWritable: true },
      { pubkey: token, isSigner: false, isWritable: false },
      { pubkey: clock, isSigner: false, isWritable: false },
    ],
    data: buf([TAG.revoke]),
  });

  /* ── pump.fun createV2 ─────────────────────────────────────────────── */

  const pumpMintAuthorityPda = () => findPda(['mint-authority'], pump)[0];
  const pumpGlobalPda = () => findPda(['global'], pump)[0];
  const pumpBondingCurvePda = (mint) => findPda(['bonding-curve', pk(mint).toBuffer()], pump)[0];
  const pumpGlobalParamsPda = () => findPda(['global-params'], mayhem)[0];
  const pumpSolVaultPda = () => findPda(['sol-vault'], mayhem)[0];
  const pumpMayhemStatePda = (mint) => findPda(['mayhem-state', pk(mint).toBuffer()], mayhem)[0];
  const pumpEventAuthorityPda = () => findPda(['__event_authority'], pump)[0];
  const pumpUserVolumeAccumulatorPda = (user) => findPda(['user_volume_accumulator', pk(user).toBuffer()], pump)[0];

  /**
   * `create_v2`（SOL 计价、非 mayhem、非 holder-reward、creatorFeeBps=0）。
   *
   * 账户表（IDL 顺序，16 条）：
   *  0 mint(签名,写) 1 mintAuthority(PDA) 2 bondingCurve(写) 3 associatedBondingCurve(写)
   *  4 global 5 user(签名,写) 6 system 7 token-2022 8 ATA program
   *  9 mayhem program(写) 10 globalParams 11 solVault(写) 12 mayhemState(写)
   *  13 mayhemTokenVault(写) 14 eventAuthority 15 pump program
   */
  const pumpCreateV2Ix = ({
    mint, user, name, symbol, uri, creator = user, mayhemMode = false,
  }) => {
    const mintKey = pk(mint);
    const userKey = pk(user);
    const creatorKey = pk(creator);
    const bondingCurve = pumpBondingCurvePda(mintKey);
    const assocBonding = ata(bondingCurve, mintKey, token2022)[0];
    const solVault = pumpSolVaultPda();
    const mayhemState = pumpMayhemStatePda(mintKey);
    const mayhemTokenVault = ata(solVault, mintKey, token2022)[0];
    const data = Buf.concat([
      buf(PUMP_CREATE_V2_DISC),
      borshString(name),
      borshString(symbol),
      borshString(uri),
      creatorKey.toBuffer(),
      buf([mayhemMode ? 1 : 0]),     // is_mayhem_mode
      buf([0]),                      // is_cashback_enabled (deprecated, must be false)
      u64le(0),                      // creator_fee_bps (0 = pump schedule)
      buf([0]),                      // is_holder_reward
    ]);
    return new TransactionInstruction({
      programId: pump,
      keys: [
        { pubkey: mintKey, isSigner: true, isWritable: true },
        { pubkey: pumpMintAuthorityPda(), isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: assocBonding, isSigner: false, isWritable: true },
        { pubkey: pumpGlobalPda(), isSigner: false, isWritable: false },
        { pubkey: userKey, isSigner: true, isWritable: true },
        { pubkey: system, isSigner: false, isWritable: false },
        { pubkey: token2022, isSigner: false, isWritable: false },
        { pubkey: ataProgram, isSigner: false, isWritable: false },
        { pubkey: mayhem, isSigner: false, isWritable: true },
        { pubkey: pumpGlobalParamsPda(), isSigner: false, isWritable: false },
        { pubkey: solVault, isSigner: false, isWritable: true },
        { pubkey: mayhemState, isSigner: false, isWritable: true },
        { pubkey: mayhemTokenVault, isSigner: false, isWritable: true },
        { pubkey: pumpEventAuthorityPda(), isSigner: false, isWritable: false },
        { pubkey: pump, isSigner: false, isWritable: false },
      ],
      data,
    });
  };

  /**
   * `buy_exact_quote_in_v3` —— 发射后**同一笔交易**里的首买（花固定数量的 SOL）。
   *
   * 账户表（IDL 顺序，17 条；与链上真实交易逐条对上）：
   *  0 global 1 baseMint 2 quoteMint(WSOL) 3 token-2022 4 token(SPL) 5 bondingCurve
   *  6 associatedBaseBondingCurve 7 associatedQuoteBondingCurve 8 user 9 associatedBaseUser
   *  10 associatedQuoteUser 11 userVolumeAccumulator 12 feeConfig 13 buybackFeeRecipient
   *  14 system 15 eventAuthority 16 pump program
   *
   * ⚠ `associated_base_user` **不会**被这条指令创建（文档明说 must exist），
   * 所以调用方要先发一条 `createAtaIdempotentIx`（Token-2022）。WSOL 侧的账户
   * 对 SOL 计价币只是占位，不需要存在。
   */
  const pumpBuyExactQuoteV3Ix = ({ mint, user, quoteIn, minTokensOut = 0n }) => {
    const mintKey = pk(mint);
    const userKey = pk(user);
    const bondingCurve = pumpBondingCurvePda(mintKey);
    const wsol = pk(WSOL_MINT);
    const data = Buf.concat([
      buf(PUMP_BUY_EXACT_QUOTE_V3_DISC),
      u64le(quoteIn),
      u64le(minTokensOut),
    ]);
    return new TransactionInstruction({
      programId: pump,
      keys: [
        { pubkey: pumpGlobalPda(), isSigner: false, isWritable: false },
        { pubkey: mintKey, isSigner: false, isWritable: false },
        { pubkey: wsol, isSigner: false, isWritable: false },
        { pubkey: token2022, isSigner: false, isWritable: false },
        { pubkey: token, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: ata(bondingCurve, mintKey, token2022)[0], isSigner: false, isWritable: true },
        { pubkey: ata(bondingCurve, wsol, token)[0], isSigner: false, isWritable: true },
        { pubkey: userKey, isSigner: true, isWritable: true },
        { pubkey: ata(userKey, mintKey, token2022)[0], isSigner: false, isWritable: true },
        { pubkey: ata(userKey, wsol, token)[0], isSigner: false, isWritable: true },
        { pubkey: pumpUserVolumeAccumulatorPda(userKey), isSigner: false, isWritable: true },
        { pubkey: pk(PUMP_FEE_CONFIG), isSigner: false, isWritable: false },
        { pubkey: pk(PUMP_BUYBACK_RECIPIENT), isSigner: false, isWritable: false },
        { pubkey: system, isSigner: false, isWritable: false },
        { pubkey: pumpEventAuthorityPda(), isSigner: false, isWritable: false },
        { pubkey: pump, isSigner: false, isWritable: false },
      ],
      data,
    });
  };

  /* ── Jupiter Lock（第三方 vesting）──────────────────────────────────── */

  const jupEscrowPda = (base) => findPda(['escrow', pk(base).toBuffer()], jup);
  const jupEventAuthorityPda = () => findPda(['__event_authority'], jup)[0];

  /**
   * `create_vesting_escrow`。
   * 锁一小时的做法：vestingStartTime = now，cliffTime = now+3600，
   * cliffUnlockAmount = amount-1，amountPerPeriod = 1，numberOfPeriod = 1，
   * frequency = 1 —— 到期那一秒释放几乎全部，剩下 1 个最小单位在 1 秒后释放。
   */
  const jupCreateLockIx = ({
    base, escrow, escrowToken, sender, senderToken, recipient, mint,
    vestingStartTime, cliffTime, frequency = 1,
    cliffUnlockAmount, amountPerPeriod = 1, numberOfPeriod = 1,
    updateRecipientMode = 0, cancelMode = 0,
  }) => {
    const data = Buf.concat([
      buf(JUP_LOCK_CREATE_DISC),
      u64le(vestingStartTime), u64le(cliffTime), u64le(frequency),
      u64le(cliffUnlockAmount), u64le(amountPerPeriod), u64le(numberOfPeriod),
      buf([Number(updateRecipientMode) & 0xff]), buf([Number(cancelMode) & 0xff]),
    ]);
    return new TransactionInstruction({
      programId: jup,
      keys: [
        { pubkey: pk(base), isSigner: true, isWritable: true },
        { pubkey: pk(escrow), isSigner: false, isWritable: true },
        { pubkey: pk(escrowToken), isSigner: false, isWritable: true },
        { pubkey: pk(sender), isSigner: true, isWritable: true },
        { pubkey: pk(senderToken), isSigner: false, isWritable: true },
        { pubkey: pk(recipient), isSigner: false, isWritable: false },
        { pubkey: token, isSigner: false, isWritable: false },
        { pubkey: system, isSigner: false, isWritable: false },
        { pubkey: jupEventAuthorityPda(), isSigner: false, isWritable: false },
        { pubkey: jup, isSigner: false, isWritable: false },
      ],
      data,
    });
  };

  /**
   * `create_vesting_escrow_v2` —— 同时支持 classic SPL 与 Token-2022
   * （pump.fun 的 createV2 现在发的都是 Token-2022，所以主路径走这条）。
   * 账户表比 v1 多一个 tokenMint，tokenProgram 是**传入的账户**而不是固定 classic。
   */
  const jupCreateLockV2Ix = ({
    base, escrow, tokenMint, escrowToken, sender, senderToken, recipient,
    tokenProgram = token, vestingStartTime, cliffTime, frequency = 1,
    cliffUnlockAmount, amountPerPeriod = 1, numberOfPeriod = 1,
    updateRecipientMode = 0, cancelMode = 0,
  }) => {
    const data = Buf.concat([
      buf(JUP_LOCK_CREATE_V2_DISC),
      u64le(vestingStartTime), u64le(cliffTime), u64le(frequency),
      u64le(cliffUnlockAmount), u64le(amountPerPeriod), u64le(numberOfPeriod),
      buf([Number(updateRecipientMode) & 0xff]), buf([Number(cancelMode) & 0xff]),
      buf([0]),   // remaining_accounts_info: None
    ]);
    return new TransactionInstruction({
      programId: jup,
      keys: [
        { pubkey: pk(base), isSigner: true, isWritable: true },
        { pubkey: pk(escrow), isSigner: false, isWritable: true },
        { pubkey: pk(tokenMint), isSigner: false, isWritable: false },
        { pubkey: pk(escrowToken), isSigner: false, isWritable: true },
        { pubkey: pk(sender), isSigner: true, isWritable: true },
        { pubkey: pk(senderToken), isSigner: false, isWritable: true },
        { pubkey: pk(recipient), isSigner: false, isWritable: false },
        { pubkey: pk(tokenProgram), isSigner: false, isWritable: false },
        { pubkey: system, isSigner: false, isWritable: false },
        { pubkey: jupEventAuthorityPda(), isSigner: false, isWritable: false },
        { pubkey: jup, isSigner: false, isWritable: false },
      ],
      data,
    });
  };

  /** `claim_v2`：支持 Token-2022 的领取。 */
  const jupClaimV2Ix = ({
    escrow, tokenMint, escrowToken, recipient, recipientToken,
    tokenProgram = token, maxAmount,
  }) => {
    const data = Buf.concat([buf(JUP_LOCK_CLAIM_V2_DISC), u64le(maxAmount), buf([0])]);
    return new TransactionInstruction({
      programId: jup,
      keys: [
        { pubkey: pk(escrow), isSigner: false, isWritable: true },
        { pubkey: pk(tokenMint), isSigner: false, isWritable: false },
        { pubkey: pk(escrowToken), isSigner: false, isWritable: true },
        { pubkey: pk(recipient), isSigner: true, isWritable: true },
        { pubkey: pk(recipientToken), isSigner: false, isWritable: true },
        { pubkey: pk(MEMO_PROGRAM_ID), isSigner: false, isWritable: false },
        { pubkey: pk(tokenProgram), isSigner: false, isWritable: false },
        { pubkey: jupEventAuthorityPda(), isSigner: false, isWritable: false },
        { pubkey: jup, isSigner: false, isWritable: false },
      ],
      data,
    });
  };

  /** `claim`：到期后由 recipient 领（maxAmount 是本次最多领多少）。 */
  const jupClaimIx = ({ escrow, escrowToken, recipient, recipientToken, maxAmount }) => new TransactionInstruction({
    programId: jup,
    keys: [
      { pubkey: pk(escrow), isSigner: false, isWritable: true },
      { pubkey: pk(escrowToken), isSigner: false, isWritable: true },
      { pubkey: pk(recipient), isSigner: true, isWritable: true },
      { pubkey: pk(recipientToken), isSigner: false, isWritable: true },
      { pubkey: token, isSigner: false, isWritable: false },
      { pubkey: jupEventAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: jup, isSigner: false, isWritable: false },
    ],
    data: Buf.concat([buf(JUP_LOCK_CLAIM_DISC), u64le(maxAmount)]),
  });

  /** Jupiter escrow 账户（bytemuck，296 字节 + 8 字节 discriminator 之外的固定布局）。 */
  const decodeJupEscrow = (data) => {
    if (!data || data.length < JUP_ESCROW_LEN) throw new Error(`Jupiter escrow is ${data ? data.length : 0} bytes`);
    const d = data;
    const key = (at) => new PublicKey(d.subarray(at, at + 32));
    return {
      recipient: key(8).toBase58(),
      mint: key(40).toBase58(),
      creator: key(72).toBase58(),
      base: key(104).toBase58(),
      bump: d[136],
      updateRecipientMode: d[137],
      cancelMode: d[138],
      tokenProgramFlag: d[139],
      cliffTime: Number(d.readBigUInt64LE(144)),
      frequency: Number(d.readBigUInt64LE(152)),
      cliffUnlockAmount: d.readBigUInt64LE(160),
      amountPerPeriod: d.readBigUInt64LE(168),
      numberOfPeriod: d.readBigUInt64LE(176),
      totalClaimedAmount: d.readBigUInt64LE(184),
      vestingStartTime: Number(d.readBigUInt64LE(192)),
      cancelledAt: Number(d.readBigUInt64LE(200)),
    };
  };

  /* ── 读链 ──────────────────────────────────────────────────────────── */

  const decodeLock = (data) => {
    if (!data || data.length !== LOCK_LEN) throw new Error(`lock account is ${data ? data.length : 0} bytes, expected ${LOCK_LEN}`);
    const key = (at) => new PublicKey(data.subarray(at, at + 32));
    const end = data.indexOf(0, 176);
    return {
      version: data[0],
      bump: data[1],
      id: BigInt(data.readBigUInt64LE(2)),
      creator: key(10).toBase58(),
      beneficiary: key(42).toBase58(),
      mint: key(74).toBase58(),
      vault: key(106).toBase58(),
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

  const readLock = async (connection, id) => {
    const [address] = lockPda(id);
    const info = await connection.getAccountInfo(address);
    if (!info) return null;
    if (!info.owner.equals(oaken)) throw new Error('That account is not owned by the Oaken Lock program.');
    return { address: address.toBase58(), ...decodeLock(info.data) };
  };

  const readNextId = async (connection) => {
    const [address] = configPda();
    const info = await connection.getAccountInfo(address);
    if (!info || info.data.length !== CONFIG_LEN) return 0;
    return Number(info.data.readBigUInt64LE(0));
  };

  const readMint = async (connection, mint) => {
    const info = await connection.getAccountInfo(pk(mint));
    if (!info || info.data.length < 82) return null;
    return {
      decimals: info.data[44],
      supply: info.data.readBigUInt64LE(36),
      owner: info.owner.toBase58(),
      isToken2022: info.owner.equals(token2022),
    };
  };

  /** Metaplex metadata 里的 name / symbol / uri（读不到就 null，不编）。 */
  const readMetadata = async (connection, mint) => {
    const [address] = metadataPda(mint);
    const info = await connection.getAccountInfo(address);
    if (!info || !info.data || info.data.length < 70) return null;
    let at = 1 + 32 + 32;                       // key + update authority + mint
    const str = () => {
      const len = info.data.readUInt32LE(at); at += 4;
      const s = info.data.subarray(at, at + len).toString('utf8'); at += len;
      return s;
    };
    try {
      const name = str().replace(/\0+$/g, '').trim();
      const symbol = str().replace(/\0+$/g, '').trim();
      const uri = str().replace(/\0+$/g, '').trim();
      return { name, symbol, uri, address: address.toBase58() };
    } catch { return null; }
  };

  const claimable = (lock, nowSeconds = Math.floor(Date.now() / 1000)) => {
    if (!lock || lock.renounced || lock.revoked) return 0n;
    if (nowSeconds < lock.unlockDate) return 0n;
    return lock.amount - lock.claimed;
  };

  return {
    web3,
    Buffer: Buf,
    // ids / pdas
    oaken, pump, token, token2022, ataProgram, metaplex, system, rent, clock,
    configPda, lockPda, metadataPda, ata,
    pumpMintAuthorityPda, pumpGlobalPda, pumpBondingCurvePda, pumpGlobalParamsPda,
    pumpSolVaultPda, pumpMayhemStatePda, pumpEventAuthorityPda,
    // SPL / Metaplex / memo
    createMintAccountIx, initializeMint2Ix, createAtaIdempotentIx, mintToIx,
    setAuthorityIx, createMetadataV3Ix, memoIx, budgetIxs,
    // Oaken Lock
    createLockIx, createLockKeys, claimIx, claimKeys, transferIx, renounceIx, revokeIx,
    // pump.fun
    pumpCreateV2Ix,
    pumpBuyExactQuoteV3Ix,
    // Jupiter Lock
    jup, jupEscrowPda, jupEventAuthorityPda, jupCreateLockIx, jupClaimIx, jupCreateLockV2Ix, jupClaimV2Ix,
    // reads
    decodeLock, readLock, readNextId, readMint, readMetadata, claimable,
    decodeJupEscrow,
  };
}
