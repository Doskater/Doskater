# ChatGPT Cloud Trading Analyst Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a source-controlled read-only cloud market-data plane that lets ChatGPT scan the full liquid Bybit USDT-perpetual universe, perform all trading calculations itself, and return a trading decision without any automatic execution.

**Architecture:** Add a new Node.js `trading-data-plane/` service beside the existing demo-execution and microstructure code. It exposes bulk read-only MCP tools, consistent analysis snapshots, neutral market/derivatives/cross-venue/microstructure data, and the fixed Trading Analyst Protocol as MCP server instructions. The existing public ChatGPT proxy is migrated to this service, while `bybit-demo-execution-cloud/` remains isolated and unchanged.

**Tech Stack:** Node.js >=20, built-in `node:test`, public Bybit V5 REST/WebSocket APIs, public Binance REST/WebSocket APIs, existing `ws` dependency patterns, MCP JSON-RPC over HTTP, Render Frankfurt.

**Spec:** `docs/superpowers/specs/2026-10-14-chatgpt-cloud-trading-analyst-design.md`

## Global Constraints

- Analysis/data service is strictly read-only; no order placement, amend, cancel, close, leverage, transfer, withdrawal, or deposit tools.
- Primary tradable universe is Bybit linear USDT perpetuals.
- Binance is reference/confirmation only where corresponding spot/perpetual markets exist.
- ChatGPT performs trading calculations, scoring, interpretation, opportunity ranking, and final decision.
- Data Plane may only collect, cache, align, normalize, bucket, chunk, and return neutral mathematical transforms.
- Allowed final ChatGPT outcomes: `LONG`, `SHORT`, `PAIR`, `CARRY`, `WAIT`, `NO TRADE`.
- No analysis result may automatically invoke Bybit Demo Execution.
- Public cloud MCP access must require a bearer secret; secrets are never returned or logged.
- Keep Node runtime at `>=20`.
- Modern MCP `2026-07-28` must be supported through `server/discover`; legacy `2025-11-25` compatibility remains through `initialize`.
- Publish the Trading Analyst Protocol as MCP server instructions in both protocol eras.
- Snapshot TTL: 15 minutes. Expired snapshots fail explicitly; never silently mix analysis cutoffs.
- Neutral microstructure bucket resolutions: 1s, 5s, 30s, 60s.
- Finalist microstructure request limit: 10 symbols; underlying existing feed may retain its current 12-symbol capacity.
- Missing Binance or microstructure data degrades evidence but does not fabricate or silently replace data.
- Preserve `bybit-demo-execution-cloud/` as a separate service and do not place demo credentials in the Data Plane.
- Do not implement live-money trading.
- Do not implement options/volatility-surface strategies in v1.
- Do not implement server-side trade ranking or recommendation logic.

### Execution baseline preflight

Before Task 1, reconcile the actual working branch. The GitHub `main` inspected while writing this plan is at commit `c206bfc` and does **not** contain the previously reported local commit `a4d7b3b`. Do not build on a stale GitHub checkout if the Mac has a newer directional-pipeline branch. In the execution worktree, run `git status --short` and `git log --oneline -20`; base the worktree on the newest verified branch containing the current directional work, or explicitly merge/rebase that work before implementation.

## Review Focus

1. **Expired/stale snapshot during a multi-tool analysis:** return an explicit snapshot error; never continue against current-time data under the old snapshot ID. Covered in Task 2.
2. **Bybit has more than one instruments-info page / symbol exists only on Bybit:** paginate fully and keep the symbol with Binance availability flags false rather than dropping it. Covered in Task 3.
3. **Large history request crosses exchange page limits or rate limits:** page deterministically, preserve cutoff, retry boundedly, and resume via cursor without duplicate rows. Covered in Tasks 4 and 5.
4. **Order-book/WebSocket sequence gap or reconnect:** mark derived microstructure unavailable until a clean rebuild; never expose stale neutral buckets as healthy. Covered in Task 7.
5. **Recommendation leakage from Data Plane:** schemas and runtime payloads must reject prohibited fields such as `signal`, `trade_score`, `long_probability`, `best_trade`, `entry`, `stop`, and `target`. Covered in Tasks 1 and 8.

---

## Target File Structure

