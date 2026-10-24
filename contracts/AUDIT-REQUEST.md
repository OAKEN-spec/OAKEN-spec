# Audit request for quotation (RFQ)

> Send this page together with the frozen commit and `AUDIT-SCOPE.md`.
> It is a request for a quote, not an audit report.

## Project

OAKEN — ownerless token/LP locks and a small set of token tools on EVM chains.
Deployed at deterministic, identical addresses on Robinhood Chain (4663),
BNB Chain (56), Base (8453) and Polygon (137).

- Public repository: https://github.com/OAKEN-spec/OAKEN-spec
- **v1 freeze:** tag `audit-2026-10-23` (contracts commit `de736d3`) — the 11 original contracts.
- **v2 addendum:** tag `audit-2026-10-23-v2` — the v2 fork, the self-review, the
  reentrancy PoC and the v2 regression tests. Resolve it with
  `git rev-parse audit-2026-10-23-v2`. The v2 files are a short diff from v1: a
  reentrancy guard and an ETH refund; everything else is byte-for-byte v1.
- **v3 addendum:** tag `audit-2026-10-24-v3` — the deployed v3 vault and adapter,
  plus the revoke-clamp regression and the unconstrained invariant suite. v3 is
  v2 plus one line of substance in `revoke()`: `frozen = max(vestedNow, claimed)`.
  Resolve it with `git rev-parse audit-2026-10-24-v3`.
- Language: Solidity 0.8.24, no OpenZeppelin in the lock family.
- Licenses: Apache-2.0 for our contracts; vendored forge-std keeps its own.

## Scope

Full detail, per-contract questions and out-of-scope notes are in
`AUDIT-SCOPE.md`. Summary:

| Priority | Contracts | Lines | Why it is in scope |
|---|---|---|---|
| P0 | LockVault, PositionLock, PinkLockAdapter | 1,556 | Hold user tokens / ERC-721 positions; vesting and release arithmetic |
| P0 | **LockVaultV2, PinkLockAdapterV2** (`contracts/v2/`) | 1,316 | Deployed 2026-10-23; holds that day's locks. v1 plus the reentrancy guard and ETH refund |
| P0 | **LockVaultV3, PinkLockAdapterV3** (`contracts/v3/`) | 1,330 | **Deployed 2026-10-24; every new lock and launch uses v3.** v2 plus the `revoke()` clamp; this diff is the current review surface |
| P1 | OakenLauncher, TokenFactory + OakenToken, MultiSender, OakenAirdrop, PresaleFactory + Presale | 1,315 | Deploy, escrow, batch transfer, Merkle claims, refunds (OakenLauncherV2/V3 are the same source with the versioned adapter as a constructor argument) |
| P2 | OakenTimelock (Bonds admin path only) | 140 | Governance path; separate trust boundary |

Total: 15 Solidity files, 5,657 lines (including comments): 3,011 lines of v1,
1,316 lines of v2 and 1,330 lines of v3.

**Out of scope:** frontend, indexer/API, deployment scripts, the Bonds NAV
keeper, third-party launchpad contracts (Pons, Genius, Flap, Clanker,
four.meme), Jupiter Lock, and the `.hood` name registry.

## What we want from the review

1. Findings by severity, each with a concrete path to impact and a minimal
   reproduction (test or call sequence).
2. Explicit answers to the questions in `AUDIT-SCOPE.md` where possible.
3. Commentary on the invariants in `contracts/test/foundry/LockVaultInvariant.t.sol`
   and `LockVaultV3Invariant.t.sol`, and on the monotonic-time assumption used by
   the fuzz/invariant handlers.
4. A short statement of what you reviewed and what you did not.

We are happy with either of these formats — quote both if you can:

- **Private engagement**: source review + report + one fix-review round.
- **Public contest**: contest page + judging + report.

## Existing assurance (not a substitute for an audit)

- 129 Hardhat tests (120 v1 + 4 v2 + 5 v3), including refusal paths and empty-state reverts.
- Foundry: 20 tests — 14 fuzz tests × 1,000 runs, two invariant suites of 4
  invariants each (v1 and the **unconstrained v3** suite), the reentrancy PoC and
  three v2 regressions (one of which sends real ETH through the refund path).
  The v3 invariant suite is documented to fail when pointed at v2.
- Coverage (Hardhat, viaIR), reported per version: **v1 product contracts**
  99.58% statements, 99.82% lines, 100% functions, branch 73.38%. **v2** 54.55%
  statements, 55.70% lines, 40% functions, 35.29% branches. **v3** 54.77%
  statements, 55.90% lines, 40% functions, 36.05% branches (`LockVaultV3.sol`
  alone: 69.72% / 68.22% / 72.22% / 45.37%). v2 and v3 are the v1 code plus
  small diffs, so the v1 suite describes the shared code, while their own paths
  are covered by the versioned Hardhat and Foundry tests.
- Deterministic deployment test: a real CREATE2 deployment through the canonical proxy,
  compared against the published addresses; `node check.js` also compares the address
  scripts with `src/chains.mjs` (v1, v2 and v3).
- Source verified byte-for-byte on Sourcify; verification is **not** an audit.

## Logistics

- Code delivery: the public repository at the frozen commit, or a zip with a
  SHA-256 manifest on request.
- Communication: one private channel; we will publish the final report and a
  remediation summary on `/security`.
- We will not ask you to sign anything that overstates the review, and we will
  not describe the result as "audited" beyond the scope you state.
- Contact: **@oakenhood on X** (a dedicated security mailbox is being set up).
