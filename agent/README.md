# OAKEN Agent Reports

The web beta of OAKEN Agent Reports: an agent reads Robinhood Chain and returns
a report with the evidence attached. Four report kinds share one index and one
stable report URL. The page at `oaken.one/agents` is free during the beta; the
**direct API** is paid per report in USDG over x402.

- **Token + locks** — runtime code, EIP-1967 slot, owner/paused, common
  selectors, OAKEN locks v1–v4, vault schedules, Pons factory/curve.
- **Pre-launch review** — the token facts above plus a **user-provided** lock
  plan. The plan is never presented as on-chain state. Duration / initial
  unlock / revocable checks use OAKEN's own heuristics, labelled as such.
- **Bond health** — the OAKEN bond vault, NAV oracle, redemption parameters and
  staking pool. Bonds are not locks; the report keeps that boundary explicit.

This is deliberately **not** an LLM-only "verdict". No prose is generated from
the token's name or metadata. Every number comes from `eth_call`,
`eth_getCode`, or `eth_getStorageAt` on Robinhood Chain (4663). The browser only
renders what the service read.

## Run it locally

The OAKEN site runs on `serve.js`; the report service is a separate Node process.

```sh
# terminal 1 — report service (defaults to 127.0.0.1:8870)
node agent/server.mjs

# terminal 2 — OAKEN site
node serve.js 8869
```

Open `http://127.0.0.1:8869/agents`.

The page calls `/api/agents/*` on the OAKEN origin. In `src/routes.mjs`, the
Worker/serve.js proxy forwards those requests to `AGENT_API_URL`; on localhost it
defaults to `http://127.0.0.1:8870`.

## Deployed

The service is live as its own Worker, **not** inside the Pages Worker:

| | |
| --- | --- |
| API (paid) | `https://agents.oaken.one/api/agents/*` (`oaken-agents`) |
| Page (free) | `https://oaken.one/agents` |
| Index | Durable Object `ReportsDO`, one SQLite-backed instance (`index`) |
| Pages env | `AGENT_API_URL=https://agents.oaken.one`, `AGENT_SITE_KEY` (secret) |
| Worker vars | `AGENT_FREE_BETA=0`, `AGENT_PAY_TO=0x27605b8D0f754A2eee5ABAf0b7D8524A54DD2cE2`, `AGENT_NARRATIVE=1`, `AGENT_NARRATIVE_MODEL=@cf/mistralai/mistral-small-3.1-24b-instruct` |
| Worker secrets | `AGENT_FACILITATOR_KEY`, `AGENT_SITE_KEY` |

The Pages project only proxies. It adds `x-oaken-site-key` server-side (from its
`AGENT_SITE_KEY` secret) for same-origin page requests; the report Worker treats
that as the free web beta. A request to `agents.oaken.one` directly has no key
and gets the x402 challenge. The key never reaches the browser.

Prices: **0.02 USDG** token + locks, **0.02 USDG** curve launch, **0.02 USDG**
bond health, **0.05 USDG** pre-launch review. Treasury `0x27605b8D0f754A2eee5ABAf0b7D8524A54DD2cE2`.

The report Worker reads Robinhood Chain with the fallback list in `src/chains.mjs`.
Settlement uses the same fallback list: the facilitator signs the USDG transfer
locally and broadcasts `eth_sendRawTransaction` through it (an ethers
`JsonRpcProvider` would pin settlement to the official endpoint, which 429s from
Cloudflare).

### The narrative layer

Every report may carry an optional `narrative` field. The model (Workers AI,
`@cf/mistralai/mistral-small-3.1-24b-instruct`) only rephrases the fact sheet
from `agent/narrative.mjs`. The answer is thrown away unless every number in it
already appears in the fact sheet, it contains no advice or security claim, and
it is under 900 characters. The deterministic `summary` and `checks` stay
authoritative; the page labels the narrative as AI and says so.

`AGENT_NARRATIVE=0` turns it off without a deploy; removing the `[ai]` binding
does too. The model id is a Worker var because the old default
(`@cf/meta/llama-3.1-8b-instruct`) was deprecated on 2026-05-30 — Workers AI
answers with a 5028 "deprecated" error and the narrative silently disappears.
`agent/test-narrative.mjs` pins the guard (unknown number, advice, length, model
failure) without a network call.

### Why a separate Worker, and why the RPC list is long

Robinhood Chain's official RPC answers `eth_call` from Cloudflare's shared egress
with **429 Too Many Requests** almost every time (`eth_getCode` still passes).
The report service therefore lists seven public endpoints and prefers
batch-capable ones via `rpcBatch`; `callMany` retries across them. Two of them
(`robinhood-rpc.publicnode.com`, `robinhood.drpc.org`) accept single calls but
not JSON-RPC batches; `daybreak` and `blockvectra` accept batches. Report
generation stays in this Worker (it can reach the fallbacks); the Pages Worker
does not generate reports.

