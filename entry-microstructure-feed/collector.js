import { WINDOW_MS, CORE_SYMBOLS, normalizeSymbol } from './config.js';
import { createTimedRingBuffer } from './ring-buffer.js';
import {
  computeAggressorImbalance,
  computeRefill,
  computeLiquidityVoid,
  computePriceImpact,
  computeImpactAsymmetry,
  computeLiquidationResponse,
  computeLeadLag,
  buildCausalSummary
} from './features.js';

const EXPECTED_FAMILIES = ['binance:spot', 'binance:perp', 'bybit:spot', 'bybit:linear'];
const PRIMARY_PRIORITY = ['binance:spot', 'binance:perp', 'bybit:spot', 'bybit:linear'];
const RETENTION_MS = 120_000;
const FRESHNESS_MS = 10_000;
const WARMUP_GRACE_MS = 30_000;

export function createCollector({ binanceFeed, bybitFeed, watchlist, clock = Date, logger = { info() {}, warn() {}, error() {} } }) {
  const now = () => typeof clock.now === 'function' ? clock.now() : Date.now();
  const tradeBuffers = new Map();
  const bookBuffers = new Map();
  const midBuffers = new Map();
  const liquidationBuffers = new Map();
  const coverageState = new Map();
  const activatedAt = new Map();
  const feedStatus = new Map();
  let started = false;

  const familyKey = (venue, market) => `${venue}:${market}`;
  const dataKey = (family, symbol) => `${family}:${symbol}`;

  function bufferFor(map, key, maxItems = 50_000) {
    if (!map.has(key)) map.set(key, createTimedRingBuffer({ retentionMs: RETENTION_MS, maxItems, now }));
    return map.get(key);
  }

  function depthFromBook(book) {
    if (!book?.healthy || !Number.isFinite(book.mid) || book.mid <= 0) return null;
    const bps = 50 / 10_000;
    const bidFloor = book.mid * (1 - bps);
    const askCeiling = book.mid * (1 + bps);
    const bidNotional = (book.bids ?? []).filter(([p]) => p >= bidFloor).reduce((s,[p,q]) => s + Number(p)*Number(q), 0);
    const askNotional = (book.asks ?? []).filter(([p]) => p <= askCeiling).reduce((s,[p,q]) => s + Number(p)*Number(q), 0);
    return { bidNotional, askNotional };
  }

  function onTrade(event) {
    const family = familyKey(event.venue, event.market);
    const symbol = normalizeSymbol(event.symbol);
    bufferFor(tradeBuffers, dataKey(family, symbol)).push({ ...event, ts: Number(event.eventTs) });
  }

  function onLiquidation(event) {
    const symbol = normalizeSymbol(event.symbol);
    bufferFor(liquidationBuffers, symbol, 10_000).push({ ...event, ts: Number(event.eventTs) });
  }

  function onBookState(event) {
    const family = familyKey(event.venue, event.market);
    const symbol = normalizeSymbol(event.symbol);
    const ts = Number(event.ts ?? now());
    coverageState.set(dataKey(family, symbol), { state: event.state, ts, book: event.book });
    if (event.state !== 'healthy' || !event.book?.healthy) return;
    const depth = depthFromBook(event.book);
    if (!depth) return;
    bufferFor(bookBuffers, dataKey(family, symbol), 10_000).push({
      ts,
      healthy: true,
      bidNotional: depth.bidNotional,
      askNotional: depth.askNotional,
      spread: Number(event.book.spread ?? 0),
      mid: Number(event.book.mid)
    });
    bufferFor(midBuffers, dataKey(family, symbol), 20_000).push({ ts, mid: Number(event.book.mid) });
  }

  function onStatus(event) {
    feedStatus.set(familyKey(event.venue, event.market), { ...event });
  }

  if (typeof binanceFeed?.setHandlers !== 'function' || typeof bybitFeed?.setHandlers !== 'function') throw new Error('feed_handlers_not_supported');
  binanceFeed.setHandlers({ onTrade, onBookState, onLiquidation, onStatus });
  bybitFeed.setHandlers({ onTrade, onBookState, onLiquidation, onStatus });

  async function ensureOne(symbol) {
    if (!activatedAt.has(symbol)) activatedAt.set(symbol, now());
    await Promise.all([binanceFeed.ensureSymbol(symbol), bybitFeed.ensureSymbol(symbol)]);
  }

  async function start() {
    if (started) return;
    started = true;
    binanceFeed.start();
    bybitFeed.start();
    await Promise.all(CORE_SYMBOLS.map(ensureOne));
  }

  function stop() {
    started = false;
    binanceFeed.stop();
    bybitFeed.stop();
  }

  async function ensureSymbols(values) {
    const normalized = values.map(normalizeSymbol);
    watchlist.ensure(normalized);
    await Promise.all(normalized.map(ensureOne));
    return getWatchlist();
  }

  function expireDynamic() {
    const removed = watchlist.expire();
    for (const symbol of removed) {
      binanceFeed.removeSymbol(symbol);
      bybitFeed.removeSymbol(symbol);
      activatedAt.delete(symbol);
      for (const family of EXPECTED_FAMILIES) {
        tradeBuffers.delete(dataKey(family, symbol));
        bookBuffers.delete(dataKey(family, symbol));
        midBuffers.delete(dataKey(family, symbol));
        coverageState.delete(dataKey(family, symbol));
      }
      liquidationBuffers.delete(symbol);
    }
    return removed;
  }

  function getWatchlist() {
    expireDynamic();
    return watchlist.list();
  }

  function coverageFor(symbol) {
    const current = now();
    return EXPECTED_FAMILIES.map(family => {
      const state = coverageState.get(dataKey(family, symbol));
      const ageMs = state ? Math.max(0, current - state.ts) : null;
      const healthy = Boolean(state?.state === 'healthy' && state?.book?.healthy && ageMs <= FRESHNESS_MS);
      return { family, state: state?.state ?? 'unknown', healthy, ageMs, reason: state?.book?.reason ?? null };
    });
  }

  function historyWarm(family, symbol) {
    const buffer = bookBuffers.get(dataKey(family, symbol));
    if (!buffer) return false;
    const points = buffer.since(now() - 60_000);
    if (points.length < 2) return false;
    return points.at(-1).ts - points[0].ts >= 60_000;
  }

  function runtimeFor(symbol, coverage) {
    const healthy = coverage.filter(x => x.healthy);
    if (healthy.length === EXPECTED_FAMILIES.length) {
      return EXPECTED_FAMILIES.every(f => historyWarm(f, symbol)) ? 'FULL_EVENT_STREAM' : 'WARMING_UP';
    }
    if (healthy.length > 0) return 'PARTIAL';
    const activationAge = now() - (activatedAt.get(symbol) ?? now());
    const anyExplicitWarming = coverage.some(x => x.state === 'WARMING_UP' || x.state === 'connecting' || x.state === 'unknown');
    if (activationAge <= WARMUP_GRACE_MS && anyExplicitWarming) return 'WARMING_UP';
    return 'UNAVAILABLE';
  }

  function primaryFamilyFor(coverage) {
    return PRIMARY_PRIORITY.find(family => coverage.some(x => x.family === family && x.healthy)) ?? null;
  }

  function windowFeatures(symbol, family, windowMs) {
    const start = now() - windowMs;
    const trades = tradeBuffers.get(dataKey(family, symbol))?.since(start) ?? [];
    const books = bookBuffers.get(dataKey(family, symbol))?.since(start) ?? [];
    const mids = midBuffers.get(dataKey(family, symbol))?.since(start) ?? [];
    const liqs = liquidationBuffers.get(symbol)?.since(start) ?? [];
    const aggressor = computeAggressorImbalance(trades, { minNotional: 1_000 });
    const refill = computeRefill(books);
    const voidFeature = computeLiquidityVoid(books, trades);
    const impact = computePriceImpact(trades, mids, { standardNotional: 100_000, minNotional: 1_000 });
    const impactAsymmetry = computeImpactAsymmetry(impact);
    const liquidationResponse = computeLiquidationResponse(liqs, mids);
    return { aggressor, refill, void: voidFeature, impact, impactAsymmetry, liquidationResponse };
  }

  function leadLagFor(symbol) {
    const series = {};
    for (const family of EXPECTED_FAMILIES) {
      const rows = midBuffers.get(dataKey(family, symbol))?.since(now() - 60_000) ?? [];
      if (rows.length >= 2) series[family] = rows;
    }
    return computeLeadLag(series, { thresholdBps: 1, minLeadMs: 50 });
  }

  function getSnapshot(value) {
    expireDynamic();
    const symbol = normalizeSymbol(value);
    if (!watchlist.list().some(x => x.symbol === symbol)) throw new Error('symbol_not_watched');
    const coverage = coverageFor(symbol);
    const runtime = runtimeFor(symbol, coverage);
    const primaryFamily = primaryFamilyFor(coverage);
    const windows = {};
    if (primaryFamily) for (const windowMs of WINDOW_MS) windows[String(windowMs)] = windowFeatures(symbol, primaryFamily, windowMs);
    const leader = leadLagFor(symbol);
    const causalInput = primaryFamily ? { ...windows['60000'], leadLag: leader } : { leadLag: leader };
    const causal = buildCausalSummary(causalInput);
    const ageValues = coverage.filter(x => x.ageMs !== null).map(x => x.ageMs);
    return {
      symbol,
      runtime,
      primaryFamily,
      freshness: { maxAgeMs: ageValues.length ? Math.max(...ageValues) : null, byFamily: Object.fromEntries(coverage.map(x => [x.family, x.ageMs])) },
      coverage,
      missingCoverage: coverage.filter(x => !x.healthy).map(x => x.family),
      windows,
      leader,
      causalSummary: causal.summary,
      strongestContradiction: causal.strongestContradiction
    };
  }

  function getSummary(value) {
    const snap = getSnapshot(value);
    return {
      symbol: snap.symbol,
      runtime: snap.runtime,
      primaryFamily: snap.primaryFamily,
      leader: snap.leader,
      causalSummary: snap.causalSummary,
      strongestContradiction: snap.strongestContradiction,
      missingCoverage: snap.missingCoverage,
      freshness: snap.freshness
    };
  }

  function getStatus() {
    expireDynamic();
    const symbols = watchlist.list().map(x => x.symbol);
    const runtimeCounts = { FULL_EVENT_STREAM: 0, WARMING_UP: 0, PARTIAL: 0, UNAVAILABLE: 0 };
    for (const symbol of symbols) runtimeCounts[getSnapshot(symbol).runtime]++;
    return {
      started,
      activeSymbols: symbols.length,
      runtimeCounts,
      feeds: { binance: binanceFeed.status(), bybit: bybitFeed.status() },
      feedStatus: Object.fromEntries(feedStatus)
    };
  }

  return { start, stop, ensureSymbols, getStatus, getWatchlist, getSnapshot, getSummary };
}
