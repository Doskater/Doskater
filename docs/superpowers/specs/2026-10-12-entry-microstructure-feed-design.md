# Entry Microstructure Feed — Design


## Deployment Override — 2026-10-13

The current v1 deployment target is **local-only on the user's Mac mini**. This override supersedes every Render/paid-cloud deployment instruction later in this document.

- Bind HTTP/MCP to `127.0.0.1` by default; no public internet exposure.
- Local lifecycle is controlled by `npm run local:ensure`, `npm run local:status`, and `npm run local:stop`.
- Default local endpoint: `http://127.0.0.1:8791`.
- Runtime PID/log state lives outside the repository under `~/Library/Application Support/entry-microstructure-feed/`.
- Loopback-only access may operate without `MICROSTRUCTURE_FEED_TOKEN`; if a non-loopback bind is explicitly requested, protected endpoints fail closed unless the bearer token is configured.
- The Trading Pipeline should ensure the collector at the start of a full run, perform broader analysis while it warms, and use event-level features only at `FULL_EVENT_STREAM`.
- If the Mac/service is unavailable or runtime is not full, the pipeline falls back to the documented `SNAPSHOT PROXY` behavior and labels that limitation.
- No Render, Oracle, public domain, or paid hosting is required for v1.

## Goal

Add a small, read-only, event-level market-data service for the Trading Pipeline so ChatGPT can evaluate entry timing from information that ordinary Binance/Bybit plugin calls do not preserve between requests.

The service is **not** a replacement for the existing Binance and Bybit ChatGPT tools. Those remain the canonical sources for ordinary snapshots and slower derivatives/context data such as candles, OI, funding, top-trader positioning, ADL, mark/index prices, and one-off order-book reads.

The new service exists only for event-sequence information required by the v2.9 Entry Intelligence layer:

- order-book deltas and cancellations;
- trade-by-trade aggressor flow;
- short rolling windows (1s / 5s / 30s / 1m);
- replenishment/refill behaviour;
- liquidity-void detection;
- price-impact asymmetry;
- liquidation bursts and post-burst response;
- venue and spot-vs-perp lead/lag.

Success means ChatGPT can ask for a compact `FULL_EVENT_STREAM` microstructure snapshot near a candidate entry and receive fresh, causally useful features without ingesting raw tick streams.

## Non-goals

The service must not:

- place, amend, cancel, or close orders;
- contain Binance or Bybit trading credentials;
- access private/account streams;
- duplicate OI, funding, candles, top-trader, ADL, or normal market-overview data already available through ChatGPT tools;
- become a general historical tick database;
- automatically create a directional trading thesis.

## Chosen Architecture

Create one independent Node.js Render Web Service in Frankfurt, deployed from the existing `Doskater/Doskater` repository.

Proposed directory:

`entry-microstructure-feed/`

Flow:

`Binance public WS + Bybit public WS -> normalized event bus -> local order books + rolling windows -> feature engine -> read-only HTTP/MCP API -> ChatGPT Trading Pipeline`

The service is isolated from `bybit-demo-execution-cloud/`. It has no code dependency on Demo Execution and receives no Demo API secrets.

Use one Render instance initially. All exchange connections require heartbeat/staleness detection, exponential reconnect, and deterministic state rebuild after disconnects, deploys, maintenance, or sequence gaps.

## Source Feeds

### Binance Spot

Use public WebSocket streams for watched symbols:

- `<symbol>@aggTrade` for real-time aggregate trades;
- `<symbol>@depth@100ms` for diff-depth updates;
- optional `<symbol>@bookTicker` where useful for top-of-book timing.

Build the local book from a REST depth snapshot plus buffered diff-depth updates, following Binance update-ID sequencing rules. Any gap or invalid update sequence invalidates that venue book until rebuilt.

### Binance USD-M Perpetual

Use public market WebSocket streams:

- `<symbol>@aggTrade`;
- `<symbol>@depth@100ms` or the highest supported stable depth cadence;
- `<symbol>@forceOrder` or the all-market liquidation stream for liquidation context.

