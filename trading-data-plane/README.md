# Trading Data Plane

Read-only cloud market-data service for the ChatGPT Trading Analyst Protocol.

## Boundary

This service collects, normalizes, aligns, buckets, chunks, and serves public Bybit/Binance market data. It does **not** rank trades, choose direction, set entries/stops/targets, or execute orders. ChatGPT performs the calculations and trading interpretation. Bybit Demo Execution stays a separate service and is invoked only after a separate explicit user command.

## MCP tools

- `source_health`
- `prepare_snapshot`
- `market_universe`
- `historical_market_data`
- `historical_derivatives_data`
- `cross_market_data`
- `microstructure_data`

Modern MCP protocol: `2026-07-28`. Legacy initialize compatibility: `2025-11-25`. Both publish the same Trading Analyst Protocol instructions.

## Data model

- Tradable universe: Bybit linear USDT perpetuals.
- Binance: reference/confirmation only where matching spot/perpetual markets exist.
- Analysis snapshots: immutable, 15-minute TTL, shared `dataCutoff`.
- Market/history responses: neutral data, deterministic pagination where supported.
- Finalist microstructure: live event buckets at 1s / 5s / 30s / 60s; response includes both `analysisCutoff` and `microstructureCapturedAt`.
- Sequence gaps/reconnects invalidate book-derived microstructure until a clean rebuild.

## Security

Set `DATA_PLANE_TOKEN` for the public MCP route. No Bybit demo credentials belong in this service. It uses public exchange endpoints only. Recommendation-like output fields are rejected at runtime by the neutral-payload guard.

## Local commands

```bash
npm install
npm test
npm run check
DATA_PLANE_TOKEN=... npm start
DATA_PLANE_URL=http://127.0.0.1:10000 DATA_PLANE_TOKEN=... npm run smoke
```

## Render target

Recommended service: Node web service, Frankfurt.

Build:
```bash
cd trading-data-plane && npm install --omit=dev && npm run check && npm test
```

Start:
```bash
cd trading-data-plane && npm start
```

Required secret:
- `DATA_PLANE_TOKEN`

The public ChatGPT proxy should use:
- `UPSTREAM_MCP_URL=https://<data-plane-service>/mcp`
- `UPSTREAM_BEARER_TOKEN=<same data-plane access token>`

Do not reuse the Bybit Demo Execution token.
