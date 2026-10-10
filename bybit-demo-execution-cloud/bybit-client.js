import crypto from 'node:crypto';

export const BYBIT_DEMO_HOST = 'https://api-demo.bybit.com';
const RECV_WINDOW = '5000';
const SIGNATURE_RE = /\b[a-f0-9]{64}\b/gi;

function redactString(value, secrets) {
  let result = String(value);
  for (const secret of secrets.filter(Boolean)) {
    result = result.split(String(secret)).join('[REDACTED]');
  }
  return result.replace(SIGNATURE_RE, '[REDACTED]');
}

export function redactSensitive(value, secrets = []) {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactSensitive(item, secrets));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const sensitiveKey = /secret|signature|api[-_]?key/i.test(key);
      result[key] = sensitiveKey ? '[REDACTED]' : redactSensitive(item, secrets);
    }
    return result;
  }
  return value;
}

function assertRelativeV5Path(path) {
  if (typeof path !== 'string' || !path.startsWith('/v5/') || path.includes('://')) {
    throw new Error('Bybit path must be a relative /v5/ path');
  }
}

function encodeQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.toString();
}

export function createBybitClient({ apiKey, apiSecret, fetchImpl = fetch, now = Date.now } = {}) {
  if (!apiKey || !apiSecret) throw new Error('Missing Bybit Demo credentials');
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');

  async function request(method, path, params = {}) {
    assertRelativeV5Path(path);
    const upper = String(method).toUpperCase();
    if (!['GET', 'POST'].includes(upper)) throw new Error('Only GET and POST are supported');

    const timestamp = String(now());
    let url = BYBIT_DEMO_HOST + path;
    let body;
    let signingData;

    if (upper === 'GET') {
      const query = encodeQuery(params);
      if (query) url += `?${query}`;
      signingData = query;
    } else {
      body = JSON.stringify(params ?? {});
      signingData = body;
    }

    const signaturePayload = timestamp + apiKey + RECV_WINDOW + signingData;
    const signature = crypto.createHmac('sha256', apiSecret).update(signaturePayload).digest('hex');

    let response;
    try {
      response = await fetchImpl(url, {
        method: upper,
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-SIGN': signature,
          'X-BAPI-RECV-WINDOW': RECV_WINDOW,
          'Content-Type': 'application/json'
        },
        body
      });
    } catch (error) {
      throw new Error(redactString(error?.message || 'Bybit request failed', [apiKey, apiSecret, signature]));
    }

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Bybit returned non-JSON response (${response.status})`);
    }

    if (!response.ok || payload.retCode !== 0) {
      const safe = redactSensitive(payload, [apiKey, apiSecret, signature]);
      throw new Error(`Bybit Demo API error: ${JSON.stringify(safe)}`);
    }
    return payload;
  }

  return { host: BYBIT_DEMO_HOST, request };
}
