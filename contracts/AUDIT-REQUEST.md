# Audit request for quotation (RFQ)

> Send this page together with the frozen commit and `AUDIT-SCOPE.md`.
> It is a request for a quote, not an audit report.

## Project

OAKEN — ownerless token/LP locks and a small set of token tools on EVM chains.
Deployed at deterministic, identical addresses on Robinhood Chain (4663),
BNB Chain (56), Base (8453) and Polygon (137).

- Public repository: https://github.com/OAKEN-spec/OAKEN-spec
- Frozen commit: `git rev-parse audit-2026-10-23` (contracts commit `de736d3`)
- Tag: `audit-2026-10-23`
- Language: Solidity 0.8.24, no OpenZeppelin in the lock family.
- Licenses: Apache-2.0 for our contracts; vendored forge-std keeps its own.

## Scope

Full detail, per-contract questions and out-of-scope notes are in
`AUDIT-SCOPE.md`. Summary:

| Priority | Contracts | Lines | Why it is in scope |
|---|---|---|---|
| P0 | LockVault, PositionLock, PinkLockAdapter | 1,556 | Hold user tokens / ERC-721 positions; vesting and release arithmetic |
| P1 | OakenLauncher, TokenFactory + OakenToken, MultiSender, OakenAirdrop, PresaleFactory + Presale | 1,315 | Deploy, escrow, batch transfer, Merkle claims, refunds |
| P2 | OakenTimelock (Bonds admin path only) | 140 | Governance path; separate trust boundary |

Total: 11 contracts, 3,011 lines (including comments).

**Out of scope:** frontend, indexer/API, deployment scripts, the Bonds NAV
keeper, third-party launchpad contracts (Pons, Genius, Flap, Clanker,
four.meme), Jupiter Lock, and the `.hood` name registry.

## What we want from the review

1. Findings by severity, each with a concrete path to impact and a minimal
   reproduction (test or call sequence).
2. Explicit answers to the questions in `AUDIT-SCOPE.md` where possible.
3. Commentary on the invariants in `contracts/test/foundry/LockVaultInvariant.t.sol`
   and on the monotonic-time assumption used by the fuzz/invariant handlers.
4. A short statement of what you reviewed and what you did not.

We are happy with either of these formats — quote both if you can:

- **Private engagement**: source review + report + one fix-review round.
- **Public contest**: contest page + judging + report.

## Existing assurance (not a substitute for an audit)

- 120 Hardhat tests, including refusal paths and empty-state reverts.
- Foundry fuzz: 15 tests × 1,000 runs; invariants: 4 × (128 runs × 64 depth).
- Coverage (product contracts): 99.58% statements, 99.82% lines, 100%
  functions; branch 73.38% (reported separately).
- Deterministic deployment test: address derived from bytecode + salt and
  compared with the live registry.
- Source verified byte-for-byte on Sourcify; verification is **not** an audit.

## Logistics

- Code delivery: the public repository at the frozen commit, or a zip with a
  SHA-256 manifest on request.
- Communication: one private channel; we will publish the final report and a
  remediation summary on `/security`.
- We will not ask you to sign anything that overstates the review, and we will
  not describe the result as "audited" beyond the scope you state.
- Contact: **@oakenhood on X** (a dedicated security mailbox is being set up).
