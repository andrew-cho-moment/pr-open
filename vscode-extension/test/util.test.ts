import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TtlCache } from '../src/util';

test('TtlCache: serves a live entry', () => {
  const cache = new TtlCache<number>(60_000);
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
});

test('TtlCache: an expired entry reads as a miss', () => {
  const cache = new TtlCache<number>(0);
  cache.set('a', 1);
  assert.equal(cache.get('a'), undefined);
});

test('TtlCache: a write drops entries that have expired, so the map cannot grow without bound', () => {
  const cache = new TtlCache<number>(0);
  for (let i = 0; i < 100; i++) {
    cache.set(`key${i}`, i);
  }
  // Every earlier key expired the instant it was written, so the last write should have swept them.
  assert.equal(cache.size, 1);
});

test('TtlCache: take returns a live entry once', () => {
  const cache = new TtlCache<number>(60_000);
  cache.set('a', 1);
  assert.equal(cache.take('a'), 1);
  assert.equal(cache.take('a'), undefined);
});
