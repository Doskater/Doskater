# Bybit Demo Cloud Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a separate cloud MCP service and private ChatGPT plugin for Bybit Demo execution so the user's Mac can be offline.

**Architecture:** Add a self-contained `bybit-demo-execution-cloud/` Node service in the existing repository. It signs Bybit V5 requests only for the fixed demo host, exposes a narrow MCP tool surface, and reads credentials only from Render environment variables. A separate private plugin points at this service; the existing read-only proxy and local Keychain client remain unchanged.

**Tech Stack:** Node.js 20+, native `http`, `fetch`, `crypto`, Node test runner, Render, ChatGPT Plugin Creator, Bybit V5 Demo API.

**Spec:** `docs/superpowers/specs/2026-10-10-bybit-demo-cloud-execution-design.md`

## Global Constraints

- Bybit host is exactly `https://api-demo.bybit.com`; no configurable mainnet/testnet host.
- Credentials are only `BYBIT_DEMO_API_KEY` and `BYBIT_DEMO_API_SECRET`.
- Never log or return credential values.
- Do not implement withdrawal, deposit, transfer, asset-movement, or API-key-management endpoints.
- Write tools are demo-only and must remain separate from `Trading Data MCP Remote`.
- Existing root read-only proxy and local `/Users/feliks/Projects/bybit-demo-execution/bybit-demo.mjs` must remain operational.
- Migration must require only pasting two secrets into Render; no new order is placed during migration verification.

## Review Focus

- Missing/empty secrets: `/healthz` remains usable while authenticated MCP calls fail safely without leaking values.
- Host tampering: no input or environment variable can redirect requests away from `api-demo.bybit.com`.
- Unsupported asset movement: tool discovery and request routing expose no transfer/withdrawal/deposit capability.
- Bybit error payloads containing request metadata: sanitize returned/logged errors and never echo secrets/signatures.
- Partial/invalid write inputs: reject unsupported category, side, type, qty, price, leverage, or TP/SL before any Bybit request.

---

### Task 1: Demo-only Bybit API client

**Files:**
- Create: `bybit-demo-execution-cloud/bybit-client.js`
- Create: `bybit-demo-execution-cloud/test/bybit-client.test.js`
- Create: `bybit-demo-execution-cloud/package.json`

**Interfaces:**
- Produces: `createBybitClient({ apiKey, apiSecret, fetchImpl? })` with `request(method, path, params)` and fixed exported `BYBIT_DEMO_HOST`.
- Produces: `redactSensitive(value, secrets)` for safe errors/logging.

- [ ] **Step 1: Write failing client security/signing tests.** Assert fixed host, no host override, GET/POST HMAC request formation, missing-secret rejection, and redaction of API key/secret/signature-like values.
- [ ] **Step 2: Run `node --test bybit-demo-execution-cloud/test/bybit-client.test.js` and confirm failure.**
- [ ] **Step 3: Implement the minimal client** using native `crypto`/`fetch`; accept only relative `/v5/...` paths and credentials passed by caller.
- [ ] **Step 4: Re-run the client tests and confirm PASS.**
- [ ] **Step 5: Commit:** `git commit -m "feat: add demo-only Bybit API client"`.

### Task 2: Narrow account/order service layer

**Files:**
- Create: `bybit-demo-execution-cloud/bybit-service.js`
- Create: `bybit-demo-execution-cloud/test/bybit-service.test.js`

**Interfaces:**
- Consumes: `createBybitClient` request interface from Task 1.
- Produces: `createBybitService(client)` with `getAccountSnapshot`, `getPositions`, `getOpenOrders`, `getOrderHistory`, `getExecutions`, `placeOrder`, `amendOrder`, `cancelOrder`, `cancelAllOrders`, `closePosition`, `setLeverage`, `setPositionProtection`.

- [ ] **Step 1: Write failing service tests** for endpoint mapping, concise result shaping, input allowlists, `reduceOnly` close behavior, and rejection of unsupported category/side/orderType/qty/price/leverage/protection.
- [ ] **Step 2: Run `node --test bybit-demo-execution-cloud/test/bybit-service.test.js` and confirm failure.**
- [ ] **Step 3: Implement the minimal service layer** for `linear` USDT perpetual execution required by the current pipeline; do not add transfer-like endpoints.
- [ ] **Step 4: Re-run tests and confirm PASS.**
- [ ] **Step 5: Commit:** `git commit -m "feat: add Bybit Demo execution service layer"`.

### Task 3: MCP server and health endpoint

