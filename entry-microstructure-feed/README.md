# Entry Microstructure Feed

Read-only event-level market-data service for the Trading Pipeline's Entry Intelligence layer.

It complements the existing Binance/Bybit ChatGPT tools. It deliberately does **not** duplicate slower data already available there (OI, funding, candles, top-trader positioning, ADL, normal market snapshots). Its job is to preserve event sequence information that ordinary request/response tools lose between calls.

## What it collects

Public market data only:

- Binance Spot: aggregate trades + diff-depth order-book updates.
- Binance USD-M perpetuals: aggregate trades + diff-depth + liquidation/force-order events.
- Bybit Spot: public trades + order-book snapshot/delta events.
- Bybit Linear perpetuals: public trades + order-book snapshot/delta + all-liquidation events.

No Binance or Bybit API keys are required. There are no account, wallet, position, order, leverage, transfer, deposit, withdrawal, or private-stream code paths.

## Derived features

The service keeps bounded in-memory event windows and derives:

- aggressor buy/sell imbalance with raw notionals;
- bid/ask replenishment, refill half-life and persistence;
- passive depth withdrawal / liquidity-void context;
- price impact per standardized aggressive notional;
- buy-vs-sell impact asymmetry;
- liquidation burst response;
- venue and spot/perp lead-lag;
- compact causal summary + strongest contradiction.

Rolling windows: 1s, 5s, 30s and 60s.

## Runtime states

Every symbol reports exactly one state:

- `FULL_EVENT_STREAM` — required venue books are sequence-valid, events are fresh, and a complete 60s post-sync history exists.
- `WARMING_UP` — connections/books are establishing or a fresh 60s history is being rebuilt after reconnect.
- `PARTIAL` — at least one venue family is healthy but expected coverage is missing/stale.
- `UNAVAILABLE` — no trustworthy event-level coverage is available after the warm-up grace period.

A reconnect, stale stream, crossed book, sequence gap or new snapshot invalidates/clears the affected venue-family rolling history. It cannot immediately reuse pre-gap history to claim `FULL_EVENT_STREAM`.

## Watchlist

Always hot:

- `BTCUSDT`
- `ETHUSDT`
- `SOLUSDT`

The Trading Pipeline may dynamically ensure additional finalists. v1 allows at most 12 total active symbols. Dynamic symbols expire after 20 minutes without refresh; core symbols never expire.

## HTTP API

`GET /healthz` is public.

All other endpoints require:

`Authorization: Bearer $MICROSTRUCTURE_FEED_TOKEN`

Protected endpoints:

- `GET /v1/status`
- `GET /v1/watchlist`
- `POST /v1/watchlist/ensure` with `{"symbols":["STXUSDT"]}`
- `GET /v1/microstructure/BTCUSDT`
- `POST /mcp`

The bearer token protects this service's control/read surface only. It is not an exchange credential.

## MCP tools

Exactly four tools are exposed, all annotated read-only/non-destructive:

- `get_stream_status`
- `ensure_symbols`
- `get_microstructure_snapshot`
- `get_microstructure_summary`

`ensure_symbols` only changes the in-memory public-data subscription watchlist. It cannot trade.

## Local development

```sh
cd entry-microstructure-feed
npm install
npm test
npm run check
npm run smoke
```

The live smoke test uses public streams only. It waits for BTC/ETH/SOL to reach `FULL_EVENT_STREAM`, forces a Binance adapter disconnect, verifies degraded coverage, reconnects, and requires a fresh `WARMING_UP` period.

To run the HTTP/MCP service locally:

```sh
cd entry-microstructure-feed
MICROSTRUCTURE_FEED_TOKEN='use-a-random-local-token' PORT=3000 npm start
```

## Render deployment

Target service:

- name: `entry-microstructure-feed`
- repo: `https://github.com/Doskater/Doskater`
- branch: `main`
- region: Frankfurt
- runtime: Node.js
- plan: always-on paid Starter or equivalent
- auto-deploy: enabled
- build: `cd entry-microstructure-feed && npm install --omit=dev && npm run check`
- start: `cd entry-microstructure-feed && npm start`
- health path: `/healthz`

Required service secret:

- `MICROSTRUCTURE_FEED_TOKEN` — high-entropy random bearer token used only by the private client/plugin.

No exchange API credentials should be configured on this service.

## Data integrity

### Binance Spot

The adapter buffers diff-depth events while obtaining a REST snapshot and applies the documented `U/u` bridge rules. A gap invalidates the book and triggers a rebuild.

### Binance USD-M perpetuals

The first processed event bridges the REST snapshot when `U <= lastUpdateId <= u`. After the bridge, futures continuity is checked with `pu == previous u`; the adapter does not incorrectly impose spot-style contiguous `U` values on futures packets.

### Bybit

Order-book `snapshot` messages replace local state. `delta` messages update it. Reconnect/staleness returns the family to warming until a new valid snapshot arrives.

## Storage and logs

Phase 1 has no database or Redis. Event history is bounded in process memory.

Logs contain operational state transitions/errors only. Raw trades/order-book payloads and bearer tokens are not logged.

## Trading Pipeline use

The normal pipeline still uses the existing Binance/Bybit ChatGPT tools for market/derivatives context. This feed activates only near a valid candidate entry zone and supplies the event-level timing features used by Entry Intelligence.

If this service is `PARTIAL` or `UNAVAILABLE`, the Trading Pipeline may fall back to its documented `SNAPSHOT PROXY` mode, but must label that limitation explicitly.
