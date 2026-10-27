import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, TestContext } from 'node:test';
import {
  addReviewWorktree,
  associateBranchWithPr,
  attachReviewBranch,
  changesFromHead,
  isDirty,
  moveReviewBranch,
  parsePrunable,
  parseWorktreePath,
  planBranchMove,
  readHead,
  readWorktreeState,
  removeFiles,
  removeWorktreePreservingChanges,
  repoCommonDir,
  runGit,
  snapshotWorkTree,
  untrackedAt,
} from '../src/git';

// Real `git for-each-ref --format=%(refname)%09%(worktreepath)` output. The pattern
// `refs/heads/andrewcho/at-2052` selects the deeper ref too, which is why the refname is matched.
const HELD = `refs/heads/andrewcho/at-2052\t/Users/me/dev/accounts
refs/heads/andrewcho/at-2052/statsig-gates\t/Users/me/dev/accounts/.claude/worktrees/gates
`;

test('parseWorktreePath: takes the exact ref, not the deeper one the pattern also matched', () => {
  assert.equal(parseWorktreePath(HELD, 'refs/heads/andrewcho/at-2052'), '/Users/me/dev/accounts');
  assert.equal(
    parseWorktreePath(HELD, 'refs/heads/andrewcho/at-2052/statsig-gates'),
    '/Users/me/dev/accounts/.claude/worktrees/gates',
  );
});

test('parseWorktreePath: a ref no worktree holds, and a ref that is absent, both read undefined', () => {
  const out = 'refs/heads/unheld\t\nrefs/heads/unheld/deeper\t/Users/me/wt\n';
  assert.equal(parseWorktreePath(out, 'refs/heads/unheld'), undefined);
  assert.equal(parseWorktreePath(out, 'refs/heads/absent'), undefined);
  assert.equal(parseWorktreePath('', 'refs/heads/absent'), undefined);
});

// Real `git worktree list --porcelain` output. Records are blank-line separated, and only a
// prunable worktree carries the `prunable` line.
const WORKTREES = `worktree /Users/me/dev/accounts
HEAD fece6a8087dd8a979fc4297c680f4cc863155976
branch refs/heads/main

worktree /Users/me/.pr-open/worktrees/accounts-pr42
HEAD fece6a8087dd8a979fc4297c680f4cc863155976
detached
prunable gitdir file points to non-existent location

worktree /Volumes/ext/wt/feature-x
HEAD fece6a8087dd8a979fc4297c680f4cc863155976
detached
prunable gitdir file points to non-existent location
`;

test('parsePrunable: names only the worktrees git would drop', () => {
  assert.deepEqual(parsePrunable(WORKTREES), [
    '/Users/me/.pr-open/worktrees/accounts-pr42',
    '/Volumes/ext/wt/feature-x',
  ]);
});

test('parsePrunable: a clone with nothing stale reports none', () => {
  assert.deepEqual(parsePrunable('worktree /Users/me/dev/accounts\nbranch refs/heads/main\n'), []);
  assert.deepEqual(parsePrunable(''), []);
});

/** A throwaway repo with one commit, for the checks that have to ask real git. */
async function scratchRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-open-git-'));
  await runGit(['init', '--quiet', '--initial-branch=main'], dir);
  await runGit(['config', 'user.email', 'test@example.com'], dir);
  await runGit(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\nprivate*.txt\n');
  await runGit(['add', '-A'], dir);
  await runGit(['commit', '--quiet', '-m', 'c1'], dir);
  return dir;
}

async function nestedRepo(dir: string): Promise<string> {
  fs.mkdirSync(dir);
  await runGit(['init', '--quiet', '--initial-branch=main'], dir);
  await runGit(['config', 'user.email', 'test@example.com'], dir);
  await runGit(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'nested.txt'), 'nested\n');
  await runGit(['add', '-A'], dir);
  await runGit(['commit', '--quiet', '-m', 'nested'], dir);
  return (await runGit(['rev-parse', 'HEAD'], dir)).trim();
}