### Deploy

```sh
# one-time: treasury + facilitator (keys under _secrets/, facilitator funded with gas)
node agent/setup-wallets.mjs

# Worker secrets (values from _secrets/agent-wallets.json and _secrets/agent-site-key.txt)
cd agent
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=985365e2d0f2f1b5db149ea0151291f3 \
  wrangler secret put AGENT_FACILITATOR_KEY --config wrangler.toml
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=985365e2d0f2f1b5db149ea0151291f3 \
  wrangler secret put AGENT_SITE_KEY --config wrangler.toml

# Worker (config: agent/wrangler.toml; vars AGENT_FREE_BETA=0 + AGENT_PAY_TO live there)
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=985365e2d0f2f1b5db149ea0151291f3 \
  wrangler deploy --config wrangler.toml

# the custom domain is attached at the account level (no Workers Routes permission):
# PUT /accounts/<account>/workers/domains {hostname:"agents.oaken.one", service:"oaken-agents", zone_id:…}

# Pages (AGENT_API_URL + AGENT_SITE_KEY must already be set on the project;
# then deploys and checks /agents, /agents.md and the free proxy health)
cd ..
node tools/deploy-pages.mjs
```

The Pages project needs `AGENT_SITE_KEY` as a **secret_text** env var with the
same value as the Worker secret; `AGENT_API_URL` is plain text. The deploy check
fails if `/api/agents/healthz` through the proxy does not say `"freeBeta":true`.

`wrangler.toml` uses compatibility date `2026-09-10` because the wrangler binary
on this machine ships a workerd that does not accept a newer date; the edge
accepts it.

### Tests against the deployment

```sh
# the free web path (four reports, reuse, rejection)
AGENT_URL=https://oaken.one node agent/test-api.mjs

# one real USDG settlement against the paid direct API — SPENDS MONEY
AGENT_URL=https://agents.oaken.one node agent/test-paid.mjs

node _look/_agents-live-check.cjs   # browser: page text, proxy 200s, screenshots
```

On this machine the direct route to Cloudflare times out in bursts; prefix the
live tests with `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:12000` when
needed. `test-paid.mjs` writes the payer/pay-to balances, authorization and
settlement receipt to `data/agent-x402-settlement-*.json`.

The first reports are stored in the Durable Object, so a redeploy does not lose
the index. The beta caps the index at 500 rows.


## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/agents/healthz` | service + RHC block height |
| `GET` | `/api/agents/quests` | report kinds, prices and beta flag |
| `GET` | `/api/agents/quote?kind=token` | free quote through the page proxy, or a 402 x402 challenge on the direct API |
| `POST` | `/api/agents/report` | generate and store a report |
| `GET` | `/api/agents/reports?limit=15` | recent reports |
| `GET` | `/api/agents/report/:id` | one stored report (free) |

`POST` body shapes:

```json
{"kind":"token","token":"0x…"}
{"kind":"prelaunch","token":"0x…","lockAmount":5000000,"lockDays":180,"steps":6,"initialUnlockPct":10,"revocable":false}
{"kind":"bond","symbol":"OAKEN"}
```

The local service writes reports to `agent/data/reports.db` (SQLite, created on
first run). Delete that file to reset the local index. The deployed Worker keeps
the same table in the `ReportsDO` Durable Object; the beta rate-limits report
generation to 12/minute/IP.

A token or bond report generated in the last 60 seconds is reused (`reused: true`)
instead of re-reading the same contracts; pass `"fresh": true` to force a new
read. A reused report is a stored report and needs no new payment. Pre-launch
reviews are never reused because the plan is an input.

## Payment (live for the direct API)

The web page is free (the Pages proxy adds the site key). Direct calls to
`https://agents.oaken.one` are paid per report: **0.02 USDG** for a token + locks
or bond report, **0.05 USDG** for a pre-launch review. `agent/x402.mjs`
implements the x402 v1 `exact`/EIP-3009 wire format used by `hood402`:

- network `robinhood` (CAIP-2 `eip155:4663`)
- asset USDG `0x5fc5360d0400a0fd4f2af552add042d716f1d168` (6 decimals)
- EIP-712 domain `Global Dollar` / `1`
- `X-PAYMENT` header → base64 JSON payload → `transferWithAuthorization`
- `X-PAYMENT-RESPONSE` header carries the settlement receipt

A request without `X-PAYMENT` gets the 402 challenge. The service verifies the
signature, the replay state and the USDG balance **before** generating the
report, then settles and only stores the report on a successful settlement.

**Real settlements, 2026-10-27:**

