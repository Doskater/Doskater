import { randomUUID } from 'node:crypto';

function clone(value) {
  return structuredClone(value);
}

export function createSnapshotStore({ ttlMs = 900_000, clock = Date } = {}) {
  const snapshots = new Map();
  const now = () => typeof clock.now === 'function' ? clock.now() : Date.now();

  function purge() {
    const current = now();
    for (const [id, entry] of snapshots) {
      if (current > entry.expiresAt) snapshots.delete(id);
    }
  }

  function create(payload = {}) {
    purge();
    const createdAt = now();
    const dataCutoff = Number.isFinite(payload.dataCutoff) ? Number(payload.dataCutoff) : createdAt;
    const entry = Object.freeze({
      ...clone(payload),
      snapshotId: randomUUID(),
      createdAt,
      dataCutoff,
      expiresAt: createdAt + ttlMs
    });
    snapshots.set(entry.snapshotId, clone(entry));
    return clone(entry);
  }

  function get(id) {
    const entry = snapshots.get(String(id));
    if (!entry) return null;
    if (now() > entry.expiresAt) {
      snapshots.delete(String(id));
      return null;
    }
    return clone(entry);
  }

  function requireSnapshot(id) {
    const key = String(id);
    const entry = snapshots.get(key);
    if (!entry) throw new Error('snapshot_not_found');
    if (now() > entry.expiresAt) {
      snapshots.delete(key);
      throw new Error('snapshot_expired');
    }
    return clone(entry);
  }

  return { create, get, require: requireSnapshot, purge };
}