```text
trading-data-plane/
  package.json
  config.js
  analyst-protocol.js
  tool-definitions.js
  schema-guard.js
  snapshot-store.js
  source-health.js
  cursors.js
  server.js
  app.js

  upstream/
    bybit-rest.js
    binance-rest.js
    retry.js

  services/
    snapshot-service.js
    universe-service.js
    market-history-service.js
    derivatives-service.js
    cross-market-service.js
    microstructure-service.js

  test/
    server.test.js
    schema-guard.test.js
    snapshot-store.test.js
    source-health.test.js
    bybit-rest.test.js
    binance-rest.test.js
    universe-service.test.js
    market-history-service.test.js
    derivatives-service.test.js
    cross-market-service.test.js
    microstructure-service.test.js
    end-to-end.test.js

  scripts/
    smoke.js

  README.md

entry-microstructure-feed/
  collector.js                  # add neutral bucket export, preserve existing API
  test/collector.test.js        # add neutral bucket/sequence tests

public-proxy.js                 # migrate allowlist/upstream behavior/instructions
package.json                    # add proxy tests/check script if needed
test/
  public-proxy.test.js          # new proxy contract tests
```

---

### Task 1: Scaffold the Data Plane MCP Boundary and Analyst Instructions

**Files:**
- Create: `trading-data-plane/package.json`
- Create: `trading-data-plane/config.js`
- Create: `trading-data-plane/analyst-protocol.js`
- Create: `trading-data-plane/tool-definitions.js`
- Create: `trading-data-plane/schema-guard.js`
- Create: `trading-data-plane/server.js`
- Test: `trading-data-plane/test/server.test.js`
- Test: `trading-data-plane/test/schema-guard.test.js`

**Interfaces:**
- Produces: `ANALYST_PROTOCOL: string`
- Produces: `TOOL_DEFINITIONS: Array<McpToolDefinition>`
- Produces: `assertNeutralPayload(value: unknown): void`
- Produces: `createHttpServer({ env, toolHandlers, logger, clock }) -> http.Server`
- Consumes later: tool handler object keyed by `source_health`, `prepare_snapshot`, `market_universe`, `historical_market_data`, `historical_derivatives_data`, `cross_market_data`, `microstructure_data`

- [ ] **Step 1: Write failing MCP discovery and read-only contract tests**

In `test/server.test.js`, add tests that assert:
- `server/discover` advertises `2026-07-28`, `instructions === ANALYST_PROTOCOL`, and tools capability.
- legacy `initialize` returns `2025-11-25`-compatible server info plus the same instructions.
- `tools/list` exposes exactly the seven v1 data tools.
- every tool has `readOnlyHint: true` and `destructiveHint: false`.
- unauthenticated public `/mcp` returns 503 if `DATA_PLANE_TOKEN` is absent and 401 for a wrong bearer token.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:
```bash
cd trading-data-plane
node --test test/server.test.js test/schema-guard.test.js
```

Expected: FAIL because service files do not exist.

- [ ] **Step 3: Implement the MCP shell and protocol text**

Create:
```js
export const ANALYST_PROTOCOL = `...`;
export const TOOL_DEFINITIONS = [...];
export function createHttpServer({ env = process.env, toolHandlers, logger, clock = Date }) {}
```

`ANALYST_PROTOCOL` must encode the agreed mandatory sequence:

`VALIDATE DATA -> BUILD UNIVERSE -> CALCULATE MARKET MATRIX -> MARKET CONTEXT -> PARALLEL ALPHA SEARCH -> DEEP ANALYSIS -> MICROSTRUCTURE -> CHALLENGE THESIS -> COSTS -> RISK -> COMPARE -> DECIDE`

and explicitly state:
- ChatGPT computes and interprets the data itself.
- all strategy families must be considered before choosing a best trade;
- `WAIT` and `NO TRADE` are valid;
- no execution occurs without a separate explicit user command.

- [ ] **Step 4: Add the recommendation-leak guard**

Implement:
```js
export function assertNeutralPayload(value) {}
```

Recursively reject object keys matching the v1 prohibited set:

`signal`, `tradeSignal`, `trade_score`, `tradeScore`, `long_probability`, `short_probability`, `best_trade`, `bestTrade`, `recommendation`, `entry`, `stop`, `stopLoss`, `target`, `takeProfit`.

The guard runs on every successful tool result before the MCP response is sent.

- [ ] **Step 5: Run tests and static checks**

Run:
```bash
npm test
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add trading-data-plane
git commit -m "feat: scaffold read-only trading data plane"
```

---

### Task 2: Add Snapshot Consistency and Source-Health State

