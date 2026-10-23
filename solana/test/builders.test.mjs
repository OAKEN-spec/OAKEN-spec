// 指令构造的对账测试。
//
// 判据不是"看起来对"：SPL 的几条和 `@solana/spl-token` 生成的指令**逐字节**比，
// pump 的 createV2 和官方 `@pump-fun/pump-sdk@4.2.0` 的产物**逐账户、逐字节**比。
// 这些字节一旦错一位，链上的表现是"交易成功、币没创建/锁没建"或直接 revert ——
// 都是静默或难读的失败，所以必须在本地钉死。
import assert from 'node:assert/strict';
import * as spl from '@solana/spl-token';
import * as web3 from '@solana/web3.js';
import { makeSolana } from '../../frontend/app/solana-build.js';

const W = web3;
const SB = makeSolana(W);

const hex = (b) => Buffer.from(b).toString('hex');
const keysOf = (ix) => ix.keys.map((k) => [String(k.pubkey), Boolean(k.isSigner), Boolean(k.isWritable)]);

const { PublicKey } = web3;
const USER = new PublicKey('6GQkYV92h1YCZSkH5PYqSWMYjGPPYyN7472tQsgNSsfs');
const MINT = new PublicKey('62bdruJbLjWFySPvVb2GmLiQt2F35Mw23HwMM2ZJGJkk');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');

/* ── SPL Token ──────────────────────────────────────────────────────── */

{
  const ours = SB.initializeMint2Ix({ mint: MINT, decimals: 6, mintAuthority: USER });
  const ref = spl.createInitializeMint2Instruction(MINT, 6, USER, null, spl.TOKEN_PROGRAM_ID);
  assert.equal(String(ours.programId), String(ref.programId));
  assert.deepEqual(keysOf(ours), ref.keys.map((k) => [String(k.pubkey), k.isSigner, k.isWritable]));
  assert.equal(hex(ours.data), hex(ref.data), 'InitializeMint2 字节不一致');
}

{
  const ownerAta = spl.getAssociatedTokenAddressSync(MINT, USER, true, spl.TOKEN_PROGRAM_ID);
  const ours = SB.createAtaIdempotentIx({ payer: USER, address: ownerAta, owner: USER, mint: MINT });
  const ref = spl.createAssociatedTokenAccountIdempotentInstruction(USER, ownerAta, USER, MINT, spl.TOKEN_PROGRAM_ID);
  assert.deepEqual(keysOf(ours), ref.keys.map((k) => [String(k.pubkey), k.isSigner, k.isWritable]));
  assert.equal(hex(ours.data), hex(ref.data), 'CreateIdempotent 字节不一致');
}

{
  const ownerAta = spl.getAssociatedTokenAddressSync(MINT, USER, true, spl.TOKEN_PROGRAM_ID);
  const ours = SB.mintToIx({ mint: MINT, destination: ownerAta, authority: USER, amount: 1_000_000n });
  const ref = spl.createMintToInstruction(MINT, ownerAta, USER, 1_000_000n, [], spl.TOKEN_PROGRAM_ID);
  assert.deepEqual(keysOf(ours), ref.keys.map((k) => [String(k.pubkey), k.isSigner, k.isWritable]));
  assert.equal(hex(ours.data), hex(ref.data), 'MintTo 字节不一致');
}

{
  const ours = SB.setAuthorityIx({ mint: MINT, currentAuthority: USER, authorityType: 0, newAuthority: null });
  const ref = spl.createSetAuthorityInstruction(MINT, USER, spl.AuthorityType.MintTokens, null, [], spl.TOKEN_PROGRAM_ID);
  assert.deepEqual(keysOf(ours), ref.keys.map((k) => [String(k.pubkey), k.isSigner, k.isWritable]));
  assert.equal(hex(ours.data), hex(ref.data), 'SetAuthority 字节不一致');
}

/* ── Metaplex CreateMetadataAccountV3 ───────────────────────────────── */

{
  const [metadata] = SB.metadataPda(MINT);
  const ix = SB.createMetadataV3Ix({
    metadata, mint: MINT, mintAuthority: USER, payer: USER, updateAuthority: USER,
    name: 'Oaken Test', symbol: 'OAKT', uri: 'https://example.com/m.json', isMutable: false,
  });
  // 期望值来自 @metaplex-foundation/mpl-token-metadata@3 的 serializer（同一组参数）
  assert.equal(
    hex(ix.data),
    '210a0000004f616b656e2054657374040000004f414b541a00000068747470733a2f2f6578616d706c652e636f6d2f6d2e6a736f6e00000000000000',
    'CreateMetadataAccountV3 字节不一致',
  );
  assert.deepEqual(keysOf(ix), [
    [String(metadata), false, true],
    [String(MINT), false, false],
    [String(USER), true, false],
    [String(USER), true, true],
    [String(USER), false, false],
    ['11111111111111111111111111111111', false, false],
    ['SysvarRent111111111111111111111111111111111', false, false],
  ]);
}

/* ── pump.fun createV2 ──────────────────────────────────────────────── */

