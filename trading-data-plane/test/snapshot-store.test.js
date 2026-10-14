import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotStore } from '../snapshot-store.js';

function fakeClock(start = 1_000_000) {
  return { value: start, now() { return this.value; } };
}

test('creates unique immutable snapshots with fixed cutoff and expiry', () => {
  const clock = fakeClock();
  const store = createSnapshotStore({ ttlMs: 900_000, clock });
  const source = { dataCutoff: clock.now(), universe: [{ symbol: 'BTCUSDT', lastPrice: 100 }] };
  const first = store.create(source);
  const second = store.create(source);
  assert.notEqual(first.snapshotId, second.snapshotId);
  assert.equal(first.dataCutoff, 1_000_000);
  assert.equal(first.expiresAt, 1_900_000);
  const fetched = store.require(first.snapshotId);
  fetched.universe[0].lastPrice = 999;
  assert.equal(store.require(first.snapshotId).universe[0].lastPrice, 100);
});

test('missing snapshot fails explicitly', () => {
  const store = createSnapshotStore({ clock: fakeClock() });
  assert.throws(() => store.require('missing'), /snapshot_not_found/);
});

test('expired snapshot fails instead of returning current data', () => {
  const clock = fakeClock();
  const store = createSnapshotStore({ ttlMs: 900_000, clock });
  const created = store.create({ dataCutoff: clock.now(), universe: [] });
  clock.value += 900_001;
  assert.throws(() => store.require(created.snapshotId), /snapshot_expired/);
});

test('creating a new snapshot purges previously expired snapshots', () => {
  const clock=fakeClock();
  const store=createSnapshotStore({ttlMs:100,clock});
  const expired=store.create({dataCutoff:clock.now(),universe:[{symbol:'OLDUSDT'}]});
  clock.value += 101;
  store.create({dataCutoff:clock.now(),universe:[{symbol:'NEWUSDT'}]});
  assert.throws(() => store.require(expired.snapshotId), /snapshot_not_found/);
});
