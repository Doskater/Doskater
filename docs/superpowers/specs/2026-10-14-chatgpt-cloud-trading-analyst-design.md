# ChatGPT Cloud Trading Analyst — Design

Date: 2026-10-14
Status: Approved conversational design, pending written-spec review
Target repository: `Doskater/Doskater`

## 1. Goal

Upgrade the current trading pipeline so a single ChatGPT request such as `проанализируй рынок` causes ChatGPT itself to perform the market-wide calculations, multi-strategy analysis, opportunity comparison, risk evaluation, and final trading decision.

The cloud infrastructure is a read-only market-data plane. It collects, normalizes, caches, aligns, buckets, and serves market data. It must not decide what to trade, rank opportunities, or emit directional trading signals.

ChatGPT is the analytical and computational engine. It follows a fixed Trading Analyst Protocol, uses numerical computation where needed, and returns one of: `LONG`, `SHORT`, `PAIR`, `CARRY`, `WAIT`, or `NO TRADE`.

Trade execution remains separated from analysis. Even when ChatGPT decides `ENTER`, no order is submitted automatically. Bybit Demo Execution is called only after a separate explicit user command such as `ставь`.

## 2. Agreed Constraints

- Primary tradable universe: all liquid Bybit linear USDT perpetual contracts.
- Binance is an independent reference/confirmation source where matching spot or perpetual markets exist.
- Analysis mode is read-only.
- Bybit Demo Execution remains a separate service and keeps all write actions behind explicit user intent.
- Cloud services may perform neutral technical aggregation and compression, but not trading inference.
- ChatGPT must perform the trading calculations and interpretations itself.
- The full liquid universe is scanned automatically; the user does not need to name symbols.
- Use a hybrid data model: lightweight market state is maintained continuously, while deeper data is fetched only for shortlisted candidates.
- The system must support `WAIT` and `NO TRADE` as first-class outcomes.

## 3. Architecture

```text
Bybit public market data       Binance public market data
          |                               |
          +---------------+---------------+
                          |
                          v
                 Cloud Data Plane
                    READ ONLY
                          |
         collect/cache/align/bucket/serve
                          |
                          v
                       ChatGPT
                          |
             Trading Analyst Protocol
                          |
              numerical calculations
                          |
       +------------------+------------------+
       |                  |                  |
       v                  v                  v
  Directional          Stat Arb            Carry
  + Momentum           + Pairs             + Funding
  + MTF                + Spread            + Basis
  + OI/Funding         + Cointegration     + Spot/Perp
  + Liquidations       + Z-score
  + Microstructure     + Half-life
       |                  |                  |
       +------------------+------------------+
                          |
                          v
                 opportunity comparison
                          |
                          v
                    risk + costs
                          |
                          v
         LONG / SHORT / PAIR / CARRY /
              WAIT / NO TRADE
                          |
                   no auto-execution
                          X
                          |
            explicit user execution command
                          |
                          v
               Bybit Demo Execution
```

The current directional pipeline becomes one analytical branch rather than the whole trading system. Existing MTF, scenario, lower-timeframe trigger, watcher, and microstructure concepts are retained as instructions and analytical methods used by ChatGPT.

## 4. Responsibility Boundaries

### 4.1 Cloud Data Plane MAY

The data plane may:

- discover and refresh Bybit linear USDT perpetual instruments;
- collect public Bybit and Binance market data;
- cache candles, quotes, funding, OI, mark/index prices, basis inputs, liquidation data, trades, and order-book data;
- align time series across symbols and venues;
- normalize schemas and timestamps;
- aggregate event streams into neutral 1s/5s/30s/60s buckets;
- expose pagination/chunking for large matrices;
- produce immutable analysis snapshots with a common cutoff timestamp;
- report source freshness, missing data, sequence gaps, and data-quality state;
- compute neutral mathematical transforms needed to reduce payload size, such as returns, rolling standard deviation, VWAP, or depth totals, provided they do not encode a trading recommendation.

### 4.2 Cloud Data Plane MUST NOT

The data plane must not:

