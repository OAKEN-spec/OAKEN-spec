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
solana/               Solana lock program source (deployed on mainnet; keypair not included)
docs/                 Frontend/local-development notes
THIRD-PARTY-NOTICES.md  Licenses of the bundled libraries and fonts
```

## Contracts

```bash
cd contracts
npm ci
npm test                         # Hardhat: 124 tests
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

**v1 and v2 are both deployed.** v1 holds every lock created before 2026-10-23;
v2 adds a reentrancy guard and an ETH refund and is what new locks and launches
use. The site reads both. Addresses, blocks and the dual-read contract are in
[contracts/V2.md](contracts/V2.md).

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

`solana/` contains the SPL lock program (program id
`Co9ZnAVxX2siGThhjTpPgXPHYrCev1nrXFyGB1VcZcQW`), its tests and the client
encoders. It is **deployed on Solana mainnet with its upgrade authority revoked**;
the on-chain ELF matches the local build (SHA-256 `8de3b7cb…`). GitHub Actions
builds it with `cargo build-sbf` and runs a five-instruction E2E on a local
validator (25 checks). Jupiter Lock remains a third-party, upgradeable option.

## License

Apache-2.0. See [LICENSE](LICENSE). The site's third-party launchpad integrations
are not relicensed by this repository; their contracts and interfaces remain their
owners' property.