**Files:**
- Create: `trading-data-plane/snapshot-store.js`
- Create: `trading-data-plane/source-health.js`
- Create: `trading-data-plane/services/snapshot-service.js`
- Test: `trading-data-plane/test/snapshot-store.test.js`
- Test: `trading-data-plane/test/source-health.test.js`
- Modify: `trading-data-plane/app.js` or create it in this task

**Interfaces:**
- Produces: `createSnapshotStore({ ttlMs = 900_000, clock = Date })`
- Store methods: `create(payload)`, `get(id)`, `require(id)`, `purge()`
- Produces: `createSourceHealth({ clock = Date })`
- Health methods: `record(source, sample)`, `snapshot()`
- Produces: `createSnapshotService({ snapshotStore, sourceHealth, captureUniverse, clock })`
- Service methods: `sourceHealth()`, `prepareSnapshot()`

- [ ] **Step 1: Write failing snapshot tests**

Assert:
- snapshot IDs are unique and immutable;
- `dataCutoff` is fixed at creation;
- `require(id)` throws `snapshot_expired` after 900,000 ms;
- a missing ID throws `snapshot_not_found`;
- mutating returned objects cannot mutate stored snapshot state.

Add Review Focus test: begin with a valid snapshot, advance fake clock beyond TTL, and assert later access fails rather than returning current data.

- [ ] **Step 2: Write failing health tests**

Assert technical states only:
- fresh success -> `GOOD`;
- stale timestamp -> `DEGRADED`;
- explicit failure/no usable sample -> `UNAVAILABLE`;
- output contains timestamps/reason but no prohibited trading keys.

- [ ] **Step 3: Run focused tests**

Run:
```bash
node --test test/snapshot-store.test.js test/source-health.test.js
```

Expected: FAIL.

- [ ] **Step 4: Implement stores and snapshot service**

`prepareSnapshot()` must call injected `captureUniverse(dataCutoff)` once, store the captured rows inside the snapshot, and return compact metadata:
```js
{
  snapshotId,
  createdAt,
  dataCutoff,
  universeCount,
  sourceHealth,
  expiresAt
}
```

- [ ] **Step 5: Wire `source_health` and `prepare_snapshot` handlers into `app.js`**

Create:
```js
export function createApp({ bybit, binance, microstructure, env, clock, logger }) {}
```

Return `{ server, services, start, stop }` with injectable dependencies for tests.

- [ ] **Step 6: Verify**

Run:
```bash
npm test
npm run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add trading-data-plane
git commit -m "feat: add consistent market analysis snapshots"
```

---

### Task 3: Implement Public Exchange Clients and Full Bybit Universe Capture

**Files:**
- Create: `trading-data-plane/upstream/retry.js`
- Create: `trading-data-plane/upstream/bybit-rest.js`
- Create: `trading-data-plane/upstream/binance-rest.js`
- Create: `trading-data-plane/services/universe-service.js`
- Create: `trading-data-plane/cursors.js`
- Test: `trading-data-plane/test/bybit-rest.test.js`
- Test: `trading-data-plane/test/binance-rest.test.js`
- Test: `trading-data-plane/test/universe-service.test.js`
- Modify: `trading-data-plane/services/snapshot-service.js`
- Modify: `trading-data-plane/app.js`

**Interfaces:**
- Produces: `createBybitRestClient({ fetchImpl = fetch, baseUrl = 'https://api.bybit.com', retry, health })`
- Bybit methods: `listLinearInstruments()`, `listSpotInstruments()`, `getLinearTickers()`, `getSpotTickers()`
- Produces: `createBinanceRestClient({ fetchImpl = fetch, spotBaseUrl, futuresBaseUrl, retry, health })`
- Binance methods: `getSpotExchangeInfo()`, `getFuturesExchangeInfo()`, `getSpotBookTickers()`, `getFuturesBookTickers()`
- Produces: `createUniverseService({ bybit, binance, snapshotStore })`
- Universe methods: `capture(dataCutoff)`, `getUniverse({ snapshotId, cursor, limit })`
- Produces: opaque cursor helpers `encodeCursor(value)` / `decodeCursor(value)`

- [ ] **Step 1: Write failing Bybit pagination tests**

Fixture two `/v5/market/instruments-info?category=linear` pages and assert `listLinearInstruments()` follows `nextPageCursor` until exhausted.