- emit `LONG`, `SHORT`, `BUY`, `SELL`, or `NO TRADE` recommendations;
- rank trading opportunities;
- return a proprietary `trade_score`, `long_probability`, `best_trade`, or equivalent recommendation field;
- decide that a market is bullish/bearish as a trading conclusion;
- select an entry, stop, target, or position size;
- trigger Bybit Demo Execution.

### 4.3 ChatGPT MUST

ChatGPT must:

- validate data quality before analysis;
- build and filter the tradable universe itself;
- compute market-wide statistics and rankings;
- independently examine multiple sources of edge;
- perform all trading interpretation itself;
- challenge its own preferred thesis before deciding;
- account for costs and portfolio risk;
- provide a final decision and explain the decisive evidence;
- stop at recommendation unless the user separately requests execution.

## 5. Cloud Tool Contract

Expose a small set of powerful read-only tools rather than many symbol-by-symbol tools.

### 5.1 `source_health`

Technical health only: source/venue, `GOOD|DEGRADED|UNAVAILABLE`, last update, latency/staleness, missing streams, sequence/snapshot validity. No market-direction interpretation.

### 5.2 `prepare_snapshot`

Establish one immutable analysis cutoff. Return `snapshot_id`, `created_at`, `data_cutoff`, universe count, source-health summary, retention/expiration metadata. Subsequent calls should reuse the same snapshot when possible.

### 5.3 `market_universe`

Return all Bybit linear USDT perpetual instruments and neutral metadata: symbol, listing/start time, last price, 24h volume/turnover, bid/ask, mark/index, OI, current funding/next funding, and matching-market availability on Bybit spot, Binance spot, Binance perp. ChatGPT decides liquidity eligibility.

### 5.4 `historical_market_data`

Bulk aligned OHLCV/history for many symbols with timeframe, lookback/start-end, selected fields, and cursor/chunking. No momentum/trend/trade scores.

Typical use:
- 1h close matrix for ~90d across liquid universe;
- 1h/4h/1d OHLCV for directional analysis;
- 1m/5m/15m only for finalists.

### 5.5 `historical_derivatives_data`

Bulk synchronized derivatives history: OI, funding, mark, index, premium/basis inputs, liquidation aggregates, resolution/lookback, cursor/chunking. ChatGPT computes OI deltas, funding percentiles, crowding interpretations, price/OI relationships, and dislocations.

### 5.6 `cross_market_data`

Synchronized Bybit/Binance and spot/perp observations where available for basis, fair-value comparison, spot confirmation, cross-venue divergence, lead/lag input, and carry analysis. Raw/neutral data only.

### 5.7 `microstructure_data`

Expensive finalist-only tool for roughly 3–10 symbols. Support neutral 1s/5s/30s/60s buckets containing timestamp, OHLC or mid movement, aggressive buy/sell quantity/notional, bid/ask/spread, bid/ask depth in defined bps bands, liquidation buy/sell notional, venue/spot/perp prices, and sequence/data-quality state.

No absorption score, fakeout probability, long probability, or trading recommendation.

The existing `entry-microstructure-feed` should be reused where appropriate, but cloud analysis must not depend on the user's Mac being online.

## 6. Data Volume Strategy

Required flow:
1. `prepare_snapshot`.
2. Fetch compact `market_universe` metadata.
3. ChatGPT filters liquidity and coverage.
4. Fetch bulk market and derivatives matrices for the filtered universe.
5. ChatGPT performs numerical calculations and shortlisting.
6. Fetch deeper multi-timeframe data only for candidates.
7. Fetch `microstructure_data` only for finalists.

Large responses must support deterministic pagination/chunking while preserving the same snapshot/cutoff. The user should not need to send `continue`; ChatGPT completes all chunks within one analysis request.

## 7. Trading Analyst Protocol

For every full-market request, ChatGPT follows this sequence.

### 7.1 Validate Data
Check source health, freshness, historical coverage, and sequence integrity. Mark degraded inputs and reduce confidence where material.

### 7.2 Build Universe
Start from all Bybit linear USDT perpetuals. ChatGPT filters by liquidity, turnover, spread, depth, listing maturity, historical coverage, and data quality.

