import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FetchUse, PrefetchedFetches } from '../src/prefetchedfetches';

function controlledFetch() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('PrefetchedFetches: a checkout consumes a completed prefetch without another fetch', async () => {
  const fetches = new PrefetchedFetches<string>(60_000);
  let calls = 0;
  const fetch = async () => `oid-${++calls}`;

  assert.equal(fetches.hasCompleted('head'), false);
  assert.equal(await fetches.run('head', FetchUse.Prefetch, fetch), 'oid-1');
  assert.equal(fetches.hasCompleted('head'), true);
  assert.equal(await fetches.run('head', FetchUse.Prefetch, fetch), 'oid-1');
  assert.equal(await fetches.run('head', FetchUse.ReusePrefetch, fetch), 'oid-1');
  assert.equal(fetches.hasCompleted('head'), false);
  assert.equal(calls, 1);

  assert.equal(await fetches.run('head', FetchUse.ReusePrefetch, fetch), 'oid-2');
  assert.equal(calls, 2, 'the completed prefetch is one-shot');
});

test('PrefetchedFetches: a checkout joins a running prefetch and consumes its result', async () => {
  const fetches = new PrefetchedFetches<string>(60_000);
  const first = controlledFetch();
  let calls = 0;
  const fetch = () => {
    calls++;
    return first.promise;
  };

  const prefetch = fetches.run('head', FetchUse.Prefetch, fetch);
  const checkout = fetches.run('head', FetchUse.ReusePrefetch, fetch);
  first.resolve('oid-1');

  assert.equal(await prefetch, 'oid-1');
  assert.equal(await checkout, 'oid-1');
  assert.equal(calls, 1);

  const second = controlledFetch();
  const next = fetches.run('head', FetchUse.ReusePrefetch, () => second.promise);
  second.resolve('oid-2');
  assert.equal(await next, 'oid-2', 'the joined result was not left cached');
});

test('PrefetchedFetches: a fresh request replaces a completed prefetch', async () => {
  const fetches = new PrefetchedFetches<string>(60_000);
  let calls = 0;
  const fetch = async () => `oid-${++calls}`;

  await fetches.run('head', FetchUse.Prefetch, fetch);
  assert.equal(await fetches.run('head', FetchUse.Fresh, fetch), 'oid-2');
  assert.equal(calls, 2);
});

test('PrefetchedFetches: clear removes completed work and stops running work from repopulating it', async () => {
  const fetches = new PrefetchedFetches<string>(60_000);
  const first = controlledFetch();
  const prefetch = fetches.run('head', FetchUse.Prefetch, () => first.promise);
  fetches.clear();
  assert.equal(fetches.hasCompleted('head'), false);

  assert.equal(await fetches.run('head', FetchUse.ReusePrefetch, async () => 'new'), 'new');
  first.resolve('old');
  await prefetch;

  assert.equal(await fetches.run('head', FetchUse.ReusePrefetch, async () => 'newer'), 'newer');
});