Also assert only `status === 'Trading'`, `quoteCoin === 'USDT'`, `settleCoin === 'USDT'`, and perpetual/linear contracts enter the tradable universe.

- [ ] **Step 2: Write failing Binance availability tests**

Given Binance fixtures, assert the normalized availability sets independently track:
- Binance spot symbol availability;
- Binance USD-M perpetual availability.

A Bybit-only symbol must remain valid with both flags false.

- [ ] **Step 3: Write failing universe snapshot tests**

Assert each row contains:
`symbol`, `launchTime`, `lastPrice`, `turnover24h`, `volume24h`, `bid1Price`, `bid1Size`, `ask1Price`, `ask1Size`, `markPrice`, `indexPrice`, `openInterest`, `fundingRate`, `nextFundingTime`, `bybitSpot`, `binanceSpot`, `binancePerp`.

Add Review Focus case: 1,001+ Bybit instruments across pages are all captured without truncation.

- [ ] **Step 4: Implement bounded retry**

Create:
```js
export async function withRetry(fn, {
  retries = 3,
  baseDelayMs = 250,
  maxDelayMs = 2000,
  clock = globalThis
} = {}) {}
```

Retry only transient network errors, HTTP 429, and HTTP 5xx. Honor `Retry-After` when present. Do not retry invalid 4xx requests.

- [ ] **Step 5: Implement clients and universe service**

Use Bybit V5 public market endpoints and Binance public exchange-info/book-ticker endpoints. Normalize all numeric fields to finite numbers or `null`; never silently coerce malformed values to zero.

Each REST client request records technical health through the injected registry:
- `bybit_rest`;
- `binance_spot_rest`;
- `binance_futures_rest`.

Record success timestamp/latency on usable responses and failure reason on exhausted retries. Do not put market interpretation into health state.

- [ ] **Step 6: Wire `market_universe` and snapshot capture**

`prepare_snapshot` must use `universeService.capture(dataCutoff)` and store the complete normalized universe in the immutable snapshot. `market_universe` pages only over those stored rows; it must not refetch live tickers under an existing snapshot ID.

- [ ] **Step 7: Verify**

Run:
```bash
node --test test/bybit-rest.test.js test/binance-rest.test.js test/universe-service.test.js
npm test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add trading-data-plane
git commit -m "feat: capture full Bybit perpetual universe"
```

---

### Task 4: Add Bulk Historical Market Data with Deterministic Chunking

**Files:**
- Create: `trading-data-plane/services/market-history-service.js`
- Test: `trading-data-plane/test/market-history-service.test.js`
- Modify: `trading-data-plane/upstream/bybit-rest.js`
- Modify: `trading-data-plane/tool-definitions.js`
- Modify: `trading-data-plane/app.js`

**Interfaces:**
- Add Bybit method:
```js
getKlines({ category = 'linear', symbol, interval, startMs, endMs, limit = 1000 })
```
- Produces:
```js
createMarketHistoryService({ bybit, snapshotStore })
```
- Service method:
```js
getHistoricalMarketData({
  snapshotId,
  symbols,
  timeframe,
  startMs,
  endMs,
  fields,
  cursor,
  maxRows = 20_000
})
```

- [ ] **Step 1: Write failing cutoff and ordering tests**

Assert:
- requested `endMs` is capped at snapshot `dataCutoff`;
- returned rows are ascending by timestamp even though Bybit returns reverse chronological candles;
- duplicate boundary candles are removed across pages;
- only requested neutral fields are returned.

- [ ] **Step 2: Write failing large-request cursor test**

Fixture more than 20,000 normalized rows across multiple symbols and Bybit pages. Assert:
- first response contains <=20,000 rows;
- returns `nextCursor`;
- resuming with that cursor produces the remaining rows with no gaps/duplicates;
- all chunks retain the original snapshot ID and cutoff.

- [ ] **Step 3: Write failing transient-rate-limit test**

Simulate 429 on an intermediate Bybit page, then success. Assert bounded retry resumes the same symbol/page and output remains deterministic.

- [ ] **Step 4: Implement history paging**

Support Bybit intervals needed for v1:
`1`, `5`, `15`, `60`, `240`, `D`.

Reject unsupported timeframes with `invalid_timeframe`.

- [ ] **Step 5: Wire `historical_market_data` handler**

Tool input limits:
- `symbols`: 1–50 unique symbols per call;
- `maxRows`: 1–20,000;
- fields restricted to `timestamp/open/high/low/close/volume/turnover`.

