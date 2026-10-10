# Bybit Demo Execution Cloud

Private MCP service for Bybit Demo Trading execution from ChatGPT.

## Safety boundary

- The Bybit endpoint is fixed in source code to `https://api-demo.bybit.com`.
- This service supports demo/paper execution only.
- It does not implement withdrawals, deposits, transfers, asset movement, or API-key management.
- Write tools must only be used after an explicit user request.
- Credentials are never returned by MCP tools or `/healthz`.

## Render environment

The service needs exactly two Bybit credential secrets:

- `BYBIT_DEMO_API_KEY`
- `BYBIT_DEMO_API_SECRET`

Render also supplies `PORT` automatically. There is no configurable Bybit host variable.

## Commands

```bash
npm test
npm run check
npm start
```

## Health check

`GET /healthz` is intentionally available before credentials are configured. It reports demo-only mode, the fixed demo host, and a boolean `credentialsConfigured` value without exposing either secret.

## MCP

The MCP endpoint is `POST /mcp`. Read tools cover account, positions, open orders, order history, and executions. Write tools cover demo-only order placement/amend/cancel, full-position close, leverage, and server-side TP/SL protection.
