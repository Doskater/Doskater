function isTransient(error) {
  const status = Number(error?.status);
  return !Number.isFinite(status) || status === 429 || status >= 500;
}

export async function withRetry(fn, {
  retries = 3,
  baseDelayMs = 250,
  maxDelayMs = 2000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (error) {
      if (!isTransient(error) || attempt >= retries) throw error;
      const retryAfterMs = Number(error?.retryAfterMs);
      const delay = Number.isFinite(retryAfterMs)
        ? retryAfterMs
        : Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
      attempt += 1;
      if (delay > 0) await sleep(delay);
    }
  }
}
