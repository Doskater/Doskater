# Universal multi-timeframe structure engine

Status: approved by user on 2026-10-14; implementation verified against this design.

## Verified starting point

Repository: /Users/feliks/Projects/trading-data-chatgpt-proxy.
Branch: feat/focused-entry-revalidation. HEAD: 83d9a73.
Working tree was clean at inspection.
Preserve e382618 dual-side watchers, 112c232 focused revalidation,
37b6009 watcher auto-sync, and 83d9a73 Terminal command policy.

## Approach and alternatives

Recommended: pure deterministic candle analysis plus a thin orchestration adapter.
This makes signals reproducible and keeps notification and execution boundaries intact.
Prompt-only analysis cannot provide regression-testable pivots or boundary validity.
Embedding analysis in the watcher daemon couples candle fetching to notifications and
risks resetting confirmations, so the full pipeline should own structure refreshes.

## Inputs and timeframe roles

Analyze normalized symbols without asset-specific price constants. Accept timestamped
OHLCV candles grouped by timeframe, source identity, observation time, and configurable
context/setup/entry roles. Defaults: context 1D/4H/1H; setup 1H/30m/15m;
entry 15m/5m/1m. Roles overlap; each physical timeframe contributes once to agreement.
Use closed candles only and explicit candle-open timestamps plus interval durations.
Validate ordering, finite positive prices, OHLC geometry, duplicate timestamps, gaps,
freshness, minimum history, and source consistency. Unavailable or malformed inputs
produce diagnostic WAIT, never manufactured structure or entry approval.
Read-only exchange candle acquisition belongs in an adapter with injectable readers;
the engine itself has no network, filesystem, account, or order access.

## Structure

Confirmed pivots require configurable left/right windows (default 2/2); record both
pivot time and confirmation time to avoid lookahead. Plateaus have a deterministic
tie rule. Compare successive same-kind pivots using volatility-scaled equality
tolerance; expose HH/HL/LH/LL and equal/unknown states. Cluster confirmed pivots into
support/resistance zones using ATR tolerance and record touches and provenance.

Ascending support and descending resistance require at least three distinct confirmed
pivot touches separated in time, bounded fitting error, correct slope, and no subsequent
closed-candle violation beyond tolerance. Expose time-dependent boundary projections,
touches, validity, and invalidation. Two points alone remain provisional.

Regime: trend when swing direction is coherent, range when repeated horizontal zones
contain price, compression when valid opposing boundaries converge and volatility
contracts; otherwise unknown. Every result includes explicit supporting evidence.

## Scenarios and confidence

Classify trend continuation, pullback, reclaim, breakout, failed breakout, reversal,
and range mean reversion from confirmed structure and closed-candle transitions.
Breakouts identify prior boundary and close evidence; retests need subsequent candles.
Failed breakouts require a prior confirmed excursion followed by a close back inside.
Reversals require relevant swing invalidation and new opposite structure, not adverse flow.
Candidate zones carry side, scenario, trigger rule, structural invalidation, targets,
source timeframes, and observation time. Multiple scenarios may coexist, including
long and short alternatives. No valid geometry means WAIT.

Expose signed per-timeframe votes, coverage, weighted agreement and scenario confidence
in [0,1]. Deduplicate overlapping roles. Confidence is an explainable heuristic,
not a calibrated success probability; missing data reduces coverage/confidence.

## Decision hierarchy and compatibility

market regime -> MTF structure -> scenario classification -> candidate zone -> lower
timeframe trigger -> event microstructure confirmation -> R:R -> ENTER/WAIT.

Provide structured evidence to focused-revalidation.js without removing its existing
freshness, market-risk, tick/quantity, live-request, expiry, and journal checks.
Legacy contexts remain supported. MTF contexts additionally require valid structure,
scenario identity, lower-timeframe confirmation and provenance before eligibility.
Microstructure veto yields WAIT_RETEST and preserves the thesis. Only actual relevant
structural invalidation yields INVALIDATED. Preserve full-size R:R >=2 and reduced-size
R:R >=1.5, with existing quantity quantization and safe command generation.

## Watcher integration and safety

Derive normalized symbol/side watcher levels from active structure; project sloping
boundaries at refresh time. Select at most one best scenario per symbol/side and retain
full scenario evidence outside the legacy normalized watcher schema. Compare and apply
the complete desired set through existing syncSetups. Preserve other monitored symbols
when one symbol's candle sources fail; missing data must not erase valid configurations.
Successful structural invalidation may remove obsolete scenarios. Log change reasons.

Keep 30s hold, 0.30 imbalance, two confirmations, 12s spacing, impact confirmation,
absorption veto, dual-side identity, latching and notification-only behavior. Refresh
structure on each full pipeline run; do not start services or edit live watcher state
as part of implementing or testing this feature.

Never place/amend/cancel/replace/close orders or change leverage/protection automatically.
Generate commands solely through the current DEMO builder after the final live gate.
One Terminal commands block, one safe command per approved entry; none for WAIT or
NO TRADE. Keep all generated commands as text.

## Proposed files

- Create entry-microstructure-feed/mtf-structure.js: candle validation, pivots, zones,
  boundaries, regime, role resolution and agreement.
- Create entry-microstructure-feed/mtf-scenarios.js: scenario evidence and candidates.
- Create entry-microstructure-feed/mtf-pipeline.js: read-only candle orchestration,
  structural contexts and complete watcher-set derivation.
- Create entry-microstructure-feed/scripts/analyze-structure.js: analysis CLI and
  explicit notification-only watcher sync option; no order execution.
- Modify focused-revalidation.js and scripts/revalidate-entry.js for optional MTF
  contexts and lower-timeframe gating, preserving legacy compatibility.
- Modify package.json, PIPELINE_PROMPT.md and README.md for checks, CLI and hierarchy.
- Add MTF tests and extend focused revalidation, watcher and pipeline-policy tests.

## Verification

Deterministic rising/falling/ranging/compressing fixtures across multiple symbols and
price scales; no lookahead under prefix replay; plateau/equal swings; provisional and
confirmed boundaries; boundary violation; all seven scenario types and mirrored sides;
overlapping roles; missing/stale/gapped/malformed/open candles; wrong source identities.

Regression coverage: temporary micro veto delays without revoking thesis; structural
break invalidates even with bullish flow; unconfirmed lower trigger cannot enter;
dual-side sync updates/removes only intended identities; unchanged scenarios retain
latching; source failure retains unaffected watchers; commands absent for WAIT and
expired contexts; existing safe DEMO builder remains sole command path.

Run both complete Node test suites, all package syntax checks and git diff --check.
No live account or notification mutations during tests. Report exact changed files,
commit hashes if commits are made, and test totals. Preserve the current checkout.

## Limitations to disclose

Pivot confirmation necessarily lags price. Sloped watchers are discretized between
pipeline refreshes. Sparse history, source disagreement or missing entry frames cause
WAIT. Confidence needs historical calibration before interpretation as predictive.
This project still requires fresh macro/derivatives/account sizing inputs from the
existing pipeline; the candle engine cannot replace those checks.
