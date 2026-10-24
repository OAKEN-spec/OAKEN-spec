# OAKEN contracts — internal self-review (2026-10-23; v3/v4 addendum 2026-10-24)

**This is not an audit.** It is a reproducible internal review: static analysis,
the existing fuzz/invariant suites, a hand triage of every High/Medium result,
and one proof-of-concept for the only High finding. No independent reviewer has
seen this code. Do not describe it as audited.

Scope: the EVM contracts in `contracts/contracts/` (11 product contracts), **the
deployed v2 fork in `contracts/v2/`** (`LockVaultV2`, `PinkLockAdapterV2`), **the
deployed v3 fork in `contracts/v3/`** (`LockVaultV3`, `PinkLockAdapterV3`) and
**the deployed v4 upgradeable stack in `contracts/v4/`** (`LockVaultV4`,
`PinkLockAdapterV4`, `ERC1967Proxy`, `DelayedProxyAdmin`, `OakenMultisig`), with
the deployed bytecode at the deterministic addresses on 4663 / 56 / 8453 / 137.
Solana is covered separately in `solana/README.md` and the CI E2E; it was not
run through an EVM analyzer.

Frozen code: v1 at tag `audit-2026-10-23` (contracts commit `de736d3`); the v2
fork and this self-review at tag `audit-2026-10-23-v2`; the v3 fork at tag
`audit-2026-10-24-v3`; the v4 stack and addendum at tag `audit-2026-10-24-v4`.
The four bundles and their SHA-256 hashes are listed in `audit/README.md`.

## Tools and commands

| What | Command | Result |
|---|---|---|
| Hardhat unit/refusal tests | `npm test` | 138 passing (120 v1 + 4 v2 + 5 v3 + 9 v4) |
| Foundry fuzz + invariant | `forge test --match-path "test/foundry/*"` | 14 fuzz tests, two 4-invariant suites (v1 and v3), 20 tests in total (including the PoC and v2 regressions) |
| Reentrancy PoC | `forge test --match-contract ReentrancyPoC -vv` | passes — demonstrates SR-01 |
| Slither 0.11.6 | `slither . --compile-force-framework hardhat --filter-paths "mocks\|test\|lib\|node_modules" --json audit/slither-product.json` | 107 findings, 17 High/Medium before triage. **Run predates v3** (v1/v2 only); SR-04 was found by the invariant suite, not Slither |
| Aggregated checks | `node check.js` | 138 contract + 63 JS tests, v1/v2/v3/v4 address and topic checks |
| Halmos 0.3.3 | `halmos --forge-build-out foundry-out --contract LockVaultSymbolic --function check_` | **not executed**: tool fails on this Foundry 1.8.6 artifact format (`Unsupported cheat code: deployCode(string)`); no symbolic result is claimed |

Solc 0.8.24 (solc-select) was used by Slither. The Slither JSON is kept at
`audit/slither-product.json`; the full run (including mocks) is
`audit/slither.json`.

## Findings

### SR-01 — Reentrancy through a token transfer callback — **High (conditional), open**

`LockVault.createLock` and the increase branch of `LockVault.editLock` read the
vault balance, call `token.transferFrom`, and only then write the lock amount.
A token that calls back into the vault during `transferFrom` (ERC-777-style
`tokensToSend`, or a malicious token) can create a second lock in the callback.
The outer balance delta then includes the inner transfer, so the outer lock is
credited more than was sent for it. The same call path is reachable through
`PinkLockAdapter.lock` / `vestingLock`.

Impact: for a token with a transfer callback, an attacker can over-credit their
own lock, claim it, and leave an unrelated lock of the same token short. The
vault's per-token balance is shared, so the shortfall is paid by another locker
of that token. Plain ERC-20 tokens without callbacks are not affected.

Proof: `contracts/test/foundry/ReentrancyPoC.t.sol` (passes). It creates a
100-token lock whose token re-enters with a 50-token lock; the outer lock is
credited 150, an unrelated 100-token lock exists, the vault holds 250, the
attacker claims 200, and the unrelated claim then reverts.

Status on the deployed contracts: **cannot be patched** (no owner, no upgrade).
Mitigation for the current deployment: the creation UI now warns explicitly that
tokens with transfer hooks/callbacks (ERC-777 and similar) are not supported; the
warning already covered fee-on-transfer, rebasing, blacklisting and pausable
tokens.

**Fixed in v2 (deployed on Robinhood 4663, BNB Chain 56, Base 8453 and Polygon 137; new locks use v2, v1 stays live for older locks):** `contracts/v2/LockVaultV2.sol` adds a
`nonReentrant` guard on `createLock`, `claim`, `revoke` and `editLock`.
`test/foundry/V2Fixes.t.sol` runs the same re-entrant token against v2: the outer
transaction reverts, no lock is booked and no tokens stay in the vault. The
deployment/migration plan (new salts, dual-read old and new vaults) is in
`contracts/V2.md`.

### SR-02 — `PinkLockAdapter` payable functions can retain ETH — **Low, accepted**

`lock` and `vestingLock` are `payable`, but the adapter has no `receive`,
`fallback`, withdrawal or rescue. ETH sent by mistake stays in the contract
forever. The site never sends value; the functions do not need ETH. Impact is
limited to a caller who attaches value by mistake.

Status on the deployed contracts: cannot be patched. **Fixed in v2 (deployed on Robinhood 4663, BNB Chain 56, Base 8453 and Polygon 137; new locks use v2, v1 stays live for older locks):** `contracts/v2/PinkLockAdapterV2.sol` keeps the functions payable
for PinkSale's form but refunds `msg.value` to the caller in the same
transaction; `V2Fixes.t.sol` asserts the adapter ends with a zero ETH balance.

### SR-03 — Slither informational / false positives — **informational**