Use public/market endpoints only. Never use user-data/private streams.

### Bybit Spot and Linear Perpetual

Use V5 public WebSocket streams:

- `publicTrade.{symbol}`;
- `orderbook.{depth}.{symbol}`;
- `allLiquidation.{symbol}` for derivatives when available/relevant.

For order books, respect snapshot/delta semantics and update IDs. Use exchange-generated/matching-engine timestamps where provided. A reconnect or sequence break returns the venue to `WARMING_UP` until a clean book is established.

## Watchlist Model

The collector does **not** subscribe to the whole market.

Always-hot core symbols:

- BTCUSDT
- ETHUSDT
- SOLUSDT

Dynamic candidates are added by ChatGPT when the main pipeline produces finalists.

Read-only control operation:

`ensure_symbols(["STXUSDT", ...])`

Rules:

- maximum 12 active symbols in v1;
- dynamic symbols expire after 20 minutes without a refresh/request;
- a symbol reports `WARMING_UP` until minimum rolling-history and valid-book conditions are met;
- unsupported spot/perp venue combinations are reported explicitly instead of fabricated.

## Normalized Event Model

Normalize raw exchange messages into a small internal schema.

Trade event:

- venue;
- market (`spot` / `perp`);
- symbol;
- event timestamp;
- receive timestamp;
- price;
- quantity;
- notional;
- aggressor side (`buy` / `sell`).

Book delta:

- venue;
- market;
- symbol;
- event/matching-engine timestamp when available;
- sequence/update IDs;
- bid level changes;
- ask level changes.

Liquidation event:

- venue;
- symbol;
- timestamp;
- side;
- quantity/notional;
- price/average price when available.

Raw messages are processed in memory and are not persisted indefinitely.

## Local Order-Book Engine

Maintain independent books for each `(venue, market, symbol)`.

For each book track:

- best bid/ask and spread;
- top depth levels and depth inside configurable bps bands around mid;
- changes attributable to executions vs passive removal/addition where inferable from event ordering;
- update-sequence health;
- last exchange timestamp and receive timestamp;
- current freshness/staleness state.

A sequence gap, stale stream, crossed/invalid book, or rebuild failure makes that venue unavailable for derived book features until repaired.

## Rolling Windows

Maintain in-memory ring buffers for:

- 1 second;
- 5 seconds;
- 30 seconds;
- 60 seconds.

Keep only the minimum event history required to compute features plus a short replay/debug tail. Do not store an unbounded raw event history.

## Feature Engine

### 1. Aggressor Imbalance

For each window compute buy/sell aggressive notional and normalized imbalance:

`(buy_notional - sell_notional) / (buy_notional + sell_notional)`

Return raw notionals as well as the normalized value so tiny-volume windows are not overinterpreted.

### 2. Liquidity Reflex / Refill

Measure how much displayed liquidity returns after a price level or bps band is consumed/depleted.

Return, when data quality permits:

- bid refill ratio;
- ask refill ratio;
- refill half-life;
- persistence after refill;
- absorption direction.

Do not claim refill metrics when only snapshot-quality data is present or a book sequence is unhealthy.

### 3. Passive Withdrawal / Liquidity Void

Measure depth disappearing without matching executed volume.

Produce separate upward and downward void-risk estimates based on:

- depth withdrawal;
- aggressor confirmation;
- spread expansion;
- persistence of the missing depth.

A void is classification context, not a directional signal by itself.

### 4. Price Impact Per Notional

For rolling windows estimate bps of mid-price movement per standardized aggressive notional for buys and sells.

Expose:

- upside impact;
- downside impact;
- sample notional/volume;
- confidence/data-quality flag.

### 5. Impact Asymmetry

Compare buy-side and sell-side impact efficiency. The feature should help identify when one side needs progressively more aggressive notional to move price while the opposite side moves it with less.

### 6. Liquidation Response

