import { createHash } from 'node:crypto';
import { encodeCursor, decodeCursor } from '../cursors.js';
import { createBoundedCache } from '../bounded-cache.js';

const RESOLUTIONS = Object.freeze({
  '5m': { oi:'5min', kline:'5' },
  '15m': { oi:'15min', kline:'15' },
  '30m': { oi:'30min', kline:'30' },
  '1h': { oi:'1h', kline:'60' },
  '4h': { oi:'4h', kline:'240' },
  '1d': { oi:'1d', kline:'D' }
});
const FIELDS = Object.freeze([
  'openInterest','fundingRate','markPrice','indexPrice','basisBps',
  'liquidationBuyNotional','liquidationSellNotional'
]);
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const keyFor = query => createHash('sha256').update(JSON.stringify(query)).digest('base64url');

export function createDerivativesService({ bybit, snapshotStore, liquidationProvider } = {}) {
  if (!bybit) throw new Error('bybit_client_required');
  if (!snapshotStore) throw new Error('snapshot_store_required');
  const cache = createBoundedCache({ maxEntries:16 });

  async function fetchOi(symbol, config, startMs, endMs) {
    const rows = [];
    let cursor = '';
    do {
      const page = await bybit.getOpenInterest({ symbol, intervalTime:config.oi, startMs, endMs, cursor, limit:200 });
      rows.push(...(page?.list ?? []));
      cursor = page?.nextPageCursor ?? '';
    } while (cursor);
    return rows;
  }

  async function fetchBackward(fetchPage, timestampOf, startMs, endMs, limit) {
    const dedupe = new Map();
    let pageEnd = endMs;
    let safety = 0;
    while (pageEnd >= startMs && safety++ < 10000) {
      const page = await fetchPage(pageEnd, limit);
      if (!Array.isArray(page) || page.length === 0) break;
      let oldest = Infinity;
      for (const item of page) {
        const ts = finite(timestampOf(item));
        if (!Number.isFinite(ts)) continue;
        oldest = Math.min(oldest, ts);
        if (ts >= startMs && ts <= endMs) dedupe.set(ts, item);
      }
      if (!Number.isFinite(oldest) || oldest <= startMs) break;
      const nextEnd = oldest - 1;
      if (nextEnd >= pageEnd) break;
      pageEnd = nextEnd;
    }
    return [...dedupe.entries()].sort((a,b) => a[0]-b[0]).map(([,v]) => v);
  }

  async function buildSymbol({ symbol, resolution, startMs, endMs, fields }) {
    const cfg = RESOLUTIONS[resolution];
    const needOi = fields.includes('openInterest');
    const needFunding = fields.includes('fundingRate');
    const needMark = fields.includes('markPrice') || fields.includes('basisBps');
    const needIndex = fields.includes('indexPrice') || fields.includes('basisBps');
    const needLiq = fields.includes('liquidationBuyNotional') || fields.includes('liquidationSellNotional');
    const coverage = {};
    const maps = { oi:new Map(), funding:new Map(), mark:new Map(), index:new Map(), liq:new Map() };

    if (needOi) {
      try {
        const rows = await fetchOi(symbol, cfg, startMs, endMs);
        for (const row of rows) {
          const ts = finite(row.timestamp);
          if (Number.isFinite(ts) && ts >= startMs && ts <= endMs) maps.oi.set(ts, finite(row.openInterest));
        }
        coverage.openInterest = { state:'FULL', startMs, endMs, reason:null };
      } catch (error) { coverage.openInterest = { state:'UNAVAILABLE', startMs, endMs, reason:error.message }; }
    }
    if (needFunding) {
      try {
        const rows = await fetchBackward(
          (pageEnd, limit) => bybit.getFundingHistory({ symbol, startMs, endMs:pageEnd, limit }),
          row => row.fundingRateTimestamp, startMs, endMs, 200
        );
        for (const row of rows) maps.funding.set(Number(row.fundingRateTimestamp), finite(row.fundingRate));
        coverage.funding = { state:'FULL', startMs, endMs, reason:null };
      } catch (error) { coverage.funding = { state:'UNAVAILABLE', startMs, endMs, reason:error.message }; }
    }
    if (needMark) {
      try {
        const rows = await fetchBackward(
          (pageEnd, limit) => bybit.getMarkPriceKlines({ symbol, interval:cfg.kline, startMs, endMs:pageEnd, limit }),
          row => row?.[0], startMs, endMs, 1000
        );
        for (const row of rows) maps.mark.set(Number(row[0]), finite(row[4]));
        coverage.markPrice = { state:'FULL', startMs, endMs, reason:null };
      } catch (error) { coverage.markPrice = { state:'UNAVAILABLE', startMs, endMs, reason:error.message }; }
    }
    if (needIndex) {
      try {
        const rows = await fetchBackward(
          (pageEnd, limit) => bybit.getIndexPriceKlines({ symbol, interval:cfg.kline, startMs, endMs:pageEnd, limit }),
          row => row?.[0], startMs, endMs, 1000
        );
        for (const row of rows) maps.index.set(Number(row[0]), finite(row[4]));
        coverage.indexPrice = { state:'FULL', startMs, endMs, reason:null };
      } catch (error) { coverage.indexPrice = { state:'UNAVAILABLE', startMs, endMs, reason:error.message }; }
    }
    if (needLiq) {
      if (!liquidationProvider?.getAggregates) {
        coverage.liquidations = { state:'UNAVAILABLE', startMs, endMs, reason:'liquidation_provider_unavailable' };
      } else {
        try {
          const result = await liquidationProvider.getAggregates({ symbol, startMs, endMs, resolution });
          for (const row of result?.rows ?? []) maps.liq.set(Number(row.timestamp), {
            liquidationBuyNotional: finite(row.liquidationBuyNotional),
            liquidationSellNotional: finite(row.liquidationSellNotional)
          });
          coverage.liquidations = result?.coverage ?? { state:'PARTIAL', startMs, endMs, reason:'coverage_unspecified' };
        } catch (error) { coverage.liquidations = { state:'UNAVAILABLE', startMs, endMs, reason:error.message }; }
      }
    }

    const timestamps = new Set();
    for (const map of Object.values(maps)) for (const ts of map.keys()) timestamps.add(ts);
    const rows = [...timestamps].sort((a,b)=>a-b).map(timestamp => {
      const out = { symbol, timestamp };
      if (fields.includes('openInterest')) out.openInterest = maps.oi.has(timestamp) ? maps.oi.get(timestamp) : null;
      if (fields.includes('fundingRate')) out.fundingRate = maps.funding.has(timestamp) ? maps.funding.get(timestamp) : null;
      if (fields.includes('markPrice')) out.markPrice = maps.mark.has(timestamp) ? maps.mark.get(timestamp) : null;
      if (fields.includes('indexPrice')) out.indexPrice = maps.index.has(timestamp) ? maps.index.get(timestamp) : null;
      if (fields.includes('basisBps')) {
        const mark = maps.mark.get(timestamp); const index = maps.index.get(timestamp);
        out.basisBps = Number.isFinite(mark) && Number.isFinite(index) && index !== 0 ? ((mark-index)/index)*10_000 : null;
      }
      if (fields.includes('liquidationBuyNotional')) out.liquidationBuyNotional = maps.liq.get(timestamp)?.liquidationBuyNotional ?? null;
      if (fields.includes('liquidationSellNotional')) out.liquidationSellNotional = maps.liq.get(timestamp)?.liquidationSellNotional ?? null;
      return out;
    });
    return { rows, coverage };
  }

  async function getHistoricalDerivativesData({
    snapshotId, symbols, resolution, startMs, endMs, fields = FIELDS, cursor, maxRows = 20_000
  } = {}) {
    const snapshot = snapshotStore.require(snapshotId);
    if (!RESOLUTIONS[resolution]) throw new Error('invalid_resolution');
    if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > 50) throw new Error('invalid_symbols');
    const uniqueSymbols = [...new Set(symbols.map(String))];
    if (uniqueSymbols.length !== symbols.length) throw new Error('duplicate_symbols');
    const selected = [...new Set(fields ?? FIELDS)];
    if (selected.length < 1 || selected.some(field => !FIELDS.includes(field))) throw new Error('invalid_fields');
    const universe = new Set((snapshot.universe ?? []).map(row => row.symbol));
    for (const symbol of uniqueSymbols) if (!universe.has(symbol)) throw new Error(`symbol_not_in_snapshot:${symbol}`);
    const effectiveEnd = Math.min(Number.isFinite(endMs) ? Number(endMs) : snapshot.dataCutoff, snapshot.dataCutoff);
    const effectiveStart = Math.max(0, Number.isFinite(startMs) ? Number(startMs) : effectiveEnd - DEFAULT_LOOKBACK_MS);
    const query = { snapshotId:snapshot.snapshotId, symbols:uniqueSymbols, resolution, startMs:effectiveStart, endMs:effectiveEnd, fields:selected };
    const key = keyFor(query);
    const decoded = decodeCursor(cursor);
    if (decoded && (decoded.kind !== 'derivatives' || decoded.key !== key)) throw new Error('invalid_cursor');
    let cached = cache.get(key);
    if (!cached) {
      const allRows = []; const coverage = {};
      for (const symbol of uniqueSymbols) {
        const built = await buildSymbol({ symbol, resolution, startMs:effectiveStart, endMs:effectiveEnd, fields:selected });
        allRows.push(...built.rows); coverage[symbol] = built.coverage;
      }
      cached = { rows:allRows, coverage };
      cache.set(key, cached);
    }
    const offset = decoded?.offset ?? 0;
    const limit = Math.max(1, Math.min(20_000, Number(maxRows) || 20_000));
    const rows = cached.rows.slice(offset, offset+limit);
    const nextOffset = offset + rows.length;
    return {
      snapshotId:snapshot.snapshotId, dataCutoff:snapshot.dataCutoff,
      resolution, startMs:effectiveStart, endMs:effectiveEnd,
      rows, coverage:cached.coverage,
      nextCursor: nextOffset < cached.rows.length ? encodeCursor({ kind:'derivatives', key, offset:nextOffset }) : null
    };
  }

  return { getHistoricalDerivativesData };
}
