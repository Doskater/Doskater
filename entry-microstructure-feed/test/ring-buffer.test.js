import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimedRingBuffer } from '../ring-buffer.js';

test('keeps chronological events and supports since/between reads', () => {
  let now = 10_000;
  const buffer = createTimedRingBuffer({ retentionMs: 10_000, maxItems: 10, now: () => now });
  buffer.push({ ts: 9_000, id: 'b' });
  buffer.push({ ts: 8_000, id: 'a' });
  buffer.push({ ts: 9_500, id: 'c' });
  assert.deepEqual(buffer.since(8_500).map(x => x.id), ['b', 'c']);
  assert.deepEqual(buffer.between(8_500, 9_100).map(x => x.id), ['b']);
});

test('prunes events older than retention using injected clock', () => {
  let now = 10_000;
  const buffer = createTimedRingBuffer({ retentionMs: 2_000, maxItems: 10, now: () => now });
  buffer.push({ ts: 7_999, id: 'old' });
  buffer.push({ ts: 8_500, id: 'keep' });
  buffer.prune();
  assert.deepEqual(buffer.since(0).map(x => x.id), ['keep']);
  now = 11_000;
  buffer.prune();
  assert.equal(buffer.size(), 0);
});

test('enforces maxItems by dropping oldest timestamps', () => {
  const buffer = createTimedRingBuffer({ retentionMs: 99_999, maxItems: 3, now: () => 10_000 });
  for (const [ts, id] of [[1000,'a'], [2000,'b'], [3000,'c'], [4000,'d']]) buffer.push({ ts, id });
  assert.deepEqual(buffer.since(0).map(x => x.id), ['b', 'c', 'd']);
  assert.equal(buffer.size(), 3);
});

test('rejects events without a finite timestamp', () => {
  const buffer = createTimedRingBuffer({ retentionMs: 1000, maxItems: 3, now: () => 1000 });
  assert.throws(() => buffer.push({ id: 'bad' }), /invalid_event_timestamp/);
});