The ChatGPT protocol may make multiple tool calls within one user request; the user is never asked to say “continue”.

- [ ] **Step 6: Verify and commit**

Run:
```bash
node --test test/market-history-service.test.js
npm test
npm run check
```

Then:
```bash
git add trading-data-plane
git commit -m "feat: add bulk snapshot-consistent market history"
```

---

### Task 5: Add Historical Derivatives Data and Explicit Coverage Metadata

**Files:**
- Create: `trading-data-plane/services/derivatives-service.js`
- Test: `trading-data-plane/test/derivatives-service.test.js`
- Modify: `trading-data-plane/upstream/bybit-rest.js`
- Modify: `trading-data-plane/tool-definitions.js`
- Modify: `trading-data-plane/app.js`

**Interfaces:**
- Add Bybit methods:
  - `getOpenInterest({ symbol, intervalTime, startMs, endMs, cursor, limit })`
  - `getFundingHistory({ symbol, startMs, endMs, cursor, limit })`
  - `getMarkPriceKlines({ symbol, interval, startMs, endMs, limit })`
  - `getIndexPriceKlines({ symbol, interval, startMs, endMs, limit })`
- Produces:
```js
createDerivativesService({ bybit, snapshotStore, liquidationProvider })
```
- Service method:
```js
getHistoricalDerivativesData({
  snapshotId,
  symbols,
  resolution,
  startMs,
  endMs,
  fields,
  cursor,
  maxRows = 20_000
})
```

- [ ] **Step 1: Write failing normalization/alignment tests**

Assert output can contain neutral series for:
`openInterest`, `fundingRate`, `markPrice`, `indexPrice`, `basisBps`, `liquidationBuyNotional`, `liquidationSellNotional`.

`basisBps` may be computed as a neutral mathematical transform:
`(markPrice - indexPrice) / indexPrice * 10_000`.

- [ ] **Step 2: Write failing partial-coverage test**

When long-history liquidation data is unavailable, assert the response includes:
```js
coverage: {
  liquidations: { state: 'PARTIAL'|'UNAVAILABLE', startMs, endMs, reason }
}
```
rather than zero-filled fabricated liquidation rows.

- [ ] **Step 3: Write failing OI cursor/rate-limit test**

Cover Bybit's paginated open-interest responses and a transient 429. Assert deterministic resume and snapshot cutoff.

- [ ] **Step 4: Implement derivatives service**

Supported resolutions:
`5m`, `15m`, `30m`, `1h`, `4h`, `1d`.

Keep each field's provenance and coverage metadata in the response.

- [ ] **Step 5: Wire `historical_derivatives_data`**

Input limit: 1–50 symbols, max 20,000 rows per response.

- [ ] **Step 6: Verify and commit**

Run:
```bash
node --test test/derivatives-service.test.js
npm test
npm run check
```

Then:
```bash
git add trading-data-plane
git commit -m "feat: add neutral derivatives history"
```

---

### Task 6: Add Cross-Market Bybit/Binance Data

**Files:**
- Create: `trading-data-plane/services/cross-market-service.js`
- Test: `trading-data-plane/test/cross-market-service.test.js`
- Modify: `trading-data-plane/upstream/bybit-rest.js`
- Modify: `trading-data-plane/upstream/binance-rest.js`
- Modify: `trading-data-plane/tool-definitions.js`
- Modify: `trading-data-plane/app.js`

**Interfaces:**
- Add neutral quote/kline methods for Bybit spot + linear and Binance spot + USD-M futures.
- Produces:
```js
createCrossMarketService({ bybit, binance, snapshotStore })
```
- Service method:
```js
getCrossMarketData({
  snapshotId,
  symbols,
  mode,
  timeframe,
  startMs,
  endMs,
  cursor,
  maxRows = 20_000
})
```
- `mode`: `snapshot` or `history`

- [ ] **Step 1: Write failing symbol-availability tests**

For each requested Bybit perp symbol:
- include each available venue/market independently;
- unavailable markets return explicit availability/coverage metadata;
- never drop the Bybit perp because Binance spot/perp is absent.

- [ ] **Step 2: Write failing synchronized-cutoff test**

Assert all returned history is capped to the same snapshot `dataCutoff`.

