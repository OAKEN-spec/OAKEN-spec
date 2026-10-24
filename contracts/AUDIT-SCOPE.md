# Audit scope and readiness

This is the package to hand to an independent auditor. It is **not** an audit.
The target should be a frozen commit of the public repository; record that
commit here before engagement.

## Priority and files

| Priority | Contract | File | Why it is first |
|---|---|---|---|
| P0 | LockVault | `contracts/LockVault.sol` (751 lines) | Holds user tokens; vesting arithmetic; no upgrade/rescue |
| P0 | PositionLock | `contracts/PositionLock.sol` (292) | Holds ERC-721 positions; time-gated release |
| P0 | PinkLockAdapter (“Oaken Lock Adapter”) | `contracts/PinkLockAdapter.sol` (513) | Third-party-compatible write path into LockVault; indexing views |
| P0 | **LockVaultV2** | `contracts/v2/LockVaultV2.sol` (772) | Deployed 2026-10-23; holds that day's locks. v1 plus `nonReentrant` on create/claim/revoke/edit |
| P0 | **PinkLockAdapterV2** | `contracts/v2/PinkLockAdapterV2.sol` (544) | Deployed 2026-10-23; v1 plus the guard and the ETH refund |
| P0 | **LockVaultV3** | `contracts/v3/LockVaultV3.sol` (786) | Deployed 2026-10-24; v2 plus `frozen = max(vestedNow, claimed)` in `revoke()` |
| P0 | **PinkLockAdapterV3** | `contracts/v3/PinkLockAdapterV3.sol` (544) | Deployed 2026-10-24; same source as the v2 adapter, pointed at the v3 vault |
| P0 | **LockVaultV4** (implementation) | `contracts/v4/LockVaultV4.sol` (810) | **Current path; every new lock uses the v4 proxy.** v3 accounting plus proxy init |
| P0 | **PinkLockAdapterV4** (implementation) | `contracts/v4/PinkLockAdapterV4.sol` (568) | **Current path.** v3 adapter with the vault in storage |
| P0 | **ERC1967Proxy** | `contracts/v4/ERC1967Proxy.sol` (145) | Holds every v4 lock's tokens; transparent admin path |
| P0 | **DelayedProxyAdmin** | `contracts/v4/DelayedProxyAdmin.sol` (108) | Schedules/executes upgrades after 48h; owner = multisig |
| P0 | **OakenMultisig** | `contracts/v4/OakenMultisig.sol` (155) | 2-of-3 owner of the delayed admin |
| P1 | OakenLauncher | `contracts/OakenLauncher.sol` (200) | Deploys a token and locks supply in one transaction |
| P1 | TokenFactory / OakenToken | `TokenFactory.sol` (95), `OakenToken.sol` (108) | Creates fixed-supply tokens; no mint after deployment |
| P1 | MultiSender | `MultiSender.sol` (167) | Moves arbitrary amounts to many recipients; batch atomicity |
| P1 | OakenAirdrop | `OakenAirdrop.sol` (238) | Merkle claims, deadlines, creator sweep |
| P1 | PresaleFactory / Presale | `PresaleFactory.sol` (147), `Presale.sol` (360) | Escrows buyer funds and sale tokens; refunds; optional router liquidity |
| P2 | OakenTimelock | `OakenTimelock.sol` (140) | Admin path for Bonds/parameters; **not** in the ownerless-lock boundary |

## Addresses and trust boundaries

The lock-family addresses are deterministic and identical across chains
(`tools`/`src/chains.mjs`). **v1, v2, v3 and v4 are all deployed on all four chains**:
v1 holds every lock created before 2026-10-23, v2 holds 2026-10-23 → 2026-10-24,
v3 holds 2026-10-24, and **v4 is what new locks and launches use**. v1–v3 have no
admin and no migration function; v4 is an ERC1967 proxy whose implementation can
be replaced by a 2-of-3 multisig after 48 hours. The four vaults are read side by
side (see `V2.md`, `V3.md` and `V4.md`). The Timelock and Safe are Robinhood
Chain (4663) deployments.