- local paid-mode service at a temporary 0.001 USDG price: tx
  `0xc18a76ac2c96557dab5a843bda393104c22ef54aebb165eeef8b1cedf53656eb`,
  gas 103,029, payer balance −0.001, treasury +0.001
- **deployed Worker, 0.02 USDG**: tx
  `0x1d73ace4df4aee4bfd97bf6db492c0d5ae3e24b35d1dd006b5714150ea91e621`,
  gas 85,610, payer `0x21b4…Da72` −0.02, treasury
  `0x27605b8D0f754A2eee5ABAf0b7D8524A54DD2cE2` +0.02, report
  `3bfd0bf6…a334` at block 99,182,589
- evidence: `data/agent-x402-settlement-*.json`

The facilitator wallet pays gas and never holds user funds. Keep its ETH balance
small (`agent/setup-wallets.mjs` tops it up to 0.00005 ETH); a settlement costs
about 0.000003 ETH. Robinhood Chain is EIP-1559 and rejects a transaction whose
max fee is below the next block's base fee (and a gas limit under 30,000) — the
settlement path computes `maxFeePerGas` from the latest base fee and uses an
explicit 300k limit. It signs locally and broadcasts `eth_sendRawTransaction`
through the same fallback RPC list the reads use; an ethers `JsonRpcProvider`
would pin settlement to the official endpoint that 429s from Cloudflare.

Local paid mode:

```sh
AGENT_FREE_BETA=0 \
AGENT_PAY_TO=0x27605b8D0f754A2eee5ABAf0b7D8524A54DD2cE2 \
AGENT_FACILITATOR_KEY=0x…gas-wallet \
node agent/server.mjs
```

On the Worker those are `[vars]` / secrets. `AGENT_SITE_KEY` is what keeps the
web page free; without it every report goes through the 402 path.

## What the reports read

- token runtime code size, EIP-1967 implementation slot, `owner()`, `paused()`
- common selectors in bytecode (`mint`, `pause`, `blacklist`, `renounceOwnership`)
- OAKEN lock adapters v1–v4: `totalLockCountForToken` + `getLocksForToken`
- the matching vault's `getLock` for schedule, revocable flag and claimed amount
- the Pons factory `getLaunchedToken`, and the curve's `getReserves`
- Chainlink ETH/USD or USDG/USD for an *estimated* quote-side value (shown with
  the feed's update time; never asserted as a guarantee)
- the OAKEN bond vault (`price`, `reserves`, `isSolvent`, `redeemFeeBps`,
  `mintCap`, `paused`), a 1-bond redemption preview, a 1-USDG mint preview, its
  NAV oracle and the staking pool (`snapshot`: staked total, streaming rates,
  instant USDG APR and OAKEN per bond / yr)
- the block timestamp, so "when was this true" is readable without trusting a
  server clock
- locked supply percentages for token reports (`still locked / total supply`)

They do **not** read source code, holder distribution, off-chain claims, or an
audit. A selector in bytecode is not a live function; an empty owner slot is not
proof of renouncement. The report says so in its own disclaimer.

## Tests

```sh
node agent/test.mjs        # live RHC: token, empty address, bond, prelaunch
node agent/test-x402.mjs   # offline: signature, structure, rejection, facilitator guard
node agent/test-api.mjs    # free web path: health, quests, four reports, reuse, rejection
node agent/test-paid.mjs   # real USDG settlement — spends one report price
node agent/setup-wallets.mjs  # create/top-up the treasury + facilitator (one-time ops)
node check.js --fast       # OAKEN's checks + the x402 unit tests + service health
```

## The hard constraint, restated

The official Robinhood Chain RPC rate-limits `eth_call` from Cloudflare's shared
egress: a Worker that asks it directly gets `429 Too Many Requests` on nearly
every call, even though `eth_getCode` and `eth_blockNumber` answer. That is why
the report service keeps the seven-endpoint fallback list in `src/chains.mjs`;
without it the reports come back complete on a fast local network and silently
thin (`symbol: null`, no locks, no Pons state) from the edge.

Keep report generation in this Worker, not in the Pages Worker: the Pages Worker
is the same-origin proxy, and putting the reads there would still depend on the
same fallback list while mixing the report index into the site's worker.
Settlement has the same constraint — the facilitator broadcasts through the
fallback list, not through a provider pinned to the official endpoint.

## Next layer

- monitor the facilitator gas balance (it is deliberately small) and top it up with
  `node agent/setup-wallets.mjs`
- add a second bond when one exists (the registry currently has only OAKEN)
- optional: an LLM summary around the structured facts only — never the numbers,
  never token metadata as instructions
- if the web page ever charges too, add the browser-side EIP-3009 signing UI
  (today the page is free through the site key)
