import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateDiff } from '../src/diffannotate';

// Multi-file diff: a modified file with two hunks (proves counters re-seed per hunk), a deleted
// file (old-line anchoring), and a pure addition ending with a no-newline marker.
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

test('annotateDiff: numbers content lines and passes headers through', () => {
  const lines = annotateDiff(DIFF).split('\n');
  const has = (s: string) => assert.ok(lines.includes(s), `missing: ${JSON.stringify(s)}`);

  // Width is 2 (max line number is 23), so single-digit numbers are right-padded.
  // First hunk: context/added carry new-file numbers, removed carries the old-file number.
  has('  1 │ line one'); // context, new line 1
  has('- 2 │ old two'); // removed, old line 2
  has('+ 2 │ new two'); // added, new line 2
  has('+ 3 │ added three'); // added, new line 3
  has('  4 │ line three'); // context resumes at new line 4
  has('  5 │ line four');

  // Second hunk re-seeds from its own header (new starts at 21), not continuing from the first.
  has(' 21 │ twenty');
  has('-21 │ old twentyone'); // old line 21
  has('+22 │ new twentytwo'); // new line 22
  has(' 23 │ twentytwo');

  // Deleted file: every line is a removal, numbered by the old file (anchors the base/left pane).
  has('- 1 │ gone one');
  has('- 2 │ gone two');

  // Pure addition: new-file numbers from 1.
  has('+ 1 │ fresh one');
  has('+ 2 │ fresh two');

  // Headers, hunk headers, and the no-newline marker pass through verbatim (no number, no bar).
  has('diff --git a/foo.ts b/foo.ts');
  has('@@ -1,4 +1,5 @@');
  has('@@ -20,3 +21,3 @@ context heading');
  has('deleted file mode 100644');
  has('+++ /dev/null');
  has('\\ No newline at end of file');
});

test('annotateDiff: single-line hunk header (no counts) numbers correctly', () => {
  const diff = `--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-was
+now`;
  const lines = annotateDiff(diff).split('\n');
  assert.ok(lines.includes('-1 │ was'));
  assert.ok(lines.includes('+1 │ now'));
});