| Item | Value |
|---|---|
| LockVault | `0xe410d0a21C1376992874a9bEEeE0d623A50D4a34` |
| PositionLock | `0xfC9A43c90e0E0d548D95cEf3C77fce802806CbA9` |
| PinkLockAdapter | `0x16e02A106fE6E978fB98F76756B3a06b4995a7A6` |
| OakenLauncher (v1, legacy) | `0x1d7561fC331594820382E8dd64582645EbafD873` |
| **LockVaultV2** | `0xbC511F31967D9EBF775d203661a2BEfF6AA42615` |
| **PinkLockAdapterV2** | `0xDBE1f3dc1d6E6759355E1B164231748f0589cb41` |
| **OakenLauncherV2** | `0x0d7cCEA7BabC5e3b4849267740D8fBBe6C4FDa58` |
| **LockVaultV3** | `0xd4064d8E73AAB53D7d9efd8A6E8DBE2003d1de4B` |
| **PinkLockAdapterV3** | `0x6022DA059FAa0673E3058ADECEef375c2Abfb4A1` |
| **OakenLauncherV3** | `0x4488C369116D0C6FEA84162313c3840976D5A9a5` |
| **Vault proxy · v4** | `0x5221A10B772D5e2d51B60E8e3dd5DA9338b04ab0` |
| **PinkLockAdapter proxy · v4** | `0xA2898528eb4Aea0bDAf47202A5BA3bA4f58F831c` |
| **OakenLauncherV4** | `0x9600f22d2f629904B44c7dA2d958f5AfB3a1e5Ff` |
| **Upgrade multisig · v4 (2-of-3)** | `0xCb847B572352156be50c90FBc752cfd032114666` |
| **DelayedProxyAdmin · v4 (48h)** | `0xDB998916A34b87c7DA337d922bC1219970FA0319` |
| **LockVaultV4 implementation** | `0xEead023bEcE7D6A458c1da1F8c22E84be885171e` |
| **PinkLockAdapterV4 implementation** | `0x33cA492931828B5a8E222fB731BBa1Ab5124cCaA` |
| TokenFactory | `0xc0A3AD1428EeB70cAF88bb89c3B17D0191E1Bd34` |
| MultiSender | `0x1f380ef5eFF9113314Ee175dCE4F226DFd75A50C` |
| OakenAirdrop | `0x17E9910cDC37BdA5531414012aeA5b0862C22066` |
| PresaleFactory | `0xAC070cf2ed45aEcb9f5299d4C670fFfCE6387724` |
| Timelock | `0x2f848dBdD8b0384AcB1102d959B63E71Ecf44845` (delay 86,400s at handoff) |
| Safe | `0x5E8C4c241a29ff7E60c648f378A4AA70053Ee92e` (2-of-3) |

**Trust model**

- LockVault and PositionLock have no owner, no pause, no upgrade, no rescue, and
  no protocol fee. The only privileged actor is a lock’s creator for a lock that
  declared `revocable`.
- TokenFactory/OakenToken fix the supply at construction; no owner, mint, or
  pause after deployment.
- MultiSender has no owner and retains no state between calls.
- Airdrop/Presale/Launcher have product-specific creator powers described in
  their headers; they do not hold an upgrade key.
- Bonds/Timelock are an **admin** product. Do not read “ownerless locks” as a
  claim about Bonds.

## Questions for the auditor

### LockVault

1. Can any sequence make `claimed > vestedAt(now)` or `claimed > amount` for a
   lock? (Invariant suite says no under monotonic time.)
2. Can `revoke` or `editLock` strand tokens, pay the wrong party, or make
   `refund + vestedAtRevoke` differ from the original credited amount?
3. Are the integer bounds in `vestedAt` tight for `amount ≤ 2^128`,
   `initialUnlockBps ≤ 10000`, `steps ≤ 10000 - initialUnlockBps`, and timestamps
   near `uint64` limits? The code argues the product stays below 2^208.
4. Can a fee-on-transfer token, a false-returning token, a no-return token, or a
   reentrant/hook token break the balance-delta accounting or the
   effects-before-interactions claim ordering?
5. Is the `editLock` “plain vs vesting” branch sound when moving `newEndTime`
   below `cliffTime`, and does a shrink ever pay the caller instead of the
   beneficiary?
6. Does the `agent` field ever exceed the beneficiary’s powers?
7. Is the no-rescue / no-owner stance internally consistent with the available
   exit paths (claim, revoke, transfer, renounce)?

### LockVaultV3 (the revoke clamp)

1. Is `frozen = max(vestedNow, claimed)` sufficient to keep
   `refund + claimed <= credited` for every ordering of claim, downward edit and
   `revoke()`? Can any sequence still make the vault pay out more than it holds
   for that lock?
2. Can `claimed > amount` still be observed after an edit (the edit guard is
   `newAmount >= claimed`, but the curve is rescaled by `amount`)?
3. Does the clamp ever withhold tokens that should be refundable to the creator
   — i.e. is `max(vestedNow, claimed)` the exact lower bound, or can `vestedNow`
   legitimately exceed `claimed` while the creator is still owed the difference?
4. Are the v3-only paths fully exercised by `test/V3.test.ts` and
   `test/foundry/LockVaultV3Invariant.t.sol`, and is the rest byte-identical to
   v2? The invariant suite is documented to fail when pointed at v2.

### Proxy, multisig and upgrade model (v4)

1. Can the proxy's admin path be reached by a non-admin, or can an admin call
   fall through to implementation code with an unexpected selector?
2. Can `DelayedProxyAdmin.executeUpgrade` run before the 48h eta, after a
   cancellation, twice, or re-entrantly? Can a scheduled upgrade be replaced
   without resetting the eta?
3. Can the multisig execute with fewer than two distinct owners, double-count a
   confirmation, or re-enter its own `execute`?
4. Does an implementation upgrade preserve the vault's locks, `nextLockId` and
   reentrancy guard, and the adapter's `vault` and indexes? Is the storage layout
   documented in `contracts/v4/README.md` actually what the code uses?
