import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  cloneMayTakeBranch,
  MAX_REVIEW_TREES,
  parseReviewTreeName,
  pickEvictions,
  pruneDropsOnlyOurs,
  reviewBranchName,
  reviewRoot,
  ReviewTree,
  reviewTreeFor,
  reviewTreeName,
} from '../src/reviewtree';

const CLONE = '/Users/me/dev/accounts';
const AGENT_WORKTREE = '/Users/me/dev/accounts/.claude/worktrees/gates';

/** A dirtiness probe that records whether it was consulted, since asking git costs a full worktree
 *  scan. */
function dirtyProbe(dirty: boolean) {
  const probe = Object.assign(
    () => {
      probe.asked = true;
      return Promise.resolve(dirty);
    },
    { asked: false },
  );
  return probe;
}

test('cloneMayTakeBranch: the clone already holds the branch', async () => {
  assert.equal(await cloneMayTakeBranch(false, CLONE, CLONE, dirtyProbe(false)), true);
  // Case-folded, since `worktreeHolding` and the clone scan can disagree on casing.
  assert.equal(
    await cloneMayTakeBranch(false, '/users/me/dev/Accounts', CLONE, dirtyProbe(false)),
    true,
  );
});

test('cloneMayTakeBranch: nobody holds the branch and the clone is free to take it', async () => {
  assert.equal(await cloneMayTakeBranch(false, undefined, CLONE, dirtyProbe(false)), true);
});

test('cloneMayTakeBranch: another worktree holds the branch, so never open it', async () => {
  assert.equal(await cloneMayTakeBranch(false, AGENT_WORKTREE, CLONE, dirtyProbe(false)), false);
  assert.equal(await cloneMayTakeBranch(false, AGENT_WORKTREE, CLONE, dirtyProbe(true)), false);
});

test('cloneMayTakeBranch: an unheld branch but a clone with work in it', async () => {
  assert.equal(await cloneMayTakeBranch(false, undefined, CLONE, dirtyProbe(true)), false);
});

test('cloneMayTakeBranch: a fork has no branch to take, however free the clone is', async () => {
  const probe = dirtyProbe(false);
  assert.equal(await cloneMayTakeBranch(true, undefined, CLONE, probe), false);
  assert.equal(probe.asked, false, 'a clean clone cannot make a fork switchable');
});

test('cloneMayTakeBranch: dirtiness is not asked for once another tree holds the branch', async () => {
  const probe = dirtyProbe(false);
  await cloneMayTakeBranch(false, AGENT_WORKTREE, CLONE, probe);
  assert.equal(probe.asked, false, 'a full worktree scan that cannot change the answer');

  const consulted = dirtyProbe(false);
  await cloneMayTakeBranch(false, undefined, CLONE, consulted);
  assert.equal(consulted.asked, true);
});

const treeDir = (n: number) => path.join(reviewRoot(), `accounts-pr${n}`);
const tree = (n: number, at: number): ReviewTree => ({ dir: treeDir(n), number: n, at });

test('pickEvictions: nothing to do at or under the cap', () => {
  assert.deepEqual(pickEvictions([], 3), []);
  assert.deepEqual(pickEvictions([tree(1, 100), tree(2, 200), tree(3, 300)], 3), []);
});

test('pickEvictions: over the cap, least recently reviewed goes first', () => {
  const trees = [tree(1, 100), tree(2, 400), tree(3, 200), tree(4, 300), tree(5, 500)];
  assert.deepEqual(
    pickEvictions(trees, 3).map((t) => t.dir),
    [treeDir(3), treeDir(1)],
  );
});

test('pickEvictions: the tree just reviewed sorts newest, so it never selects itself', () => {
  const justUsed = tree(9, Date.now());
  const trees = [tree(1, 1), tree(2, 2), tree(3, 3), justUsed];
  assert.equal(
    pickEvictions(trees, MAX_REVIEW_TREES).some((t) => t.dir === justUsed.dir),
    false,
  );
});

test('pickEvictions: an unrecorded tree ranks oldest', () => {
  const trees = [tree(1, 0), tree(2, 100), tree(3, 200), tree(4, 300)];
  assert.deepEqual(
    pickEvictions(trees, 3).map((t) => t.dir),
    [treeDir(1)],
  );
});

test('reviewTreeName: round-trips through the parser', () => {
  assert.equal(reviewTreeName('accounts', 42), 'accounts-pr42');
  assert.deepEqual(parseReviewTreeName('accounts-pr42'), { repo: 'accounts', number: 42 });
});

test('parseReviewTreeName: matches from the right, so a slug ending in -pr<n> survives', () => {
  assert.deepEqual(parseReviewTreeName('vscode-pr2-pr17'), { repo: 'vscode-pr2', number: 17 });
});

test('parseReviewTreeName: rejects names that are not ours', () => {
  assert.equal(parseReviewTreeName('accounts'), undefined);
  assert.equal(parseReviewTreeName('accounts-pr'), undefined);
  assert.equal(parseReviewTreeName('accounts-prx7'), undefined);
});

test('reviewTreeName: a slug that is not a safe directory name is escaped, and still parses', () => {
  const name = reviewTreeName('some/repo', 7);
  assert.equal(name.includes('/'), false);
  assert.deepEqual(parseReviewTreeName(name), { repo: 'some_repo', number: 7 });
});

test('reviewBranchName: lives in pr-open’s namespace and is a valid ref for any repo slug', () => {
  assert.equal(reviewBranchName('accounts', 42), 'pr-open/review/accounts-pr42');
  assert.equal(reviewBranchName('some/repo..lock', 7), 'pr-open/review/some_repo__lock-pr7');
});

test('reviewTreeFor: reads the PR straight out of a review tree path', () => {
  assert.deepEqual(reviewTreeFor(path.join(reviewRoot(), 'accounts-pr42')), {
    repo: 'accounts',
    number: 42,
  });
});

test('pruneDropsOnlyOurs: a clone with nothing stale, and one holding only our trees', () => {
  assert.equal(pruneDropsOnlyOurs([]), true);
  assert.equal(
    pruneDropsOnlyOurs([
      path.join(reviewRoot(), 'accounts-pr42'),
      path.join(reviewRoot(), 'accounts-pr7'),
    ]),
    true,
  );
});

test('pruneDropsOnlyOurs: one worktree of the user’s declines the whole prune', () => {
  // The case that matters: a worktree on a volume that is merely unmounted reads as prunable, and
  // pruning it discards its HEAD, index, and per-worktree refs.
  assert.equal(
    pruneDropsOnlyOurs([path.join(reviewRoot(), 'accounts-pr42'), '/Volumes/ext/wt/feature-x']),
    false,
  );
  assert.equal(pruneDropsOnlyOurs([AGENT_WORKTREE]), false);
  // A directory named like a review tree, but not under the review root.
  assert.equal(pruneDropsOnlyOurs(['/Users/me/dev/accounts-pr42']), false);
});

test('reviewTreeFor: anything outside the review root is not one of ours', () => {
  assert.equal(reviewTreeFor(CLONE), undefined);
  assert.equal(reviewTreeFor(AGENT_WORKTREE), undefined);
  // A clone that happens to be named like a review tree, but sits elsewhere.
  assert.equal(reviewTreeFor('/Users/me/dev/accounts-pr42'), undefined);
  // Nested deeper than a direct child of the root.
  assert.equal(reviewTreeFor(path.join(reviewRoot(), 'accounts-pr42', 'src')), undefined);
});
