import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../upstream/retry.js';

test('retries transient failures up to success', async () => {
  let attempts = 0;
  const result = await withRetry(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('temporary');
      error.status = 500;
      throw error;
    }
    return 'ok';
  }, { retries: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('does not retry non-transient 4xx', async () => {
  let attempts = 0;
  await assert.rejects(() => withRetry(async () => {
    attempts += 1;
    const error = new Error('bad_request');
    error.status = 400;
    throw error;
  }, { retries: 3, baseDelayMs: 0, sleep: async () => {} }), /bad_request/);
  assert.equal(attempts, 1);
});