interface SubmoduleReview {
  dir: string;
  source: string;
  tree: string;
  child: string;
  expected: string;
}

async function submoduleReview(
  t: TestContext,
  configureSource?: (source: string) => Promise<void>,
): Promise<SubmoduleReview> {
  const dir = await scratchRepo();
  const source = `${dir}-submodule-source`;
  const tree = `${dir}-review`;
  t.after(() => {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await nestedRepo(source);
  await configureSource?.(source);
  await runGit(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', source, 'child'], dir);
  await runGit(['commit', '--quiet', '-m', 'add submodule'], dir);
  const head = (await runGit(['rev-parse', 'HEAD'], dir)).trim();
  const expected = (await runGit(['rev-parse', 'HEAD:child'], dir)).trim();
  await addReviewWorktree(dir, tree, 'pr-open/review/test-submodule', head);
  await runGit(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '--quiet'], tree);
  const child = path.join(tree, 'child');
  await runGit(['config', 'user.email', 'test@example.com'], child);
  await runGit(['config', 'user.name', 'Test'], child);
  return { dir, source, tree, child, expected };
}

test('addReviewWorktree: checks out the PR commit on its dedicated branch', async (t) => {
  const dir = await scratchRepo();
  const tree = `${dir}-review`;
  t.after(() => {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const oid = (await runGit(['rev-parse', 'HEAD'], dir)).trim();
  const branch = 'pr-open/review/accounts-pr42';

  await addReviewWorktree(dir, tree, branch, oid);

  assert.deepEqual(await readHead(tree), { branch, oid });
  assert.deepEqual(await readWorktreeState(tree), {
    commonDir: await repoCommonDir(dir),
    head: { branch, oid },
  });
});

test('attachReviewBranch: migrates a detached tree without discarding staged or unstaged edits', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oid = (await runGit(['rev-parse', 'HEAD'], dir)).trim();
  await runGit(['switch', '--detach', oid], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
  await runGit(['add', 'a.txt'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'unstaged\n');
  const branch = 'pr-open/review/accounts-pr42';

  await attachReviewBranch(dir, branch, oid);

  assert.deepEqual(await readHead(dir), { branch, oid });
  assert.equal(await runGit(['show', ':a.txt'], dir), 'staged\n');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'unstaged\n');
});

test('associateBranchWithPr: writes the metadata consumed by the GitHub PR extension', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const branch = 'pr-open/review/accounts-pr42';

  await associateBranchWithPr(dir, branch, {
    owner: 'moment-technology',
    repo: 'accounts',
    number: 42,
  });

  assert.equal(
    await runGit(['config', '--local', `branch.${branch}.github-pr-owner-number`], dir),
    'moment-technology#accounts#42\n',
  );
});

// `isDirty` answers "does this tree hold anything at all", which is what switching the user's clone
// onto a branch and removing a review tree both need. Its correctness rests on the invocation rather
// than on any parsing: no header flag, so any output means dirty.
test('isDirty: a clean tree, and each kind of change that must count as dirty', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(await isDirty(dir), false);

  // Gitignored build output stays clean, which is what keeps review trees evictable.
  fs.mkdirSync(path.join(dir, 'build'));
  fs.writeFileSync(path.join(dir, 'build', 'out.js'), 'x\n');
  assert.equal(await isDirty(dir), false, 'gitignored output is not the user’s work');

  fs.writeFileSync(path.join(dir, 'notes.md'), 'reviewer notes\n');
  assert.equal(await isDirty(dir), true, 'an untracked file nothing would recover');
  fs.rmSync(path.join(dir, 'notes.md'));

  fs.writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
  assert.equal(await isDirty(dir), true, 'a tracked edit');
  await runGit(['add', '-A'], dir);
  assert.equal(await isDirty(dir), true, 'staged too');
});

// The snapshot is the only thing standing between an eviction and lost work, and every claim it makes
// is a property of the plumbing rather than of any parsing.
test('snapshotWorkTree: saves exactly what isDirty reported, referenced by nothing', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
  await runGit(['add', 'a.txt'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'reviewer notes\n');
  fs.mkdirSync(path.join(dir, 'build'));
  fs.writeFileSync(path.join(dir, 'build', 'out.js'), 'x\n');

  const oid = await snapshotWorkTree(dir, 'saved work');
  assert.ok(oid);
  assert.match(oid, /^[0-9a-f]{40}$/);

  const files = (await runGit(['ls-tree', '-r', '--name-only', oid], dir)).split('\n');
  assert.ok(files.includes('notes.md'), 'the untracked file nothing else would recover');
  assert.equal(await runGit(['show', `${oid}:a.txt`], dir), 'edited\n', 'the working-tree edit');
  assert.equal(await runGit(['show', `${oid}^2:a.txt`], dir), 'staged\n', 'the distinct staged edit');
  assert.equal(files.includes('build/out.js'), false, 'gitignored output is not the user’s work');

  // Unreachable, so it neither joins the user's history nor lands on their stash stack. Only
  // `gc.pruneExpire` bounds it.
  assert.equal((await runGit(['log', '--all', '--format=%H'], dir)).includes(oid), false);
  assert.equal(await runGit(['stash', 'list'], dir), '');

  // A scratch index: a tree left behind by a failed removal must not be found with work staged.
  assert.equal(await runGit(['show', ':a.txt'], dir), 'staged\n');
  assert.equal(await isDirty(dir), true, 'the worktree itself is untouched');
});

test('removeWorktreePreservingChanges: recovers staged and working versions of an ignored addition', async (t) => {
  const dir = await scratchRepo();
  const tree = `${dir}-review`;
  t.after(() => {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, 'private-tracked.txt'), 'base tracked\n');
  await runGit(['add', '--force', 'private-tracked.txt'], dir);
  await runGit(['commit', '--quiet', '-m', 'track ignored file'], dir);
  const head = (await runGit(['rev-parse', 'HEAD'], dir)).trim();
  await addReviewWorktree(dir, tree, 'pr-open/review/test-pr1', head);
  fs.writeFileSync(path.join(tree, 'private-added.txt'), 'staged secret\n');
  await runGit(['add', '--force', 'private-added.txt'], tree);
  fs.writeFileSync(path.join(tree, 'private-added.txt'), 'working secret\n');
  await runGit(['rm', '--cached', '--quiet', 'private-tracked.txt'], tree);
  fs.writeFileSync(path.join(tree, 'private-tracked.txt'), 'working tracked\n');

  const rescue = await removeWorktreePreservingChanges(tree, 'saved work');

  assert.ok(rescue);
  assert.equal(fs.existsSync(tree), false, 'the recoverable worktree can be evicted');
  assert.equal(await runGit(['show', `${rescue}:private-added.txt`], dir), 'working secret\n');
  assert.equal(await runGit(['show', `${rescue}^2:private-added.txt`], dir), 'staged secret\n');
  assert.equal(await runGit(['show', `${rescue}:private-tracked.txt`], dir), 'working tracked\n');
  await assert.rejects(runGit(['cat-file', '-e', `${rescue}^2:private-tracked.txt`], dir));
});

test('snapshotWorkTree: refuses uncommitted files inside a tracked submodule', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = path.join(dir, 'child');
  const childOid = await nestedRepo(child);
  await runGit(['update-index', '--add', '--cacheinfo', `160000,${childOid},child`], dir);
  await runGit(['commit', '--quiet', '-m', 'add submodule'], dir);
  fs.writeFileSync(path.join(child, 'nested.txt'), 'uncommitted\n');

  await assert.rejects(snapshotWorkTree(dir, 'saved work'), /submodule contains changes/);
  assert.equal(fs.readFileSync(path.join(child, 'nested.txt'), 'utf8'), 'uncommitted\n');
});

test('removeWorktreePreservingChanges: keeps a local submodule commit and its worktree', async (t) => {
  const dir = await scratchRepo();
  const source = `${dir}-submodule-source`;
  const tree = `${dir}-review`;
  t.after(() => {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await nestedRepo(source);
  await runGit(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', source, 'child'], dir);
  await runGit(['commit', '--quiet', '-m', 'add submodule'], dir);
  const head = (await runGit(['rev-parse', 'HEAD'], dir)).trim();
  await addReviewWorktree(dir, tree, 'pr-open/review/test-pr2', head);
  await runGit(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--quiet'], tree);
  await runGit(['config', 'submodule.child.ignore', 'all'], tree);
  const child = path.join(tree, 'child');
  await runGit(['config', 'user.email', 'test@example.com'], child);
  await runGit(['config', 'user.name', 'Test'], child);
  fs.writeFileSync(path.join(child, 'nested.txt'), 'local commit\n');
  await runGit(['add', 'nested.txt'], child);
  await runGit(['commit', '--quiet', '-m', 'local child commit'], child);
  const localCommit = (await runGit(['rev-parse', 'HEAD'], child)).trim();
  await assert.rejects(runGit(['cat-file', '-e', `${localCommit}^{commit}`], source));

  await assert.rejects(removeWorktreePreservingChanges(tree, 'saved work'), /submodule contains changes/);
  await runGit(['add', 'child'], tree);
  await assert.rejects(removeWorktreePreservingChanges(tree, 'saved work'), /submodule contains changes/);

  assert.equal(fs.existsSync(tree), true, 'a failed snapshot blocks eviction');
  assert.equal(await runGit(['cat-file', '-t', localCommit], child), 'commit\n');
  assert.equal(fs.readFileSync(path.join(child, 'nested.txt'), 'utf8'), 'local commit\n');
});

test('removeWorktreePreservingChanges: removes an ordinary clean submodule with a remote tag', async (t) => {
  const review = await submoduleReview(t, async (source) => {
    await runGit(['tag', '-a', 'release', '-m', 'remote release'], source);
  });
  assert.match(await runGit(['show-ref', '--verify', 'refs/tags/release'], review.child), /^[0-9a-f]+/);

  const rescue = await removeWorktreePreservingChanges(review.tree, 'saved work');

  assert.equal(rescue, undefined);
  assert.equal(fs.existsSync(review.tree), false);
});

test('removeWorktreePreservingChanges: keeps a clean local submodule branch and its objects', async (t) => {
  const review = await submoduleReview(t);
  await runGit(['switch', '--quiet', '--create', 'saved-local'], review.child);
  fs.writeFileSync(path.join(review.child, 'nested.txt'), 'local branch\n');
  await runGit(['add', 'nested.txt'], review.child);
  await runGit(['commit', '--quiet', '-m', 'local branch commit'], review.child);
  const localCommit = (await runGit(['rev-parse', 'HEAD'], review.child)).trim();
  await runGit(['switch', '--quiet', '--detach', review.expected], review.child);
  await runGit(['config', 'submodule.child.ignore', 'all'], review.tree);
  assert.equal(await runGit(['status', '--porcelain'], review.tree), '');

  await assert.rejects(removeWorktreePreservingChanges(review.tree, 'saved work'), /local branch saved-local/);

  assert.equal(fs.existsSync(review.tree), true);
  assert.equal(await runGit(['cat-file', '-t', localCommit], review.child), 'commit\n');
  assert.match(await runGit(['show-ref', '--verify', 'refs/heads/saved-local'], review.child), new RegExp(localCommit));
});

test('removeWorktreePreservingChanges: keeps a clean local submodule tag and its objects', async (t) => {
  const review = await submoduleReview(t);
  fs.writeFileSync(path.join(review.child, 'nested.txt'), 'local tag\n');
  await runGit(['add', 'nested.txt'], review.child);
  await runGit(['commit', '--quiet', '-m', 'local tag commit'], review.child);
  const localCommit = (await runGit(['rev-parse', 'HEAD'], review.child)).trim();
  await runGit(['tag', '-a', 'saved-tag', '-m', 'local tag'], review.child);
  await runGit(['switch', '--quiet', '--detach', review.expected], review.child);
  assert.equal(await runGit(['status', '--porcelain'], review.tree), '');

  await assert.rejects(removeWorktreePreservingChanges(review.tree, 'saved work'), /local tag saved-tag/);

  assert.equal(fs.existsSync(review.tree), true);
  assert.equal(await runGit(['cat-file', '-t', localCommit], review.child), 'commit\n');
  assert.match(await runGit(['show-ref', '--verify', 'refs/tags/saved-tag'], review.child), /^[0-9a-f]+/);
});

test('removeWorktreePreservingChanges: keeps an unreferenced local submodule commit', async (t) => {
  const review = await submoduleReview(t);
  fs.writeFileSync(path.join(review.child, 'nested.txt'), 'unreferenced\n');
  await runGit(['add', 'nested.txt'], review.child);
  await runGit(['commit', '--quiet', '-m', 'unreferenced commit'], review.child);
  const localCommit = (await runGit(['rev-parse', 'HEAD'], review.child)).trim();
  await runGit(['switch', '--quiet', '--detach', review.expected], review.child);
  assert.equal(await runGit(['status', '--porcelain'], review.tree), '');

  await assert.rejects(removeWorktreePreservingChanges(review.tree, 'saved work'), /unreachable local objects/);

  assert.equal(fs.existsSync(review.tree), true);
  assert.equal(await runGit(['cat-file', '-t', localCommit], review.child), 'commit\n');
});

test('removeWorktreePreservingChanges: keeps a detached submodule commit absent from remote history', async (t) => {
  const review = await submoduleReview(t);
  await runGit(['switch', '--quiet', '--orphan', 'replacement'], review.source);
  await runGit(['commit', '--quiet', '--allow-empty', '-m', 'replacement history'], review.source);
  const replacement = (await runGit(['rev-parse', 'HEAD'], review.source)).trim();
  await runGit(['branch', '--force', 'main', replacement], review.source);
  await runGit(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], review.child);
  await runGit(['branch', '--force', 'main', 'refs/remotes/origin/main'], review.child);
  assert.equal(await runGit(['status', '--porcelain'], review.tree), '');

  await assert.rejects(removeWorktreePreservingChanges(review.tree, 'saved work'), /detached HEAD/);

  assert.equal(fs.existsSync(review.tree), true);
  assert.equal(await runGit(['cat-file', '-t', review.expected], review.child), 'commit\n');
});

test('removeWorktreePreservingChanges: finds local state in an initialized nested submodule', async (t) => {
  const dir = await scratchRepo();
  const childSource = `${dir}-child-source`;
  const nestedSource = `${dir}-nested-source`;
  const tree = `${dir}-review`;
  t.after(() => {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(childSource, { recursive: true, force: true });
    fs.rmSync(nestedSource, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await nestedRepo(nestedSource);
  await nestedRepo(childSource);
  await runGit(
    ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', nestedSource, 'nested'],
    childSource,
  );
  await runGit(['commit', '--quiet', '-m', 'add nested submodule'], childSource);
  await runGit(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', childSource, 'child'], dir);
  await runGit(['commit', '--quiet', '-m', 'add child submodule'], dir);
  const head = (await runGit(['rev-parse', 'HEAD'], dir)).trim();
  await addReviewWorktree(dir, tree, 'pr-open/review/test-nested-submodule', head);
  await runGit(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '--quiet'], tree);
  const nested = path.join(tree, 'child', 'nested');
  const expected = (await runGit(['rev-parse', 'HEAD'], nested)).trim();
  await runGit(['config', 'user.email', 'test@example.com'], nested);
  await runGit(['config', 'user.name', 'Test'], nested);
  await runGit(['switch', '--quiet', '--create', 'nested-local'], nested);
  fs.writeFileSync(path.join(nested, 'nested.txt'), 'nested local branch\n');
  await runGit(['add', 'nested.txt'], nested);
  await runGit(['commit', '--quiet', '-m', 'nested local branch'], nested);
  const localCommit = (await runGit(['rev-parse', 'HEAD'], nested)).trim();
  await runGit(['switch', '--quiet', '--detach', expected], nested);
  assert.equal(await runGit(['status', '--porcelain'], tree), '');

  await assert.rejects(
    removeWorktreePreservingChanges(tree, 'saved work'),
    /Submodule child\/nested has local branch nested-local/,
  );

  assert.equal(fs.existsSync(tree), true);
  assert.equal(await runGit(['cat-file', '-t', localCommit], nested), 'commit\n');
});

test('removeWorktreePreservingChanges: removes an ordinary deinitialized submodule', async (t) => {
  const review = await submoduleReview(t);
  await runGit(['submodule', 'deinit', '--force', '--quiet', 'child'], review.tree);

  const rescue = await removeWorktreePreservingChanges(review.tree, 'saved work');

  assert.equal(rescue, undefined);
  assert.equal(fs.existsSync(review.tree), false);
});

test('removeWorktreePreservingChanges: keeps local state in a deinitialized submodule', async (t) => {
  const review = await submoduleReview(t);
  await runGit(['switch', '--quiet', '--create', 'deinitialized-local'], review.child);
  fs.writeFileSync(path.join(review.child, 'nested.txt'), 'deinitialized local branch\n');
  await runGit(['add', 'nested.txt'], review.child);
  await runGit(['commit', '--quiet', '-m', 'deinitialized local branch'], review.child);
  const localCommit = (await runGit(['rev-parse', 'HEAD'], review.child)).trim();
  const gitDir = (await runGit(['rev-parse', '--path-format=absolute', '--git-dir'], review.child)).trim();
  await runGit(['switch', '--quiet', '--detach', review.expected], review.child);
  await runGit(['submodule', 'deinit', '--force', '--quiet', 'child'], review.tree);

  await assert.rejects(removeWorktreePreservingChanges(review.tree, 'saved work'), /branch deinitialized-local/);

  assert.equal(fs.existsSync(review.tree), true);
  assert.equal(await runGit([`--git-dir=${gitDir}`, 'cat-file', '-t', localCommit], review.tree), 'commit\n');
});

test('snapshotWorkTree: refuses an untracked nested repository', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = path.join(dir, 'child');
  await nestedRepo(child);

  await assert.rejects(snapshotWorkTree(dir, 'saved work'), /newly added nested repository/);
  assert.equal(fs.readFileSync(path.join(child, 'nested.txt'), 'utf8'), 'nested\n');
});

// What separates this from `isDirty` is the whole point of it existing: a forced review-branch move
// resets tracked files and leaves the rest, so a tree full of build output must not raise a modal.
test('changesFromHead: names the tracked edits a move discards, and nothing else', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(await changesFromHead(dir), []);

  fs.writeFileSync(path.join(dir, 'notes.md'), 'reviewer notes\n');
  fs.mkdirSync(path.join(dir, 'build'));
  fs.writeFileSync(path.join(dir, 'build', 'out.js'), 'x\n');
  assert.deepEqual(await changesFromHead(dir), [], 'untracked and gitignored files survive the move');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
  assert.deepEqual(await changesFromHead(dir), ['a.txt']);
  await runGit(['add', 'a.txt'], dir);
  assert.deepEqual(await changesFromHead(dir), ['a.txt'], 'staged reads the same as unstaged');

  // Staging is what turns an untracked file into work the move would take, and it then reads as one.
  await runGit(['add', 'notes.md'], dir);
  assert.deepEqual(await changesFromHead(dir), ['a.txt', 'notes.md']);
});

// The case `git diff HEAD` alone cannot see: the working tree matches HEAD, so a worktree diff is
// empty, while the index holds a blob `--discard-changes` resets and nothing else references.
test('changesFromHead: content staged and then reverted on disk is still work a move takes', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
  await runGit(['add', 'a.txt'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  assert.equal(await runGit(['diff', '--name-only', 'HEAD'], dir), '', 'the worktree matches HEAD');

  assert.deepEqual(await changesFromHead(dir), ['a.txt']);

  // What the modal would otherwise have failed to warn about: the staged blob is the only copy.
  const staged = (await runGit(['rev-parse', ':a.txt'], dir)).trim();
  assert.equal(await runGit(['cat-file', 'blob', staged], dir), 'staged\n');
});

test('changesFromHead: a path git would quote comes back as the path itself', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = 'a file "quoted" ünïcode.txt';
  fs.writeFileSync(path.join(dir, name), 'one\n');
  await runGit(['add', '-A'], dir);
  await runGit(['commit', '--quiet', '-m', 'c2'], dir);
  fs.writeFileSync(path.join(dir, name), 'two\n');
  assert.deepEqual(await changesFromHead(dir), [name]);
});

/** A repo whose HEAD commit no longer carries `a.txt`, so re-pointing it at the first commit needs
 *  that path back — the shape every untracked-file collision takes. Returns the first commit. */
async function repoDroppingAText(dir: string): Promise<string> {
  const first = (await runGit(['rev-parse', 'HEAD'], dir)).trim();
  await runGit(['rm', '--quiet', 'a.txt'], dir);
  await runGit(['commit', '--quiet', '-m', 'c2'], dir);
  return first;
}

// `git checkout(1)` says `-f` proceeds "even if there are untracked files in the way"; git 2.50
// refuses instead. The distinction decides whether anything has to be cleared before a move, so it
// is pinned rather than trusted, and `untrackedAt` exists only because this is how it behaves.
test('moveReviewBranch: refuses rather than overwrite an untracked file the target carries', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = await repoDroppingAText(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'mine\n');

  await assert.rejects(moveReviewBranch(dir, 'pr-open/review/test-pr1', first), /a\.txt/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'mine\n', 'left as it was');
});

test('untrackedAt: names the untracked files that block the move, and only those', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = await repoDroppingAText(dir);

  assert.deepEqual(await untrackedAt(dir, first), []);

  fs.writeFileSync(path.join(dir, 'notes.md'), 'reviewer notes\n');
  fs.mkdirSync(path.join(dir, 'build'));
  fs.writeFileSync(path.join(dir, 'build', 'out.js'), 'x\n');
  assert.deepEqual(await untrackedAt(dir, first), [], 'nothing the target carries is in the way');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'mine\n');
  assert.deepEqual(await untrackedAt(dir, first), ['a.txt']);

  // Clearing exactly that set is what makes a move possible without touching anything else.
  await removeFiles(dir, await untrackedAt(dir, first));
  await moveReviewBranch(dir, 'pr-open/review/test-pr1', first);
  assert.equal(fs.existsSync(path.join(dir, 'notes.md')), true, 'the reviewer’s other file stays');
  assert.equal(fs.existsSync(path.join(dir, 'build', 'out.js')), true, 'so does build output');
});

// The gap `ensureReviewTree` falls back to `recreate` for. Both sides of the intersection are exact
// paths, so a collision git resolves by path *shape* is invisible to it: here the target carries a
// directory where the tree holds an untracked file, and `git switch` refuses over a path this names
// nothing about. Pinned because a tree that will not move is only recoverable by being cut fresh.
test('untrackedAt: a file where the target carries a directory reads as no collision, and blocks anyway', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'd'));
  fs.writeFileSync(path.join(dir, 'd', 'x.txt'), 'x\n');
  await runGit(['add', '-A'], dir);
  await runGit(['commit', '--quiet', '-m', 'c2'], dir);
  const carrying = (await runGit(['rev-parse', 'HEAD'], dir)).trim();
  await runGit(['rm', '--quiet', '-r', 'd'], dir);
  await runGit(['commit', '--quiet', '-m', 'c3'], dir);

  fs.writeFileSync(path.join(dir, 'd'), 'mine\n');
  assert.deepEqual(await changesFromHead(dir), [], 'nothing tracked differs');
  assert.deepEqual(await untrackedAt(dir, carrying), [], 'and the path intersection is empty');

  await assert.rejects(
    moveReviewBranch(dir, 'pr-open/review/test-pr1', carrying),
    /\bd\b/,
    'yet the move cannot be made',
  );
});