5. Can the implementation be initialized directly, or a proxy initialized twice?
6. What exactly can a compromised 2-of-3 quorum do after 48h, and what can the
   admin never do (move a lock, change a schedule, pause, take a fee)?
7. Is the 48h delay a real exit window (events, pending state, cancellation) or
   only a number in a document?

### PositionLock

1. Can a position be locked without owner approval, or locked twice?
2. Can `release`/`reclaim` race to the wrong party, or move a position after
   release?
3. Does the receiver refusal for unsolicited `safeTransferFrom` hold for token
   id 0 collisions or malicious ERC-721 implementations?

### PinkLockAdapter

1. Does every PinkLock-shaped argument map onto a LockVault schedule with the
   intended units (days vs seconds, bps vs percent)?
2. Are the compatibility read views (`getLockById`, cumulative views, per-user
   lists, `_lockedAmountOf`) exact enough that a third-party UI cannot show a
   false lock state?
3. Can the adapter’s own indexes become inconsistent with the vault after a
   transfer or revoke?
4. Does `multipleVestingLock` intentionally revert (Unsupported), and is that
   acceptable for the compatibility claim?

### Launcher / Factory / Airdrop / Presale / MultiSender

- Launcher: token creation + lock atomicity; can a failure leave a token without
  its promised lock?
- Factory: supply authority, decimals, and the absence of mint/pause.
- Airdrop: Merkle proof binding, double-claim prevention, sweep deadline, and
  unclaimed-token custody.
- Presale: soft/hard cap accounting, refunds, reentrancy, router liquidity
  share, and rounding at the rate boundary.
- MultiSender: native/ERC-20 failure atomicity, per-row validation, and
  fee-on-transfer accounting in safe mode.

### Timelock

- Queue/execute/cancel authorization, `onlySelf` parameter changes, replay,
  `eta` boundaries, and whether a compromised keeper can do more than publish a
  NAV within the configured limits. At this handoff `delay()` is **86,400s**; a
  queued change to **172,800s** executes at 2026-10-25T09:52Z. The delay is a
  parameter, not an audit result — review the authorization path, not the number.

## Out of scope

- Frontend, static site, indexer, keeper scripts, and social assets.
- Third-party contracts: HD Protocol `.hood` registry, Pons/Genius/Flap/Clanker/
  four.meme launchpads, Jupiter Lock.
- Bonds economics, NAV strategy, and the Safe signer identities (separate
  governance review).
- The Solana program; it is deployed on mainnet with its upgrade authority revoked and passed a 25-check local-validator E2E, but it is outside this EVM audit and has not been audited.
- Formal verification (none has been performed; the invariant suite is not a
  proof).

## Readiness checklist

- [x] Exact file list and addresses above.
- [x] Hardhat unit/integration suite (138 passing: 120 v1 + 4 v2 + 5 v3 + 9 v4).
- [x] Foundry fuzz (14 tests × 1,000 runs), two invariant suites of 4 invariants
      each (v1 and **v3**, the latter unconstrained), the reentrancy PoC and 3
      v2 regressions — 20 Foundry tests in total. The v4 accounting is v3; the
      proxy/admin layer is covered by the 9 v4 Hardhat tests and the local
      upgrade E2E.
- [x] Coverage, reported per version, not blended: **v1 product contracts**
      99.58% statements / 99.82% lines / 100% functions (branch 73.38% — a
      branch-coverage pass remains). **v2** 54.55% / 55.70% / 40% / 35.29%
      branch. **v3** 54.77% / 55.90% / 40% / 36.05% branch
      (`LockVaultV3.sol`: 69.72% statements / 68.22% lines / 72.22% functions /
      45.37% branch). v2/v3/v4 are the v1 code plus small diffs, so the v1 suite
      describes the shared code; their own paths are covered by the versioned
      Hardhat and Foundry tests. v4 is reported per file: `LockVaultV4`
      36.04/35.82/61.90/23.64, `PinkLockAdapterV4` 38.71/43.81/29.55/23.53,
      `ERC1967Proxy` 52.17/58.06/69.23/31.25, `DelayedProxyAdmin`
      78.26/78.26/77.78/43.33, `OakenMultisig` 71.43/75.00/63.64/45.83
      (statements / lines / functions / branch).
- [x] Written invariants, known limitations, and monotonic-time assumption.
- [x] Frozen tags and bundle hashes: `audit-2026-10-23` (v1), `audit-2026-10-23-v2`
      (v2 + self-review + PoC), `audit-2026-10-24-v3` (v3 + the revoke-clamp
      regression) and `audit-2026-10-24-v4` (v4 + proxy/multisig/admin);
      `audit/SHA256SUMS` covers all four bundles.
- [ ] Third-party audit engagement.
- [ ] Public report link and “Audited by … on …” badge (only after the report).
- [ ] Public bug bounty program (separate owner/platform decision).
- [ ] Formal verification of release/schedule arithmetic (optional).
