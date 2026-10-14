export function createSnapshotService({ snapshotStore, sourceHealth, captureUniverse, clock = Date }) {
  if (!snapshotStore) throw new Error('snapshot_store_required');
  if (!sourceHealth) throw new Error('source_health_required');
  if (typeof captureUniverse !== 'function') throw new Error('capture_universe_required');
  const now = () => typeof clock.now === 'function' ? clock.now() : Date.now();

  async function prepareSnapshot() {
    const dataCutoff = now();
    const captured = await captureUniverse(dataCutoff);
    const universe = Array.isArray(captured) ? captured : (captured?.universe ?? []);
    const extras = Array.isArray(captured) || !captured || typeof captured !== 'object'
      ? {}
      : Object.fromEntries(Object.entries(captured).filter(([key]) => key !== 'universe'));
    const sourceHealthSnapshot = sourceHealth.snapshot();
    const stored = snapshotStore.create({ dataCutoff, universe, ...extras, sourceHealth: sourceHealthSnapshot });
    return {
      snapshotId: stored.snapshotId,
      createdAt: stored.createdAt,
      dataCutoff: stored.dataCutoff,
      universeCount: Array.isArray(universe) ? universe.length : 0,
      sourceHealth: sourceHealthSnapshot,
      expiresAt: stored.expiresAt
    };
  }

  function sourceHealthSnapshot() {
    return sourceHealth.snapshot();
  }

  return { prepareSnapshot, sourceHealth: sourceHealthSnapshot };
}
