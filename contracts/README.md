# OAKEN contracts

Solidity 0.8.24 contracts for OAKEN’s token/LP locks and launch tools. No
OpenZeppelin dependency, no proxy, no owner on the lock vaults.

> **Security status:** no third-party audit has been completed; no bug bounty is
> live. See [`SECURITY.md`](./SECURITY.md) and [`AUDIT-SCOPE.md`](./AUDIT-SCOPE.md).
> “Source verified” is not “audited”.

## Layout

```
contracts/            LockVault, PositionLock, PinkLockAdapter, OakenLauncher,
                      TokenFactory, OakenToken, MultiSender, OakenAirdrop,
                      Presale, PresaleFactory, OakenTimelock, mocks/
test/                 Hardhat unit + integration tests
test/foundry/         Foundry fuzz + invariant tests
scripts/              deterministic addresses and deployment helpers
```

## Requirements

- Node 20+ and npm
- Solidity 0.8.24 (Hardhat downloads it)
- Foundry (`forge`) for the fuzz/invariant suite — https://book.getfoundry.sh/

## Build and test

```bash
npm ci
npm test                       # Hardhat: 124 tests
npm run typecheck
npm run build                  # compile

# Foundry (fuzz + invariants)
forge test --match-path "test/foundry/*"
forge test --match-path test/foundry/LockVaultFuzz.t.sol -vvv
forge test --match-path test/foundry/LockVaultInvariant.t.sol -vvv
```

Coverage uses a separate config because `solidity-coverage` instrumentation
pushes `LockVault.createLock` past the legacy stack limit; the coverage build
enables `viaIR`, which changes the bytecode (so the deterministic-address tests
are excluded there and still run in `npm test`).

```bash
npm run coverage
```

Last run (2026-10-23): product contracts **99.58% statements · 99.82% lines ·
100% functions**; branch **73.38%**. Overall including mocks: 98.83% statements /
98.87% lines. The >95% line/statement gate is met; branch coverage is reported
honestly and remains a target.

## Deterministic addresses

The lock-family contracts take no constructor arguments and are deployed through
a deterministic deployer, so the address is the same on every chain. The source
of truth for addresses is `scripts/deterministic-addresses.ts` and
`../src/chains.mjs`; the tests compare both.

```bash
npm run addresses
```

Do not deploy a build that differs from the published source; the whole product
is that a lock’s address and code can be checked by anyone.

## License

Apache-2.0 for the contracts and tests. See the repository’s `LICENSE`.

## v2 (deployed 2026-10-23)

`contracts/v2/` contains the two fixes from `SELF-REVIEW.md`: a reentrancy guard
on `LockVaultV2` and an ETH refund in `PinkLockAdapterV2`. v2 is deployed at new
deterministic addresses on Robinhood Chain (4663), BNB Chain (56), Base (8453) and
Polygon (137); **new locks and new launches use v2**, while v1 remains live at its
existing addresses for locks created before 2026-10-23. The site reads both.
Read `V2.md` for the addresses, deployment blocks and the dual-read contract.
