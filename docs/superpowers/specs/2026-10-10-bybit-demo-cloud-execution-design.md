# Bybit Demo Cloud Execution — Design

## Goal

Make Bybit Demo execution available from ChatGPT on any device, including phone, without requiring the user's Mac to be online.

Success means:
- ChatGPT can read the Bybit Demo account, positions, open orders, and order history from the cloud service.
- Explicit user commands can place/amend/cancel/close demo orders and set leverage or TP/SL protection.
- No request can reach Bybit mainnet or testnet.
- Withdrawal and transfer operations are not implemented.
- API credentials never appear in source code, logs, ChatGPT messages, or plugin output.
- The only manual migration step is pasting two values into Render secret environment variables.

## Architecture

Create a third Render web service, separate from `trading-data-mcp` and `trading-data-chatgpt-proxy`.

Flow:

`ChatGPT plugin -> Bybit Demo Execution MCP service on Render -> https://api-demo.bybit.com`

The existing `Trading Data MCP Remote` remains read-only and unchanged. The existing local `bybit-demo.mjs` remains available as a fallback but is no longer required for phone use.

## Deployment layout

Use the existing GitHub repository `https://github.com/Doskater/Doskater`, but place the new service in its own subdirectory so it cannot interfere with the current root-level read-only proxy.

Proposed directory:

`bybit-demo-execution-cloud/`

The Render service will build and start from that directory or with commands that explicitly `cd` into it.

## Security boundaries

1. The Bybit base URL is a source-code constant: `https://api-demo.bybit.com`.
2. Startup fails if the configured host is anything else; there is no environment-variable override for the host.
3. Only documented Demo Trading account/order/position endpoints required by the pipeline are exposed.
4. No withdrawal, deposit, transfer, asset-movement, API-key-management, or mainnet/testnet tools exist.
5. Credentials are read only from:
   - `BYBIT_DEMO_API_KEY`
   - `BYBIT_DEMO_API_SECRET`
6. Credential values are redacted from errors/logs and are never returned by tools.
7. Write tools are clearly identified as write actions; the trading pipeline still requires an explicit user command before place/close/cancel/replace/leverage/protection actions.

## MCP tools

Read-only tools:
- `get_account_snapshot`
- `get_positions`
- `get_open_orders`
- `get_order_history`
- `get_executions`

Write tools:
- `place_order`
- `amend_order`
- `cancel_order`
- `cancel_all_orders`
- `close_position`
- `set_leverage`
- `set_position_protection`

Each write tool validates category/symbol/quantity inputs and refuses unsupported operations.

## API behavior

The service signs Bybit V5 HMAC requests using the Demo API key and secret. It returns concise structured results rather than full raw responses where possible.

`/healthz` must work even before secrets are configured and report whether credentials are present, without revealing them.

The MCP endpoint is `/mcp` and supports the ChatGPT MCP protocol used by the current read-only proxy.

## Plugin

Create a separate private plugin named `Bybit Demo Execution` instead of adding write tools to `Trading Data MCP Remote`.

The plugin description must make these points explicit:
- Demo/paper execution only.
- No real-money trading.
- Mainnet/testnet blocked.
- Write actions require an explicit user request.

The plugin connects to the new Render service and can be used from desktop or phone while the Mac is offline.

## Credential migration UX

After the cloud service is deployed, the user performs exactly one manual step in Render:

1. Open the new service's Environment section.
2. Paste the existing Demo API Key into `BYBIT_DEMO_API_KEY`.
3. Paste the existing Demo API Secret into `BYBIT_DEMO_API_SECRET`.
4. Save.

No secret is copied into ChatGPT. No terminal command is required. The current values stay in macOS Keychain as a local fallback.

## Verification

Before enabling write tests:
- `/healthz` returns OK and says whether secrets are configured.
- MCP discovery lists only the intended tools.
- Read-only account snapshot succeeds against `api-demo.bybit.com`.
- The cloud snapshot matches the known Bybit Demo account/position state closely enough to prove the correct account is connected.
- No mainnet/testnet/withdrawal/transfer code path exists.

After the user has pasted the two secrets, the first cloud test is read-only. No new order is placed during migration.

## Rollback

If the cloud service fails, the existing local `/Users/feliks/Projects/bybit-demo-execution/bybit-demo.mjs` remains untouched and can continue to be used through the Mac.

## Scope exclusions

Not included in this change:
- Real-money Bybit trading.
- Bybit mainnet/testnet support.
- Withdrawals, deposits, or transfers.
- Automatic trading without an explicit user command.
- Moving or deleting the local Keychain credentials.
