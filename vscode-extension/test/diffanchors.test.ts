import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffAnchors, isAnchorLegal, isRangeLegal } from '../src/diffanchors';
import { DiffSide } from '../src/prthreads';

// Same shape as the diffannotate fixture: a modified file with two hunks (proves the counters
// re-seed and that the gap between them is not commentable), a deleted file, and a pure addition
// ending with a no-newline marker.
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
 twentytwo
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-gone one
-gone two
diff --git a/added.ts b/added.ts
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/added.ts
@@ -0,0 +1,2 @@
+fresh one
+fresh two
\\ No newline at end of file`;

const A = diffAnchors(DIFF);

test('diffAnchors: added lines are commentable on the right', () => {
  assert.ok(isAnchorLegal(A, 'foo.ts', 2, DiffSide.Right)); // +new two
  assert.ok(isAnchorLegal(A, 'foo.ts', 3, DiffSide.Right)); // +added three
});

test('diffAnchors: deleted lines are commentable on the left, at their old numbers', () => {
  assert.ok(isAnchorLegal(A, 'foo.ts', 2, DiffSide.Left)); // -old two
  assert.ok(isAnchorLegal(A, 'foo.ts', 21, DiffSide.Left)); // -old twentyone
});

test('diffAnchors: context lines are commentable on the right and not on the left', () => {
  assert.ok(isAnchorLegal(A, 'foo.ts', 1, DiffSide.Right)); // " line one"
  assert.equal(isAnchorLegal(A, 'foo.ts', 1, DiffSide.Left), false);
});

test('diffAnchors: the gap between two hunks is commentable on neither side', () => {
  assert.equal(isAnchorLegal(A, 'foo.ts', 12, DiffSide.Right), false);
  assert.equal(isAnchorLegal(A, 'foo.ts', 12, DiffSide.Left), false);
});

test('diffAnchors: a new file is commentable on the right only', () => {
  assert.ok(isAnchorLegal(A, 'added.ts', 1, DiffSide.Right));
  assert.equal(isAnchorLegal(A, 'added.ts', 1, DiffSide.Left), false);
});

test('diffAnchors: /dev/null never becomes a path key', () => {
  assert.equal(A.has('/dev/null'), false);
  assert.equal(A.has('dev/null'), false);
});

test('diffAnchors: a deleted file keys on its old path and is commentable on the left only', () => {
  assert.ok(isAnchorLegal(A, 'gone.ts', 1, DiffSide.Left));
  assert.equal(isAnchorLegal(A, 'gone.ts', 1, DiffSide.Right), false);
});

test('diffAnchors: the no-newline marker consumes no line number', () => {
  // added.ts has exactly two lines; a third would mean the marker was counted as content.
  assert.deepEqual([...(A.get('added.ts')?.right ?? [])].sort((a, b) => a - b), [1, 2]);
});

test('diffAnchors: a rename keys on the new path, which is the one GitHub shows', () => {
  const renamed = `diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1,1 +1,1 @@
-was
+is`;
  const r = diffAnchors(renamed);
  assert.ok(isAnchorLegal(r, 'new.ts', 1, DiffSide.Right));
  assert.equal(r.has('old.ts'), false);
});

test('diffAnchors: a binary stanza yields no anchors', () => {
  const bin = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ`;
  // No `---`/`+++` headers in a binary stanza, so the file never becomes a key: nothing to anchor on.
  const b = diffAnchors(bin);
  assert.equal(b.has('logo.png'), false);
  assert.equal(isAnchorLegal(b, 'logo.png', 1, DiffSide.Right), false);
});

test('isRangeLegal: accepts a range inside one hunk and rejects one spanning two', () => {
  assert.ok(isRangeLegal(A, 'foo.ts', 1, 3, DiffSide.Right));
  assert.equal(isRangeLegal(A, 'foo.ts', 3, 21, DiffSide.Right), false);
});

test('isRangeLegal: rejects an inverted range', () => {
  assert.equal(isRangeLegal(A, 'foo.ts', 3, 1, DiffSide.Right), false);
});

test('isAnchorLegal: rejects a file the diff never mentioned', () => {
  assert.equal(isAnchorLegal(A, 'invented.ts', 1, DiffSide.Right), false);
});

test('diffAnchors: a git-quoted path is unquoted, so it matches what the model transcribes', () => {
  // core.quotePath is on by default, so a non-ASCII path arrives C-quoted with octal UTF-8 bytes.
  const quoted = `diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"
--- "a/caf\\303\\251.ts"
+++ "b/caf\\303\\251.ts"
@@ -1,1 +1,1 @@
-was
+is`;
  const q = diffAnchors(quoted);
  assert.ok(q.has('caf\u00e9.ts'), `keys were ${JSON.stringify([...q.keys()])}`);
  assert.ok(isAnchorLegal(q, 'caf\u00e9.ts', 1, DiffSide.Right));
});
