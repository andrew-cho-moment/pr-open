import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AddedFolder,
  FolderSlot,
  MAX_ADDED,
  pickActiveDir,
  pickStartupDrops,
  pickVictim,
} from '../src/folders';

/** `count` folders pr-open added, oldest first, at indexes starting from `from`. */
function owned(count: number, from = 0): { folders: FolderSlot[]; added: AddedFolder[] } {
  const folders: FolderSlot[] = [];
  const added: AddedFolder[] = [];
  for (let i = 0; i < count; i++) {
    const dir = `/dev/repo${i}`;
    folders.push({ index: from + i, dir });
    added.push({ dir, at: 1_000 + i });
  }
  return { folders, added };
}

test('pickVictim: leaves the list alone while under the cap', () => {
  const { folders, added } = owned(MAX_ADDED - 1);
  assert.equal(pickVictim(folders, added, undefined), undefined);
});

test('pickVictim: drops the least recently shown folder at the cap', () => {
  const { folders, added } = owned(MAX_ADDED);
  const last = MAX_ADDED - 1;
  added[last].at = 1; // the newest reveal, but the one not shown in the longest
  assert.equal(pickVictim(folders, added, undefined)?.dir, `/dev/repo${last}`);
});

test('pickVictim: never drops folder 0, even when it is the oldest', () => {
  const { folders, added } = owned(MAX_ADDED);
  const victim = pickVictim(folders, added, undefined);
  assert.equal(victim?.index, 1);
  assert.equal(victim?.dir, '/dev/repo1');
});

test('pickVictim: never drops a folder pr-open did not add', () => {
  // The user opened /dev/mine; every other folder is one pr-open appended after it.
  const { folders, added } = owned(MAX_ADDED, 1);
  folders.unshift({ index: 0, dir: '/dev/mine' });
  const victim = pickVictim(folders, added, undefined);
  assert.equal(victim?.dir, '/dev/repo0');
});

test('pickVictim: counts only folders pr-open added towards the cap', () => {
  // A window full of the user's own folders leaves pr-open room for its first.
  const folders: FolderSlot[] = [];
  for (let i = 0; i < MAX_ADDED + 3; i++) {
    folders.push({ index: i, dir: `/dev/theirs${i}` });
  }
  assert.equal(pickVictim(folders, [], undefined), undefined);
});

test('pickVictim: spares the folder used most recently, however long ago it was revealed', () => {
  // The hazard this rules out: a repo revealed first and worked in ever since. `at` has to mean "last
  // used", not "last revealed", or eviction takes the folder the user is editing in.
  const { folders, added } = owned(MAX_ADDED);
  added[1].at = 9_999; // repo1 is the oldest reveal but the newest use
  assert.equal(pickVictim(folders, added, undefined)?.dir, '/dev/repo2');
});

test('pickVictim: matches tracked folders case-insensitively, as the filesystem does', () => {
  const { folders, added } = owned(MAX_ADDED);
  for (const entry of added) {
    entry.dir = entry.dir.toUpperCase();
  }
  assert.equal(pickVictim(folders, added, undefined)?.dir, '/dev/repo1');
});

test('pickVictim: never drops the protected active choice, taking the next-oldest instead', () => {
  // repo1 is the oldest evictable folder, but it is the repo under review, so the eviction falls to
  // the next-oldest rather than dropping the status block's repo out from under it.
  const { folders, added } = owned(MAX_ADDED);
  assert.equal(pickVictim(folders, added, '/dev/repo1')?.dir, '/dev/repo2');
});

test('pickStartupDrops: keeps the folder shown most recently and drops the rest', () => {
  const { folders, added } = owned(4, 1);
  folders.unshift({ index: 0, dir: '/dev/mine' });
  assert.deepEqual(
    pickStartupDrops(folders, added, undefined).map((s) => s.dir),
    ['/dev/repo2', '/dev/repo1', '/dev/repo0'], // repo3 was shown last, so it opens the window
  );
});

test('pickStartupDrops: never drops folder 0, so more than the cap can survive', () => {
  // Removing folder 0 restarts the extension host. Keeping one extra folder costs a watcher; taking
  // folder 0 costs the reload the whole placement path exists to avoid.
  const { folders, added } = owned(3);
  assert.deepEqual(
    pickStartupDrops(folders, added, undefined).map((s) => s.dir),
    ['/dev/repo1'], // repo2 is newest and repo0 is folder 0, leaving only repo1 to go
  );
});

test('pickStartupDrops: never drops the repo a reveal claimed while the trim was running', () => {
  // A window opened by a deep link reveals a PR as the trim runs, so the folder that reveal is
  // waiting on has to survive the removals that follow it.
  const { folders, added } = owned(3, 1);
  folders.unshift({ index: 0, dir: '/dev/mine' });
  assert.deepEqual(
    pickStartupDrops(folders, added, '/dev/repo0').map((s) => s.dir),
    ['/dev/repo1'], // repo2 is newest and repo0 is the reveal's, leaving only repo1 to go
  );
});

test('pickStartupDrops: never drops a folder pr-open did not add', () => {
  const folders: FolderSlot[] = [
    { index: 0, dir: '/dev/theirs0' },
    { index: 1, dir: '/dev/theirs1' },
    { index: 2, dir: '/dev/theirs2' },
  ];
  assert.deepEqual(pickStartupDrops(folders, [], undefined), []);
});

test('pickStartupDrops: a window already at the cap has nothing to trim', () => {
  const { folders, added } = owned(1, 1);
  folders.unshift({ index: 0, dir: '/dev/mine' });
  assert.deepEqual(pickStartupDrops(folders, added, undefined), []);
});

const REPOS = ['/dev/repo0', '/dev/repo1', '/dev/repo2'];

test('pickActiveDir: the explicit choice wins over a stale editor-focus hint', () => {
  // The exact revert this fix prevents: a checkout chose repo2, then an old repo0 editor re-surfaced.
  // The choice must hold; the focus hint must not pull the panel back.
  assert.equal(pickActiveDir(REPOS, '/dev/repo2', '/dev/repo0'), '/dev/repo2');
});

test('pickActiveDir: follows the editor when no choice is live', () => {
  assert.equal(pickActiveDir(REPOS, undefined, '/dev/repo1'), '/dev/repo1');
});

test('pickActiveDir: falls back to the editor when the chosen repo has left the window', () => {
  assert.equal(pickActiveDir(REPOS, '/dev/gone', '/dev/repo1'), '/dev/repo1');
});

test('pickActiveDir: falls back to the first repo when neither choice nor focus is present', () => {
  assert.equal(pickActiveDir(REPOS, undefined, undefined), '/dev/repo0');
  assert.equal(pickActiveDir(REPOS, '/dev/gone', '/dev/also-gone'), '/dev/repo0');
});

test('pickActiveDir: matches both signals case-insensitively, as the filesystem does', () => {
  assert.equal(pickActiveDir(REPOS, '/DEV/REPO2', undefined), '/dev/repo2');
  assert.equal(pickActiveDir(REPOS, undefined, '/DEV/REPO1'), '/dev/repo1');
});

test('pickActiveDir: has no answer for a window holding no repos', () => {
  assert.equal(pickActiveDir([], '/dev/repo0', '/dev/repo1'), undefined);
});
