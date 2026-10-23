# Contributing

Thanks for looking at the code rather than the page. Two kinds of contributions
are most useful: **security reports** and **fixes with a reproducible failure**.

## Security reports

Do not open a public issue for an exploitable bug and do not publish exploit
details before a fix is live. The disclosure route, scope and current status
(no audit, no bounty) are in [SECURITY.md](SECURITY.md) and
[contracts/SECURITY.md](contracts/SECURITY.md). Contact **@oakenhood on X**.

There is **no audit and no bug bounty** at this time. Do not describe this
repository or the site as audited.

## Contracts

```bash
cd contracts
npm ci
npm test                                   # Hardhat: 120 tests
forge test --match-path "test/foundry/*"   # Foundry fuzz + invariant
npm run coverage                           # solidity-coverage (viaIR)
```

- Solidity 0.8.24, no OpenZeppelin dependency in the lock contracts.
- Every behavioural change needs a test that fails before the change. An
  invariant that never runs is not a test.
- The deployed address is derived from the bytecode and a fixed salt. A change
  to a lock contract changes its address; update
  `contracts/scripts/deterministic-addresses.ts` and the site registry together,
  and never point the site at an address that has no code.
- Do not add an owner, an upgrade proxy, or an admin key to the lock family.

## Frontend

The site is static HTML/CSS/ES modules; there is no bundler. `frontend/app` is
the source of truth. To look at it locally:

```bash
# from the repository root
node frontend/serve-local.mjs 8080
# open http://localhost:8080
```

`serve-local.mjs` maps URLs to files the same way the production build does.
The indexer/API is not part of this repository, so list pages fall back to their
read-failure/empty states; record pages still read the chain from your browser.

Rules the pages follow, and pull requests should keep:

- A page must never invent a number. A failed read says it failed; it is not
  rendered as `0`, `—` or an empty list that looks like "there is nothing".
- Dates and gas budgets come from the chain's latest block timestamp, not from
  `Date.now()` — a user's clock can be days off.
- Wallet prompts are user gestures: no signature on page load.
- Errors are translated to a sentence a user can act on; raw revert data goes in
  the detail line, not in place of the message.
- Do not add an `Audited by` badge, an audit report link, or a bounty link that
  does not exist. "Source verified" means the published source compiles to the
  deployed bytecode — nothing more.

## Scope of the public tree

This repository deliberately excludes the mirror captures, the indexer/API
service, deployment keys, databases and user data. Do not add them. If you need
a fixture, build it from a public chain read and say which block it came from.

## Language

The site is written in English. Keep user-visible copy English, including error
paths.

## License

By contributing you agree that your contribution is licensed under
Apache-2.0, the same as the rest of this repository.
