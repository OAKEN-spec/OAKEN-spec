// SNS (`.sns` on Solana) — pure builders and decoders. No network, no wallet.
//
// Split the same way `solana-build.js` is split from `solana.js`: this module only
// turns inputs into bytes (instructions, PDAs, a price quote). `names-sns.js` does
// the reads/writes and the UI. The Node tests in `solana/test/sns-build.test.mjs`
// compare every instruction here against `@bonfida/spl-name-service` byte for byte.
//
// Facts pinned against mainnet on 2026-10-24 (see README §五之…):
//   · The current TLD is `.sns`. `.sol` is the legacy suffix; SNS's current SDK
//     pauses `.sol` resolution and the registrar only issues `.sns`.
//   · Registration is a one-off USD price paid in a token (we use wrapped SOL),
//     converted on-chain by the registrar through a Pyth pull feed.
//   · The on-chain instruction is the registrar's CreateSplitV2 (tag 20); the
//     real transaction `4zMncWK2…` uses exactly the account order below.
import {
  TOKEN_PROGRAM_ID, ATA_PROGRAM_ID, SYSTEM_PROGRAM_ID, RENT_SYSVAR_ID, WSOL_MINT,
} from './solana-build.js';

export { WSOL_MINT };

export const NAME_PROGRAM_ID = 'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX';
export const REGISTER_PROGRAM_ID = 'jCebN34bUfdeUYJT13J1yG16XWQpt5PDx6Mse9GUqhR';
export const SNS_ROOT_DOMAIN_ACCOUNT = '58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx';
export const CENTRAL_STATE = '33m47vH6Eav6jr5Ry86XjhRft2jRBLDnDgPSHoquXi2Z';
export const VAULT_OWNER = '5D2zKog251d6KPCyFyLMt3KroWwXXPWSgTPyhV22K2gR';
export const SNS_RECORDS_ID = 'HP3D4D1ZCmohQGFVms2SS4LCANgJyksBf5s1F77FuFjZ';
export const NAME_OFFERS_ID = '85iDfUvr3HJyLM2zcq5BXSiDvUWfw6cSE1FfNBo8Ap29';
export const NAME_TOKENIZER_ID = 'nftD3vbNkNqfj2Sd3HZwbpw4BxxKWr4AjGb9X38JeZk';
export const PYTH_PUSH_PROGRAM_ID = 'pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou';

/** Pyth feed id for wrapped SOL (the same feed the SNS registrar reads). */
export const SOL_FEED_ID = [
  239, 13, 139, 111, 218, 44, 235, 164, 29, 161, 93, 64, 149, 209, 218, 57,
  42, 13, 47, 142, 208, 198, 199, 188, 15, 76, 250, 200, 194, 128, 181, 109,
];

/** SNS's public price table, in whole USD. One-off; there is no renewal. */
export const PRICE_USD = { 1: 750, 2: 700, 3: 640, 4: 160 };

/** Record keys the page edits → the on-chain record type name. */
export const RECORD_MAP = {
  url: 'url',
  avatar: 'pic',
  description: 'bio',
  twitter: 'twitter',
  github: 'github',
  telegram: 'telegram',
  discord: 'discord',
  email: 'email',
};

const ZERO32 = new Uint8Array(32);

/* ── SHA-256 (sync, dependency-free) ──────────────────────────────────────
 * `PublicKey.findProgramAddressSync` is sync, so the name hash has to be too.
 * Compared against Node's crypto in the tests for random ASCII/emoji inputs.
 */