**Files:**
- Create: `bybit-demo-execution-cloud/server.js`
- Create: `bybit-demo-execution-cloud/test/server.test.js`
- Modify: `bybit-demo-execution-cloud/package.json`

**Interfaces:**
- Consumes: `createBybitService` from Task 2 and env vars `BYBIT_DEMO_API_KEY`, `BYBIT_DEMO_API_SECRET`, `PORT`.
- Produces: HTTP `/healthz` and MCP `/mcp`; tool names exactly match the spec.

- [ ] **Step 1: Write failing MCP/HTTP tests** for health without secrets, `server/discover`, `tools/list`, read/write `tools/call`, unknown-tool rejection, JSON size/rate safeguards, and absence of asset-movement tools.
- [ ] **Step 2: Run server tests and confirm failure.**
- [ ] **Step 3: Implement native HTTP MCP compatibility** following the current proxy's modern protocol semantics; mark write tools distinctly in descriptions and never expose credentials.
- [ ] **Step 4: Run all cloud-service tests plus `node --check bybit-demo-execution-cloud/server.js`; confirm PASS.**
- [ ] **Step 5: Commit:** `git commit -m "feat: expose Bybit Demo MCP server"`.

### Task 4: Deployment packaging and local verification

**Files:**
- Create: `bybit-demo-execution-cloud/README.md`
- Modify: `bybit-demo-execution-cloud/package.json`

**Interfaces:**
- Produces: Render-compatible `npm start`, `npm test`, `npm run check`; documents only the two secret names.

- [ ] **Step 1: Add deployment/readme smoke checks** that prove `/healthz` works with no secrets and reports `credentialsConfigured: false` without values.
- [ ] **Step 2: Run `npm test` and `npm run check` inside the subdirectory.**
- [ ] **Step 3: Start the server locally with secrets unset and curl `/healthz`; expect healthy service with credentials absent.**
- [ ] **Step 4: Search executable source for forbidden host/asset-movement paths and verify no mainnet/testnet/withdrawal/transfer/deposit route exists.**
- [ ] **Step 5: Commit:** `git commit -m "docs: prepare Bybit Demo cloud deployment"`.

### Task 5: Push and create Render service without credentials

**Files:**
- No product-code changes unless deployment verification finds an issue.

**Interfaces:**
- Consumes: GitHub repo `https://github.com/Doskater/Doskater`, branch `main`.
- Produces: third Render web service `bybit-demo-execution` in Frankfurt, free plan, auto-deploy enabled, using subdirectory commands.

- [ ] **Step 1: Push committed branch to GitHub and verify clean status.**
- [ ] **Step 2: Create Render service** with build command `cd bybit-demo-execution-cloud && npm install --omit=dev && npm run check` and start command `cd bybit-demo-execution-cloud && npm start`; do not set Bybit credentials yet.
- [ ] **Step 3: Wait for deploy success; inspect events if it fails.**
- [ ] **Step 4: Call public `/healthz`; expect demo-only mode and `credentialsConfigured: false` with no secret content.**

### Task 6: Create separate private ChatGPT plugin

**Files:**
- Create temporary plugin package under `bybit-demo-execution-cloud/plugin/` or `/tmp`; never include secrets.

**Interfaces:**
- Consumes: deployed Render `/mcp` URL.
- Produces: private plugin `Bybit Demo Execution` with demo-only descriptions and explicit-write guidance.

- [ ] **Step 1: Inspect a known working plugin package format and prepare the smallest valid separate plugin package for the new MCP endpoint.**
- [ ] **Step 2: Validate archive contains no credential values or local Keychain references.**
- [ ] **Step 3: Create the private plugin with Plugin Creator and retain its returned plugin URL/ID.**
- [ ] **Step 4: Verify plugin metadata/skill wording says demo only, no real-money trading, mainnet/testnet blocked, and writes require explicit user request.**

### Task 7: User's one manual secret step and read-only cloud proof

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: Render service ID and user's two existing Bybit Demo credential values.
- Produces: cloud account/positions/open-orders snapshot from the same Demo account.

- [ ] **Step 1: Give the user the exact Render service Environment screen and exactly two variable names: `BYBIT_DEMO_API_KEY`, `BYBIT_DEMO_API_SECRET`.**
- [ ] **Step 2: User pastes values and saves; values are never sent through ChatGPT.**
- [ ] **Step 3: Verify `/healthz` now reports credentials configured without values.**
- [ ] **Step 4: Through the new cloud MCP/plugin, call only read tools and compare account/position/open-order state with the known Demo account.**
- [ ] **Step 5: Do not place a new order during migration verification. Report readiness for phone use only after the read-only proof passes.**
