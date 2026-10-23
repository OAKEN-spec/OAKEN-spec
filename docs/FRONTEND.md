# Frontend source notes

`frontend/app` contains the site's static pages and client-side modules. The
production build also needs:

- `/app/*` → `frontend/app/*` (pages import `/app/oaken.js` etc.)
- `/oaken/*` → `frontend/brand/oaken/*` (logo, display font)
- `/favicon.png`, `/logo512.png` → `frontend/brand/`
- an HTTP API/indexer for cross-chain lock lists, launches, activity, and
  name-registry indexing. Without it the client-side chain reads still work, but
  list pages will show their read-failure/empty states.

No API keys, wallet keys, user data, captured mirror pages, or build artifacts
are included. Pages may be served by any static file server with the mappings
above; the production site uses a custom static build and a Cloudflare Worker.

## Run it locally

```bash
node frontend/serve-local.mjs 8080
# open http://localhost:8080
```

The server maps the same URLs the production build serves (`/locks/create`,
`/dashboard`, `/locks/<chain>/record/<id>`, …) onto files in
`frontend/app`. There is no bundler and no build step.

It also answers `/api/chains` from `frontend/api/chains.json`, a snapshot
generated from the real chain registry (`src/chains.mjs` in the build tree).
That one endpoint is what record, token and position pages need to resolve which
chain to read. Every other `/api/*` endpoint is absent.

What works without the indexer/API:

- Record pages, token pages and position pages read the chain directly in the
  browser through the public RPCs listed in `frontend/app/oaken.js`.
- The `/verify` page, the security pages and every static page.
- Wallet connection (injected wallets and the vendored WalletConnect bundle).

What shows its failure state until an indexer is supplied:

- `/locks`, `/activity`, `/leaderboard`, `/launchpads`, `/dashboard` and the
  tool list pages call `/api/*`. They say the read failed; they never render a
  fake zero.

## Test networks

The chain registry in `frontend/app/oaken.js` (`CHAINS`) points at the four
production chains. To use a testnet, add an entry there with its chain id and
public RPC, and deploy the contracts from `contracts/scripts` to that chain. The
deterministic address is the same on every chain, so the pages need no other
change — but do not point the site at an address that has no code.

## Rules for changes

See [CONTRIBUTING.md](../CONTRIBUTING.md). The short version: never render a
failed read as zero, take dates from the chain's latest block, and do not add an
"audited" badge or a bounty link that does not exist.
