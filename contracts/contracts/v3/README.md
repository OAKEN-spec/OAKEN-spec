# v3 — deployed 2026-10-24

**V3 is V2 plus one fix in `revoke()`.** The Solidity files here are frozen as
deployed: their comments are part of the metadata hash, so editing one changes
the bytecode and therefore the CREATE2 address. `node check.js` compares the
compiled addresses with `src/chains.mjs` and fails if they drift.

## The bug V3 fixes

V1 and V2 allowed this sequence:

1. a **revocable** lock partially vests and the beneficiary claims (say 50 of 100);
2. the beneficiary (or agent) **edits the amount down** to 60 — allowed, because
   the only guard is `newAmount >= claimed`;
3. the vesting curve is scaled by `amount`, so at the same timestamp the 60-token
   schedule vests **36**, less than the 50 already paid;
4. the creator calls `revoke()`. V2 froze `amount` at `vestedNow` (36) and
   refunded `60 - 36 = 24` — but the vault held only `60 - 50 = 10` for this
   lock. The other 14 came out of **other locks of the same token**.

The record then showed `claimed > amount`, and the vault's balance no longer
covered its outstanding principal.

V3 clamps the frozen amount at `max(vestedNow, claimed)`. The beneficiary was
already paid past the new curve, so nothing further is refundable. The vault
keeps exactly what belongs to the other locks.

The Foundry invariant suite found this (2026-10-24). The deterministic
regression is in `contracts/test/V3.test.ts`; the unconstrained fuzz suite is
`contracts/test/foundry/LockVaultV3Invariant.t.sol`. The frozen v1 suite limits
edits to states V1 can actually handle and points at the V3 suite.

## Deployed addresses

Same on Robinhood 4663, BNB Chain 56, Base 8453 and Polygon 137. Salts
`locker.v3` / `adapter.v3` / `launcher.v3`.

| Contract | Address |
|---|---|
| LockVaultV3 | `0xd4064d8E73AAB53D7d9efd8A6E8DBE2003d1de4B` |
| PinkLockAdapterV3 | `0x6022DA059FAa0673E3058ADECEef375c2Abfb4A1` |
| OakenLauncherV3 | `0x4488C369116D0C6FEA84162313c3840976D5A9a5` |

Deployment blocks are in `src/chains.mjs` (`v3DeployBlock`, `v3LauncherBlock`).
Records: `data/v3-deployments.json`.

## Who uses what

- New locks and new launches go through **v3**.
- v2 remains live for locks created 2026-10-23 → 2026-10-24; v1 remains live for
  everything before 2026-10-23. The site reads all three.
- Record URLs carry `?vault=v3` (or `v2`); without the parameter the page reads
  v1, so old links keep working.

If a future change is required, it belongs in a **new** directory with new salts
and new addresses — never as an edit here.
