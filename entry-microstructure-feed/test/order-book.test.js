import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderBook } from '../order-book.js';

function freshBook() {
  const book = createOrderBook({ venue: 'binance', market: 'spot', symbol: 'BTCUSDT', maxLevels: 10 });
  book.reset({
    bids: [[100, 2], [99, 3]], asks: [[101, 4], [102, 5]],
    sequence: 10, eventTs: 1000, receiveTs: 1001
  });
  return book;
}

test('loads snapshot and exposes sorted top of book', () => {
  const snap = freshBook().snapshot();
  assert.equal(snap.healthy, true);
  assert.equal(snap.bestBid, 100);
  assert.equal(snap.bestAsk, 101);
  assert.equal(snap.spread, 1);
  assert.equal(snap.mid, 100.5);
  assert.deepEqual(snap.bids, [[100,2],[99,3]]);
  assert.deepEqual(snap.asks, [[101,4],[102,5]]);
});

test('applies add update and zero-size delete', () => {
  const book = freshBook();
  book.apply({ bids: [[100, 1], [98, 7]], asks: [[101, 0], [100.8, 2]], finalUpdateId: 11, firstUpdateId: 11, previousFinalUpdateId: 10, eventTs: 1010, receiveTs: 1011 });
  const snap = book.snapshot();
  assert.deepEqual(snap.bids, [[100,1],[99,3],[98,7]]);
  assert.deepEqual(snap.asks, [[100.8,2],[102,5]]);
  assert.equal(snap.bestAsk, 100.8);
});

test('computes depth inside bps band using notional', () => {
  const book = freshBook();
  const depth = book.depthWithinBps(150);
  assert.equal(depth.healthy, true);
  assert.equal(depth.bidQty, 5);
  assert.equal(depth.askQty, 9);
  assert.equal(depth.bidNotional, 497);
  assert.equal(depth.askNotional, 914);
});

test('crossed book invalidates immediately', () => {
  const book = freshBook();
  const result = book.apply({ bids: [[102, 1]], asks: [], finalUpdateId: 11, firstUpdateId: 11, previousFinalUpdateId: 10, eventTs: 1010, receiveTs: 1011 });
  assert.equal(result.ok, false);
  assert.match(book.health().reason, /crossed_book/);
  assert.equal(book.snapshot().healthy, false);
});

test('sequence gap invalidates and later deltas cannot restore health without reset', () => {
  const book = freshBook();
  const gap = book.apply({ bids: [[100, 1]], asks: [], firstUpdateId: 12, finalUpdateId: 12, previousFinalUpdateId: 11, eventTs: 1010, receiveTs: 1011 });
  assert.equal(gap.ok, false);
  assert.match(book.health().reason, /sequence_gap/);
  assert.equal(book.snapshot().healthy, false);

  const later = book.apply({ bids: [[100, 2]], asks: [], firstUpdateId: 13, finalUpdateId: 13, previousFinalUpdateId: 12, eventTs: 1020, receiveTs: 1021 });
  assert.equal(later.ok, false);
  assert.equal(book.snapshot().healthy, false);

  book.reset({ bids: [[100,2]], asks: [[101,2]], sequence: 20, eventTs: 1030, receiveTs: 1031 });
  assert.equal(book.snapshot().healthy, true);
  assert.equal(book.health().sequence, 20);
});

test('monotonic generic sequence rejects regressions', () => {
  const book = freshBook();
  book.apply({ bids: [], asks: [[101, 3]], sequence: 11, eventTs: 1010, receiveTs: 1011 });
  assert.equal(book.health().sequence, 11);
  const bad = book.apply({ bids: [], asks: [], sequence: 10, eventTs: 1020, receiveTs: 1021 });
  assert.equal(bad.ok, false);
  assert.match(book.health().reason, /sequence_regression/);
});
