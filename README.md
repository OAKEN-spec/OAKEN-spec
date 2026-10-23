# OAKEN

**Website:** https://oaken.one · **X:** [@oakenhood](https://x.com/oakenhood) ·
**Security:** [SECURITY.md](SECURITY.md)

Open-source source code for OAKEN: EVM lock and launch contracts, their tests,
the static frontend source, and the Solana program source.

**Security status:** no third-party audit has been completed; no bug bounty is
live. See [SECURITY.md](SECURITY.md) and
[contracts/SECURITY.md](contracts/SECURITY.md). Verification is not an audit.

## Layout

```
contracts/            Solidity 0.8.24 contracts + Hardhat/Foundry tests
frontend/app/         Static frontend source (HTML/CSS/JS, media, bonds module)
frontend/serve-local.mjs  Minimal static server for the exported pages (no indexer)
frontend/brand/       OAKEN brand assets used by the pages
solana/               Solana lock program source (not deployed; no keypair)
docs/                 Frontend/local-development notes
THIRD-PARTY-NOTICES.md  Licenses of the bundled libraries and fonts
```

## Contracts

```bash
cd contracts
npm ci
npm test                         # Hardhat: 120 tests
forge test --match-path "test/foundry/*"   # Foundry: fuzz + invariant
npm run coverage                 # solidity-coverage (viaIR instrumentation)
```

Coverage (2026-10-23, product contracts): **99.58% statements · 99.82% lines ·
100% functions**; branch 73.38% (reported separately). See
[contracts/SECURITY.md](contracts/SECURITY.md) for the invariant list and known
limitations.

The lock-family contracts are deployed at deterministic, identical addresses on
each supported EVM chain. Addresses live in `contracts/scripts/deterministic-addresses.ts`
and the site registry; the tests compare both.

## Frontend

The frontend is a static, dependency-free set of pages (ethers is vendored by the
site build; a copy lives in `frontend/app/vendor`). The runtime API/indexer is a
separate service and is not part of this repository. `frontend/app` is the source
of truth for page markup and client-side chain reads; it references assets under
`/app/` and `/oaken/`, which a static server should map to this tree (see
`docs/FRONTEND.md`).

Local run (static pages, no indexer/API):

```bash
node frontend/serve-local.mjs 8080
# open http://localhost:8080
```

Record pages read the chain directly from your browser. The local server ships a
static `/api/chains` snapshot (generated from the real registry) so they can
resolve which chain to read. List pages fall back to their read-failure/empty
states because the indexer is not part of this repository. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the rules a pull request has to keep.

## Solana

`solana/` contains the program source and tests. It is **not deployed** and has
not completed an on-chain E2E run; the site currently uses Jupiter Lock and says
so on the page. Do not present it as an independent, deployed OAKEN program yet.

## License

Apache-2.0. See [LICENSE](LICENSE). The site's third-party launchpad integrations
are not relicensed by this repository; their contracts and interfaces remain their
owners' property.
