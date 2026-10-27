import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameAnchor } from '../src/askanchor';
import {
  aimChange,
  AskRepo,
  buildAskPayload,
  buildFollowUpPayload,
  diffFitsBudget,
  filePatchFor,
  numberLines,
} from '../src/askpayload';

const REPO: AskRepo = {
  owner: 'moment-technology',
  repo: 'pr-open',
  cloneDir: '/dev/pr-open',
  number: 42,
  base: 'aaa111',
  headOid: 'bbb222',
  title: '[AT-1] feat(ask): answer questions about a diff line',
  body: 'Why: reviewers had no way to ask back.',
};

// Three files, so extraction can be tested at the head, the middle and the tail of the diff.
const DIFF = `diff --git a/first.ts b/first.ts
--- a/first.ts
+++ b/first.ts
@@ -1,2 +1,2 @@
- 1 │ old first
+ 1 │ new first
  2 │ kept
diff --git a/src/middle.ts b/src/middle.ts
--- a/src/middle.ts
+++ b/src/middle.ts
@@ -10,1 +10,2 @@
 10 │ context
+11 │ added
diff --git a/last.ts b/last.ts
--- a/last.ts
+++ b/last.ts
@@ -1,1 +1,1 @@
- 1 │ old last
+ 1 │ new last`;

test('filePatchFor extracts the first, a middle, and the last file', () => {
  const first = filePatchFor(DIFF, 'first.ts');
  assert.ok(first.startsWith('diff --git a/first.ts'));
  assert.ok(first.includes('new first'));
  assert.ok(!first.includes('middle.ts'), 'must stop at the next file');

  const middle = filePatchFor(DIFF, 'src/middle.ts');
  assert.ok(middle.startsWith('diff --git a/src/middle.ts'));
  assert.ok(middle.includes('added') && !middle.includes('last.ts'));

  // The last file has no following `diff --git` to terminate on.
  const last = filePatchFor(DIFF, 'last.ts');
  assert.ok(last.startsWith('diff --git a/last.ts'));
  assert.ok(last.endsWith('new last'));
});

test('filePatchFor finds a deleted or renamed file by either header path', () => {
  const renamed = `diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts`;
  assert.ok(filePatchFor(renamed, 'src/old.ts').includes('rename to'));
  assert.ok(filePatchFor(renamed, 'src/new.ts').includes('rename from'));
});

test('filePatchFor returns nothing for a path outside the diff', () => {
  assert.equal(filePatchFor(DIFF, 'absent.ts'), '');
});

