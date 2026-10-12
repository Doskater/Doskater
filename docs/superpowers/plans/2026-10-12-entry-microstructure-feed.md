# Entry Microstructure Feed Implementation Plan


## Deployment Override — 2026-10-13

The user selected **local Mac mini deployment** instead of Render. This section supersedes all Render-specific goals, constraints, and Task 12 steps below.

Current deployment work:

- default bind `127.0.0.1`; local port `8791`;
- add idempotent `local:ensure`, plus `local:status` and `local:stop`;
- store PID/log outside the repo under `~/Library/Application Support/entry-microstructure-feed/`;
- allow no bearer only for loopback-only operation; retain fail-closed auth for any explicit non-loopback bind;
- verify real local lifecycle and `FULL_EVENT_STREAM` on BTC/ETH/SOL;
- update Trading Pipeline v2.9 so a full run ensures the local collector first and falls back to `SNAPSHOT PROXY` if unavailable/non-full.

No external deployment should be created as part of this plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only Render service that continuously consumes Binance/Bybit public event streams and exposes compact, trustworthy entry-microstructure features to the Trading Pipeline.

**Architecture:** One isolated Node.js service in `entry-microstructure-feed/` maintains per-venue local books and short in-memory rolling windows for BTC/ETH/SOL plus dynamic candidates. Pure feature modules derive aggressor imbalance, refill/void, price-impact asymmetry, liquidation response, and venue lead/lag; a small bearer-protected HTTP/MCP layer returns only compact derived state. Existing Binance/Bybit ChatGPT tools remain canonical for OI/funding/candles/top-trader/ADL and are not duplicated.

**Tech Stack:** Node.js >=20, ESM, `ws` 8.x, built-in `node:http`, `node:test`, public Binance Spot/USD-M REST+WebSocket, public Bybit V5 WebSocket.

**Spec:** `docs/superpowers/specs/2026-10-12-entry-microstructure-feed-design.md`

## Global Constraints

