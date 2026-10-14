import { withRetry } from './retry.js';

function requestError(message, status, retryAfterMs) {
  const error = new Error(message);
  error.status = status;
  if (Number.isFinite(retryAfterMs)) error.retryAfterMs = retryAfterMs;
  return error;
}

export function createBybitRestClient({
  fetchImpl = fetch,
  baseUrl = 'https://api.bybit.com',
  retry = withRetry,
  health,
  clock = Date
} = {}) {
  const now = () => typeof clock.now === 'function' ? clock.now() : Date.now();

  async function get(path, params = {}) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    const started = now();
    try {
      const payload = await retry(async () => {
        const res = await fetchImpl(url.toString(), { headers: { accept: 'application/json' } });
        if (!res.ok) {
          const retryAfter = Number(res.headers.get('retry-after'));
          throw requestError(`bybit_http_${res.status}`, res.status, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
        }
        const body = await res.json();
        if (Number(body?.retCode ?? 0) !== 0) throw requestError(`bybit_ret_${body.retCode}:${body.retMsg ?? 'error'}`, 400);
        return body;
      });
      health?.record?.('bybit_rest', { ok: true, at: now(), latencyMs: Math.max(0, now() - started) });
      return payload;
    } catch (error) {
      health?.record?.('bybit_rest', { ok: false, at: now(), reason: error.message });
      throw error;
    }
  }

  async function listLinearInstruments() {
    const rows = [];
    let cursor = '';
    do {
      const body = await get('/v5/market/instruments-info', { category: 'linear', status: 'Trading', limit: 1000, cursor });
      for (const row of body?.result?.list ?? []) {
        if (row.status === 'Trading' && row.quoteCoin === 'USDT' && row.settleCoin === 'USDT' && row.contractType === 'LinearPerpetual') rows.push(row);
      }
      cursor = body?.result?.nextPageCursor ?? '';
    } while (cursor);
    return rows;
  }

  async function listSpotInstruments() {
    const body = await get('/v5/market/instruments-info', { category: 'spot', status: 'Trading' });
    return (body?.result?.list ?? []).filter(row => row.status === 'Trading' && row.quoteCoin === 'USDT');
  }

  async function getLinearTickers() {
    const body = await get('/v5/market/tickers', { category: 'linear' });
    return body?.result?.list ?? [];
  }

  async function getSpotTickers() {
    const body = await get('/v5/market/tickers', { category: 'spot' });
    return body?.result?.list ?? [];
  }

  async function getKlines({ category = 'linear', symbol, interval, startMs, endMs, limit = 1000 }) {
    const body = await get('/v5/market/kline', {
      category, symbol, interval, start: startMs, end: endMs, limit
    });
    return body?.result?.list ?? [];
  }


  async function getOpenInterest({ symbol, intervalTime, startMs, endMs, cursor, limit = 200 }) {
    const body = await get('/v5/market/open-interest', {
      category:'linear', symbol, intervalTime, startTime:startMs, endTime:endMs, cursor, limit
    });
    return { list: body?.result?.list ?? [], nextPageCursor: body?.result?.nextPageCursor ?? '' };
  }

  async function getFundingHistory({ symbol, startMs, endMs, limit = 200 }) {
    const body = await get('/v5/market/funding/history', {
      category:'linear', symbol, startTime:startMs, endTime:endMs, limit
    });
    return body?.result?.list ?? [];
  }

  async function getMarkPriceKlines({ symbol, interval, startMs, endMs, limit = 1000 }) {
    const body = await get('/v5/market/mark-price-kline', {
      category:'linear', symbol, interval, start:startMs, end:endMs, limit
    });
    return body?.result?.list ?? [];
  }

  async function getIndexPriceKlines({ symbol, interval, startMs, endMs, limit = 1000 }) {
    const body = await get('/v5/market/index-price-kline', {
      category:'linear', symbol, interval, start:startMs, end:endMs, limit
    });
    return body?.result?.list ?? [];
  }

  return { listLinearInstruments, listSpotInstruments, getLinearTickers, getSpotTickers, getKlines, getOpenInterest, getFundingHistory, getMarkPriceKlines, getIndexPriceKlines, _get: get };
}