const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** SHA-256 over a Uint8Array; returns 32 bytes. */
export function sha256(input) {
  const msg = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bitLen = msg.length * 8;
  const withPad = new Uint8Array((((msg.length + 9 + 63) >> 6) << 6));
  withPad.set(msg);
  withPad[msg.length] = 0x80;
  // 64-bit big-endian length. Names are tiny, but do it properly.
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  const end = withPad.length;
  withPad[end - 8] = (hi >>> 24) & 0xff; withPad[end - 7] = (hi >>> 16) & 0xff;
  withPad[end - 6] = (hi >>> 8) & 0xff; withPad[end - 5] = hi & 0xff;
  withPad[end - 4] = (lo >>> 24) & 0xff; withPad[end - 3] = (lo >>> 16) & 0xff;
  withPad[end - 2] = (lo >>> 8) & 0xff; withPad[end - 1] = lo & 0xff;

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((withPad[j] << 24) | (withPad[j + 1] << 16) | (withPad[j + 2] << 8) | withPad[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + SHA_K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (H[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (H[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (H[i] >>> 8) & 0xff;
    out[i * 4 + 3] = H[i] & 0xff;
  }
  return out;
}

/** How many user-perceived characters (graphemes) a label has. */
export function graphemeCount(s) {
  const v = String(s ?? '');
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return [...seg.segment(v)].length;
    }
  } catch { /* fall through */ }
  return Array.from(v).length;
}

/** One-off USD price for a label (SNS's public table). */
export function priceUsd(label) {
  const n = graphemeCount(label);
  return PRICE_USD[n] || 20;
}

/**
 * Turn whatever the user typed into a label. Lowercase, NFC, one label, no dots.
 * We do not silently drop characters: whitespace and dots are errors, because
 * "alice bob" and "alice.bob" are different things to a user and to the chain.
 */
export function cleanLabel(input) {
  let s = String(input ?? '').normalize('NFC').trim().toLowerCase();
  s = s.replace(/\.sns$/i, '').replace(/\.sol$/i, '');
  if (!s) return { label: '', error: 'Enter a name.' };
  if (s.includes('.')) return { label: '', error: 'One label only — dots are not allowed.' };
  if (/\s/.test(s)) return { label: '', error: 'Spaces are not allowed.' };
  if (/[\u0000-\u001f\u007f]/.test(s)) return { label: '', error: 'Control characters are not allowed.' };
  if (graphemeCount(s) > 63) return { label: '', error: 'That name is too long (63 characters max).' };
  return { label: s, error: null };
}

export function makeSns(web3) {
  const {
    PublicKey, TransactionInstruction, SystemProgram,
  } = web3;
  const Buf = web3.Buffer || (typeof Buffer !== 'undefined' ? Buffer : null);
  if (!Buf) throw new Error('sns build: no Buffer implementation');

  const pk = (v) => (v instanceof PublicKey ? v : new PublicKey(String(v)));
  const bytes = (v) => (v instanceof Uint8Array ? v : Uint8Array.from(v || []));
  const u16le = (n) => { const b = Buf.alloc(2); b.writeUInt16LE(Number(n)); return b; };
  const u32le = (n) => { const b = Buf.alloc(4); b.writeUInt32LE(Number(n)); return b; };
  const borshString = (s) => {
    const raw = Buf.from(String(s ?? ''), 'utf8');
    return Buf.concat([u32le(raw.length), raw]);
  };
  const pda = (seeds, program) => PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === 'string' ? Buf.from(s, 'utf8') : s)),
    pk(program),
  )[0];

  const nameProgram = pk(NAME_PROGRAM_ID);
  const registerProgram = pk(REGISTER_PROGRAM_ID);
  const root = pk(SNS_ROOT_DOMAIN_ACCOUNT);
  const central = pk(CENTRAL_STATE);
  const vaultOwner = pk(VAULT_OWNER);
  const recordsProgram = pk(SNS_RECORDS_ID);
  const offersProgram = pk(NAME_OFFERS_ID);
  const tokenizer = pk(NAME_TOKENIZER_ID);
  const pythProgram = pk(PYTH_PUSH_PROGRAM_ID);
  const tokenProgram = pk(TOKEN_PROGRAM_ID);
  const ataProgram = pk(ATA_PROGRAM_ID);
  const systemProgram = pk(SYSTEM_PROGRAM_ID);
  const rentSysvar = pk(RENT_SYSVAR_ID);
  const wsol = pk(WSOL_MINT);

  /** The SNS name hash: sha256("SPL Name Service" + label). */
  const hashName = (label) => Buf.from(sha256(Buf.from('SPL Name Service' + String(label), 'utf8')));

  const nameAccount = (label) => pda([hashName(label), ZERO32, root.toBuffer()], nameProgram);
  const reverseAccount = (nameKey) => pda([hashName(pk(nameKey).toBase58()), central.toBuffer(), ZERO32], nameProgram);
  const recordAccount = (label, record) => pda(
    [hashName('\x02' + record), centralStateRecords().toBuffer(), nameAccount(label).toBuffer()],
    nameProgram,
  );
  const centralStateRecords = () => pda([recordsProgram.toBuffer()], recordsProgram);
  const primaryAccount = (owner) => pda([Buf.from('favourite_domain', 'utf8'), pk(owner).toBuffer()], offersProgram);
  const pythFeed = () => pda([u16le(0), Uint8Array.from(SOL_FEED_ID)], pythProgram);
  const domainMint = (nameKey) => pda([Buf.from('NAME', 'utf8'), pk(nameKey).toBuffer()], tokenizer);

  const ata = (owner, mint = WSOL_MINT) => pda(
    [pk(owner).toBuffer(), tokenProgram.toBuffer(), pk(mint).toBuffer()], ataProgram,
  );

  /** ATA program: tag 1 = CreateIdempotent (the real SNS transaction uses this). */
  function createAtaIdempotentIx(payer, owner, mint = WSOL_MINT) {
    return new TransactionInstruction({
      programId: ataProgram,
      keys: [
        { pubkey: pk(payer), isSigner: true, isWritable: true },
        { pubkey: ata(owner, mint), isSigner: false, isWritable: true },
        { pubkey: pk(owner), isSigner: false, isWritable: false },
        { pubkey: pk(mint), isSigner: false, isWritable: false },
        { pubkey: systemProgram, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
      ],
      data: Buf.from([1]),
    });
  }

  function syncNativeIx(owner) {
    return new TransactionInstruction({
      programId: tokenProgram,
      keys: [{ pubkey: ata(owner), isSigner: false, isWritable: true }],
      data: Buf.from([17]),
    });
  }

  function closeAccountIx(owner) {
    return new TransactionInstruction({
      programId: tokenProgram,
      keys: [
        { pubkey: ata(owner), isSigner: false, isWritable: true },
        { pubkey: pk(owner), isSigner: false, isWritable: true },
        { pubkey: pk(owner), isSigner: true, isWritable: false },
      ],
      data: Buf.from([9]),
    });
  }

  /**
   * The registrar's CreateSplitV2 (tag 20).
   *
   * Account order is the one the official SDK builds and the one mainnet
   * transaction `4zMncWK2…` carries: program, root, name, reverse, system,
   * central, buyer (signer), owner, fee payer, buyer's WSOL ATA, Pyth feed,
   * vault ATA, token program, rent sysvar, registrar state PDA.
   */
  function registerIx({ buyer, label, space = 0 }) {
    const buyerKey = pk(buyer);
    const nameKey = nameAccount(label);
    const reverseKey = reverseAccount(nameKey);
    const state = pda([nameKey.toBuffer()], registerProgram);
    const data = Buf.concat([
      Buf.from([20]),
      borshString(label),
      u32le(space),
      Buf.from([0]), // Option<u16> referrer: None
    ]);
    return new TransactionInstruction({
      programId: registerProgram,
      keys: [
        { pubkey: nameProgram, isSigner: false, isWritable: false },
        { pubkey: root, isSigner: false, isWritable: false },
        { pubkey: nameKey, isSigner: false, isWritable: true },
        { pubkey: reverseKey, isSigner: false, isWritable: true },
        { pubkey: systemProgram, isSigner: false, isWritable: false },
        { pubkey: central, isSigner: false, isWritable: false },
        { pubkey: buyerKey, isSigner: true, isWritable: true },
        { pubkey: buyerKey, isSigner: false, isWritable: false },
        { pubkey: buyerKey, isSigner: true, isWritable: true },
        { pubkey: ata(buyerKey), isSigner: false, isWritable: true },
        { pubkey: pythFeed(), isSigner: false, isWritable: false },
        { pubkey: ata(vaultOwner), isSigner: false, isWritable: true },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
        { pubkey: rentSysvar, isSigner: false, isWritable: false },
        { pubkey: state, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * The five instructions a registration needs, in the same order as the
   * official app: idempotent WSOL ATA, fund it, syncNative, register, close it.
   * `lamports` is the amount wrapped; the registrar charges the USD price at
   * execution and `closeAccount` returns the remainder (and the ATA rent).
   */
  function registerIxs({ buyer, label, lamports, space = 0 }) {
    const buyerKey = pk(buyer);
    const wsolAta = ata(buyerKey);
    return [
      createAtaIdempotentIx(buyerKey, buyerKey),
      SystemProgram.transfer({ fromPubkey: buyerKey, toPubkey: wsolAta, lamports: Number(lamports) }),
      syncNativeIx(buyerKey),
      registerIx({ buyer: buyerKey, label, space }),
      closeAccountIx(buyerKey),
    ];
  }

  /** V2 record: tag 1 allocates+posts, tag 2 edits an existing account. */
  function recordIx({ label, record, value, owner, payer, exists = false }) {
    const ownerKey = pk(owner);
    const payerKey = pk(payer || owner);
    const parent = nameAccount(label);
    const account = recordAccount(label, record);
    const content = Buf.from(String(value ?? ''), 'utf8');
    const data = Buf.concat([
      Buf.from([exists ? 2 : 1]),
      borshString('\x02' + record),
      u32le(content.length),
      content,
    ]);
    return new TransactionInstruction({
      programId: recordsProgram,
      keys: [
        { pubkey: systemProgram, isSigner: false, isWritable: false },
        { pubkey: nameProgram, isSigner: false, isWritable: false },
        { pubkey: payerKey, isSigner: true, isWritable: true },
        { pubkey: account, isSigner: false, isWritable: true },
        { pubkey: parent, isSigner: false, isWritable: true },
        { pubkey: ownerKey, isSigner: true, isWritable: true },
        { pubkey: centralStateRecords(), isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /** Primary-domain selection (tag 6 of the name-offers program). */
  function primaryIx({ label, owner }) {
    const ownerKey = pk(owner);
    return new TransactionInstruction({
      programId: offersProgram,
      keys: [
        { pubkey: nameAccount(label), isSigner: false, isWritable: false },
        { pubkey: primaryAccount(ownerKey), isSigner: false, isWritable: true },
        { pubkey: ownerKey, isSigner: true, isWritable: true },
        { pubkey: systemProgram, isSigner: false, isWritable: false },
      ],
      data: Buf.from([6]),
    });
  }

  /**
   * Parse a Pyth pull-oracle account as posted by the SNS registrar.
   * Layout (134 bytes): 8 discriminator · 32 write authority · 1 verification
   * level · 32 feed id · i64 price · u64 conf · i32 exponent · i64 publish time …
   */
  function parsePyth(data) {
    const b = bytes(data);
    if (b.length < 134) throw new Error('The price account is not a Pyth pull feed.');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const price = dv.getBigInt64(73, true);
    const conf = dv.getBigUint64(81, true);
    const exponent = dv.getInt32(89, true);
    const publishTime = Number(dv.getBigInt64(93, true));
    const feed = Array.from(b.subarray(41, 73));
    return { price, conf, exponent, publishTime, feed };
  }

  /** Lamports to wrap for a label, using the on-chain feed and a small buffer. */
  function quoteLamports(label, pyth, { bufferBps = 300 } = {}) {
    const usdMicro = BigInt(priceUsd(label)) * 1000000n;
    const exp = BigInt(pyth.exponent);
    const price = BigInt(pyth.price);
    if (price <= 0n) throw new Error('The price feed returned a non-positive price.');
    let num;
    let den;
    if (exp <= 0n) { num = usdMicro * 10n ** (3n - exp); den = price; }
    else { num = usdMicro * 1000n; den = price * 10n ** exp; }
    let lamports = (num + den - 1n) / den;
    lamports = (lamports * (10000n + BigInt(bufferBps)) + 9999n) / 10000n;
    return lamports;
  }

  /** Decode a name-registry account: 96-byte header + payload. */
  function decodeRegistry(data) {
    const b = bytes(data);
    if (b.length < 96) throw new Error('That is not a name-registry account.');
    const enc = (u8) => new PublicKey(u8).toBase58();
    return {
      parent: enc(b.subarray(0, 32)),
      owner: enc(b.subarray(32, 64)),
      class: enc(b.subarray(64, 96)),
      data: b.subarray(96),
    };
  }

  /** Validation enum → byte length of the id that follows the content header. */
  const validationLen = (v) => (v === 1 || v === 3 ? 32 : v === 2 ? 20 : 0);

  /** Decode a V2 record account (name-registry header + 8-byte record header). */
  function decodeRecord(data) {
    const b = bytes(data);
    if (b.length < 104) throw new Error('That is not a record account.');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const staleness = dv.getUint16(96, true);
    const roa = dv.getUint16(98, true);
    const len = dv.getUint32(100, true);
    const start = 104 + validationLen(staleness) + validationLen(roa);
    const content = b.subarray(start, Math.min(b.length, start + len));
    return {
      staleness,
      roa,
      length: len,
      content,
      text: Buf.from(content).toString('utf8'),
      verified: staleness === 1 || staleness === 3,
    };
  }

  /** Primary-domain account: tag u8 + name account (32 bytes). */
  function decodePrimary(data) {
    const b = bytes(data);
    if (b.length < 33) throw new Error('That is not a primary-domain account.');
    return { tag: b[0], nameAccount: new PublicKey(b.subarray(1, 33)).toBase58() };
  }

  return {
    web3,
    Buf,
    pk,
    pda,
    hashName,
    nameAccount,
    reverseAccount,
    recordAccount,
    centralStateRecords,
    primaryAccount,
    pythFeed,
    domainMint,
    ata,
    createAtaIdempotentIx,
    syncNativeIx,
    closeAccountIx,
    registerIx,
    registerIxs,
    recordIx,
    primaryIx,
    parsePyth,
    quoteLamports,
    decodeRegistry,
    decodeRecord,
    decodePrimary,
  };
}

/** Short display helpers shared by the page and the probes. */
export function fmtUsd(v) { return '$' + Number(v).toLocaleString('en-US'); }
export function fmtSol(lamports) {
  const n = Number(lamports) / 1e9;
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 0.01 ? 6 : 4 }) + ' SOL';
}

/** Turn the common Solana/SNS failures into sentences a visitor can act on. */
export function humanizeSnsError(e) {
  const msg = String((e && (e.message || e)) || '').trim();
  if (!msg) return 'The wallet returned an unknown error.';
  if (/user rejected|rejected the request|4001/i.test(msg)) return 'You rejected the request in your wallet.';
  if (/insufficient lamports|insufficient funds|0x1\b/i.test(msg)) {
    return 'Not enough SOL for the price plus rent and fees. The quote includes a small buffer; top up and try again.';
  }
  if (/blockhash not found|BlockhashNotFound/i.test(msg)) return 'The blockhash expired before it landed. Try again.';
  if (/already in use|already registered|0x0\b/i.test(msg)) return 'That name was registered between your search and your signature. Nothing was taken from you.';
  if (/AccountNotFound/i.test(msg)) return 'That wallet has no SOL yet — it needs a little SOL for fees.';
  if (/Transaction simulation failed/i.test(msg)) return 'The chain rejected the transaction: ' + msg.slice(0, 180);
  return msg.slice(0, 240);
}