{
  const ix = SB.pumpCreateV2Ix({
    mint: MINT, user: USER, name: 'Oaken Test', symbol: 'OAKT', uri: 'https://example.com/m.json',
  });
  // 参考值：@pump-fun/pump-sdk@4.2.0 的 PUMP_SDK.createV2Instruction（同 mint/user/参数）
  assert.equal(
    hex(ix.data),
    'd6904cec5f8b31b40a0000004f616b656e2054657374040000004f414b541a00000068747470733a2f2f6578616d706c652e636f6d2f6d2e6a736f6e4e3d0076de95a35c6dabb63a1aca8e325a73a1f16bfab72788a00abab0170c6e0000000000000000000000',
    'pump createV2 的指令数据不一致',
  );
  assert.equal(String(ix.programId), '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  assert.deepEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner ? 'S' : '', k.isWritable ? 'W' : ''].join('|')), [
    '62bdruJbLjWFySPvVb2GmLiQt2F35Mw23HwMM2ZJGJkk|S|W',
    'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM||',
    'F7SnFhZUp35qZybPRZ4uFh7SjC1sjyCX3ojHgnxTRZqY||W',
    'BgB7YH3Nnkr6mXyFqk7hwK1GmuRCf3Kkzf36Eu6krhFq||W',
    '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf||',
    '6GQkYV92h1YCZSkH5PYqSWMYjGPPYyN7472tQsgNSsfs|S|W',
    '11111111111111111111111111111111||',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb||',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL||',
    'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e||W',
    '13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ||',
    'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s||W',
    '7tjHN7oXd3pqAUaQoJHCzwMgpwuLRSU1yPnSJb9uNdDV||W',
    'AC5JPVPMMp5vCqFVaK8YC8mgo4r5JXTewfyJXAJq8cRQ||W',
    'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1||',
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P||',
  ], 'pump createV2 账户表不一致');
}

/* ── Jupiter Lock create_v2（Token-2022 路径）────────────────────────── */

{
  const base = new PublicKey('62bdruJbLjWFySPvVb2GmLiQt2F35Mw23HwMM2ZJGJkk');
  const vestingStart = 1000;
  const cliff = 4600;
  const [escrow] = SB.jupEscrowPda(base);
  const token2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const [escrowToken] = SB.ata(escrow, MINT, token2022);
  const [senderToken] = SB.ata(USER, MINT, token2022);
  const ix = SB.jupCreateLockV2Ix({
    base, escrow, tokenMint: MINT, escrowToken,
    sender: USER, senderToken, recipient: USER, tokenProgram: token2022,
    vestingStartTime: vestingStart, cliffTime: cliff, frequency: 1,
    cliffUnlockAmount: 999n, amountPerPeriod: 1n, numberOfPeriod: 1n,
    updateRecipientMode: 0, cancelMode: 0,
  });
  // 期望值来自 jup-ag/jup-lock-starter 的 IDL + Anchor 生成的同一笔指令（2026-10-20 对过）
  assert.equal(
    hex(ix.data),
    'b59b68b7b680232fe803000000000000f8110000000000000100000000000000e70300000000000001000000000000000100000000000000000000',
    'Jupiter createV2 的字节不一致',
  );
  assert.equal(String(ix.programId), 'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn');
  assert.deepEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
    [base.toBase58(), true, true],
    [escrow.toBase58(), false, true],
    [MINT.toBase58(), false, false],
    [escrowToken.toBase58(), false, true],
    [USER.toBase58(), true, true],
    [senderToken.toBase58(), false, true],
    [USER.toBase58(), false, false],
    [token2022.toBase58(), false, false],
    ['11111111111111111111111111111111', false, false],
    [String(SB.jupEventAuthorityPda()), false, false],
    ['LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn', false, false],
  ]);
}

/* ── Oaken Lock 的 PDA / 布局 ───────────────────────────────────────── */

{
  const [config] = SB.configPda();
  const [lock] = SB.lockPda(7);
  const [vault] = SB.ata(lock, WSOL);
  assert.equal(String(config), String(SB.configPda()[0]));
  assert.equal(String(lock), String(SB.lockPda(7)[0]));
  assert.notEqual(String(lock), String(SB.lockPda(8)[0]));
  assert.equal(String(vault), String(spl.getAssociatedTokenAddressSync(WSOL, lock, true, spl.TOKEN_PROGRAM_ID)));
  const ix = SB.createLockIx(
    { id: 7, amount: 123n, unlockDate: 1_800_000_000, revocable: true, label: 'Team' },
    SB.createLockKeys({ payer: USER, beneficiary: USER, mint: WSOL, source: vault, lock, vault, config }),
  );
  assert.equal(hex(ix.data.slice(0, 1 + 8 + 8 + 8 + 1)), '00' + '0700000000000000' + '7b00000000000000' + '00d2496b00000000' + '01');
  assert.equal(ix.keys[3].isSigner, false, 'source（代币账户）不能要求签名');
}

/* ── pump.fun buy_exact_quote_in_v3（dev buy）───────────────────────────
 *
 * The IDL has three args — spendable_quote_in u64, min_tokens_out u64,
 * partial_fill: OptionBool (a one-field struct => one byte). Shipping the
 * first two only made Anchor reject the instruction and the whole
 * create+dev-buy transaction reverted (2026-10-23 review).
 */
{
  const ix = SB.pumpBuyExactQuoteV3Ix({ mint: MINT, user: USER, quoteIn: 1000n, minTokensOut: 7n });
  const d = Buffer.from(ix.data);
  assert.equal(d.length, 8 + 8 + 8 + 1, 'buy_exact_quote_in_v3 参数长度');
  assert.deepEqual([...d.slice(0, 8)], [225, 247, 80, 30, 213, 179, 132, 136], 'discriminator');
  assert.equal(d.readBigUInt64LE(8), 1000n);
  assert.equal(d.readBigUInt64LE(16), 7n);
  assert.equal(d[24], 0, 'partial_fill default = false');
  const some = SB.pumpBuyExactQuoteV3Ix({ mint: MINT, user: USER, quoteIn: 1n, partialFill: true });
  assert.equal(Buffer.from(some.data)[24], 1, 'partial_fill = true encodes as one byte');
}

console.log('✓ solana-build: SPL / Metaplex / pump createV2 / pump dev-buy / Jupiter createV2 / Oaken Lock 全部逐字节对上');
