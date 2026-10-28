# OAKEN Curve — Solana

The pump.fun-shaped launch on Solana: one fixed 1B supply, minted to a bonding
curve, with no creator allocation.

## Status (2026-10-25)

| Piece | State |
|---|---|
| SBF build (deployable, SBPF v3) | ✅ `target/deploy/oaken_curve.so` — **106,184 bytes**, sha256 `cc9ab3c8541797f80f4f7f90f305df7124994e6f31265f42f9e1ccc45928eb08` |
| Host unit tests | ✅ 26/26 (`cargo test`) |
| Client builders | ✅ 9/9 (`node --test test/curve-builders.test.mjs`) |
| In-process integration tests | ✅ **2/2**: real runtime + **the real PumpSwap ELF** and **the real Metaplex Token Metadata ELF**; `cargo-test-sbf --arch v2` (the 2.3 test runtime supports SBPF v2; the deployable artifact is v3). |
| Local validator E2E | ⛔ blocked on this Windows machine — `solana-test-validator` needs symlink privileges (error 1314). Two scripts are ready for Linux/CI: `scripts/curve-e2e.mjs` (vault) and `scripts/curve-pumpswap-e2e.mjs` (real PumpSwap, cloned from mainnet). |
| PumpSwap CPI | ✅ **implemented and exercised in-process.** `GraduatePumpSwap` creates a permissionless PumpSwap pool and leaves the LP locked in a data-less authority's Token-2022 ATA. |
| Mainnet deployment | ⛔ not deployed. Deploy peak ≈ **1.482 SOL** (ProgramData + buffer), final ≈ **0.741 SOL**; the wallet holds 0.024525788 SOL (short by ≈1.457 SOL). |

## The curve

Constants are from pump.fun's on-chain `Global` account (2026-10-25):

- supply 1,000,000,000 (6 decimals)
- initial virtual SOL 30; initial virtual token 1,073,000,000
- sellable 793,100,000; reserved for the pool 206,900,000
- fees: 0.95% protocol + creator fee (default 5 bps, max 300 bps)
- the curve completes at about 85 SOL of real reserves
- `Buy.amount_in` is a **maximum**, not an escrowed amount: the buyer is debited
  exactly `gross` (net + fees). The unused part of the maximum is never taken,
  so there is no refund transfer from the curve. A buy that reaches the line
  takes exactly the remaining sellable tokens.

### Accounts and why there are three PDAs

A System transfer **cannot use an account that carries data as its source**
(`Transfer: from must not carry data`). The curve account carries 232 bytes of
state, so neither the tokens nor the SOL can live in it:

| PDA | Seeds | Data | Holds |
|---|---|---|---|
| curve | `["curve", mint]` | 232-byte state | accounting only (rent) |
| SOL vault | `["sol", mint]` | none (system account) | the raised SOL |
| pump authority | `["pump", mint]` | none (system account) | owns the curve ATA, the wSOL ATA and the LP ATA; is the PumpSwap creator |
| graduation vault | `["graduate", mint]` | none (system account) | vault-path tokens/SOL |

The mint authority is the curve PDA and is renounced inside `Create`. The token
vault (`curve ATA`) is owned by the **pump authority**, which is also the
PumpSwap creator: PumpSwap transfers the vault's tokens using the creator as
authority, so those owners must match.

## Instructions

| tag | instruction | accounts |
|---|---|---|
| 0 | Create { creator_fee_bps } | creator, mint, curve, curve ATA, pump authority, protocol fee recipient, creator fee recipient, token, system, ATA, rent |
| 5 | CreateWithMetadata { creator_fee_bps, name, symbol, uri } | the same 11 + Metaplex metadata PDA (writable) + Token Metadata program |
| 1 | Buy { amount_in, min_tokens_out } | buyer, curve, mint, curve ATA, buyer ATA, SOL vault, pump authority, protocol fee recipient, creator fee recipient, token, system |
| 2 | Sell { amount_in, min_sol_out } | seller, curve, mint, seller ATA, curve ATA, SOL vault, protocol fee recipient, creator fee recipient, token, system |
| 3 | Graduate (vault) | payer, curve, mint, curve ATA, SOL vault, pump authority, graduation vault, vault ATA, token, system, ATA |
| 4 | GraduatePumpSwap { index } | payer, curve, mint, curve ATA, SOL vault, pump authority, curve wSOL ATA, pool, PumpSwap global config, LP mint, LP ATA, pool base ATA, pool quote ATA, event authority, PumpSwap program, wSOL mint, token, token-2022, system, ATA |

The client builders in `client.mjs` are the same wire format and account order;
`test/curve-builders.test.mjs` pins them.

## Metadata

`CreateWithMetadata` (tag 5) gives the token a name. It writes Metaplex
`CreateMetadataAccountV3` through a CPI **before** minting the supply and
renouncing the mint authority: after the renounce the curve PDA can no longer
sign for Metaplex, so this is the only window.

- metadata PDA: `["metadata", metaplex, mint]` under the Token Metadata program;
- update authority: the curve PDA, and `is_mutable = false`, so no one can
  rewrite the name, symbol or URI;
- the program verifies the metadata account, the Metaplex program id and the
  UTF-8 string lengths (name 1–32, symbol 1–10, URI 1–200) before the CPI.

