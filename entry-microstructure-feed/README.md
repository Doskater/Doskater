# Entry Microstructure Feed

Read-only event-level market-data service for the Trading Pipeline's Entry Intelligence layer.

It complements the existing Binance/Bybit ChatGPT tools. It deliberately does **not** duplicate slower data already available there (OI, funding, candles, top-trader positioning, ADL, normal market snapshots). Its job is to preserve event sequence information that ordinary request/response tools lose between calls.

## Deployment model

The v1 deployment target is the user's local Mac mini, not Render or another public cloud host.

Normal lifecycle:

```text
Trading Pipeline / Desktop Commander
        ↓
local:ensure
        ↓
127.0.0.1:8791
        ↓
Binance + Bybit public WebSockets
        ↓
60s WARMING_UP
        ↓
FULL_EVENT_STREAM
```

When the Mac is off or the collector is not running, the Trading Pipeline must fall back to its documented `SNAPSHOT PROXY` mode and label that limitation explicitly.

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

- `FULL_EVENT_STREAM` — required venue books are sequence-valid, events are fresh, and 60 seconds of continuous healthy post-sync history exist.
- `WARMING_UP` — connections/books are establishing or a fresh 60s history is being rebuilt after reconnect.
- `PARTIAL` — at least one venue family is healthy but expected coverage is missing/stale.
- `UNAVAILABLE` — no trustworthy event-level coverage is available after the warm-up grace period.

A reconnect, stale stream, crossed book, sequence gap or new snapshot invalidates/clears the affected venue-family rolling history. It cannot immediately reuse pre-gap history to claim `FULL_EVENT_STREAM`.

## Watchlist

Always hot while the service is running:

- `BTCUSDT`
- `ETHUSDT`
- `SOLUSDT`

The Trading Pipeline may dynamically ensure additional finalists. v1 allows at most 12 total active symbols. Dynamic symbols expire after 20 minutes without refresh; core symbols never expire.

## Local HTTP/MCP API

Default endpoint:

`http://127.0.0.1:8791`

Endpoints:

- `GET /healthz`
- `GET /v1/status`
- `GET /v1/watchlist`
- `POST /v1/watchlist/ensure` with `{"symbols":["STXUSDT"]}`
- `GET /v1/microstructure/BTCUSDT`
- `POST /mcp`

When bound to loopback (`127.0.0.1`, `::1` or `localhost`), the local API may run without a bearer token so Desktop Commander / the local Trading Pipeline can use it directly.

If the service is explicitly bound to a non-loopback address such as `0.0.0.0`, the protected API still fails closed unless `MICROSTRUCTURE_FEED_TOKEN` is configured. A configured token is always enforced.

## MCP tools

Exactly four tools are exposed, all annotated read-only/non-destructive:

- `get_stream_status`
- `ensure_symbols`
- `get_microstructure_snapshot`
- `get_microstructure_summary`

`ensure_symbols` only changes the in-memory public-data subscription watchlist. It cannot trade.

## Local lifecycle

From the service directory:

```sh
npm run local:ensure
npm run local:status
npm run local:stop
```

`local:ensure` is idempotent: it starts the service if needed and otherwise returns the existing healthy process.
On a fresh checkout, `local:ensure` automatically installs the locked production dependencies (`npm install --omit=dev --ignore-scripts`) if `ws` is not present.

Runtime state is stored outside the repository:

```text
~/Library/Application Support/entry-microstructure-feed/service.json
~/Library/Application Support/entry-microstructure-feed/service.log
```

The manager validates both PID liveness and `/healthz` service identity before treating the process as healthy or before sending SIGTERM. This avoids killing an unrelated reused PID.

Default local port: `8791`.

Optional overrides:

- `ENTRY_MICROSTRUCTURE_PORT`
- `ENTRY_MICROSTRUCTURE_STATE_DIR`

## Development and verification

```sh
cd entry-microstructure-feed
npm install
npm test
npm run check
npm run smoke
```

The live smoke test uses public streams only. It waits for BTC/ETH/SOL to reach `FULL_EVENT_STREAM`, forces a Binance adapter disconnect, verifies degraded coverage, reconnects, and requires a fresh `WARMING_UP` period.

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

At the beginning of a full trading-pipeline run, Desktop Commander should call `npm run local:ensure` (or equivalently ensure the service is healthy at `127.0.0.1:8791`). The rest of the pipeline can perform macro/market/derivatives analysis while the feed warms.

Near a valid candidate entry zone, Entry Intelligence should read the local event-level snapshot. If the feed is `FULL_EVENT_STREAM`, use the event-level features. If it is `WARMING_UP`, `PARTIAL` or `UNAVAILABLE`, do not pretend event-level evidence exists; fall back to the documented `SNAPSHOT PROXY` behavior where appropriate.

## Local trigger watcher

The optional watcher is notification-only. It never places, changes, or cancels orders.
It persists arbitrary coin setups under `~/Library/Application Support/entry-microstructure-feed/watcher-setups.json`, refreshes dynamic feed subscriptions while they are monitored, and emits a macOS notification only after the configured trigger and microstructure confirmation rules pass.

Default confirmation rules for a setup are:

- trigger price holds continuously for 30 seconds;
- feed runtime is `FULL_EVENT_STREAM`;
- 60s aggressor imbalance is > +0.30 for LONG or < -0.30 for SHORT;
- impact asymmetry is `buy_more_efficient` for LONG or `sell_more_efficient` for SHORT;
- no opposite-side absorption veto;
- two valid confirmations at least 12 seconds apart;
- after notification, the setup latches until price invalidates the trigger, preventing repeated alerts.

Register or update any symbol and auto-start both feed and watcher:

```sh
cd /Users/feliks/Projects/trading-data-chatgpt-proxy/entry-microstructure-feed
npm run watcher:ensure -- --symbol NEARUSDT --side long --trigger 5.25
```

Optional overrides:

```sh
--hold-ms 30000 --min-imbalance 0.30 --confirmations 2 --confirmation-interval-ms 12000
```

Management:

```sh
npm run watcher:list
npm run watcher:status
npm run watcher:remove -- --symbol NEARUSDT
npm run watcher:stop
```

Future ChatGPT sessions using Desktop Commander can invoke these commands whenever the user asks to monitor a setup. The watcher keeps the corresponding dynamic symbol active in the event-level collector while the setup remains registered.