Group liquidation events into short bursts and measure price follow-through after the burst.

Classify only when enough data exists:

- continuation;
- absorbed/exhausted;
- mixed;
- unavailable.

### 7. Price-Discovery / Lead-Lag

Across healthy venue streams calculate short rolling lead/lag using event timestamps, first-break timing, and short-return cross-correlation.

Return a leader only when the evidence exceeds a minimum stability threshold; otherwise return `no_clear_leader`.

Never permanently designate Binance or Bybit as the leader.

### 8. Cross-Layer Summary

Do not convert every feature into independent votes. Produce a short causal summary such as:

`Binance spot leads -> aggressive buys rise -> ask refill weakens -> upside impact rises -> perp follows`

or

`Perp breakout not confirmed by spot -> depth withdrawal caused move -> weak aggressor confirmation -> fakeout risk`.

The Trading Pipeline remains responsible for combining this with higher-timeframe thesis, EV/R:R, risk, and event context.

## Runtime States

Every symbol response includes one runtime state:

### `FULL_EVENT_STREAM`

All required event streams for the requested feature set are healthy, local books are sequence-valid, rolling windows are warm, and freshness is inside limits.

### `WARMING_UP`

Streams are connected but insufficient rolling history/book state exists yet.

### `PARTIAL`

Some venues/features are healthy but at least one expected stream is missing or stale. Return only valid features and list missing coverage.

### `UNAVAILABLE`

The service cannot produce trustworthy event-level features for that symbol.

The service must never label a REST/plugin snapshot reconstruction as `FULL_EVENT_STREAM`.

## API and MCP Surface

Expose a small read-only interface.

### Public HTTP

`GET /healthz`

Returns service health without revealing secrets or market payloads.

### Bearer-protected read/control endpoints

- `GET /v1/status`
- `GET /v1/watchlist`
- `POST /v1/watchlist/ensure`
- `GET /v1/microstructure/:symbol`

`ensure` mutates only the in-memory public-data watchlist. It cannot perform any trading/account action.

### MCP tools

Expose equivalent concise tools for a private ChatGPT plugin:

- `get_stream_status`
- `ensure_symbols`
- `get_microstructure_snapshot`
- `get_microstructure_summary`

Responses should be compact and structured. ChatGPT should receive derived features, freshness, coverage, and causal summary rather than raw event floods.

## Security Boundary

1. No exchange API keys or account credentials are required.
2. No private Binance/Bybit WebSocket or REST endpoints are implemented.
3. No order, account, wallet, transfer, withdrawal, leverage, or position methods exist.
4. The Render API/MCP surface is protected with a separate random bearer secret such as `MICROSTRUCTURE_FEED_TOKEN`.
5. `/healthz` is the only unauthenticated endpoint.
6. Secrets are redacted from logs and never returned in responses.
7. The service must be deployable and testable without any Demo Execution secret.

## Render Deployment

Create a separate Render Web Service:

- name: `entry-microstructure-feed`;
- repo: `https://github.com/Doskater/Doskater`;
- branch: `main`;
- region: `frankfurt`;
- runtime: Node.js;
- plan: paid Starter or equivalent always-on plan;
- build: `cd entry-microstructure-feed && npm install --omit=dev && npm run check`;
- start: `cd entry-microstructure-feed && npm start`;
- health check: `/healthz`;
- auto-deploy: enabled.

The service binds HTTP to `0.0.0.0:$PORT`.

Free Render is not the production target because a continuous market collector should not depend on free-service sleep/restart behaviour.

## Connection Reliability

Each exchange connection requires:

- ping/pong or exchange-prescribed heartbeat handling;
- stale-message timeout;
- exponential reconnect with jitter;
- resubscription of the current watchlist;
- deterministic local-book rebuild;
- transition to `WARMING_UP` after reconnect until feature windows recover;
- graceful `SIGTERM` handling on Render deploy/restart.

No feature derived from an invalid/stale book is returned as healthy.

## Observability

Log structured operational events only:

