// SNS (.sns) 指令构造的对账测试。
//
// 判据和 builders.test.mjs 一样：不是"看起来对"，而是和官方 SDK / spl-token
// 生成的指令**逐账户、逐字节**比；注册那一段再和主网真实交易
// `4zMncWK2…`（minehub，2026-10-24）的 data 与账户表比。
//
// 这些字节错一位，链上的表现是交易成功但名字没建、或钱扣了 revert —— 都是静默的。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as spl from '@solana/spl-token';
import * as web3 from '@solana/web3.js';
import * as SNS from '@bonfida/spl-name-service';
import {
  makeSns, sha256, graphemeCount, priceUsd, cleanLabel, SOL_FEED_ID,
  NAME_PROGRAM_ID, REGISTER_PROGRAM_ID, SNS_ROOT_DOMAIN_ACCOUNT, CENTRAL_STATE,
  VAULT_OWNER, WSOL_MINT, NAME_OFFERS_ID, fmtSol,
} from '../../app/sns-build.js';

const W = web3;
const S = makeSns(W);
const { PublicKey } = W;

const hex = (b) => Buffer.from(b).toString('hex');
const keysOf = (ix) => ix.keys.map((k) => [String(k.pubkey), Boolean(k.isSigner), Boolean(k.isWritable)]);
const sameIx = (ours, ref, label) => {
  assert.equal(String(ours.programId), String(ref.programId), label + ': programId');
  // A meta with an undefined pubkey compiles to a transaction that dies in
  // `compileMessage`; catch it here rather than in the page.
  for (const k of ours.keys) assert.ok(k.pubkey, label + ': undefined account key');
  for (const k of ref.keys) assert.ok(k.pubkey, label + ': reference has undefined account key');
  assert.deepEqual(keysOf(ours), ref.keys.map((k) => [String(k.pubkey), Boolean(k.isSigner), Boolean(k.isWritable)]), label + ': accounts');
  assert.equal(hex(ours.data), hex(ref.data), label + ': data');
};

/* ── SHA-256 / grapheme / price / label ─────────────────────────────── */

{
  for (const s of ['', 'a', 'SPL Name Servicealice', 'minehub', '💝', 'a'.repeat(200), '名字.sns', 'x'.repeat(63)]) {
    const ours = Buffer.from(sha256(Buffer.from(s, 'utf8'))).toString('hex');
    const ref = createHash('sha256').update(s, 'utf8').digest('hex');
    assert.equal(ours, ref, 'sha256: ' + JSON.stringify(s));
  }
  assert.equal(graphemeCount('💝'), 1);
  assert.equal(graphemeCount('👨‍👩‍👧‍👦'), 1);
  assert.equal(graphemeCount('abc'), 3);
  assert.equal(priceUsd('a'), 750);
  assert.equal(priceUsd('ab'), 700);
  assert.equal(priceUsd('abc'), 640);
  assert.equal(priceUsd('abcd'), 160);
  assert.equal(priceUsd('abcde'), 20);
  assert.equal(priceUsd('💝'), 750);
  assert.deepEqual(cleanLabel(' Alice.SNS '), { label: 'alice', error: null });
  assert.equal(cleanLabel('alice.sol').label, 'alice');
  assert.equal(cleanLabel('alice.bob').error, 'One label only — dots are not allowed.');
  assert.equal(cleanLabel('alice bob').error, 'Spaces are not allowed.');
  assert.equal(cleanLabel('   ').error, 'Enter a name.');
}

/* ── 派生地址和官方 SDK 比 ─────────────────────────────────────────── */

const LABELS = ['alice', 'minehub', 'abcde', '💝', 'x'.repeat(20)];
for (const label of LABELS) {
  const ours = S.nameAccount(label).toBase58();
  const ref = SNS.getNameAccountKeySync(SNS.getHashedNameSync(label), undefined, SNS.SNS_ROOT_DOMAIN_ACCOUNT).toBase58();
  assert.equal(ours, ref, 'name account: ' + label);
}

{
  const label = 'minehub';
  const nameKey = S.nameAccount(label);
  const refReverse = SNS.getNameAccountKeySync(SNS.getHashedNameSync(nameKey.toBase58()), SNS.CENTRAL_STATE).toBase58();
  assert.equal(S.reverseAccount(nameKey).toBase58(), refReverse, 'reverse account');
}

for (const record of ['url', 'pic', 'bio', 'twitter', 'email']) {
  const ours = S.recordAccount('minehub', record).toBase58();
  const ref = SNS.getRecordV2Key('minehub', record).toBase58();
  assert.equal(ours, ref, 'record account: ' + record);
}

{
  const owner = new PublicKey('6GQkYV92h1YCZSkH5PYqSWMYjGPPYyN7472tQsgNSsfs');
  const [ref] = SNS.PrimaryDomain.getKeySync(new PublicKey(NAME_OFFERS_ID), owner);
  assert.equal(S.primaryAccount(owner).toBase58(), ref.toBase58(), 'primary account');
}

/* ── 注册：和官方 SDK，以及主网真实交易比 ─────────────────────────── */

const BUYER = new PublicKey('MiNEHUBfAJUH9HH7KmWzinkDvUPvfPDTMzyhos2tgg9'); // real tx buyer
{
  const label = 'minehub';
  const [sdkIx] = (await SNS.registerDomain(label + '.sns', 0, BUYER, S.ata(BUYER), new PublicKey(WSOL_MINT))).slice(-1);
  sameIx(S.registerIx({ buyer: BUYER, label }), sdkIx, 'register vs SDK');
}