For `mode: 'snapshot'`, assert quotes come from bulk reference quotes captured during `prepare_snapshot`, not from a later live refetch. Extend snapshot capture to store:
- Bybit linear ticker quotes;
- Bybit spot ticker quotes where present;
- Binance spot book tickers;
- Binance USD-M futures book tickers.

This prevents mixed-time cross-venue comparisons.

- [ ] **Step 3: Write failing basis-input test**

Assert service returns raw prices/quotes sufficient for ChatGPT to compute:
- Bybit spot/perp basis;
- Binance spot/perp basis;
- Bybit/Binance divergence.

Do **not** return `arbitrage`, `carryScore`, `buyVenue`, or `sellVenue`.

- [ ] **Step 4: Implement and wire `cross_market_data`**

Extend `snapshot-service`/`universe-service` capture so the snapshot owns the bulk cross-market quote maps described above. `mode: 'snapshot'` reads only those stored maps; `mode: 'history'` uses exchange history endpoints capped at the snapshot cutoff.

Keep schemas columnar/compact where practical but transparent: timestamps plus named numeric series, no opaque proprietary scores.

- [ ] **Step 5: Verify and commit**

Run:
```bash
node --test test/cross-market-service.test.js
npm test
```

Then:
```bash
git add trading-data-plane
git commit -m "feat: add cross-market reference data"
```

---

### Task 7: Reuse the Existing Event Feed for Neutral Microstructure Buckets

**Files:**
- Modify: `entry-microstructure-feed/collector.js`
- Modify: `entry-microstructure-feed/test/collector.test.js`
- Create: `trading-data-plane/services/microstructure-service.js`
- Test: `trading-data-plane/test/microstructure-service.test.js`
- Modify: `trading-data-plane/tool-definitions.js`
- Modify: `trading-data-plane/app.js`

**Interfaces:**
- Add backward-compatible collector method:
```js
getNeutralBuckets(symbol, {
  bucketMs = 1000,
  lookbackMs = 60_000
}) -> NeutralMicrostructureSnapshot
```
- Produces:
```js
createMicrostructureService({ collector, snapshotStore, clock })
```
- Service method:
```js
getMicrostructureData({
  snapshotId,
  symbols,
  bucketMs,
  lookbackMs
})
```

- [ ] **Step 1: Write failing neutral-bucket collector tests**

For one healthy symbol, assert each bucket contains only neutral fields:
- `timestamp`;
- `open/high/low/close` or mid-price equivalents;
- aggressive buy/sell quantity and notional;
- best bid/ask/spread;
- bid/ask depth;
- liquidation buy/sell notional;
- family/venue/market provenance.

Explicitly assert the response does not contain existing derived fields such as `causalSummary`, `strongestContradiction`, `impactAsymmetry`, `refill`, or `void`.

- [ ] **Step 2: Write Review Focus sequence-gap test**

Drive the collector through healthy -> sequence gap/unhealthy -> rebuild.
Assert:
- neutral buckets for the affected family become unavailable immediately after the gap;
- coverage reports the gap/unhealthy state;
- healthy status returns only after a clean book rebuild/warmup.

- [ ] **Step 3: Implement `getNeutralBuckets` without breaking current methods**

Preserve existing:
`getSnapshot`, `getSummary`, `getStatus`, `ensureSymbols`.

Reuse existing ring buffers; do not add a second raw event store.

- [ ] **Step 4: Write and implement Data Plane microstructure service**

Rules:
- 1–10 requested symbols;
- `bucketMs` enum: `1000`, `5000`, `30000`, `60000`;
- `lookbackMs` max: `120000`;
- ensure candidate subscriptions via existing collector;
- return runtime/coverage/freshness for every symbol;
- no server-side interpretation.

`createApp()` production wiring must instantiate the existing public Binance/Bybit WebSocket feeds, watchlist, and collector inside the cloud process when no collector is injected. Start/stop that collector with the Data Plane lifecycle. Feed/connect/rebuild state records technical health under `microstructure_binance` and `microstructure_bybit`. The cloud service must not call `local-service.js` or depend on the user's Mac.

- [ ] **Step 5: Verify both packages**

Run:
```bash
cd entry-microstructure-feed
npm test
npm run check

cd ../trading-data-plane
node --test test/microstructure-service.test.js
npm test
```

Expected: existing microstructure tests remain green plus new neutral-bucket tests pass.

- [ ] **Step 6: Commit**

```bash
git add entry-microstructure-feed trading-data-plane
git commit -m "feat: expose neutral microstructure buckets"
```

