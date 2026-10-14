import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedCache } from '../bounded-cache.js';

test('bounded cache evicts the oldest query after sixteen entries', () => {
  const cache=createBoundedCache({maxEntries:16});
  for(let i=0;i<17;i++) cache.set(`q${i}`,{value:i});
  assert.equal(cache.size,16);
  assert.equal(cache.get('q0'),undefined);
  assert.deepEqual(cache.get('q16'),{value:16});
});

test('updating an existing key refreshes it without growing the cache', () => {
  const cache=createBoundedCache({maxEntries:2});
  cache.set('a',1); cache.set('b',2); cache.set('a',3); cache.set('c',4);
  assert.equal(cache.size,2);
  assert.equal(cache.get('b'),undefined);
  assert.equal(cache.get('a'),3);
  assert.equal(cache.get('c'),4);
});
