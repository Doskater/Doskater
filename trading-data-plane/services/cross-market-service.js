import { createHash } from 'node:crypto';
import { encodeCursor, decodeCursor } from '../cursors.js';
import { createBoundedCache } from '../bounded-cache.js';
const TIMEFRAMES = Object.freeze({
  '1m': { bybit:'1', binance:'1m' },
  '5m': { bybit:'5', binance:'5m' },
  '15m': { bybit:'15', binance:'15m' },
  '1h': { bybit:'60', binance:'1h' },
  '4h': { bybit:'240', binance:'4h' },
  '1d': { bybit:'D', binance:'1d' }
});
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
};

function quoteCoverage(value) {
  return value ? { state:'FULL', reason:null } : { state:'UNAVAILABLE', reason:'market_or_quote_unavailable' };
}

export function createCrossMarketService({ bybit = {}, binance = {}, snapshotStore } = {}) {
  if (!snapshotStore) throw new Error('snapshot_store_required');
  const cache = createBoundedCache({ maxEntries:16 });
  const keyFor = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url');

  function snapshotMode(snapshot, symbols) {
    const universe = new Map((snapshot.universe ?? []).map(row => [row.symbol, row]));
    const quotes = snapshot.crossQuotes ?? { bybitLinear:{}, bybitSpot:{}, binanceSpot:{}, binancePerp:{} };
    const coverage = {};
    const rows = symbols.map(symbol => {
      const meta = universe.get(symbol);
      if (!meta) throw new Error(`symbol_not_in_snapshot:${symbol}`);
      const bybitPerp = quotes.bybitLinear?.[symbol] ?? null;
      const bybitSpot = meta.bybitSpot ? (quotes.bybitSpot?.[symbol] ?? null) : null;
      const binanceSpot = meta.binanceSpot ? (quotes.binanceSpot?.[symbol] ?? null) : null;
      const binancePerp = meta.binancePerp ? (quotes.binancePerp?.[symbol] ?? null) : null;
      coverage[symbol] = {
        bybitPerp: quoteCoverage(bybitPerp), bybitSpot: quoteCoverage(bybitSpot),
        binanceSpot: quoteCoverage(binanceSpot), binancePerp: quoteCoverage(binancePerp)
      };
      return { symbol, bybitPerp, bybitSpot, binanceSpot, binancePerp };
    });
    return { snapshotId:snapshot.snapshotId, dataCutoff:snapshot.dataCutoff, mode:'snapshot', rows, coverage, nextCursor:null };
  }

  async function collectBybit({ symbol, category, interval, startMs, endMs }) {
    if (typeof bybit.getKlines !== 'function') return [];
    const values = new Map(); let pageEnd = endMs; let safety = 0;
    while (pageEnd >= startMs && safety++ < 10000) {
      const page = await bybit.getKlines({ category, symbol, interval, startMs, endMs:pageEnd, limit:1000 });
      if (!Array.isArray(page) || page.length === 0) break;
      let oldest = Infinity;
      for (const row of page) {
        const ts = finite(row?.[0]); const close = finite(row?.[4]);
        if (!Number.isFinite(ts)) continue;
        oldest = Math.min(oldest, ts);
        const durationMs = interval === 'D' || interval === '1d' ? 86400000 : interval.endsWith?.('h') ? Number(interval.slice(0,-1))*3600000 : Number(String(interval).replace('m',''))*60000;
        if (ts >= startMs && ts + durationMs <= endMs) values.set(ts, close);
      }
      if (!Number.isFinite(oldest) || oldest <= startMs) break;
      const nextEnd = oldest - 1; if (nextEnd >= pageEnd) break; pageEnd = nextEnd;
    }
    return [...values.entries()];
  }

  async function collectBinance(fetchPage, { symbol, interval, startMs, endMs }) {
    if (typeof fetchPage !== 'function') return [];
    const values = new Map(); let pageStart = startMs; let safety = 0;
    while (pageStart <= endMs && safety++ < 10000) {
      const page = await fetchPage({ symbol, interval, startMs:pageStart, endMs, limit:1000 });
      if (!Array.isArray(page) || page.length === 0) break;
      let latest = -Infinity;
      for (const row of page) {
        const ts = finite(row?.[0]); const close = finite(row?.[4]);
        if (!Number.isFinite(ts)) continue;
        latest = Math.max(latest, ts);
        const durationMs = interval === 'D' || interval === '1d' ? 86400000 : interval.endsWith?.('h') ? Number(interval.slice(0,-1))*3600000 : Number(String(interval).replace('m',''))*60000;
        if (ts >= startMs && ts + durationMs <= endMs) values.set(ts, close);
      }
      if (!Number.isFinite(latest) || latest >= endMs || page.length < 1000) break;
      const nextStart = latest + 1; if (nextStart <= pageStart) break; pageStart = nextStart;
    }
    return [...values.entries()];
  }

  async function historyMode(snapshot, symbols, timeframe, startMs, endMs) {
    const tf = TIMEFRAMES[timeframe]; if (!tf) throw new Error('invalid_timeframe');
    const universe = new Map((snapshot.universe ?? []).map(row => [row.symbol, row]));
    const coverage = {}; const rows = [];
    for (const symbol of symbols) {
      const meta = universe.get(symbol); if (!meta) throw new Error(`symbol_not_in_snapshot:${symbol}`);
      const series = { bybitPerp:new Map(), bybitSpot:new Map(), binanceSpot:new Map(), binancePerp:new Map() };
      const symbolCoverage = {
        bybitPerp:{state:'UNAVAILABLE',reason:'not_loaded'},
        bybitSpot:meta.bybitSpot?{state:'UNAVAILABLE',reason:'not_loaded'}:{state:'UNAVAILABLE',reason:'market_unavailable'},
        binanceSpot:meta.binanceSpot?{state:'UNAVAILABLE',reason:'not_loaded'}:{state:'UNAVAILABLE',reason:'market_unavailable'},
        binancePerp:meta.binancePerp?{state:'UNAVAILABLE',reason:'not_loaded'}:{state:'UNAVAILABLE',reason:'market_unavailable'}
      };
      const perp = await collectBybit({ symbol, category:'linear', interval:tf.bybit, startMs, endMs });
      series.bybitPerp = new Map(perp); symbolCoverage.bybitPerp = {state:perp.length?'PARTIAL':'UNAVAILABLE',observedRows:perp.length,reason:perp.length?'time_grid_not_verified':'no_observations'};
      const optional = async (enabled, key, loader) => {
        if (!enabled) return;
        try { series[key] = new Map(await loader()); symbolCoverage[key] = {state:series[key].size?'PARTIAL':'UNAVAILABLE',observedRows:series[key].size,reason:series[key].size?'time_grid_not_verified':'no_observations'}; }
        catch (error) { symbolCoverage[key] = {state:'UNAVAILABLE',reason:String(error?.message ?? 'source_failure')}; }
      };
      await Promise.all([
        optional(meta.bybitSpot,'bybitSpot',()=>collectBybit({ symbol, category:'spot', interval:tf.bybit, startMs, endMs })),
        optional(meta.binanceSpot,'binanceSpot',()=>collectBinance(binance.getSpotKlines?.bind(binance), { symbol, interval:tf.binance, startMs, endMs })),
        optional(meta.binancePerp,'binancePerp',()=>collectBinance(binance.getFuturesKlines?.bind(binance), { symbol, interval:tf.binance, startMs, endMs }))
      ]);
      coverage[symbol] = symbolCoverage;
      const timestamps = new Set(); for (const m of Object.values(series)) for (const ts of m.keys()) timestamps.add(ts);
      for (const timestamp of [...timestamps].sort((a,b)=>a-b)) rows.push({
        symbol, timestamp,
        bybitPerpPrice: series.bybitPerp.get(timestamp) ?? null,
        bybitSpotPrice: series.bybitSpot.get(timestamp) ?? null,
        binanceSpotPrice: series.binanceSpot.get(timestamp) ?? null,
        binancePerpPrice: series.binancePerp.get(timestamp) ?? null
      });
    }
    return { rows, coverage };
  }

  async function getCrossMarketData({ snapshotId, symbols, mode, timeframe, startMs, endMs, cursor, maxRows = 20_000 } = {}) {
    const snapshot = snapshotStore.require(snapshotId);
    if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > 50) throw new Error('invalid_symbols');
    const uniqueSymbols = [...new Set(symbols.map(String))];
    if (uniqueSymbols.length !== symbols.length) throw new Error('duplicate_symbols');
    if (mode === 'snapshot') {
      if (cursor) throw new Error('invalid_cursor');
      return snapshotMode(snapshot, uniqueSymbols);
    }
    if (mode !== 'history') throw new Error('invalid_mode');
    const effectiveEnd = Math.min(Number.isFinite(endMs)?Number(endMs):snapshot.dataCutoff, snapshot.dataCutoff);
    const effectiveStart = Math.max(0, Number.isFinite(startMs)?Number(startMs):effectiveEnd-DEFAULT_LOOKBACK_MS);
    if (effectiveStart > effectiveEnd) throw new Error('invalid_range');
    const query = { snapshotId:snapshot.snapshotId, symbols:uniqueSymbols, mode, timeframe, startMs:effectiveStart, endMs:effectiveEnd };
    const key = keyFor(query);
    const decoded = decodeCursor(cursor);
    if (decoded && (decoded.kind !== 'cross_market' || decoded.key !== key)) throw new Error('invalid_cursor');
    let built = cache.get(key);
    if (!built) { built = await historyMode(snapshot, uniqueSymbols, timeframe, effectiveStart, effectiveEnd); cache.set(key,built); }
    const limit = Math.max(1, Math.min(20_000, Number(maxRows)||20_000));
    const offset = decoded?.offset ?? 0;
    const rows = built.rows.slice(offset,offset+limit);
    const nextOffset = offset + rows.length;
    return { snapshotId:snapshot.snapshotId, dataCutoff:snapshot.dataCutoff, mode:'history', timeframe, startMs:effectiveStart, endMs:effectiveEnd, rows, coverage:built.coverage, nextCursor: nextOffset < built.rows.length ? encodeCursor({kind:'cross_market',key,offset:nextOffset}) : null };
  }

  return { getCrossMarketData };
}
