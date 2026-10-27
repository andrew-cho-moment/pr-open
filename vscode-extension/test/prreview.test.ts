import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffAnchors } from '../src/diffanchors';
import {
  createReviewRequest,
  DropReason,
  parseCreatedReview,
  parsePendingReviewTarget,
  planThreads,
  ReviewState,
  reviewBody,
  threadBody,
} from '../src/prreview';
import { DiffSide } from '../src/prthreads';

const DIFF = `diff --git a/foo.ts b/foo.ts
index 1111111..2222222 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,4 +1,5 @@
 line one
-old two
+new two
+added three
 line three
 line four
@@ -20,3 +21,3 @@ context heading
 twenty
-old twentyone
+new twentytwo
 twentytwo`;

const ANCHORS = diffAnchors(DIFF);
const at = (over: Partial<Parameters<typeof threadBody>[0]> = {}) => ({
  file: 'foo.ts',
  line: 2,
  side: DiffSide.Right,
  body: 'boom',
  ...over,
});

test('planThreads: keeps a finding on a line the diff carries', () => {
  const plan = planThreads([at()], ANCHORS);
  assert.equal(plan.dropped.length, 0);
  assert.equal(plan.threads[0].path, 'foo.ts');
  assert.equal(plan.threads[0].line, 2);
});

test('planThreads: drops a finding whose file the diff never mentions, keeping the others', () => {
  const plan = planThreads([at({ file: 'invented.ts' }), at()], ANCHORS);
  assert.equal(plan.threads.length, 1);
  assert.equal(plan.dropped[0].reason, DropReason.FileNotInDiff);
});

test('planThreads: drops a line that falls between hunks', () => {
  const plan = planThreads([at({ line: 12 })], ANCHORS);
  assert.equal(plan.threads.length, 0);
  assert.equal(plan.dropped[0].reason, DropReason.LineNotInDiff);
});

test('planThreads: drops a range spanning two hunks', () => {
  // Both ends are in the diff (3 in the first hunk, 21 in the second), so the span is the fault.
  const plan = planThreads([at({ startLine: 3, line: 21 })], ANCHORS);
  assert.equal(plan.dropped[0].reason, DropReason.RangeSpansHunks);
});

test('planThreads: a range whose end is off-diff blames the line, not the span', () => {
  // Line 12 sits in the gap between the hunks, so it straddles nothing. Telling the PR author the
  // range crossed two hunks would describe a shape the finding never had.
  const plan = planThreads([at({ startLine: 1, line: 12 })], ANCHORS);
  assert.equal(plan.dropped[0].reason, DropReason.LineNotInDiff);
});

test('planThreads: a single-line finding carries no startLine or startSide key at all', () => {
  // GitHub rejects startLine === line, and a null start_side is not the same as an absent one.
  const [thread] = planThreads([at()], ANCHORS).threads;
  assert.deepEqual(Object.keys(thread).sort(), ['body', 'line', 'path', 'side']);
});

test('planThreads: a multi-line finding carries startLine and a matching startSide', () => {
  const [thread] = planThreads([at({ startLine: 1, line: 3 })], ANCHORS).threads;
  assert.equal(thread.startLine, 1);
  assert.equal(thread.startSide, DiffSide.Right);
});

test('planThreads: a range that starts where it ends degrades to a single-line comment', () => {
  const [thread] = planThreads([at({ startLine: 2, line: 2 })], ANCHORS).threads;
  assert.equal(thread.startLine, undefined);
  assert.ok(!('startSide' in thread));
});

test('threadBody: trims the finding body', () => {
  const body = threadBody(at({ body: 'boom  ' }));
  assert.equal(body, 'boom');
});

test('reviewBody: is empty when every finding anchored', () => {
  assert.equal(reviewBody([]), '');
});

test('reviewBody: carries a dropped finding rather than losing it', () => {
  const body = reviewBody([{ finding: at({ file: 'invented.ts', body: 'lost text' }), reason: DropReason.FileNotInDiff }]);
  assert.ok(body.includes('invented.ts:2'));
  assert.ok(body.includes('lost text'));
});

// The one test that guards the whole feature: an `event` key would publish the review to the PR
// author the moment it is created, which is exactly what a pending draft exists to prevent.
test('createReviewRequest: the payload carries no event key anywhere', () => {
  const json = createReviewRequest({ pullRequestId: 'PR_1', commitOID: 'abc', body: 'b', threads: [] });
  assert.ok(!/"event"/.test(json));
  assert.ok(!/\bevent\s*:/.test(json));
});

test('createReviewRequest: threads travel as a JSON array of objects, not as scalars', () => {
  const threads = [{ path: 'foo.ts', body: 'b', line: 2, side: DiffSide.Right }];
  const parsed = JSON.parse(createReviewRequest({ pullRequestId: 'PR_1', commitOID: 'abc', body: 'b', threads }));
  assert.deepEqual(parsed.variables.threads, threads);
});

const target = (nodes: unknown[], login = 'me') =>
  JSON.stringify({
    data: { viewer: { login }, repository: { pullRequest: { id: 'PR_1', headRefOid: 'deadbeef', reviews: { nodes } } } },
  });

test('parsePendingReviewTarget: reads the PR node id and head oid', () => {
  const t = parsePendingReviewTarget(target([]));
  assert.equal(t.pullRequestId, 'PR_1');
  assert.equal(t.headOid, 'deadbeef');
  assert.equal(t.pending, undefined);
});

test('parsePendingReviewTarget: finds the viewer own pending review', () => {
  const t = parsePendingReviewTarget(target([{ id: 'R_1', url: 'u', author: { login: 'me' } }]));
  assert.deepEqual(t.pending, { id: 'R_1', url: 'u' });
});

test('parsePendingReviewTarget: ignores a pending review authored by someone else', () => {
  const t = parsePendingReviewTarget(target([{ id: 'R_1', url: 'u', author: { login: 'someone-else' } }]));
  assert.equal(t.pending, undefined);
});

test('parsePendingReviewTarget: throws when the pull request is missing', () => {
  assert.throws(() => parsePendingReviewTarget(JSON.stringify({ data: { repository: { pullRequest: null } } })));
});

const created = (state: string) =>
  JSON.stringify({ data: { addPullRequestReview: { pullRequestReview: { id: 'R_1', url: 'u', state } } } });

test('parseCreatedReview: accepts a pending draft', () => {
  assert.deepEqual(parseCreatedReview(created('PENDING')), { id: 'R_1', url: 'u', state: ReviewState.Pending });
});

test('parseCreatedReview: throws when GitHub created anything but a draft', () => {
  // COMMENTED means the PR author was notified, which is the outcome this feature prevents.
  assert.throws(() => parseCreatedReview(created('COMMENTED')), /rather than a pending draft/);
});
