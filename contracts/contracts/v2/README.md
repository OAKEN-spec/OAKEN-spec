# v2 — deployed 2026-10-23

The Solidity files in this directory are **frozen as deployed**. Their header
comments still say "not deployed" because the source hash is part of the
Solidity metadata, and the metadata hash is part of the bytecode — editing even
a comment changes the bytecode and therefore the CREATE2 address.
`node check.js` compares the compiled address with `src/chains.mjs` and fails if
they drift.

Deployed addresses (same on Robinhood 4663, BNB Chain 56, Base 8453, Polygon 137):

| Contract | Address |
|---|---|
| LockVaultV2 | `0xbC511F31967D9EBF775d203661a2BEfF6AA42615` |
| PinkLockAdapterV2 | `0xDBE1f3dc1d6E6759355E1B164231748f0589cb41` |
| OakenLauncherV2 | `0x0d7cCEA7BabC5e3b4849267740D8fBBe6C4FDa58` |

- New locks and new launches use v2. v1 remains live for locks created before
  2026-10-23 and is the only way to claim, edit or revoke those.
- Both v1 and v2 are Sourcify exact matches on all four chains.
- Deployment blocks, the dual-read contract and the migration notes are in
  `../V2.md`. The self-review that produced these fixes is `../SELF-REVIEW.md`.

If a future change is required, it belongs in a **new** directory with new salts
and new addresses — never as an edit here.