---

### Task 8: Wire All Tools, Enforce Neutral Schemas, and Migrate the Public Proxy

**Files:**
- Modify: `trading-data-plane/app.js`
- Modify: `trading-data-plane/server.js`
- Modify: `trading-data-plane/tool-definitions.js`
- Test: `trading-data-plane/test/end-to-end.test.js`
- Modify: `public-proxy.js`
- Modify: `package.json`
- Create: `test/public-proxy.test.js`

**Interfaces:**
- Data Plane MCP tool names remain exactly:
  - `source_health`
  - `prepare_snapshot`
  - `market_universe`
  - `historical_market_data`
  - `historical_derivatives_data`
  - `cross_market_data`
  - `microstructure_data`
- Proxy imports `ANALYST_PROTOCOL` from `./trading-data-plane/analyst-protocol.js`.

- [ ] **Step 1: Write failing end-to-end MCP test**

With fixture exchange clients:
1. call `server/discover`;
2. assert Trading Analyst instructions present;
3. call `prepare_snapshot`;
4. call every read-only tool with the snapshot ID;
5. recursively run `assertNeutralPayload` on every result;
6. assert no execution tools are listed.

- [ ] **Step 2: Write failing proxy tests**

Assert modern `server/discover` from `public-proxy.js` returns:
- `supportedVersions: ['2026-07-28']`;
- the same `ANALYST_PROTOCOL`;
- tools capability.

Assert `tools/list` exposes only the seven v1 Data Plane tools.

Assert attempts to call legacy on-chain/old tools or any execution-like tool return `-32602`.

- [ ] **Step 3: Refactor proxy constants for testability**

Export:
```js
export const ALLOWED_TOOLS = new Set([...]);
export function createProxyServer({ upstreamUrl, token, fetchImpl, clock }) {}
```

Keep production `server.listen(...)` behind a direct-execution guard so tests can instantiate without opening a real port.

- [ ] **Step 4: Point proxy to the new Data Plane upstream**

Change default upstream only after the new Render service URL exists; before that, require `UPSTREAM_MCP_URL` explicitly in deployment.

Do not alter `bybit-demo-execution-cloud/`.

- [ ] **Step 5: Add runtime neutral-payload enforcement**

Every Data Plane tool response passes through `assertNeutralPayload` before leaving the server. Add a fixture handler that intentionally returns `{ signal: 'LONG' }` and assert MCP responds with a safe internal schema violation rather than leaking it.

- [ ] **Step 6: Verify**

Run:
```bash
cd trading-data-plane
npm test
npm run check

cd ..
node --test test/public-proxy.test.js
npm run check

cd entry-microstructure-feed
npm test
npm run check

cd ../bybit-demo-execution-cloud
npm test
npm run check
```

Expected: all suites PASS; Demo Execution behavior unchanged.

- [ ] **Step 7: Commit**

```bash
git add trading-data-plane public-proxy.js package.json test
git commit -m "feat: expose cloud market data plane to ChatGPT"
```

---

### Task 9: Add Analyst-Protocol Fixtures, Smoke Test, Documentation, and Render Cutover

**Files:**
- Create: `trading-data-plane/test/fixtures/` fixture JSON files
- Create: `trading-data-plane/scripts/smoke.js`
- Create: `trading-data-plane/README.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-14-chatgpt-cloud-trading-analyst-design.md` only if deployment facts need an implementation note; do not change agreed behavior

**Interfaces:**
- Smoke command: `npm run smoke`
- Health endpoint: `GET /healthz`
- MCP endpoint: `POST /mcp`

- [ ] **Step 1: Add deterministic protocol fixture datasets**

Create fixtures representing:
- strong directional momentum;
- crowded positive funding with weak spot confirmation;
- liquidation cascade continuation;
- liquidation exhaustion;
- cointegrated-pair divergence;
- positive gross funding but negative net carry after costs;
- no valid edge.

Fixtures contain only market facts; expected files describe which required calculations the dataset enables, not a hard-coded LLM trade answer.

- [ ] **Step 2: Add contract sufficiency tests**

For each fixture, assert the seven tools can provide every raw/neutral field required by the relevant Trading Analyst Protocol branch.

Also assert the protocol instructions contain these mandatory stage labels:
`VALIDATE`, `UNIVERSE`, `MOMENTUM`, `DIRECTIONAL`, `STAT ARB`, `CARRY`, `MICROSTRUCTURE`, `CHALLENGE`, `COST`, `RISK`, `DECIDE`.

