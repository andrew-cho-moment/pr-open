import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiffSide, parseReviewThreads } from '../src/prthreads';

/** One GraphQL response, shaped as `gh api graphql` returns it. */
function response(threads: unknown[], opts: { threadsNextPage?: boolean; crossRepo?: boolean } = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          headRefName: 'andrewcho/fix',
          headRefOid: 'abc1234def',
          isCrossRepository: opts.crossRepo ?? false,
          reviewThreads: { pageInfo: { hasNextPage: opts.threadsNextPage ?? false }, nodes: threads },
        },
      },
    },
  });
}

const THREAD = {
  id: 'PRRT_1',
  path: 'src/panel.ts',
  line: 14,
  startLine: 12,
  diffSide: 'RIGHT',
  isResolved: false,
  isOutdated: false,
  comments: {
    pageInfo: { hasNextPage: false },
    nodes: [
      { body: 'this guard is inverted', author: { login: 'alice' } },
      { body: 'agreed', author: { login: 'bob' } },
    ],
  },
  // The query asks for the opening comment's hunk under its own alias, since every reply repeats it.
  hunk: { nodes: [{ diffHunk: '@@ -1 +1 @@\n+if (!x) {' }] },
};

test('parseReviewThreads reads the head, the lines and the conversation', () => {
  const { head, threads, truncated } = parseReviewThreads(response([THREAD]));
  assert.deepEqual(head, { refName: 'andrewcho/fix', oid: 'abc1234def', crossRepo: false });
  assert.equal(truncated, false);
  assert.equal(threads.length, 1);
  const thread = threads[0];
  assert.equal(thread.id, 'PRRT_1');
  assert.equal(thread.path, 'src/panel.ts');
  assert.deepEqual([thread.startLine, thread.line], [12, 14]);
  assert.equal(thread.side, DiffSide.Right);
  assert.equal(thread.resolved, false);
  assert.ok(thread.hunk.includes('if (!x)'));
  assert.deepEqual(
    thread.comments.map((c) => `${c.author}: ${c.body}`),
    ['alice: this guard is inverted', 'bob: agreed'],
  );
});

test('parseReviewThreads keeps resolved threads, flagged, so the caller decides', () => {
  const { threads } = parseReviewThreads(response([{ ...THREAD, isResolved: true }]));
  assert.equal(threads[0].resolved, true);
});

test('parseReviewThreads places a file-level thread on no line', () => {
  const { threads } = parseReviewThreads(
    response([{ ...THREAD, line: null, startLine: null, isOutdated: true }]),
  );
  assert.equal(threads[0].line, undefined);
  assert.equal(threads[0].startLine, undefined);
  assert.equal(threads[0].outdated, true);
});

test('parseReviewThreads reports a page it did not read, at either level', () => {
  assert.equal(parseReviewThreads(response([THREAD], { threadsNextPage: true })).truncated, true);
  const moreComments = { ...THREAD, comments: { ...THREAD.comments, pageInfo: { hasNextPage: true } } };
  assert.equal(parseReviewThreads(response([moreComments])).truncated, true);
});

test('parseReviewThreads rejects a diff side it does not know', () => {
  assert.throws(() => parseReviewThreads(response([{ ...THREAD, diffSide: 'MIDDLE' }])), /unknown diff side/);
});

test('parseReviewThreads rejects a response with no pull request or no head', () => {
  assert.throws(() => parseReviewThreads(JSON.stringify({ data: { repository: null } })), /no pull request/);
  const headless = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
  assert.throws(() => parseReviewThreads(headless), /no head ref/);
});

test('parseReviewThreads survives a comment whose author is gone', () => {
  const orphaned = { ...THREAD, comments: { pageInfo: {}, nodes: [{ body: 'x', author: null }] } };
  assert.equal(parseReviewThreads(response([orphaned])).threads[0].comments[0].author, 'unknown');
});
