import { withRetry } from './retry.js';

function requestError(message, status, retryAfterMs) {
  const error = new Error(message);
  error.status = status;
  if (Number.isFinite(retryAfterMs)) error.retryAfterMs = retryAfterMs;
  return error;
}

export function createBinanceRestClient({
  fetchImpl = fetch,
  spotBaseUrl = 'https://api.binance.com',
  futuresBaseUrl = 'https://fapi.binance.com',
  retry = withRetry,
  health,
  clock = Date
} = {}) {
  const now = () => typeof clock.now === 'function' ? clock.now() : Date.now();

  async function get(baseUrl, path, source, params = {}) {
    const started = now();
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    try {
      const payload = await retry(async () => {
        const res = await fetchImpl(url.toString(), { headers: { accept: 'application/json' } });
        if (!res.ok) {
          const retryAfter = Number(res.headers.get('retry-after'));
          throw requestError(`binance_http_${res.status}`, res.status, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
        }
        return res.json();
      });
      health?.record?.(source, { ok: true, at: now(), latencyMs: Math.max(0, now() - started) });
      return payload;
    } catch (error) {
      health?.record?.(source, { ok: false, at: now(), reason: error.message });
      throw error;
    }
  }

  const getSpotExchangeInfo = () => get(spotBaseUrl, '/api/v3/exchangeInfo', 'binance_spot_rest');
  const getFuturesExchangeInfo = () => get(futuresBaseUrl, '/fapi/v1/exchangeInfo', 'binance_futures_rest');
  const getSpotBookTickers = () => get(spotBaseUrl, '/api/v3/ticker/bookTicker', 'binance_spot_rest');
  const getFuturesBookTickers = () => get(futuresBaseUrl, '/fapi/v1/ticker/bookTicker', 'binance_futures_rest');
  const getSpotKlines = ({ symbol, interval, startMs, endMs, limit = 1000 }) => get(spotBaseUrl, '/api/v3/klines', 'binance_spot_rest', { symbol, interval, startTime:startMs, endTime:endMs, limit });
  const getFuturesKlines = ({ symbol, interval, startMs, endMs, limit = 1000 }) => get(futuresBaseUrl, '/fapi/v1/klines', 'binance_futures_rest', { symbol, interval, startTime:startMs, endTime:endMs, limit });

  return { getSpotExchangeInfo, getFuturesExchangeInfo, getSpotBookTickers, getFuturesBookTickers, getSpotKlines, getFuturesKlines };
}