test('numberLines matches the annotated-diff number column and truncates a huge selection', () => {
  assert.equal(numberLines('const a = 1;\nconst b = 2;', 9), ' 9 │ const a = 1;\n10 │ const b = 2;');

  const many = numberLines(Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n'), 1);
  assert.equal(many.split('\n').length, 201, '200 lines plus the elision note');
  assert.ok(many.includes('50 more selected lines omitted'));
});

const ANCHOR = { file: 'src/middle.ts', startLine: 10, endLine: 11, side: 'head' as const };
const AIM = { anchor: ANCHOR };

test('a head-side payload carries the anchor, the file patch, the full diff and the question', () => {
  const aim = { anchor: ANCHOR, code: 'context\nadded' };
  const p = buildAskPayload({ repo: REPO, aim, annotatedDiff: DIFF, question: 'why?' });
  assert.ok(p.includes('slug: moment-technology/pr-open'));
  assert.ok(p.includes('### PULL REQUEST #42'));
  assert.ok(p.includes('lines: 10-11'));
  assert.ok(p.includes('### DIFF: src/middle.ts'));
  assert.ok(p.includes('### FULL PR DIFF'));
  assert.ok(p.trimEnd().endsWith('why?'));
  assert.ok(p.includes('HEAD (after)') && p.includes('match the file on disk'));
});

test('a base-side payload warns that the numbers do not match the disk', () => {
  const p = buildAskPayload({
    repo: REPO,
    aim: { anchor: { ...ANCHOR, side: 'base' } },
    annotatedDiff: DIFF,
    question: 'why?',
  });
  assert.ok(p.includes('MERGE BASE (before)'));
  assert.ok(p.includes('do NOT match the file on disk'));
});

test('an over-budget diff is replaced by a changed-file index', () => {
  const over = `${DIFF}\n${'x'.repeat(240_001)}`;
  assert.equal(diffFitsBudget(over), false);
  const p = buildAskPayload({ repo: REPO, aim: AIM, annotatedDiff: over, question: 'why?' });
  assert.ok(!p.includes('### FULL PR DIFF'));
  assert.ok(p.includes('### CHANGED FILES'));
  assert.ok(p.includes('- src/middle.ts') && p.includes('- last.ts'));
  // The model must know the before state is missing rather than guess at it.
  assert.ok(p.includes('no view of their before'));
  // The anchored file's own patch still goes in, so the question stays answerable.
  assert.ok(p.includes('### DIFF: src/middle.ts'));

  // Just under the budget the whole diff still goes in.
  const under = DIFF + '\n' + 'x'.repeat(239_000 - DIFF.length);
  assert.ok(diffFitsBudget(under));
  assert.ok(buildAskPayload({ repo: REPO, aim: AIM, annotatedDiff: under, question: 'why?' }).includes('### FULL PR DIFF'));
});

test('a long PR description is capped', () => {
  const p = buildAskPayload({ repo: { ...REPO, body: 'x'.repeat(5_000) }, annotatedDiff: DIFF, question: 'why?' });
  assert.ok(p.includes('(description truncated)'));
  assert.ok(!p.includes('x'.repeat(4_500)));
});

test('a whole-PR payload carries the repo, the diff and the question, and no anchor', () => {
  const p = buildAskPayload({ repo: REPO, annotatedDiff: DIFF, question: 'what does this PR do?' });
  assert.ok(p.includes('### REPO') && p.includes('### PULL REQUEST #42'));
  assert.ok(p.includes('### FULL PR DIFF'));
  assert.ok(!p.includes('### ANCHOR') && !p.includes('### DIFF: '));
  assert.ok(p.trimEnd().endsWith('what does this PR do?'));
});

test('an over-budget whole-PR payload promises no file patch it has not sent', () => {
  const p = buildAskPayload({ repo: REPO, annotatedDiff: `${DIFF}\n${'x'.repeat(240_001)}`, question: 'why?' });
  assert.ok(p.includes('### CHANGED FILES'));
  assert.ok(!p.includes("anchored file's patch"));
});

test('a moved follow-up carries the anchor and the question, and none of the seed', () => {
  const moved = buildFollowUpPayload('and this guard?', {
    kind: 'moved',
    aim: { anchor: ANCHOR, code: 'context\nadded' },
  });
  assert.ok(moved.startsWith('### ANCHOR'));
  assert.ok(moved.includes('lines: 10-11') && moved.includes('10 │ context'));
  assert.ok(moved.trimEnd().endsWith('and this guard?'));
  // The resumed session already holds all of this, so paying for it again is the bug being avoided.
  assert.ok(!moved.includes('### REPO') && !moved.includes('### FULL PR DIFF') && !moved.includes('### DIFF: '));
});

test('an unchanged follow-up is the question alone, and a released one says so', () => {
  const unchanged = buildFollowUpPayload('so is it safe to drop?', { kind: 'unchanged' });
  assert.equal(unchanged, '### QUESTION\nso is it safe to drop?');

  // Silence would leave the last anchor standing, so widening back out has to be stated outright.
  const released = buildFollowUpPayload('what does this PR do overall?', { kind: 'released' });
  assert.ok(released.startsWith('### ANCHOR'));
  assert.ok(released.includes('as a whole'));
  assert.ok(!released.includes('lines: '));
  assert.ok(released.trimEnd().endsWith('what does this PR do overall?'));
});

test('aimChange tells a repeated aim from a moved one and from a released one', () => {
  const question = 'why?';
  assert.deepEqual(aimChange({ question, aim: AIM }, ANCHOR), { kind: 'unchanged' });
  assert.deepEqual(aimChange({ question }, undefined), { kind: 'unchanged' });

  const elsewhere = { ...ANCHOR, endLine: 12 };
  assert.deepEqual(aimChange({ question, aim: { anchor: elsewhere } }, ANCHOR), {
    kind: 'moved',
    aim: { anchor: elsewhere },
  });
  assert.deepEqual(aimChange({ question, aim: AIM }, undefined), { kind: 'moved', aim: AIM });

  // The case the anchor-or-nothing shape could not express: a session that was aimed, and a turn
  // that is not.
  assert.deepEqual(aimChange({ question }, ANCHOR), { kind: 'released' });
});

test('sameAnchor tells a moved anchor from a repeated one', () => {
  assert.ok(sameAnchor(ANCHOR, { ...ANCHOR }));
  assert.ok(sameAnchor(undefined, undefined));
  assert.ok(!sameAnchor(ANCHOR, { ...ANCHOR, endLine: 12 }));
  assert.ok(!sameAnchor(ANCHOR, { ...ANCHOR, side: 'base' }));
  assert.ok(!sameAnchor(ANCHOR, undefined));
});

test('replayed history appears only when a lost session is being recovered', () => {
  const history = [{ question: 'first?', answer: 'because of the guard' }];
  const withHistory = buildAskPayload({ repo: REPO, aim: AIM, annotatedDiff: DIFF, question: 'and now?', history });
  assert.ok(withHistory.includes('### EARLIER IN THIS CONVERSATION'));
  assert.ok(withHistory.includes('Q: first?') && withHistory.includes('A: because of the guard'));

  const without = buildAskPayload({ repo: REPO, aim: AIM, annotatedDiff: DIFF, question: 'and now?' });
  assert.ok(!without.includes('EARLIER IN THIS CONVERSATION'));
});
