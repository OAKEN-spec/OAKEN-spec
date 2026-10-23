# Security policy and audit readiness — OAKEN contracts

**Status as of 2026-10-23: no third-party audit has been completed. No bug bounty
is live. This document is an internal readiness package, not an audit report.**

The site currently says “Verification is not an audit.” That stays true until a
real report exists. We will not add an “Audited by …” badge, a fake report link,
or a bounty link before then.

## What is in scope

The EVM contracts in this repository. Addresses are deterministic and identical
on every chain where they are deployed.

| Contract | File | Mainnet address (4663) | Trust model |
|---|---|---|---|
| LockVault | `contracts/LockVault.sol` | `0xe410d0a21C1376992874a9bEEeE0d623A50D4a34` | No owner, no pause, no upgrade, no rescue |
| PositionLock | `contracts/PositionLock.sol` | `0xfC9A43c90e0E0d548D95cEf3C77fce802806CbA9` | No owner, no upgrade, no rescue |
| PinkLockAdapter (“Oaken Lock Adapter”) | `contracts/PinkLockAdapter.sol` | `0x16e02A106fE6E978fB98F76756B3a06b4995a7A6` | Compatibility layer; forwards to LockVault |
| OakenLauncher | `contracts/OakenLauncher.sol` | `0x1d7561fC331594820382E8dd64582645EbafD873` | Deploys + locks in one transaction |
| TokenFactory / OakenToken | `contracts/TokenFactory.sol`, `OakenToken.sol` | `0xc0A3AD1428EeB70cAF88bb89c3B17D0191E1Bd34` | Fixed supply, no owner/mint/pause |
| MultiSender | `contracts/MultiSender.sol` | `0x1f380ef5eFF9113314Ee175dCE4F226DFd75A50C` | No storage between calls, no owner |
| OakenAirdrop | `contracts/OakenAirdrop.sol` | `0x17E9910cDC37BdA5531414012aeA5b0862C22066` | Merkle claims; creator sweep after deadline |
| PresaleFactory / Presale | `contracts/PresaleFactory.sol`, `Presale.sol` | `0xAC070cf2ed45aEcb9f5299d4C670fFfCE6387724` | Sale terms are public; soft/hard caps and refunds |
| OakenTimelock | `contracts/OakenTimelock.sol` | `0x2f848dBdD8b0384AcB1102d959B63E71Ecf44845` | Admin delay for Bonds/parameters — **not** part of Locks |

**v2 (deployed 2026-10-23):** the reentrancy fix from `SELF-REVIEW.md` (SR-01) and
the ETH-refund fix (SR-02) live in a fork, at new deterministic addresses on all
four chains. New locks and new launches use v2; v1 stays live for everything
created before that date.

| Contract | File | Address (same on every chain) | Change from v1 |
|---|---|---|---|
| LockVaultV2 | `contracts/v2/LockVaultV2.sol` | `0xbC511F31967D9EBF775d203661a2BEfF6AA42615` | `nonReentrant` on `createLock` / `claim` / `revoke` / `editLock` |
| PinkLockAdapterV2 | `contracts/v2/PinkLockAdapterV2.sol` | `0xDBE1f3dc1d6E6759355E1B164231748f0589cb41` | same guard; returns attached ETH to the caller |
| OakenLauncherV2 | `contracts/OakenLauncher.sol` (same source) | `0x0d7cCEA7BabC5e3b4849267740D8fBBe6C4FDa58` | constructor points at PinkLockAdapterV2 |

See `contracts/V2.md` for regression tests, deployment blocks and the dual-read
migration. Both v1 and v2 are Sourcify exact matches on all four chains.

The Safe that proposes through the Timelock is a 2-of-3 at
`0x5E8C4c241a29ff7E60c648f378A4AA70053Ee92e`. It is a different trust boundary
from the ownerless lock contracts. Bonds have an admin path; Locks do not.

**Out of scope for this repository's audit:** the static frontend and indexer,
third-party launchpad contracts (Pons, Genius, Flap, Clanker, four.meme, Jupiter
Lock), HD Protocol `.hood` registry contracts, and the Solana program (its own
repo/audit target; deployed on mainnet and **not** covered by the EVM audit). Those are documented separately and
must not be presented as covered by an EVM audit.

## What the tests pin

- Hardhat unit + integration tests: **120 passing** (`npm test`).
- Foundry fuzz tests: **14 fuzz tests × 1,000 runs** across LockVault and
  PositionLock.
- Foundry invariant tests: **4 invariants, 128 runs × 64 depth**, with a handler
  that calls create/claim/revoke/edit/transfer/renounce from the right and wrong
  callers on a monotonic chain clock.
- Solidity coverage (Hardhat, viaIR for instrumentation):
  - product contracts: **99.58% statements · 99.82% lines · 100% functions**;
  - including mocks: **98.83% statements · 98.87% lines**;
  - branch coverage is **73.38%** (product contracts) — intentionally reported
    separately; line/statement coverage is above the 95% gate, branch coverage is
    not. A branch-coverage pass is on the audit-readiness list.

### Run it yourself

