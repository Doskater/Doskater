export function createSourceHealth({ clock = Date, freshMs = 30_000 } = {}) {
  const rows = new Map();
  const now = () => typeof clock.now === 'function' ? clock.now() : Date.now();

  function record(source, sample = {}) {
    const key = String(source);
    const previous = rows.get(key) ?? {};
    const at = Number.isFinite(sample.at) ? Number(sample.at) : now();
    if (sample.ok) {
      rows.set(key, {
        ...previous,
        lastSuccessAt: at,
        lastAttemptAt: at,
        latencyMs: Number.isFinite(sample.latencyMs) ? Number(sample.latencyMs) : null,
        reason: null
      });
      return;
    }
    rows.set(key, {
      ...previous,
      lastAttemptAt: at,
      reason: sample.reason ? String(sample.reason) : 'source_failure'
    });
  }

  function snapshot() {
    const current = now();
    const out = {};
    for (const [source, row] of rows) {
      let state = 'UNAVAILABLE';
      if (Number.isFinite(row.lastSuccessAt)) {
        state = current - row.lastSuccessAt <= freshMs ? 'GOOD' : 'DEGRADED';
      }
      out[source] = {
        state,
        lastSuccessAt: row.lastSuccessAt ?? null,
        lastAttemptAt: row.lastAttemptAt ?? null,
        ageMs: Number.isFinite(row.lastSuccessAt) ? Math.max(0, current - row.lastSuccessAt) : null,
        latencyMs: row.latencyMs ?? null,
        reason: state === 'GOOD' ? null : (row.reason ?? (state === 'DEGRADED' ? 'stale' : 'no_success'))
      };
    }
    return out;
  }

  return { record, snapshot };
}