- Service directory: `entry-microstructure-feed/`.
- No exchange account credentials, private streams, orders, positions, wallet, transfer, withdrawal, leverage, or account methods.
- Do not duplicate OI, funding, candles, top-trader positioning, ADL, normal market-overview data, or historical tick storage.
- Core always-hot symbols: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`.
- Maximum active symbols in v1: 12.
- Dynamic symbols expire after 20 minutes without refresh/request.
- Runtime states are exactly `FULL_EVENT_STREAM`, `WARMING_UP`, `PARTIAL`, `UNAVAILABLE`.
- Rolling windows are 1s, 5s, 30s, and 60s.
- `/healthz` is the only unauthenticated endpoint; all read/control API and MCP methods require `MICROSTRUCTURE_FEED_TOKEN`.
- Render target: separate Frankfurt web service named `entry-microstructure-feed`, always-on paid Starter or equivalent, auto-deploy from `main`.
- A REST/plugin snapshot reconstruction must never be labelled `FULL_EVENT_STREAM`.
- Keep raw events bounded in memory; no database/Redis/multi-instance scaling in Phase 1.

## Review Focus

1. **Exchange sequence gaps/reconnects:** a stale or gapped book must immediately stop producing healthy book-derived features and return to `WARMING_UP` until rebuilt. Covered in Tasks 3, 6, and 7.
2. **Tiny-volume windows:** normalized imbalance/impact values must carry raw volume/sample metadata so an almost-empty window cannot appear high-confidence. Covered in Task 4.
3. **Unsupported venue/market combinations:** never fabricate coverage; report missing coverage and `PARTIAL`/`UNAVAILABLE`. Covered in Tasks 5 and 8.
4. **Dynamic watchlist abuse:** invalid symbols, >12 active symbols, and expiry/refresh behavior must be deterministic and bounded. Covered in Task 5.
5. **Secret/error leakage:** wrong bearer tokens, malformed requests, upstream socket errors, and logs must not expose `MICROSTRUCTURE_FEED_TOKEN` or unbounded raw events. Covered in Tasks 8 and 9.

---

## File Map

Create under `entry-microstructure-feed/`:

- `package.json` — Node/runtime/scripts/dependency declaration.
- `config.js` — constants, symbol validation, thresholds, endpoints, runtime-state names.
- `ring-buffer.js` — bounded timestamped event buffer and rolling-window reads.
- `order-book.js` — sequence-valid local book state and depth metrics.
- `normalizers.js` — normalized trade/book/liquidation event constructors and aggressor-side semantics.
- `features.js` — pure feature calculations from windows/book snapshots.
- `watchlist.js` — core/dynamic symbol lifecycle and 12-symbol cap.
- `binance-feed.js` — Binance spot/USD-M public WS + snapshot/rebuild lifecycle.
- `bybit-feed.js` — Bybit spot/linear public WS snapshot/delta lifecycle.
- `collector.js` — per-symbol orchestration, runtime state, freshness/coverage, feature snapshots.
- `server.js` — `/healthz`, protected REST endpoints, read-only MCP tools, auth/rate/body limits.
- `README.md` — local run, Render env, endpoint/tool contract, explicit security boundary.
- `test/*.test.js` — unit, replay, API, and connector-state tests.

Do not modify `bybit-demo-execution-cloud/` behavior.

### Task 1: Service scaffold, config, and bounded rolling buffers

**Files:**
- Create: `entry-microstructure-feed/package.json`
- Create: `entry-microstructure-feed/config.js`
- Create: `entry-microstructure-feed/ring-buffer.js`
- Test: `entry-microstructure-feed/test/ring-buffer.test.js`
- Test: `entry-microstructure-feed/test/config.test.js`

**Interfaces:**
- Produces: `RUNTIME_STATES`, `CORE_SYMBOLS`, `MAX_ACTIVE_SYMBOLS`, `DYNAMIC_TTL_MS`, `WINDOW_MS`, `normalizeSymbol(value)`, `isSupportedSymbol(value)` from `config.js`.
- Produces: `createTimedRingBuffer({ retentionMs, maxItems, now })` returning `{ push(event), prune(), between(startMs,endMs), since(startMs), size() }`.

- [ ] **Step 1: Write failing config tests** asserting core symbols are BTC/ETH/SOL, max symbols = 12, TTL = 20 minutes, windows = `[1000,5000,30000,60000]`, and invalid symbols such as `../BTC` are rejected.
- [ ] **Step 2: Run** `cd entry-microstructure-feed && node --test test/config.test.js`; expect FAIL because modules do not exist.
- [ ] **Step 3: Implement `config.js`** with exact constants and uppercase `^[A-Z0-9]{2,30}USDT$` validation.
- [ ] **Step 4: Write failing ring-buffer tests** for chronological push, pruning by retention, bounded item count, and `since()` window reads using an injected clock.
- [ ] **Step 5: Run** `node --test test/ring-buffer.test.js`; expect FAIL.
- [ ] **Step 6: Implement `createTimedRingBuffer(...)`** with bounded in-memory storage only.
- [ ] **Step 7: Create `package.json`** with `type=module`, Node `>=20`, scripts `test`, `check`, `start`, and dependency `ws` 8.x.
- [ ] **Step 8: Run** `npm install && npm test`; expect Task 1 tests PASS.
- [ ] **Step 9: Commit** `feat: scaffold microstructure feed core`.

### Task 2: Normalized event model and aggressor semantics

**Files:**
- Create: `entry-microstructure-feed/normalizers.js`
- Test: `entry-microstructure-feed/test/normalizers.test.js`

**Interfaces:**
- Consumes: symbol validation from Task 1.
- Produces: `normalizeTrade(input)`, `normalizeBookDelta(input)`, `normalizeLiquidation(input)` with fields fixed by the spec: venue, market, symbol, eventTs, receiveTs, price/qty/notional/side as applicable, and sequence IDs for book deltas.
- Produces exchange helpers `fromBinanceAggTrade`, `fromBybitPublicTrade`, `fromBinanceLiquidation`, `fromBybitLiquidation`.

- [ ] **Step 1: Write failing tests** proving Binance maker flag maps to correct aggressor side, Bybit `S`/side maps correctly, notional = price × qty, timestamps are preserved, malformed/negative numeric values are rejected, and unknown liquidation shapes return a controlled parse error.
- [ ] **Step 2: Run** `node --test test/normalizers.test.js`; expect FAIL.
- [ ] **Step 3: Implement normalized event constructors and exchange mapping helpers** without network calls.
- [ ] **Step 4: Run** the test; expect PASS.
- [ ] **Step 5: Commit** `feat: normalize exchange microstructure events`.

### Task 3: Sequence-valid local order-book engine

**Files:**
- Create: `entry-microstructure-feed/order-book.js`
- Test: `entry-microstructure-feed/test/order-book.test.js`

**Interfaces:**
- Consumes: normalized book deltas from Task 2.
- Produces: `createOrderBook({ venue, market, symbol, maxLevels })` with methods `reset(snapshot)`, `apply(delta)`, `invalidate(reason)`, `snapshot()`, `depthWithinBps(bps)`, `health()`.
- `health()` returns `{ valid, reason, lastEventTs, lastReceiveTs, sequence }`.

- [ ] **Step 1: Write failing replay tests** for snapshot load, update/add/delete of bid/ask levels, top-of-book/spread, depth in bps bands, zero-size deletion, crossed-book invalidation, and sequence-gap invalidation.
- [ ] **Step 2: Add Review Focus test**: after sequence gap, `snapshot().healthy` is false and no later normal delta restores health without explicit `reset(snapshot)`.
- [ ] **Step 3: Run** `node --test test/order-book.test.js`; expect FAIL.
- [ ] **Step 4: Implement the local book** using sorted numeric price maps/arrays appropriate for v1 max watched symbols; correctness over premature optimization.
- [ ] **Step 5: Run** the test; expect PASS.
- [ ] **Step 6: Commit** `feat: add sequence-valid local order books`.

### Task 4: Pure microstructure feature engine

**Files:**
- Create: `entry-microstructure-feed/features.js`
- Test: `entry-microstructure-feed/test/features.test.js`

**Interfaces:**
- Consumes: arrays of normalized trades/liquidations and book/depth samples from Tasks 2–3.
- Produces:
  - `computeAggressorImbalance(events)` -> `{ buyNotional, sellNotional, totalNotional, imbalance, quality }`
  - `computeRefill(samples, options)` -> bid/ask refill ratio, half-life, persistence, absorption direction, quality
  - `computeLiquidityVoid(samples, trades, options)` -> up/down void score, aggressor confirmation, spread expansion, quality
  - `computePriceImpact(trades, mids, options)` -> buy/sell bps-per-notional, sample notionals, quality
  - `computeImpactAsymmetry(impact)` -> direction/ratio/quality
  - `computeLiquidationResponse(liquidations, mids, options)` -> continuation/absorbed/mixed/unavailable + burst stats
  - `computeLeadLag(seriesByVenue, options)` -> leader/no_clear_leader, lagMs, stability, quality
  - `buildCausalSummary(features)` -> one concise causal string plus strongest contradiction.

- [ ] **Step 1: Write failing aggressor/impact tests** including zero/tiny-volume windows and exact raw-notional metadata.
- [ ] **Step 2: Write failing refill/void tests** using deterministic sequences that distinguish executed depletion from passive withdrawal and prove no refill claim when book quality is invalid.
- [ ] **Step 3: Write failing liquidation tests** for continuation vs absorbed burst.
- [ ] **Step 4: Write failing lead/lag tests** where Binance spot clearly leads, where Bybit leads, and where evidence is unstable and must return `no_clear_leader`.
- [ ] **Step 5: Run** `node --test test/features.test.js`; expect FAIL.
- [ ] **Step 6: Implement minimal pure calculations** with explicit `quality`/sample fields; no fake numeric confidence probabilities.
- [ ] **Step 7: Run** test; expect PASS.
- [ ] **Step 8: Commit** `feat: compute entry microstructure features`.

### Task 5: Bounded core/dynamic watchlist

**Files:**
- Create: `entry-microstructure-feed/watchlist.js`
- Test: `entry-microstructure-feed/test/watchlist.test.js`

**Interfaces:**
- Consumes: constants and symbol validation from Task 1.
- Produces: `createWatchlist({ coreSymbols, maxActive, dynamicTtlMs, now, onAdd, onRemove })` with `ensure(symbols)`, `touch(symbol)`, `expire()`, `list()`.

- [ ] **Step 1: Write failing tests** proving core symbols cannot expire, dynamic candidate add/refresh/expiry works at 20 minutes, duplicate ensure is idempotent, invalid symbols are rejected, and the 12-symbol cap rejects overflow without evicting core symbols.
- [ ] **Step 2: Run** `node --test test/watchlist.test.js`; expect FAIL.
- [ ] **Step 3: Implement watchlist lifecycle** with callbacks for adapters to subscribe/unsubscribe.
- [ ] **Step 4: Run** test; expect PASS.
- [ ] **Step 5: Commit** `feat: add bounded dynamic microstructure watchlist`.

### Task 6: Binance public-feed adapter with deterministic book rebuild

**Files:**
- Create: `entry-microstructure-feed/binance-feed.js`
- Test: `entry-microstructure-feed/test/binance-feed.test.js`

**Interfaces:**
- Consumes: Task 2 normalizers and Task 3 order books.
- Produces: `createBinanceFeed({ WebSocketImpl, fetchImpl, clock, logger, onTrade, onBookState, onLiquidation, onStatus })` with `start()`, `stop()`, `ensureSymbol(symbol)`, `removeSymbol(symbol)`, `status()`.
- Must manage independent Spot and USD-M connections/books.

- [ ] **Step 1: Write failing fake-socket tests** for subscribe/unsubscribe, parsing spot/perp aggTrades, and forwarding normalized events.
- [ ] **Step 2: Write failing snapshot+delta replay test** that buffers depth deltas while REST snapshot loads, applies only valid update-ID range, and reaches healthy book.
- [ ] **Step 3: Add Review Focus gap test**: skipped update ID invalidates the book, emits `WARMING_UP`, rebuilds from a new REST snapshot, then returns healthy only after valid deltas.
- [ ] **Step 4: Write reconnect test** for exponential backoff with injected clock/timer and deterministic resubscription after reconnect.
- [ ] **Step 5: Run** `node --test test/binance-feed.test.js`; expect FAIL.
- [ ] **Step 6: Implement Binance adapter** using only public Spot/USD-M endpoints and `ws`.
- [ ] **Step 7: Run** test; expect PASS.
- [ ] **Step 8: Commit** `feat: stream Binance event-level microstructure`.

### Task 7: Bybit public-feed adapter with snapshot/delta recovery

**Files:**
- Create: `entry-microstructure-feed/bybit-feed.js`
- Test: `entry-microstructure-feed/test/bybit-feed.test.js`

**Interfaces:**
- Consumes: Task 2 normalizers and Task 3 order books.
- Produces: `createBybitFeed({ WebSocketImpl, clock, logger, onTrade, onBookState, onLiquidation, onStatus })` with the same lifecycle methods as Task 6 for Spot and Linear public streams.

- [ ] **Step 1: Write failing fake-socket tests** for publicTrade, orderbook snapshot, orderbook delta, and allLiquidation messages.
- [ ] **Step 2: Write failing update/restart test** proving a new Bybit snapshot resets the local book and old deltas are not carried through.
- [ ] **Step 3: Add Review Focus stale/reconnect test** proving stale connection/book returns to `WARMING_UP` and no book-derived feature is treated healthy during recovery.
- [ ] **Step 4: Run** `node --test test/bybit-feed.test.js`; expect FAIL.
- [ ] **Step 5: Implement public Spot/Linear adapters** with heartbeat and reconnect/resubscribe behavior.
- [ ] **Step 6: Run** test; expect PASS.
- [ ] **Step 7: Commit** `feat: stream Bybit event-level microstructure`.

### Task 8: Collector orchestration and runtime-state snapshots

**Files:**
- Create: `entry-microstructure-feed/collector.js`
- Test: `entry-microstructure-feed/test/collector.test.js`

**Interfaces:**
- Consumes: watchlist, ring buffers, adapters, order books, features.
- Produces: `createCollector({ binanceFeed, bybitFeed, watchlist, clock, logger })` with `start()`, `stop()`, `ensureSymbols(symbols)`, `getStatus()`, `getWatchlist()`, `getSnapshot(symbol)`, `getSummary(symbol)`.
- `getSnapshot(symbol)` returns runtime, freshness, coverage, per-window features, leader, causal summary, strongest contradiction, and missing coverage list.

- [ ] **Step 1: Write failing orchestration test** where BTC receives healthy trades/books from all expected families, accumulates >=60s warm history, and reaches `FULL_EVENT_STREAM`.
- [ ] **Step 2: Write failing state tests** for `WARMING_UP` before windows are warm, `PARTIAL` when one venue family is stale/unsupported, and `UNAVAILABLE` when no trustworthy event source exists.
- [ ] **Step 3: Add Review Focus unsupported-market test** proving missing spot/perp coverage is listed and never synthesized.
- [ ] **Step 4: Write failing dynamic-symbol test** where `ensureSymbols(['STXUSDT'])` starts subscriptions, reports warm-up, and expiry removes them.
- [ ] **Step 5: Run** `node --test test/collector.test.js`; expect FAIL.
- [ ] **Step 6: Implement collector orchestration** and exact runtime-state rules. Require valid event-stream history for `FULL_EVENT_STREAM`; snapshots alone never qualify.
- [ ] **Step 7: Run** test; expect PASS.
- [ ] **Step 8: Commit** `feat: orchestrate full event stream snapshots`.

### Task 9: Bearer-protected HTTP + read-only MCP API

**Files:**
- Create: `entry-microstructure-feed/server.js`
- Test: `entry-microstructure-feed/test/server.test.js`

**Interfaces:**
- Consumes: collector from Task 8.
- Produces HTTP routes: `GET /healthz`, `GET /v1/status`, `GET /v1/watchlist`, `POST /v1/watchlist/ensure`, `GET /v1/microstructure/:symbol`, `POST /mcp`.
- Produces MCP tools exactly: `get_stream_status`, `ensure_symbols`, `get_microstructure_snapshot`, `get_microstructure_summary`, all annotated read-only/non-destructive; `ensure_symbols` only changes in-memory public-data subscriptions.

- [ ] **Step 1: Write failing auth tests** proving `/healthz` works without token, protected endpoints reject absent/wrong token, valid token works, and no response echoes the token.
- [ ] **Step 2: Write failing REST contract tests** for status/watchlist/ensure/microstructure, malformed JSON, oversized bodies, invalid symbol, and 12-symbol-cap errors.
- [ ] **Step 3: Write failing MCP tests** for initialize/discover/tools/list/tools/call and exact four-tool list with read-only annotations.
- [ ] **Step 4: Add Review Focus error-leak test** with an upstream error containing the bearer token string; response/log sanitization must redact it.
- [ ] **Step 5: Run** `node --test test/server.test.js`; expect FAIL.
- [ ] **Step 6: Implement server** following existing `bybit-demo-execution-cloud/server.js` MCP protocol/auth/body/rate-limit patterns, replacing trade service dispatch with collector reads only.
- [ ] **Step 7: Run** test; expect PASS.
- [ ] **Step 8: Commit** `feat: expose read-only microstructure MCP API`.

### Task 10: Process wiring, health, observability, graceful shutdown

**Files:**
- Modify: `entry-microstructure-feed/server.js`
- Create: `entry-microstructure-feed/logger.js`
- Test: `entry-microstructure-feed/test/deployment.test.js`

**Interfaces:**
- Produces executable startup path used by `npm start` and Render.
- `/healthz` reports uptime, exchange-family states, active-symbol count, runtime-state counts, and last-event ages without auth/secrets.

- [ ] **Step 1: Write failing deployment tests** for binding to `0.0.0.0:$PORT`, missing `MICROSTRUCTURE_FEED_TOKEN` causing protected API to remain unavailable while `/healthz` stays available, and SIGTERM calling collector stop/closing sockets.
- [ ] **Step 2: Write failing logging test** that connect/reconnect/book-gap/state-transition messages are structured while raw trades/book deltas are not emitted.
- [ ] **Step 3: Run** `node --test test/deployment.test.js`; expect FAIL.
- [ ] **Step 4: Implement startup/logger/shutdown behavior** with low-cadence health/memory logging and secret redaction.
- [ ] **Step 5: Run** test; expect PASS.
- [ ] **Step 6: Run full suite** `npm test && npm run check`; expect all PASS and syntax checks clean.
- [ ] **Step 7: Commit** `feat: harden microstructure feed runtime`.

### Task 11: Live public-stream smoke test

**Files:**
- Create: `entry-microstructure-feed/scripts/smoke.js`
- Modify: `entry-microstructure-feed/package.json`
- Modify: `entry-microstructure-feed/README.md`

**Interfaces:**
- Smoke script starts collector without account secrets, observes BTC/ETH/SOL public streams, and prints only compact status/feature summaries.

- [ ] **Step 1: Add `npm run smoke`** and a script with a bounded runtime suitable for manual verification.
- [ ] **Step 2: Run** `npm run smoke`; expect Binance + Bybit public connections, BTC/ETH/SOL activity, no account credential prompt, and runtime progression away from `UNAVAILABLE`.
- [ ] **Step 3: Force one adapter reconnect** during smoke test and verify it returns through `WARMING_UP` after rebuild rather than staying falsely healthy.
- [ ] **Step 4: Update README** with observed startup/warm-up behavior and distinction between `FULL_EVENT_STREAM` vs pipeline `SNAPSHOT PROXY` fallback.
- [ ] **Step 5: Run** `npm test && npm run check`; expect PASS.
- [ ] **Step 6: Commit** `test: verify live public microstructure streams`.

### Task 12: Render deployment and remote verification

**Files:**
- Modify: `entry-microstructure-feed/README.md` only if deployment details differ from spec.

**Interfaces:**
- Produces Render service `entry-microstructure-feed` in confirmed workspace `tea-dar9787f3r2c73bjs4cg`.

- [ ] **Step 1: Push implementation commits to `origin/main`** and verify working tree clean.
- [ ] **Step 2: Generate a random high-entropy `MICROSTRUCTURE_FEED_TOKEN` locally**; store it only in Render environment, never commit or print it in user-facing output.
- [ ] **Step 3: Create Render Web Service**: repo `https://github.com/Doskater/Doskater`, branch `main`, region `frankfurt`, Node runtime, paid Starter or equivalent, auto-deploy `yes`, build `cd entry-microstructure-feed && npm install --omit=dev && npm run check`, start `cd entry-microstructure-feed && npm start`.
- [ ] **Step 4: Set `MICROSTRUCTURE_FEED_TOKEN`** through Render environment tooling and never place it in source/logs.
- [ ] **Step 5: Verify deploy events and `/healthz`** until service is available; inspect Render events/metrics on failure rather than guessing.
- [ ] **Step 6: Verify protected REST endpoint with bearer token** and ensure missing/wrong token returns 401.
- [ ] **Step 7: Verify BTC/ETH/SOL status remotely**; require healthy public streams, valid books, warm rolling windows, and `FULL_EVENT_STREAM` only when all configured conditions are actually met.
- [ ] **Step 8: Run source/security check** proving no account/private/order/withdrawal/transfer routes or exchange credentials exist.
- [ ] **Step 9: Commit any deployment-doc corrections** and push.

### Task 13: Trading Pipeline integration contract

**Files:**
- Modify: `docs/superpowers/specs/2026-10-12-entry-microstructure-feed-design.md` only if implementation contract changed.
- Update external Google Doc Trading Pipeline v2.9 after service verification, not before.

**Interfaces:**
- ChatGPT pipeline uses feed only near candidate entry zones; ordinary Binance/Bybit plugin data remains unchanged.

- [ ] **Step 1: Verify final API/MCP response schema against v2.9 Entry Intelligence fields**: runtime, freshness, coverage, Liquidity Reflex/refill, Void, Impact, Liquidation Response, Leader/lead-lag, causal summary, strongest contradiction.
- [ ] **Step 2: Perform one read-only BTC pipeline probe** combining normal plugin market context with the deployed feed; do not place any demo order.
- [ ] **Step 3: Confirm fallback behavior**: if feed is `PARTIAL`/`UNAVAILABLE`, pipeline labels `SNAPSHOT PROXY` and does not pretend event-level features exist.
- [ ] **Step 4: Update the Google Doc architecture from “collector planned” to “deployed FULL EVENT STREAM source” only after all production verification passes.**
- [ ] **Step 5: Final verification**: repo clean, tests green, Render healthy, service read-only, no trading secret/code path, and documented endpoint/plugin contract matches deployed behavior.
- [ ] **Step 6: Commit** any final docs changes as `docs: finalize microstructure feed integration`.