/* 主网交易 4zMncWK2… 的 registrar data（base58）—— 用 bs58 不在测试依赖里，
   所以这里存的是它的 base16 形式 14070000006d696e656875620000000000。 */
{
  const real = Buffer.from('14070000006d696e656875620000000000', 'hex');
  assert.equal(hex(S.registerIx({ buyer: BUYER, label: 'minehub' }).data), hex(real), 'register data vs real tx');
}

{
  const label = 'minehub';
  const lamports = 202231081;
  const ours = S.registerIxs({ buyer: BUYER, label, lamports });
  const wsolAta = spl.getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), BUYER, true);
  const refs = [
    spl.createAssociatedTokenAccountIdempotentInstruction(BUYER, wsolAta, BUYER, new PublicKey(WSOL_MINT)),
    W.SystemProgram.transfer({ fromPubkey: BUYER, toPubkey: wsolAta, lamports }),
    spl.createSyncNativeInstruction(wsolAta),
    S.registerIx({ buyer: BUYER, label }),
    spl.createCloseAccountInstruction(wsolAta, BUYER, BUYER),
  ];
  assert.equal(ours.length, refs.length);
  ours.forEach((ix, i) => sameIx(ix, refs[i], 'registerIxs[' + i + ']'));
}

/* ── 记录 / 主名：和官方 SDK 比 ───────────────────────────────────── */

{
  const owner = BUYER;
  const payer = BUYER;
  const sdkCreate = SNS.createRecord('minehub.sns', SNS.Record.Url, 'https://oaken.one', owner, payer);
  sameIx(S.recordIx({ label: 'minehub', record: 'url', value: 'https://oaken.one', owner, payer, exists: false }), sdkCreate, 'record create');
  const sdkEdit = SNS.updateRecord('minehub.sns', SNS.Record.Url, 'https://oaken.one/2', owner, payer);
  sameIx(S.recordIx({ label: 'minehub', record: 'url', value: 'https://oaken.one/2', owner, payer, exists: true }), sdkEdit, 'record edit');
}

{
  const owner = BUYER;
  const nameKey = S.nameAccount('minehub');
  const primary = S.primaryAccount(owner);
  const ref = new SNS.SetPrimaryInstruction().getInstruction(
    new PublicKey(NAME_OFFERS_ID), nameKey, primary, owner, W.SystemProgram.programId,
  );
  sameIx(S.primaryIx({ label: 'minehub', owner }), ref, 'primary');
}

/* ── Pyth 价格账户（真实字节，2026-10-24 抓的 WSOL 喂价）───────────── */

const PYTH_HEX = '22f123639d7ef4cd5bb115b00dd208eaac9f2a6bed58b686c87ddcf52e6dadf15870224332169ecd01ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d727d784d02000000bfe51c0000000000f8ffffff34d1dc6a0000000033d1dc6a000000002aff1154020000009b652f000000000087d7781b0000000000';
{
  const p = S.parsePyth(Buffer.from(PYTH_HEX, 'hex'));
  assert.equal(p.exponent, -8);
  assert.equal(Number(p.price), 9889676658);
  assert.equal(Array.from(p.feed).join(','), SOL_FEED_ID.join(','));
  assert.equal(S.quoteLamports('abcde', p, { bufferBps: 0 }), 202231081n);
  assert.equal(S.quoteLamports('abcde', p, { bufferBps: 300 }), 208298014n);
  // $750 for a 1-char name: exact ceil of 750e6 * 1e11 / price.
  const big = (750n * 1000000n * 10n ** 11n + p.price - 1n) / p.price;
  assert.equal(S.quoteLamports('a', p, { bufferBps: 0 }), big);
  assert.equal(fmtSol(202231081n), '0.2022 SOL');
}

/* ── 读账户：name registry / record / primary ─────────────────────── */

{
  const header = Buffer.alloc(96);
  new PublicKey(SNS_ROOT_DOMAIN_ACCOUNT).toBuffer().copy(header, 0);
  BUYER.toBuffer().copy(header, 32);
  const reg = S.decodeRegistry(Buffer.concat([header, Buffer.from('clue2.sol')]));
  assert.equal(reg.parent, SNS_ROOT_DOMAIN_ACCOUNT);
  assert.equal(reg.owner, BUYER.toBase58());
  assert.equal(reg.class, '11111111111111111111111111111111');
  assert.equal(Buffer.from(reg.data).toString('utf8'), 'clue2.sol');

  const content = Buffer.from('https://oa…');
  const recHeader = Buffer.alloc(8);
  recHeader.writeUInt16LE(1, 0);  // staleness = Solana
  recHeader.writeUInt16LE(0, 2);  // roa = none
  recHeader.writeUInt32LE(content.length, 4);
  const rec = Buffer.concat([Buffer.alloc(96), recHeader, Buffer.alloc(32, 7), content]);
  const d = S.decodeRecord(rec);
  assert.equal(d.verified, true);
  assert.equal(d.text, 'https://oa…');

  const prim = Buffer.concat([Buffer.from([1]), S.nameAccount('minehub').toBuffer()]);
  assert.equal(S.decodePrimary(prim).nameAccount, S.nameAccount('minehub').toBase58());
}

/* 常量和官方 SDK 的常量逐字相等（地址抄错一位是灾难，闸要自己红） */
assert.equal(String(SNS.NAME_PROGRAM_ID), NAME_PROGRAM_ID);
assert.equal(String(SNS.REGISTER_PROGRAM_ID), REGISTER_PROGRAM_ID);
assert.equal(String(SNS.SNS_ROOT_DOMAIN_ACCOUNT), SNS_ROOT_DOMAIN_ACCOUNT);
assert.equal(String(SNS.CENTRAL_STATE), CENTRAL_STATE);
assert.equal(String(SNS.VAULT_OWNER), VAULT_OWNER);

console.log('sns-build: all checks passed');
