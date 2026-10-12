const OMIT_KEYS = new Set(['raw', 'payload', 'data', 'body', 'authorization']);

function sanitize(value, secret) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return secret ? value.split(secret).join('REDACTED') : value;
  if (Array.isArray(value)) return value.map(item => sanitize(item, secret));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (OMIT_KEYS.has(key)) continue;
      out[key] = sanitize(item, secret);
    }
    return out;
  }
  return value;
}

export function createLogger({ sink = line => console.log(line), env = process.env, clock = Date } = {}) {
  const secret = String(env.MICROSTRUCTURE_FEED_TOKEN ?? '');
  const write = (level, event) => {
    const payload = sanitize(typeof event === 'object' && event !== null ? event : { message: String(event) }, secret);
    sink(JSON.stringify({ ts: new Date(typeof clock.now === 'function' ? clock.now() : Date.now()).toISOString(), level, ...payload }));
  };
  return {
    info: event => write('info', event),
    warn: event => write('warn', event),
    error: event => write('error', event)
  };
}