### 7.3 Calculate Market Matrix
Compute as relevant: 1h/4h/24h/3d/7d/30d returns, realized volatility, ATR/range measures, relative volume, drawdown, distance to highs/lows, relative strength, volatility-adjusted momentum, breadth, dispersion.

### 7.4 Build Market Context
Using BTC, ETH, breadth, dispersion, volatility, funding distribution, and OI distribution, form context such as risk-on, risk-off, fragmented, compression/range, or high-volatility dislocation. This is context, not a hard rule.

### 7.5 Parallel Alpha Search
ChatGPT must inspect multiple independent strategy families before choosing a trade.

#### Cross-Sectional Momentum
Rank the liquid universe using multi-horizon momentum, relative strength, volatility adjustment, and liquidity context. Produce candidates, not automatic trades.

#### Directional / MTF
Apply existing directional methodology to shortlisted candidates: HTF/MTF structure, existing scenario families, location, lower-TF trigger, invalidation, OI/funding/liquidation context, finalist microstructure confirmation.

#### Derivatives / Liquidation Dislocation
Examine price, OI, funding, basis, and liquidation combinations; explicitly consider competing explanations such as cascade continuation versus exhaustion.

#### Statistical Arbitrage
For suitable liquid pairs compute correlation prefilter, hedge ratio, spread, stationarity/cointegration, z-score, half-life, and cost-adjusted convergence potential.

#### Carry / Funding / Basis
Evaluate funding and spot-perp/cross-venue basis using gross carry minus realistic execution and capital costs.

### 7.6 Merge Candidates
Normalize strategy type, legs, direction, horizon, edge/payoff thesis, estimated costs, invalidation, liquidity/execution quality, and data quality.

### 7.7 Deep Analysis Top-N
Only serious candidates receive deeper candles, derivatives history, order-book/trade data, and cross-market data.

### 7.8 Microstructure
For finalists derive and interpret aggressor imbalance, depth imbalance, refill/withdrawal, impact per notional, absorption, and spot/perp or venue lead/lag from neutral data.

### 7.9 Challenge the Thesis
Before final selection, explicitly test counter-evidence and competing explanations. Reject candidates whose counter-thesis is stronger or whose evidence is materially inconsistent.

### 7.10 Costs
Evaluate every candidate after maker/taker fees, spread, slippage/depth, funding, multi-leg execution costs, and capital/borrow costs where applicable.

### 7.11 Risk and Existing Exposure
Before final decision, ChatGPT may read the Bybit Demo account/position state through separate read-only Demo Execution tools. Assess entry/invalidation/stop logic, R:R, concentration, same-direction exposure, BTC/market beta, sector correlation, and multi-leg risk.

### 7.12 Compare Opportunities
Compare expected edge, evidence quality, data quality, liquidity, execution quality, invalidation clarity, costs, risk, correlation/concentration burden, and capital efficiency. Confidence is an evidence-quality score, not claimed probability of profit.

### 7.13 Final Decision
Allowed outcomes: `LONG`, `SHORT`, `PAIR`, `CARRY`, `WAIT`, `NO TRADE`.

A recommendation may include entry zone, invalidation, stop, targets, horizon, expected R:R, major evidence, main risks, alternatives, rejected candidates, and data limitations.

## 8. User-Facing Output

Default full-market response:

```text
MARKET STATE
...

BEST OPPORTUNITY
<symbol/legs + strategy>

Entry:
Invalidation / Stop:
Targets:
Horizon:
Estimated R:R / edge:

Why:
- ...

Main risks:
- ...

Confidence:
...

ALTERNATIVES
#2 ...
#3 ...

REJECTED / WAITING
...

DATA LIMITATIONS
...

ACTION: ENTER / WAIT / NO TRADE
```

Show decisive calculations/results, not hidden chain-of-thought.

## 9. Execution Boundary

- A ChatGPT conclusion of `ENTER` does not call an execution tool.
- Execution requires a separate explicit user command.
- Only Bybit Demo Execution may perform demo order writes.
- Market-data/analysis services receive no demo trading credentials.
- Existing demo-only host and access-control boundaries remain intact.

## 10. Existing-System Integration