// Both sides of the intersection are `-z` output, and git quotes such a name in every other format,
// so a quoted path is where the two sets would fail to meet and a real collision go unnamed.
test('untrackedAt: a path git would quote is matched against the tree as itself', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = 'a file "quoted" ünïcode.txt';
  fs.writeFileSync(path.join(dir, name), 'one\n');
  await runGit(['add', '-A'], dir);
  await runGit(['commit', '--quiet', '-m', 'c2'], dir);
  const carrying = (await runGit(['rev-parse', 'HEAD'], dir)).trim();
  await runGit(['rm', '--quiet', name], dir);
  await runGit(['commit', '--quiet', '-m', 'c3'], dir);

  fs.writeFileSync(path.join(dir, name), 'mine\n');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'reviewer notes\n');
  assert.deepEqual(await untrackedAt(dir, carrying), [name]);
});

// `git clean` reads its arguments as pathspecs, so an unescaped name is a glob: without
// `:(literal)` this deletes `a1.txt` as well, which the reviewer was never asked about.
test('removeFiles: a name holding glob characters takes only that file', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a[1].txt'), 'named\n');
  fs.writeFileSync(path.join(dir, 'a1.txt'), 'bystander\n');

  await removeFiles(dir, ['a[1].txt']);
  assert.equal(fs.existsSync(path.join(dir, 'a[1].txt')), false, 'the file named goes');
  assert.equal(fs.existsSync(path.join(dir, 'a1.txt')), true, 'the file the glob would have matched');
});

