import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnchorRepo, cloneDirFor, docRefFor, UriParts } from '../src/askanchor';
import { baseFragment, BASE_SCHEME } from '../src/schemes';

const REPO: AnchorRepo = { cloneDir: '/dev/pr-open', base: 'aaa111', headOid: 'bbb222' };

function fileUri(fsPath: string): UriParts {
  return { scheme: 'file', path: fsPath, fragment: '', fsPath };
}

// Minted through `baseFragment`, the same function `BaseContentProvider` mints with: a hand-rolled
// fragment here would keep these tests green while a change to the encoding broke anchoring for real.
function baseUri(repoRelPath: string, dir = REPO.cloneDir, ref = REPO.base): UriParts {
  return {
    scheme: BASE_SCHEME,
    path: `/${repoRelPath}`,
    fragment: baseFragment(dir, ref),
    fsPath: `/${repoRelPath}`,
  };
}

test('a file in the clone anchors on the head side', () => {
  assert.deepEqual(docRefFor(fileUri('/dev/pr-open/src/tour.ts'), REPO), { path: 'src/tour.ts', side: 'head' });
});

test('a sibling directory sharing a prefix is not in the clone', () => {
  // The bug `isUnder` exists to prevent: /dev/pr-open must not swallow /dev/pr-open-fork.
  assert.equal(docRefFor(fileUri('/dev/pr-open-fork/src/tour.ts'), REPO), undefined);
});

test('a base document at the merge base anchors on the base side', () => {
  assert.deepEqual(docRefFor(baseUri('src/tour.ts'), REPO), { path: 'src/tour.ts', side: 'base' });
});

test('a base document at HEAD (a deleted file) anchors on the head side', () => {
  assert.deepEqual(docRefFor(baseUri('gone.ts', REPO.cloneDir, REPO.headOid), REPO), {
    path: 'gone.ts',
    side: 'head',
  });
});

test('a base document at some other ref has no anchor', () => {
  assert.equal(docRefFor(baseUri('src/tour.ts', REPO.cloneDir, 'ccc333'), REPO), undefined);
});

test('a base document from another clone has no anchor', () => {
  assert.equal(docRefFor(baseUri('src/tour.ts', '/dev/other'), REPO), undefined);
});

test("a rename's base pane keeps the old path", () => {
  assert.deepEqual(docRefFor(baseUri('src/old-name.ts'), REPO), { path: 'src/old-name.ts', side: 'base' });
});

test('foreign schemes have no anchor', () => {
  // `comment` is a comment widget's text box, which is a `TextEditor` over a document too.
  for (const scheme of ['comment', 'review', 'pr', 'untitled', 'output', 'git']) {
    const uri: UriParts = { scheme, path: '/src/tour.ts', fragment: 'x=1', fsPath: '/src/tour.ts' };
    assert.equal(docRefFor(uri, REPO), undefined, scheme);
  }
});

test('cloneDirFor matches a file to a known clone and a base document to its own', () => {
  const known = ['/dev/other', '/dev/pr-open'];
  assert.equal(cloneDirFor(fileUri('/dev/pr-open/src/tour.ts'), known), '/dev/pr-open');
  assert.equal(cloneDirFor(fileUri('/elsewhere/x.ts'), known), undefined);
  assert.equal(cloneDirFor(baseUri('src/tour.ts'), []), '/dev/pr-open');
  // A comment box's `fsPath` sits under the clone it is opened over, and still names no clone.
  const box: UriParts = { scheme: 'comment', path: '/commentinput-1.md', fragment: '', fsPath: '/dev/pr-open/x.ts' };
  assert.equal(cloneDirFor(box, known), undefined);
});
