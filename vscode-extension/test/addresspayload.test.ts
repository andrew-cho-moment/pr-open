import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAddressPayload,
  labelThreads,
  lineRange,
  ThreadOutcome,
  validateThreadResult,
} from '../src/addresspayload';
import { AskRepo } from '../src/askpayload';
import { DiffSide, ReviewThread } from '../src/prthreads';

const REPO: AskRepo = {
  owner: 'moment-technology',
  repo: 'pr-open',
  cloneDir: '/dev/pr-open',
  number: 42,
  base: 'aaa111',
  headOid: 'bbb222',
  title: '[AT-1] fix(panel): resize the question box',
  body: 'Why: the box could not be resized.',
};

const DIFF = `diff --git a/src/panel.ts b/src/panel.ts
--- a/src/panel.ts
+++ b/src/panel.ts
@@ -10,1 +10,2 @@
 10 │ context
+11 │ added`;

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'PRRT_1',
    path: 'src/panel.ts',
    line: 14,
    startLine: 12,
    side: DiffSide.Right,
    resolved: false,
    outdated: false,
    hunk: '@@ -1 +1 @@\n+if (!x) {',
    comments: [{ author: 'alice', body: 'this guard is inverted' }],
    ...over,
  };
}

test('labelThreads labels in the order GitHub returned them', () => {
  const labelled = labelThreads([thread({ id: 'a' }), thread({ id: 'b' })]);
  assert.deepEqual(
    labelled.map((l) => [l.label, l.thread.id]),
    [
      ['T1', 'a'],
      ['T2', 'b'],
    ],
  );
});

test('lineRange collapses a single line and names a file-level thread', () => {
  assert.equal(lineRange({ line: 14, startLine: 12 }), '12-14');
  assert.equal(lineRange({ line: 14, startLine: 14 }), '14');
  assert.equal(lineRange({ line: 14, startLine: undefined }), '14');
  assert.equal(lineRange({ line: undefined, startLine: undefined }), 'whole file');
});

test('buildAddressPayload carries the PR, the diff and one block per thread', () => {
  const payload = buildAddressPayload({
    repo: REPO,
    annotatedDiff: DIFF,
    threads: labelThreads([thread(), thread({ id: 'PRRT_2', path: 'src/ask.ts', line: 3, startLine: undefined })]),
  });
  assert.ok(payload.includes('slug: moment-technology/pr-open'));
  assert.ok(payload.includes('### PULL REQUEST #42'));
  assert.ok(payload.includes('### FULL PR DIFF'));
  assert.ok(payload.includes('### REVIEW THREADS (2)'));
  assert.ok(payload.includes('--- T1\nfile: src/panel.ts\nlines: 12-14'));
  assert.ok(payload.includes('--- T2\nfile: src/ask.ts\nlines: 3'));
  assert.ok(payload.includes('@alice:'));
  assert.ok(payload.includes('this guard is inverted'));
});

test('buildAddressPayload says an outdated thread has moved', () => {
  const payload = buildAddressPayload({
    repo: REPO,
    annotatedDiff: DIFF,
    threads: labelThreads([thread({ outdated: true })]),
  });
  assert.ok(payload.includes('outdated:'));
});

test('buildAddressPayload drops a diff over budget rather than truncating it', () => {
  const huge = `${DIFF}\n${'x'.repeat(240_001)}`;
  const payload = buildAddressPayload({ repo: REPO, annotatedDiff: huge, threads: labelThreads([thread()]) });
  assert.ok(payload.includes('### NO FULL DIFF'));
  assert.ok(!payload.includes('xxxxx'));
});

const LABELS = new Set(['T1', 'T2']);

test('validateThreadResult accepts a well-formed line', () => {
  const result = validateThreadResult({ thread: 'T2', outcome: 'fixed', reply: '  Fixed.  ' }, LABELS);
  assert.deepEqual(result, { label: 'T2', outcome: ThreadOutcome.Fixed, reply: 'Fixed.' });
});

test('validateThreadResult rejects anything it cannot place or post', () => {
  const cases: unknown[] = [
    undefined,
    'a string',
    { thread: 'T9', outcome: 'fixed', reply: 'Fixed.' }, // a label that was never sent
    { thread: 'T1', outcome: 'done', reply: 'Fixed.' }, // outcome outside the enum
    { thread: 'T1', outcome: 'fixed', reply: '   ' }, // nothing to post
    { thread: 'T1', reply: 'Fixed.' },
    { outcome: 'fixed', reply: 'Fixed.' },
  ];
  for (const c of cases) {
    assert.equal(validateThreadResult(c, LABELS), undefined, JSON.stringify(c));
  }
});