test('isDirty: status.showUntrackedFiles=no cannot hide the user’s work', async (t) => {
  const dir = await scratchRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await runGit(['config', 'status.showUntrackedFiles', 'no'], dir);
  fs.writeFileSync(path.join(dir, 'notes.md'), 'reviewer notes\n');
  assert.equal(await isDirty(dir), true);
});

/** A containment check that records whether it was consulted, since asking git costs a subprocess. */
function contains(answer: boolean): ((local: string) => Promise<boolean>) & { asked: boolean } {
  const fn = Object.assign(
    (_local: string) => {
      fn.asked = true;
      return Promise.resolve(answer);
    },
    { asked: false },
  );
  return fn;
}

test('planBranchMove: creates the branch when nothing local carries the head ref', async () => {
  const ask = contains(false);
  assert.equal(await planBranchMove(undefined, 'aaa', ask), 'create');
  assert.equal(ask.asked, false);
});

test('planBranchMove: a local branch already at the head only needs a switch', async () => {
  const ask = contains(false);
  assert.equal(await planBranchMove('aaa', 'aaa', ask), 'switch');
  assert.equal(ask.asked, false);
});

test('planBranchMove: a local branch the head contains fast-forwards', async () => {
  assert.equal(await planBranchMove('aaa', 'bbb', contains(true)), 'fast-forward');
});

test('planBranchMove: a local branch with commits the head lacks has diverged', async () => {
  assert.equal(await planBranchMove('aaa', 'bbb', contains(false)), 'diverged');
});
