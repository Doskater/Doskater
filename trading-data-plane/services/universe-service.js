import { encodeCursor, decodeCursor } from '../cursors.js';

const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function tradingSpotSet(info) {
  return new Set((info?.symbols ?? []).filter(x => x.status === 'TRADING' && x.quoteAsset === 'USDT').map(x => x.symbol));
}

function tradingFuturesSet(info) {
  return new Set((info?.symbols ?? []).filter(x => x.status === 'TRADING' && x.quoteAsset === 'USDT' && x.contractType === 'PERPETUAL').map(x => x.symbol));
}

export function createUniverseService({ bybit, binance, snapshotStore } = {}) {
  if (!bybit) throw new Error('bybit_client_required');
  if (!binance) throw new Error('binance_client_required');

  function bybitQuote(row = {}) {
    return {
      bidPrice: finite(row.bid1Price), bidSize: finite(row.bid1Size),
      askPrice: finite(row.ask1Price), askSize: finite(row.ask1Size),
      lastPrice: finite(row.lastPrice), markPrice: finite(row.markPrice), indexPrice: finite(row.indexPrice)
    };
  }

  function binanceQuote(row = {}) {
    return {
      bidPrice: finite(row.bidPrice), bidSize: finite(row.bidQty),
      askPrice: finite(row.askPrice), askSize: finite(row.askQty)
    };
  }

  async function captureBundle(_dataCutoff) {
    const [instruments, spotInstruments, tickers, spotTickers, binanceSpotInfo, binanceFuturesInfo, binanceSpotBooks, binanceFuturesBooks] = await Promise.all([
      bybit.listLinearInstruments(),
      bybit.listSpotInstruments().catch(() => []),
      bybit.getLinearTickers(),
      typeof bybit.getSpotTickers === 'function' ? bybit.getSpotTickers().catch(() => []) : [],
      binance.getSpotExchangeInfo().catch(() => ({ symbols: [] })),
      binance.getFuturesExchangeInfo().catch(() => ({ symbols: [] })),
      typeof binance.getSpotBookTickers === 'function' ? binance.getSpotBookTickers().catch(() => []) : [],
      typeof binance.getFuturesBookTickers === 'function' ? binance.getFuturesBookTickers().catch(() => []) : []
    ]);
    const tickerMap = new Map(tickers.map(row => [row.symbol, row]));
    const bybitSpot = new Set(spotInstruments.map(row => row.symbol));
    const binanceSpot = tradingSpotSet(binanceSpotInfo);
    const binancePerp = tradingFuturesSet(binanceFuturesInfo);

    const universe = instruments.map(instrument => {
      const ticker = tickerMap.get(instrument.symbol) ?? {};
      return {
        symbol: instrument.symbol,
        launchTime: finite(instrument.launchTime),
        fundingIntervalMinutes: finite(instrument.fundingInterval),
        prevPrice24h: finite(ticker.prevPrice24h),
        prevPrice1h: finite(ticker.prevPrice1h),
        highPrice24h: finite(ticker.highPrice24h),
        lowPrice24h: finite(ticker.lowPrice24h),
        lastPrice: finite(ticker.lastPrice),
        turnover24h: finite(ticker.turnover24h),
        volume24h: finite(ticker.volume24h),
        bid1Price: finite(ticker.bid1Price),
        bid1Size: finite(ticker.bid1Size),
        ask1Price: finite(ticker.ask1Price),
        ask1Size: finite(ticker.ask1Size),
        markPrice: finite(ticker.markPrice),
        indexPrice: finite(ticker.indexPrice),
        openInterest: finite(ticker.openInterest),
        fundingRate: finite(ticker.fundingRate),
        nextFundingTime: finite(ticker.nextFundingTime),
        bybitSpot: bybitSpot.has(instrument.symbol),
        binanceSpot: binanceSpot.has(instrument.symbol),
        binancePerp: binancePerp.has(instrument.symbol)
      };
    });
    return {
      universe,
      crossQuotes: {
        bybitLinear: Object.fromEntries(tickers.map(row => [row.symbol, bybitQuote(row)])),
        bybitSpot: Object.fromEntries(spotTickers.map(row => [row.symbol, bybitQuote(row)])),
        binanceSpot: Object.fromEntries(binanceSpotBooks.map(row => [row.symbol, binanceQuote(row)])),
        binancePerp: Object.fromEntries(binanceFuturesBooks.map(row => [row.symbol, binanceQuote(row)]))
      }
    };
  }

  async function capture(dataCutoff) {
    return (await captureBundle(dataCutoff)).universe;
  }

  function getUniverse({ snapshotId, cursor, limit = 200 } = {}) {
    if (!snapshotStore) throw new Error('snapshot_store_required');
    const snapshot = snapshotStore.require(snapshotId);
    const decoded = decodeCursor(cursor);
    if (decoded && decoded.kind !== 'universe') throw new Error('invalid_cursor');
    const offset = decoded?.offset ?? 0;
    const pageSize = Math.max(1, Math.min(1000, Number(limit) || 200));
    const rows = Array.isArray(snapshot.universe) ? snapshot.universe : [];
    const page = rows.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      snapshotId: snapshot.snapshotId,
      dataCutoff: snapshot.dataCutoff,
      rows: page,
      nextCursor: nextOffset < rows.length ? encodeCursor({ kind: 'universe', offset: nextOffset }) : null
    };
  }

  return { capture, captureBundle, getUniverse };
}