- connect/disconnect/reconnect;
- subscribe/unsubscribe;
- order-book rebuild and sequence-gap events;
- symbol runtime-state transitions;
- feature-loop errors;
- process health/memory statistics at a low cadence.

Do not log every raw trade/book delta.

`/healthz` should summarize:

- process uptime;
- exchange connection states;
- number of active symbols;
- count of `FULL_EVENT_STREAM` / `WARMING_UP` / `PARTIAL` symbols;
- last event age per exchange family.

## Testing Strategy

### Unit tests

- aggressor-side normalization;
- rolling-window expiry;
- imbalance calculations;
- refill metrics on deterministic event sequences;
- depth-withdrawal/void classification;
- impact calculations;
- liquidation-burst classification;
- lead/lag calculation;
- auth middleware and secret redaction.

### Order-book replay tests

Feed recorded/synthetic snapshot + delta sequences and verify:

- correct update ordering;
- gap detection;
- rebuild requirement;
- zero-size level deletion;
- no derived feature is emitted from an invalid book.

### Integration tests

Against public exchange streams only:

- BTCUSDT reaches `FULL_EVENT_STREAM` after warm-up;
- ETHUSDT and SOLUSDT remain healthy concurrently;
- dynamic `ensure_symbols` adds and later expires a candidate;
- forced socket reconnect returns the symbol to `WARMING_UP`, rebuilds, then reaches `FULL_EVENT_STREAM` again;
- no exchange credential is needed anywhere.

### API tests

- `/healthz` works without auth;
- protected endpoints reject missing/wrong bearer token;
- microstructure responses contain freshness/coverage/runtime state;
- responses never expose raw bearer token or unbounded raw events.

## Trading-Pipeline Integration

The main v2.9 pipeline continues using the existing Binance/Bybit ChatGPT tools for ordinary market/derivatives data.

Activate this service only when:

1. the main pipeline has a valid candidate thesis;
2. EV/R:R is still acceptable;
3. price is near the candidate entry/alert zone.

Then:

1. call `ensure_symbols` for the finalists;
2. use `FULL_EVENT_STREAM` when available;
3. obtain `get_microstructure_snapshot`;
4. feed Liquidity Reflex, Leader, Void, Impact, and Liquidation Response into Entry Intelligence;
5. Entry Intelligence outputs `ENTER NOW / ARM ENTRY / WAIT / CANCEL SETUP` but still cannot override the base hard veto/risk rules.

If the feed is `PARTIAL` or `UNAVAILABLE`, the pipeline may fall back to the documented `SNAPSHOT PROXY` mode using ordinary plugin calls, but it must label that limitation explicitly.

## Rollout

Phase 1:

- BTC/ETH/SOL always-hot;
- Binance spot + USD-M perp;
- Bybit spot + linear perp;
- trades, order-book deltas, liquidations;
- core features and read-only API/MCP.

Phase 2 only after Phase 1 proves stable:

- dynamic candidate watchlist tuning;
- feature calibration from paper-trade attribution;
- optional short retained feature history for debugging/A-B analysis.

Do not add a database, Redis, multi-instance scaling, or historical tick storage in Phase 1 unless operational evidence requires it.

## Verification Before Production Use

Before v2.9 may label the service `FULL_EVENT_STREAM` in a trading run:

- Render service is healthy and always-on;
- all market families needed for the symbol have valid connection state or explicitly reported unsupported coverage;
- local order books pass sequence validation;
- event freshness is within configured thresholds;
- rolling windows are warm;
- reconnect/rebuild test has passed;
- bearer auth is enforced;
- source inspection confirms there is no account/trading/private-stream code path.

## Scope Exclusions

Not included in the first implementation:

- real-money or demo order execution;
- account/portfolio reads;
- historical tick warehouse;
- machine-learning prediction model;
- auto-trading;
- whole-market permanent subscriptions;
- duplicate retrieval of OI/funding/candles/top-traders/ADL already available through ChatGPT plugins.