```bash
cd contracts
npm ci

npm test                     # Hardhat (120 tests)
npm run coverage             # solidity-coverage, uses hardhat.coverage.config.ts

# Foundry (install forge first: https://book.getfoundry.sh/)
forge test --match-path "test/foundry/*"        # fuzz + invariant
forge test --match-path test/foundry/LockVaultFuzz.t.sol -vvv
forge test --match-path test/foundry/LockVaultInvariant.t.sol -vvv
```

The Foundry suite lives in `test/foundry/`; `lib/forge-std` is vendored for
reproducibility. The coverage configuration excludes the four deterministic-
address tests because instrumentation changes the bytecode; those four still run
in the normal suite and in `check.js`.

## Invariants a reviewer should attack first

1. **Credited = balance delta.** A fee-on-transfer token must create a lock for
   the amount that actually arrived, never the amount requested.
2. **Vesting is monotone and bounded.** `vestedAt(t)` never decreases as `t`
   moves forward, never exceeds `amount`, is zero before `start`, and equals
   `amount` at/after `end`.
3. **Claims cannot exceed vested.** `claimed <= vestedAt(now)` and
   `claimed <= amount` for every lock at every reachable state.
4. **The vault is solvent.** For a single token, the vault balance always covers
   the sum of `amount - claimed` across all locks; there is no privilege that can
   move tokens out except the lock’s own claim/revoke/edit rules.
5. **Revoke splits exactly.** `refund + vestedAtRevoke == credited`; after the
   revoke, the schedule is frozen and the beneficiary can still claim the vested
   part unless renounced.
6. **Edit cannot erase history.** A shrink below `claimed` reverts; a shrink pays
   the beneficiary, never the caller; a grow credits the balance delta.
7. **Plain locks are the degenerate case.** `start == cliff == end` releases
   nothing before the timestamp and everything at it.
8. **Staircases never outrun the continuous curve**, and both reach the full
   amount at `end`.
9. **No unauthorized movement.** Only the creator can revoke; only the
   beneficiary/declared agent can transfer, renounce, edit, or rename; claims pay
   the beneficiary and can be submitted by anyone.
10. **PositionLock is one escrow per position.** Release is time-gated and sends
    only to the stored beneficiary; reclaim is creator-only, revocable-only, and
    impossible after release; pushed-in NFTs (no lock record) are refused.

The critical assumption found while building the invariant suite: `revoke`
relies on **block timestamps being monotonic**. A backward clock could make
`vestedNow < claimed`; a real block producer cannot create that state. The
handler enforces monotonic time, and this assumption is listed here for the
auditor rather than hidden in a test.

## Known limitations (not vulnerabilities unless a reviewer disagrees)

- **Rebasing tokens are not modelled.** The vault pays from its balance; an
  upward rebase leaves surplus, a downward rebase can make a claim revert. The
  front end refuses tokens it can identify as rebasing; the contract does not
  claim to solve it.
- **Tokens with blacklists/freeze/hooks can block a claim or revoke.** The vault
  has no rescue and cannot bypass the token.
- **Fee-on-transfer is supported by crediting the delta**, so the lock is
  smaller than requested rather than failing. The event carries the credited
  amount.
- **Revocable locks and editable locks are weaker promises.** The UI must label
  them; the events carry old and new values.
- **No recovery for assets sent directly to an escrow contract.** LockVault only
  creates locks through `createLock`; PositionLock’s receiver only accepts
  `tokenId == 0`.
- **Bonds are a different product** with admin/Timelock/NAV risk. Locks are
  ownerless. Reading one as the other is a user-interface bug, not a contract
  bug.
- **SR-01 / SR-02 are fixed in v2 only.** v1 is immutable and still holds
  pre-2026-10-23 locks; a token with a transfer callback can re-enter it. The
  creation form warns against transfer-hook (ERC-777-style) tokens. v2 makes the
  re-entrant path revert and returns attached ETH; see `V2.md`.
- **Solana:** the OAKEN Solana lock program is deployed on mainnet
  (`Co9ZnAVxX2siGThhjTpPgXPHYrCev1nrXFyGB1VcZcQW`, upgrade authority revoked) and
  passed a 25-check E2E on a local validator. Jupiter Lock remains available as
  a third-party option. The Solana program is outside the EVM audit scope.
- **No formal verification** (Certora or equivalent) has been performed. The
  invariant suite is not a formal proof.

## Vulnerability disclosure

- Contact: **@oakenhood on X** (direct message). Do not post exploit details
  publicly before a fix is live.
- Please include: affected chain/address, function, a minimal reproduction, and
  whether funds are at risk.
- We will acknowledge a report, reproduce it, and coordinate disclosure. A
  public bug bounty is **not live yet**; do not assume a payout or a scope until
  an official program page exists.
- This is a small project with no upgrade path on the lock contracts. A critical
  bug in a deployed lock cannot be patched in place; the response is to warn users
  and, where possible, help them use the exit paths that exist.

## Audit status

| Item | Status |
|---|---|
| Third-party audit (Trail of Bits / Spearbit / Zellic or equivalent) | **Not commissioned** |
| Public audit report | **None** — no report link is displayed |
| Bug bounty (Immunefi / Code4rena / Sherlock) | **Not live** |
| Formal verification | **Not performed** |
| Internal test/fuzz/invariant/coverage package | Complete (this repository) |

When a real audit is completed, this table and the site’s Verify page should be
updated with the firm, date, scope, report URL, and any unresolved findings. Until
then, any “audited” badge would be false.