Preserve:
- `bybit-demo-execution-cloud/` as demo execution boundary;
- `entry-microstructure-feed/` as reusable public WS/order-book/trade/liquidation/normalization code;
- existing directional MTF/scenario work as part of ChatGPT's Trading Analyst Protocol rather than an authoritative server-side signal.

Targeted improvement: consolidate the cloud-facing read-only market-data contract into source-controlled code in `Doskater/Doskater` so deployment, tests, and tool schemas are reproducible. Do not merge execution and analysis services.

## 11. Error Handling and Degradation

- Every data response includes timestamps/provenance sufficient to assess freshness.
- Stale/incomplete inputs are marked, never fabricated.
- Missing Binance reference does not automatically remove a valid Bybit instrument; it lowers cross-venue evidence.
- Missing microstructure does not crash analysis; ChatGPT may lower confidence or return `WAIT`.
- Sequence gaps invalidate book-derived features until clean rebuild.
- Snapshot expiration returns explicit error; ChatGPT prepares a new snapshot rather than mixing cutoffs.
- Unsupported symbol/venue combinations are explicit.
- Rate limits/transient failures use bounded retries/backoff and expose final degradation state.

## 12. Security

- Market-data components use public/read-only exchange endpoints only.
- No trading API keys in the data plane.
- Public MCP/API remains authenticated where applicable.
- Secrets are environment-managed and never logged/returned.
- Demo execution secrets stay isolated in Demo Execution.
- No withdrawal, deposit, transfer, or asset-movement capabilities are added.

## 13. Testing Strategy

### Unit tests
- schema normalization;
- timestamp alignment;
- snapshot immutability;
- universe discovery inputs;
- pagination/chunking;
- derivatives normalization;
- cross-market symbol mapping;
- event bucketing;
- order-book sequence handling;
- stale/degraded flags;
- enforcement that data-plane responses contain no prohibited recommendation fields.

### Contract tests
Verify each MCP/data schema and representative payload, including large-universe pagination.

### Fixture/replay tests
Use recorded public market fixtures for deterministic normalization and bucket output without live exchange dependency.

### Integration tests
Verify Bybit/Binance public endpoints, snapshot consistency, retries, and graceful degradation.

### ChatGPT protocol verification
Provide deterministic fixtures for strong momentum, crowded funding with weak spot confirmation, liquidation continuation, liquidation exhaustion, cointegrated-pair divergence, attractive gross funding but negative net carry after costs, and no valid edge.

The goal is to verify that the data contract supports all required calculations and that the protocol does not skip strategy families or thesis-challenge/cost/risk stages.

### Safety tests
Verify analysis tools cannot place/amend/cancel/close orders and execution cannot occur from a normal analysis request.

## 14. Deployment Model

Target the user's existing Render infrastructure with source-controlled code in `Doskater/Doskater`.

The implementation plan should decide whether the data plane replaces the legacy `trading-data-mcp` deployment or is introduced as a new service and migrated behind the existing ChatGPT proxy. Preference: source-controlled modular data-plane service with stable MCP contract, then migrate consumers without weakening execution separation.

Microstructure collection must be cloud-available for finalist analysis; cloud analysis must not depend on the Mac mini being online.

## 15. Non-Goals

- live-money execution;
- fully autonomous trading;
- continuously running LLM without user request;
- server-side recommendation engine;
- server-side opportunity ranking;
- full historical tick warehouse;
- options/volatility-surface strategies in v1;
- automated strategy parameter optimization/auto-tuning in v1.

## 16. Success Criteria

The upgrade is successful when one ChatGPT request can:
1. establish a consistent market snapshot;
2. scan the full liquid Bybit USDT-perpetual universe;
3. perform cross-sectional, directional, derivatives/liquidation, stat-arb, and carry analysis using ChatGPT-side computation;
4. request deep and microstructure data only for finalists;
5. compare heterogeneous opportunities after costs and risk;
6. produce a clear `LONG`, `SHORT`, `PAIR`, `CARRY`, `WAIT`, or `NO TRADE` decision;
7. disclose degraded/missing data;
8. leave all execution untouched until a separate explicit user command;
9. complete analysis without requiring the user's Mac online;
10. remain reproducible through source-controlled schemas, code, fixtures, and tests.
