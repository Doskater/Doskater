import { createHash } from 'node:crypto';
import { encodeCursor, decodeCursor } from '../cursors.js';
import { createBoundedCache } from '../bounded-cache.js';

const INTERVALS = Object.freeze({ '1m':'1', '5m':'5', '15m':'15', '1h':'60', '4h':'240', '1d':'D' });
const ALL_FIELDS = Object.freeze(['timestamp','open','high','low','close','volume','turnover']);
const DEFAULT_LOOKBACK_MS = Object.freeze({
  '1m': 7 * 24 * 60 * 60 * 1000,
  '5m': 30 * 24 * 60 * 60 * 1000,
  '15m': 60 * 24 * 60 * 60 * 1000,
  '1h': 90 * 24 * 60 * 60 * 1000,
  '4h': 180 * 24 * 60 * 60 * 1000,
  '1d': 730 * 24 * 60 * 60 * 1000
});

const finite = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function normalizeKline(symbol, row) {
  const timestamp = finite(row?.[0]);
  if (!Number.isFinite(timestamp)) return null;
  return {
    symbol,
    timestamp,
    open: finite(row[1]), high: finite(row[2]), low: finite(row[3]), close: finite(row[4]),
    volume: finite(row[5]), turnover: finite(row[6])
  };
}

function queryKey(query) {
  return createHash('sha256').update(JSON.stringify(query)).digest('base64url');
}

export function createMarketHistoryService({ bybit, snapshotStore } = {}) {
  if (!bybit?.getKlines) throw new Error('bybit_kline_client_required');
  if (!snapshotStore) throw new Error('snapshot_store_required');
  const cache = createBoundedCache({ maxEntries:16 });

  async function collectSymbol({ symbol, interval, startMs, endMs }) {
    const dedupe = new Map();
    let pageEnd = endMs;
    let safety = 0;
    while (pageEnd >= startMs && safety++ < 10000) {
      const page = await bybit.getKlines({ category:'linear', symbol, interval, startMs, endMs:pageEnd, limit:1000 });
      if (!Array.isArray(page) || page.length === 0) break;
      let oldest = Infinity;
      for (const raw of page) {
        const row = normalizeKline(symbol, raw);
        if (!row) continue;
        oldest = Math.min(oldest, row.timestamp);
        if (row.timestamp < startMs || row.timestamp > endMs) continue;
        dedupe.set(row.timestamp, row);
      }
      if (!Number.isFinite(oldest) || oldest <= startMs) break;
      const nextEnd = oldest - 1;
      if (nextEnd >= pageEnd) break;
      pageEnd = nextEnd;
    }
    return [...dedupe.values()].sort((a,b) => a.timestamp - b.timestamp);
  }

  async function buildRows({ snapshot, symbols, timeframe, startMs, endMs }) {
    const interval = INTERVALS[timeframe];
    if (!interval) throw new Error('invalid_timeframe');
    const universe = new Set((snapshot.universe ?? []).map(row => row.symbol));
    for (const symbol of symbols) if (!universe.has(symbol)) throw new Error(`symbol_not_in_snapshot:${symbol}`);
    const grouped = [];
    for (const symbol of symbols) grouped.push(...await collectSymbol({ symbol, interval, startMs, endMs }));
    return grouped;
  }

  async function getHistoricalMarketData({
    snapshotId, symbols, timeframe, startMs, endMs, fields = ALL_FIELDS, cursor, maxRows = 20_000
  } = {}) {
    const snapshot = snapshotStore.require(snapshotId);
    if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > 50) throw new Error('invalid_symbols');
    const uniqueSymbols = [...new Set(symbols.map(String))];
    if (uniqueSymbols.length !== symbols.length) throw new Error('duplicate_symbols');
    if (!INTERVALS[timeframe]) throw new Error('invalid_timeframe');
    const selected = [...new Set(fields ?? ALL_FIELDS)];
    if (selected.length < 1 || selected.some(field => !ALL_FIELDS.includes(field))) throw new Error('invalid_fields');
    const effectiveEnd = Math.min(Number.isFinite(endMs) ? Number(endMs) : snapshot.dataCutoff, snapshot.dataCutoff);
    const effectiveStart = Math.max(0, Number.isFinite(startMs) ? Number(startMs) : effectiveEnd - DEFAULT_LOOKBACK_MS[timeframe]);
    if (effectiveStart > effectiveEnd) throw new Error('invalid_range');
    const normalizedQuery = { snapshotId:snapshot.snapshotId, symbols:uniqueSymbols, timeframe, startMs:effectiveStart, endMs:effectiveEnd, fields:selected };
    const key = queryKey(normalizedQuery);
    const decoded = decodeCursor(cursor);
    if (decoded && (decoded.kind !== 'market_history' || decoded.key !== key)) throw new Error('invalid_cursor');
    let rows = cache.get(key);
    if (!rows) {
      rows = await buildRows({ snapshot, symbols:uniqueSymbols, timeframe, startMs:effectiveStart, endMs:effectiveEnd });
      cache.set(key, rows);
    }
    const offset = decoded?.offset ?? 0;
    const limit = Math.max(1, Math.min(20_000, Number(maxRows) || 20_000));
    const rawPage = rows.slice(offset, offset + limit);
    const page = rawPage.map(row => {
      const out = { symbol: row.symbol };
      for (const field of selected) out[field] = row[field];
      return out;
    });
    const nextOffset = offset + rawPage.length;
    return {
      snapshotId: snapshot.snapshotId,
      dataCutoff: snapshot.dataCutoff,
      timeframe,
      startMs: effectiveStart,
      endMs: effectiveEnd,
      rows: page,
      nextCursor: nextOffset < rows.length ? encodeCursor({ kind:'market_history', key, offset:nextOffset }) : null
    };
  }

  return { getHistoricalMarketData };
}
