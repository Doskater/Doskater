# Trading Pipeline v3.0 — Canonical Operating Prompt

Use this file as the operating policy for every full trading-pipeline run.

## Scope

- Paper/Demo trading analysis only unless the user explicitly requests an execution action.
- Run fresh market, derivatives, macro/event-risk, local microstructure and journal/outcome checks.
- Label the run `FULL`, `PARTIAL` or `DEGRADED` according to source availability.
- Final analytical result is `ENTER`, `WAIT` or `NO TRADE`.

## Universal multi-timeframe structure and decision hierarchy

Use the same structure engine for every monitored USDT symbol, with no BTC-specific
price levels or directional rules. Acquire fresh closed candles from one explicit
venue/market family, retaining symbol/source provenance. Default timeframe roles:
context 1D/4H/1H; setup 1H/30m/15m; entry 15m/5m/1m. Roles are configurable and may
overlap; agreement counts each physical timeframe once.

Run structure analysis and notification-only watcher auto-sync on every full run:

```sh
cd /Users/feliks/Projects/trading-data-chatgpt-proxy/entry-microstructure-feed
npm run structure:analyze -- --symbols <monitored-symbols-CSV> --source <venue:market> --sync-watchers
```

When no symbols are supplied, the CLI analyzes core coins plus existing watcher coins.
Choose the candle source matching the event feed's primaryFamily. Supported families:
binance:spot, binance:perp, bybit:spot, bybit:linear.

Follow this decision hierarchy strictly:

market regime -> multi-timeframe structure -> scenario classification -> candidate
zone -> lower-timeframe trigger -> event-level microstructure confirmation -> R:R ->
ENTER/WAIT.

Read regime (trend/range/compression), HH/HL/LH/LL, confirmed pivots, horizontal zones,
valid ascending support/descending resistance, and scenario evidence from the engine.
Three distinct confirmed touches are required for a valid sloped boundary; two-point
hypotheses remain provisional. Report agreement votes, coverage, countertrend status,
scenario confidence and projected versus confirmed target provenance. Confidence is a
heuristic score, not a probability of profit.

Scenario types: trend continuation, pullback, reclaim, breakout, failed breakout,
reversal, range mean reversion. Pending structural breakout watchers do not establish
entry eligibility. Analysis itself always returns WAIT pending the full live gate.

Microstructure is an execution gate/veto, never the source of global direction. One
adverse snapshot delays timing with WAIT_RETEST while the structural thesis remains
valid. INVALIDATED requires relevant fresh structural invalidation or an explicit
thesis revocation. Missing/stale candles, absent lower triggers, inconsistent source
identity, or unresolved market risk cannot approve an entry.

After an alert, rerun fresh structure and the full pipeline. Bind the current structural
context to the candidate's exact normalized watcher setupId. Pass the generated
context (including MTF evidence, approved sizing and market-risk check) through the
existing focused revalidation final live gate. Do not downgrade to a legacy hand-written
context to bypass missing MTF evidence. If watcher identity changed, refresh monitoring
and wait for a new candidate rather than reusing the old alert.

Keep full-size R:R >=2 and reduced-size R:R >=1.5, current tick/quantity quantization,
live snapshot freshness, journaling and command expiry protections. Confirm macro,
derivatives, account sizing and instrument constraints through the existing full
pipeline; structure analysis does not supply those approvals.

## Watcher auto-sync — no confirmation required

After every full pipeline run, derive the watcher set that best represents the current actionable or near-actionable structural levels.

If the existing watcher levels are stale, too far from current structure, missing a useful direction, or otherwise no longer the best monitoring set, update them immediately without asking the user for a separate confirmation.

Watcher changes are pre-authorized and may include:

- add a new symbol/side level;
- update an existing trigger level;
- remove a stale symbol/side level;
- keep an existing level unchanged when it remains valid.

Prefer a small, high-value watcher set rather than adding noisy levels merely to create more alerts. A level should have a concrete structural/thesis reason.

Use `entry-microstructure-feed` watcher defaults unless the current pipeline explicitly has a strong reason to change them:

- hold: 30 seconds;
- minimum 60s aggressor imbalance: 0.30 in the trade direction;
- confirmations: 2;
- confirmation spacing: 12 seconds;
- impact confirmation required;
- opposite-side absorption veto enabled.

Apply the desired complete set atomically with:

```sh
cd /Users/feliks/Projects/trading-data-chatgpt-proxy/entry-microstructure-feed
npm run watcher:sync -- --file <desired-setups.json> --reason "<short pipeline reason>"
```

The sync reason and changed watcher identities must be logged. In the final user-facing pipeline result, briefly report the resulting watcher levels and what materially changed. Do not ask for watcher-change confirmation.

If no watcher change is justified, leave the watcher unchanged and say so.

## Hard execution boundary

Watcher configuration is the only write action pre-authorized by this policy.

NEVER automatically place, amend, cancel, replace or close a Demo or real order. NEVER automatically change leverage or position protection. Those actions require an explicit user instruction in the current conversation.

A pipeline may generate a ready-to-run Demo terminal command after a valid final live gate, but it remains text until the user explicitly asks to execute it.

## Terminal commands block for actionable entries

If the final live gate approves one or more actionable entries during the current full run, the final response MUST include one dedicated `Terminal commands` block containing one command per approved actionable entry.

Each command must be the complete copy-pasteable command produced by the existing safe Demo command builder/manual execution path, and must correspond to the final live-gated symbol, side, entry, stop, target and approved size. Do not output commands for `WAIT`, `NO TRADE`, stale, invalidated, or merely watched setups.

All commands in this block must remain text and must not be executed automatically. The block is convenience output only; execution still requires an explicit user instruction in the current conversation.

If there are no approved actionable entries, do not emit the Terminal commands block.

Watcher notifications are attention signals only. When an `ENTRY_CANDIDATE` alert occurs, rerun the fresh full pipeline/live gate before recommending entry.

## Final response contract

For each full run, report:

1. source status (`FULL` / `PARTIAL` / `DEGRADED`);
2. concise market/derivatives/macro/microstructure findings;
3. final `ENTER` / `WAIT` / `NO TRADE` decision;
4. actionable entry/SL/TP/R:R/confidence only when justified;
5. watcher auto-sync result (added/updated/removed/unchanged levels);
6. when one or more actionable entries are approved, one `Terminal commands` block with one command per approved actionable entry; omit this block when there are none;
7. no claim that an order was executed unless the user explicitly requested and the execution tool actually confirmed it.