`tests/create_with_metadata.rs` loads the **real mainnet Metaplex ELF**
(`tests/fixtures/mpl_token_metadata.so`, 793,991 bytes) into `solana-program-test`
and asserts the stored name/symbol/URI, the curve PDA as update authority, the
renounced mint authority, and that a metadata account which is not the mint's PDA
is refused. The fixture is a test input, not a deployment; it is not executable
on mainnet.

## Graduation into PumpSwap

`GraduatePumpSwap` is atomic and permissionless:

1. derive and verify every address from the mint and the index: the SOL vault,
   the pump authority, the pool (`creator = pump authority`), the LP mint and
   the five ATAs;
2. wrap the raised SOL: the SOL vault (data-less) sends it to the pump
   authority's wSOL ATA with a System transfer, then `sync_native`;
3. fund the data-less pump authority with 12M lamports (it pays for the accounts
   PumpSwap creates) and create the pool-side base/quote ATAs with the payer;
4. CPI `create_pool` with the pump authority as creator. PumpSwap creates the
   LP mint and the pump authority's LP ATA, and transfers the curve ATA /
   wSOL ATA into the pool — both are owned by the pump authority, matching the
   creator authority;
5. if the runtime exposes the fresh LP account, reject a wrong mint or a zero
   balance (the integration test asserts both over RPC);
6. close the wSOL account to the payer, refund 2M of the 12M rent budget with a
   plain System transfer, record the pool in the curve account and set
   `graduated`. The ≈3–5M residual stays locked in the data-less pump authority
   (its post-CPI lamports cannot be read reliably; no instruction moves them).

The LP stays in the pump authority's Token-2022 ATA. No instruction in this
program can move it, so the pool's liquidity is locked permanently.

The 69-byte `create_pool` data and the 18-account CPI order are pinned against
`@pump-fun/pump-swap-sdk` (offline) in `src/pump.rs`. A real mainnet
`simulateTransaction` on 2026-10-25 confirmed that PumpSwap creates the LP mint
and the creator's Token-2022 LP ATA itself and mints the LP there (79,691 CU for
`create_pool`; 96,405 CU inside the full graduation).

The caller spends ≈0.013 SOL permanently (pool/LP rents, pool ATAs, the
residual) plus the transaction fee.

## Verification

- **In-process integration test** (`tests/graduate_pumpswap.rs`): loads the real
  PumpSwap program (mainnet `.so` in `tests/fixtures`) and the real global
  config into `solana-program-test`, creates a curve, buys to completion,
  graduates, and asserts: the curve records the pool; the pool creator is the
  pump authority; the pool holds 206.9M tokens and the raised SOL; the LP supply
  is non-zero and 100% in the pump authority's Token-2022 ATA; the wSOL account
  is closed; the SOL vault is empty; a second PumpSwap graduation and the vault
  graduation are both refused.
- `cargo-test-sbf --arch v2` runs it. The 2.3 test runtime supports SBPF up to
  v2; the deployable artifact is built v3 (mainnet 4.x supports it — the OAKEN
  lock program deployed with v3 on 2026-10-23).
- On Windows, building the 2.3 test runtime's OpenSSL needs a native Perl and
  an ASCII target dir. This machine keeps a portable Strawberry Perl at
  `solana/_strawberry` and an ASCII junction `E:\oaken → the project`; the exact
  invocation is:
  `PATH=/e/oaken/solana/_strawberry/perl/bin:$PATH CARGO_TARGET_DIR=E:/oaken-target cargo-test-sbf --arch v2`
  (first run builds vendored OpenSSL, ~20–30 min). Linux/CI needs neither.

## Build / deploy

```bash
# Host tests + SBF build (deployable, v3)
cd solana && cargo test
cargo-build-sbf --manifest-path curve-program/Cargo.toml

# Integration tests (real PumpSwap + real Metaplex, SBPF v2 for the 2.3 runtime)
node scripts/fetch-pump-fixtures.mjs
solana program dump metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  tests/fixtures/mpl_token_metadata.so -u m
cd curve-program && cargo-test-sbf --arch v2

# Cost check (no send), then the real deploy with --final (authority → none):
cd solana && node scripts/deploy-curve.mjs
EXECUTE=1 node scripts/deploy-curve.mjs
```

`scripts/deploy-curve.mjs` computes the two rent deposits (ProgramData and the
deploy buffer exist at the same time), refuses to start if the wallet cannot
cover both, deploys with `--final`, reads ProgramData back, and fails unless the
on-chain bytes and sha256 match the local `.so` and the authority is none.
For this 106,184-byte build: **peak ≈ 1.482 SOL, final ≈ 0.741 SOL**.

Program ID: `BvTeztC4ENG8x2TW19AkiJ9EnC9JNresmA1pE6MBWpRi`.

## E2E (Linux/CI)

```bash
# validator with the program, then the script (vault path)
solana-test-validator --bpf-program BvTeztC4ENG8x2TW19AkiJ9EnC9JNresmA1pE6MBWpRi \
  target/deploy/oaken_curve.so --reset --quiet &
node scripts/curve-e2e.mjs

# PumpSwap path: spawns a validator that clones the real AMM from mainnet
node scripts/curve-pumpswap-e2e.mjs --start
```

`curve-pumpswap-e2e.mjs --start` clones `pAMM…`, its global config / event
authority, and the token programs; it checks the pool account, both reserves,
the LP mint, the pump-authority LP ATA (locked liquidity), the closed wSOL
account, and that neither graduation path can run twice. The CI workflow runs
the in-process test and both validator E2Es.
