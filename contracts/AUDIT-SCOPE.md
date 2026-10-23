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
| P1 | OakenLauncher | `contracts/OakenLauncher.sol` (200) | Deploys a token and locks supply in one transaction |
| P1 | TokenFactory / OakenToken | `TokenFactory.sol` (95), `OakenToken.sol` (108) | Creates fixed-supply tokens; no mint after deployment |
| P1 | MultiSender | `MultiSender.sol` (167) | Moves arbitrary amounts to many recipients; batch atomicity |
| P1 | OakenAirdrop | `OakenAirdrop.sol` (238) | Merkle claims, deadlines, creator sweep |
| P1 | PresaleFactory / Presale | `PresaleFactory.sol` (147), `Presale.sol` (360) | Escrows buyer funds and sale tokens; refunds; optional router liquidity |
| P2 | OakenTimelock | `OakenTimelock.sol` (140) | Admin path for Bonds/parameters; **not** in the ownerless-lock boundary |

## Addresses and trust boundaries

The lock-family addresses are deterministic and identical across chains
(`tools`/`src/chains.mjs`). The Timelock and Safe are Robinhood Chain (4663)
deployments.

| Item | Value |
|---|---|
| LockVault | `0xe410d0a21C1376992874a9bEEeE0d623A50D4a34` |
| PositionLock | `0xfC9A43c90e0E0d548D95cEf3C77fce802806CbA9` |
| PinkLockAdapter | `0x16e02A106fE6E978fB98F76756B3a06b4995a7A6` |
| OakenLauncher | `0x1d7561fC331594820382E8dd64582645EbafD873` |
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
  NAV within the configured limits. The 24h delay is a parameter, not an audit
  result.

## Out of scope

- Frontend, static site, indexer, keeper scripts, and social assets.
- Third-party contracts: HD Protocol `.hood` registry, Pons/Genius/Flap/Clanker/
  four.meme launchpads, Jupiter Lock.
- Bonds economics, NAV strategy, and the Safe signer identities (separate
  governance review).
- The Solana program; it is not deployed and has not completed an on-chain E2E.
- Formal verification (none has been performed; the invariant suite is not a
  proof).

## Readiness checklist

- [x] Exact file list and addresses above.
- [x] Hardhat unit/integration suite (120 passing).
- [x] Foundry fuzz (14 tests × 1,000 runs) and invariants (4 × 128 runs × 64 depth).
- [x] Coverage: product contracts 99.58% statements / 99.82% lines / 100%
      functions (branch 73.38% — a branch-coverage pass remains).
- [x] Written invariants, known limitations, and monotonic-time assumption.
- [ ] Third-party audit engagement and frozen commit hash.
- [ ] Public report link and “Audited by … on …” badge (only after the report).
- [ ] Public bug bounty program (separate owner/platform decision).
- [ ] Formal verification of release/schedule arithmetic (optional).