Triaged and dismissed, with reasons:

- **divide-before-multiply** in `LockVault._vested` and
  `MultiSender.disperseEtherEqual`: intentional. The first quantizes vesting to
  whole `stepSize` tranches; the second computes an equal share and returns the
  dust. Both are covered by tests.
- **divide-before-multiply** in `PinkLockAdapter._vestingSchedule`: `steps *
  cycle` is part of the schedule; inputs are bounded and Solidity checks
  overflow. Not a precision loss in the same sense.
- **incorrect-equality** (`amount == 0`, `received == 0`, `ret.length == 0`):
  deliberate zero checks; the “dangerous” pattern does not apply.
- **uninitialized-local** (`MultiSender.total`, `Presale.toLiquidity`): Solidity
  zero-initializes locals; these are accumulator initializations.
- **erc20-interface** on `IERC721TransferFrom`: the interface is deliberately an
  ERC-721 transferFrom with a uint256 id; the detector matches on the name.
- **missing-inheritance**, **constable-states**, **calls-loop**,
  **block-timestamp**: style/scheduling notes, not defects. Timestamps are the
  schedule; the vesting code is designed around them.

The raw Slither report still contains all of these; this file records the
triage rather than hiding the report.

### SR-04 — `revoke()` after a downward edit can refund from other locks — **High (conditional), fixed in v3**

Found on 2026-10-24 by the unconstrained invariant suite, not by Slither:

1. a revocable lock partially vests and the beneficiary claims part of it
   (50 of 100);
2. the amount is edited down to 60 — allowed, because the only guard is
   `newAmount >= claimed`;
3. the curve is scaled by `amount`, so at the same timestamp the 60-token
   schedule has vested 36 — less than the 50 already paid;
4. `revoke()` froze `amount` at `vestedNow` (36) and refunded `60 - 36 = 24`,
   but the vault held only `60 - 50 = 10` for this lock. The other 14 came from
   tokens held for **other locks of the same token**, and the record showed
   `claimed > amount`.

No revocable locks existed on chain when this was found; the create form could
still make one.

**Fixed in v3 (deployed on all four chains on 2026-10-24; inherited by v4,
which is what new locks and launches use; v1 and v2 stay live for earlier
locks):**
`contracts/v3/LockVaultV3.sol` sets `frozen = max(vestedNow, claimed)` and
refunds `amount - frozen`. `test/V3.test.ts` (5 Hardhat tests) pins the sequence
and the normal paths; `test/foundry/LockVaultV3Invariant.t.sol` is the
unconstrained suite and is documented to fail when pointed at v2. The deployment
and multi-read migration are in `contracts/V3.md`.

### v4 — the upgrade path introduced because v1–v3 cannot be repaired — **design change, not a finding**

The SR-04 fix had to be deployed beside the immutable vaults; that made the
absence of a repair path the next problem. v4 keeps the v3 accounting and puts it
behind an ERC1967 proxy:

- `OakenMultisig` is a 2-of-3 with the existing Safe owners;
- it owns `DelayedProxyAdmin`, which requires `scheduleUpgrade`, then a **48-hour
  wait**, then `executeUpgrade`; the owner can cancel in between;
- the admin cannot move a lock's tokens, change a schedule, pause the vault, take
  a fee or rescue funds — it can only replace the vault/adapter implementation;
- `test/V4.test.ts` (9 tests) covers proxy wiring, one-shot initialization,
  non-admin refusal, lock/claim through the adapter proxy, the 2-of-3 + 48h path,
  cancellation, non-owner refusal, a vault upgrade that preserves locks, an
  adapter upgrade that preserves indexes, and the launcher through the proxy;
- `_look/v4-upgrade-e2e.cjs` repeats the real path on a local chain with two
  impersonated owners and checks that a lock survives the implementation swap.

The risk this introduces is stated in `V4.md`: a compromised 2-of-3 quorum plus
the 48h delay can replace the code. The delay is the exit window, not a vote.
v1–v3 remain immutable and cannot be moved into v4.

## Solana

- `cargo build-sbf` succeeds; the deployed program's bytecode hash matches the
  local build (see `solana/README.md`).
- GitHub Actions `.github/workflows/solana-e2e.yml` runs the five instructions
  on a local validator: **25/25 checks pass** (run `39928391564`).
- Mainnet execution also completed the same instruction set; five test locks
  were left on chain (one renounced, one revoked).
- Local `cargo test` fails on this Windows machine because `openssl-sys` builds
  against the Git-Bash Perl; CI runs the same tests on Linux.
- No Rust static analyzer (clippy/cargo-audit) result is claimed: clippy could
  not be installed (rustup mirror 404 for this toolchain) and cargo-audit is not
  installed. The program has one runtime dependency, `solana-program`, and no
  Anchor.

## Limitations

- One reviewer (the author of the code) looking at their own code.
- No independent audit, no formal verification, no economic/oracle review.
- The EVM contracts and Solana program are already deployed and immutable;
  findings in this file cannot be fixed at the same addresses.
- Static analyzers miss design bugs; the fuzz/invariant suites encode the
  properties they were given, not all properties.

## Recommended next steps

1. Add the token-callback warning to the lock creation UI (SR-01) now — **done**.
2. For any v2 deployment: the guarded `LockVaultV2` and refunding
   `PinkLockAdapterV2` are ready in `contracts/v2/`; the PoC is converted into
   `V2Fixes.t.sol` (must revert). Follow `contracts/V2.md` for the dual-read
   migration.
3. Run Halmos on a toolchain combination that supports it, or a symbolic tool
   that supports Foundry 1.8.6; publish the properties and results.
4. Keep the public disclosure route (`SECURITY.md`, GitHub private advisories)
   and add a paid bounty only when a funded pool exists.