- [ ] **Step 3: Implement smoke script**

`npm run smoke` must:
1. call `/healthz`;
2. make authenticated `server/discover`;
3. list tools;
4. prepare a snapshot;
5. fetch the first universe page;
6. fetch a small BTC/ETH/SOL market-history sample;
7. fetch derivatives data;
8. request one microstructure finalist if feed is healthy;
9. verify no prohibited recommendation fields.

Exit non-zero on any contract violation.

- [ ] **Step 4: Document deployment and operational boundaries**

README must state:
- Render Frankfurt target;
- public read-only exchange data only;
- required `DATA_PLANE_TOKEN`;
- no Bybit demo credentials in this service;
- snapshot TTL 15 minutes;
- tool limits/pagination;
- microstructure degradation behavior;
- ChatGPT performs trading decisions;
- execution requires a separate explicit Demo Execution command.

- [ ] **Step 5: Full local verification**

Run:
```bash
cd trading-data-plane
npm test
npm run check

cd ../entry-microstructure-feed
npm test
npm run check

cd ../bybit-demo-execution-cloud
npm test
npm run check

cd ..
node --test test/public-proxy.test.js
npm run check
```

Expected: all PASS.

- [ ] **Step 6: Deploy new Data Plane on Render**

Create a new Frankfurt Node web service from `Doskater/Doskater`:
- root directory: repository root;
- build command: `cd trading-data-plane && npm install --omit=dev && npm run check && npm test`;
- start command: `cd trading-data-plane && npm start`;
- authenticated env: `DATA_PLANE_TOKEN=<secret>`;
- auto-deploy: initially off for controlled cutover.

Do not reuse the Demo Execution token.

- [ ] **Step 7: Run production smoke against the new service**

Expected:
- `/healthz` healthy;
- `server/discover` exposes instructions;
- seven tools listed;
- full universe paginates;
- sample history/derivatives requests work;
- microstructure either returns healthy data or explicit degraded state;
- no recommendation fields.

- [ ] **Step 8: Cut public proxy to the new upstream**

Update `trading-data-chatgpt-proxy`:
- `UPSTREAM_MCP_URL=<new-data-plane>/mcp`;
- `UPSTREAM_BEARER_TOKEN=<data-plane token>`.

Deploy proxy. Re-run ChatGPT-facing `server/discover`, `tools/list`, and a small full chain.

Keep the old upstream deployment intact until verification succeeds.

- [ ] **Step 9: End-to-end manual acceptance in ChatGPT**

Issue:
`Проанализируй рынок`.

Acceptance criteria:
- ChatGPT begins with data validation/snapshot;
- scans the Bybit universe rather than a hand-picked coin;
- performs its own calculations/analysis across directional, stat-arb, carry, and derivatives/liquidation branches;
- uses microstructure only on finalists;
- challenges the preferred thesis;
- accounts for costs/risk/current demo exposure when relevant;
- returns `LONG`, `SHORT`, `PAIR`, `CARRY`, `WAIT`, or `NO TRADE`;
- does not place any order.

Then separately issue an explicit Demo Execution command only if desired, confirming analysis and execution remain separate.

- [ ] **Step 10: Commit documentation/deployment metadata**

```bash
git add trading-data-plane README.md docs
git commit -m "docs: complete cloud trading analyst rollout"
```

---

## Final Verification Checklist

- [ ] Working baseline includes the latest local directional-pipeline work before feature implementation begins.
- [ ] All new market-data MCP tools are read-only.
- [ ] Trading Analyst Protocol appears in modern `server/discover` and legacy `initialize`.
- [ ] Full Bybit USDT-perpetual universe is paginated and available.
- [ ] Historical market data is snapshot-consistent and chunkable.
- [ ] OI/funding/mark/index/basis inputs are available with explicit field coverage.
- [ ] Binance absence degrades confirmation but does not drop valid Bybit contracts.
- [ ] Neutral microstructure buckets work for finalists and invalidate on sequence gaps.
- [ ] Runtime schema guard blocks recommendation leakage.
- [ ] Public proxy exposes exactly the intended analysis tools.
- [ ] Bybit Demo Execution tests still pass unchanged.
- [ ] Render production smoke passes.
- [ ] A ChatGPT full-market request completes without Mac mini availability.
- [ ] No analysis request can place an order.
