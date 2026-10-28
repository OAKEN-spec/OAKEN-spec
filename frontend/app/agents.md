# OAKEN Agent Reports — API

A reading aid, not an audit, a security score, or financial advice. Every number
comes from Robinhood Chain reads at the block named in the report. Unknown
checks are left unknown rather than guessed.

**Web beta: free.** The page at `https://oaken.one/agents` is free during the
beta and needs no account, API key or wallet.

**Direct API: paid** in USDG on Robinhood Chain over x402 — 0.02 USDG for a
token + locks report, a curve launch report or a bond report, and 0.05 USDG for
a pre-launch review. No account or API key is required; payment is per report.
The report shape and the endpoints are stable.

Base URLs:
- `https://agents.oaken.one` — paid API (x402)
- `https://oaken.one/api/agents/*` — the free same-origin proxy used by the web page
- local: `http://127.0.0.1:8869` (site) and `http://127.0.0.1:8870` (service)

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/agents/quests` | report kinds, prices and beta flag |
| `GET` | `/api/agents/quote?kind=token` | free beta quote, or a 402 x402 challenge in paid mode |
| `POST` | `/api/agents/report` | generate and store a report |
| `GET` | `/api/agents/reports?limit=15` | recent reports |
| `GET` | `/api/agents/report/:id` | one stored report (free, no payment) |
| `GET` | `/api/agents/healthz` | service + RHC block height |

Limit: 12 report generations per minute per IP in the beta.

A token, curve or bond report generated in the last 60 seconds is reused and returned with `reused: true`; pass `"fresh": true` in the POST body to force a new read. A reused report is a stored report and needs no new payment. Pre-launch reviews are never reused because the plan is an input; curve reports are never reused because the curve moves with every trade.

## Payment (x402)

A direct `POST /api/agents/report` without an `X-PAYMENT` header answers `402`
with the challenge:

```json
{"x402Version":1,"accepts":[{"scheme":"exact","network":"robinhood","maxAmountRequired":"20000","resource":"https://agents.oaken.one/api/agents/report","payTo":"0x…","maxTimeoutSeconds":300,"asset":"0x5fc5360d0400a0fd4f2af552add042d716f1d168","extra":{"name":"Global Dollar","version":"1"}}]}
```

`maxAmountRequired` is atomic USDG (6 decimals). Sign an EIP-3009
`TransferWithAuthorization` for `from`, `to`, `value`, `validAfter`,
`validBefore` and a random `nonce`, with the EIP-712 domain `Global Dollar` /
version `1` / chain `4663` / verifying contract the USDG address above. Put the
base64 JSON in `X-PAYMENT` and retry:

```json
{"x402Version":1,"scheme":"exact","network":"robinhood","payload":{"signature":"0x…","authorization":{"from":"0x…","to":"0x…","value":"20000","validAfter":"…","validBefore":"…","nonce":"0x…"}}}
```

The service's facilitator broadcasts the transfer and pays gas; the payer only
needs USDG. The nonce is single-use. A successful response carries
`X-PAYMENT-RESPONSE` (base64 JSON) with the settlement transaction. A report
generated in the last 60 seconds is reused and needs no new payment; pass
`"fresh": true` to force a new read.

## Generate a report

`POST /api/agents/report` with `content-type: application/json`.

### Token + locks

```json
{
  "kind": "token",
  "token": "0x02b0de4c4d4a7416a3465126730df71a026d7bbb"
}
```

Reads the token runtime code, EIP-1967 implementation slot, `owner()`, `paused()`,
common selectors, every OAKEN lock in v1–v4, the vault schedule behind each lock,
and the Pons factory/curve state. Returns checks, a summary and the sources.

### Curve launch

```json
{
  "kind": "curve",
  "address": "0x5eDa1a2d4Ac30B173729684FB96EdbCBcAB0730D"
}
```

The input is the **curve address**, the same address the site opens at
`/curve/robinhood/<curve>`. The v5 factory has no registry getter, so a token
address cannot be turned into its curve without replaying factory logs; the
report reads `token()` from the curve and refuses an address that does not
answer it.

Reads the curve's launch supply, reserved slice, sellable allocation, tracked
reserves, graduation line, fee parameters, pending fee balances and the token
behind it (including its OAKEN locks and source verification). After graduation
the contract zeroes its tracked reserves; the report says "graduated" and does
not present those zeros as progress.

### Pre-launch review

```json
{
  "kind": "prelaunch",
  "token": "0x02b0de4c4d4a7416a3465126730df71a026d7bbb",
  "lockAmount": 5000000,
  "lockDays": 180,
  "steps": 6,
  "initialUnlockPct": 10,
  "revocable": false
}
```

The token facts are on-chain; the lock plan is user-provided and is marked as
such. Duration, initial unlock and revocable checks use OAKEN's own heuristics,
not a contract rule or an audit standard.

### Bond health

```json
{
  "kind": "bond",
  "symbol": "OAKEN"
}
```

Reads the OAKEN bond vault, NAV oracle, redemption parameters and staking pool.
Bonds are not locks: they have a 2-of-3 Safe, a NAV keeper and an oracle.

### Narrative

Every report may include an optional `narrative` field: a short prose paragraph
written by a Workers AI model from the report's fact sheet. It is additive, and
it is guarded: the answer is discarded if it contains any number that is not
already in the fact sheet, or if it gives advice or a security score. The
deterministic `summary` and `checks` remain authoritative. Send
`"narrative": false` to skip the model call.

## Response shape

```json
{
  "ok": true,
  "report": {
    "id": "uuid",
    "kind": "token-lock-report",
    "createdAt": "2026-10-27T00:00:00.000Z",
    "blockNumber": 98570000,
    "blockTimeIso": "2026-10-27T00:00:00.000Z",
    "chain": { "id": 4663, "name": "Robinhood Chain" },
    "token": { "...": "..." },
    "locks": { "total": 1, "rows": [] },
    "pons": { "...": "..." },
    "checks": [
      { "key": "contract", "label": "Contract code", "status": "pass", "detail": "..." }
    ],
    "summary": "Read at block ...",
    "narrative": { "text": "...", "model": "@cf/meta/llama-3.1-8b-instruct", "factsChecked": true },
    "sources": [],
    "disclaimer": "...",
    "beta": { "free": true, "price": "0.05", "asset": "USDG", "network": "eip155:4663" }
  }
}
```

`checks[].status` is one of `pass`, `flag`, `info`, `unknown`. A `flag` is a
thing to look at, not a verdict. An `unknown` means the read was not available;
it is never converted to a zero or a pass.

## x402 mode

The direct API is paid. A `POST /api/agents/report` without an `X-PAYMENT`
header answers `402 Payment Required` with an `accepts[]` entry for
`exact`/EIP-3009 in USDG on `robinhood` (CAIP-2 `eip155:4663`). A paying client
signs the standard `TransferWithAuthorization` typed data and retries with an
`X-PAYMENT` header. The facilitator settles the authorization; the server
returns the report and a settlement receipt header.

The web page calls the same-origin proxy at `oaken.one/api/agents/*`, which adds
a server-side site key and keeps the web beta free. A request without that key
(including a bare `curl` to `agents.oaken.one`) is charged.

Prices:

| Report | Price |
| --- | ---: |
| Token + locks | 0.02 USDG |
| Curve launch | 0.02 USDG |
| Bond health | 0.02 USDG |
| Pre-launch review | 0.05 USDG |

`GET /api/agents/report/:id` remains free: a stored report does not need a
second payment.

## Caveats

- Robinhood Chain (4663) only. USDG is the stablecoin on this chain; there is no
  canonical USDC here.
- The service must run on a host that can reach the Robinhood Chain RPC. The
  Cloudflare edge used by the static site cannot reach it reliably, which is why
  this is a separate service (deployed as the `oaken-agents` Worker with RPC
  fallbacks).
- A selector found in bytecode is not a live function. An empty owner slot is
  not proof of renouncement. A curve price is not a promise of liquidity.
- Sourcify is queried for the token and the curve; an exact match is reported
  as such. Verification is not an audit, and a missing source is not evidence
  of malice.

Contact: [@oakenhood](https://x.com/oakenhood)
