import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTool, runToolPrefix, runToolStreamingBytes } from './exec';
import { OwnedPrRef, RepoId } from './prref';
import { isGitRepo, parseRemote } from './resolver';

/** A file changed in a PR, classified from git's name-status output. */
export interface ChangedFile {
  /** Repo-relative path at HEAD (the new path for renames). */
  path: string;
  /** Prior path at the base, present only for renames. */
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R';
  binary: boolean;
  /** The immutable object at HEAD. Gitlinks stay distinct because their object is a commit. */
  headEntry?: { kind: 'blob'; oid: string } | { kind: 'gitlink'; oid: string };
}

const GIT_CANDIDATES = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'];
const GIT_NOT_FOUND = 'The `git` CLI was not found. Install it or add it to PATH.';

interface GitOpts {
  env?: Record<string, string>;
  input?: string;
}

export function runGit(args: string[], cwd: string, opts: GitOpts = {}): Promise<string> {
  return runTool('git', args, {
    candidates: GIT_CANDIDATES,
    notFound: GIT_NOT_FOUND,
    cwd,
    ...opts,
  });
}

/** The `origin` remote URL, or undefined if unset/unreadable. */
async function originUrl(dir: string): Promise<string | undefined> {
  try {
    return (await runGit(['remote', 'get-url', 'origin'], dir)).trim();
  } catch {
    return undefined;
  }
}

/**
 * The owner and repo `origin` names, read live rather than off the clone scan, which skips a
 * worktree's `.git` pointer file and so answers nothing for a review tree. Undefined for a remote
 * that is not GitHub's, which no caller can build a `gh` query or a PR URL from.
 *
 * One spawn per call: `handoff.repoIdFor` is this read memoized per directory, and is what a
 * repeated question about the same tree should ask.
 */
export async function originRepoId(dir: string): Promise<RepoId | undefined> {
  const url = await originUrl(dir);
  const parsed = url ? parseRemote(url) : undefined;
  return parsed && { owner: parsed.owner, repo: parsed.slug };
}

/**
 * The worktree holding `branch`, or undefined if no tree does. `%(worktreepath)` covers the main
 * clone as well as linked worktrees, and is empty for a branch no tree holds.
 *
 * Undefined too when git can't be read: a failed lookup should fall through to the checkout path
 * rather than fail the click.
 */
const WORKTREE_FORMAT = '%(refname)%09%(worktreepath)';

/** The worktree path `out` gives for exactly `ref`, or undefined if `ref` is absent or holds none.
 * A `for-each-ref` pattern without a glob also matches refs one slash deeper, so `<branch>` selects
 * `<branch>/sub` too, and only the exact ref answers the question asked. */
export function parseWorktreePath(out: string, ref: string): string | undefined {
  for (const line of out.split('\n')) {
    const [refname, ...rest] = line.split('\t');
    if (refname === ref) {
      return rest.join('\t') || undefined;
    }
  }
  return undefined;
}

export async function worktreeHolding(dir: string, branch: string): Promise<string | undefined> {
  const ref = `refs/heads/${branch}`;
  let held: string | undefined;
  try {
    const out = await runGit(['for-each-ref', `--format=${WORKTREE_FORMAT}`, ref], dir);
    held = parseWorktreePath(out, ref);
  } catch {
    return undefined;
  }
  // `%(worktreepath)` carries no prunability bit, and git keeps naming a worktree whose gitdir link
  // is broken (its directory often still exists, emptied). A submodule also reports its gitdir here
  // rather than its checkout. Requiring a real checkout rejects both; a switch needs one anyway.
  return held && isGitRepo(held) ? held : undefined;
}

/** Whether the tree at `dir` holds any staged, unstaged, unmerged, or untracked change. Scans the
 * whole worktree, so it is reserved for the checkout path. `--untracked-files=normal` is explicit
 * because this guards someone's uncommitted work, which a local `status.showUntrackedFiles` must not
 * be able to hide. No header flag is passed, so every line of output is an entry.
 *
 * The question is "does this tree hold anything at all", which an unforced `switchBranch` and a
 * removal both need. A review-branch move asks the narrower `changesFromHead` instead. */
export async function isDirty(dir: string): Promise<boolean> {
  return (
    (await runGit(['status', '--porcelain=v2', '--untracked-files=normal', '--ignore-submodules=none'], dir)).trim() !==
    ''
  );
}

/** Paths as git's `-z` output carries them: NUL-terminated, and so never quoted or escaped. */
function nulSplit(out: string): string[] {
  return out.split('\0').filter((p) => p !== '');
}

/**
 * The tracked files that differ from HEAD in the working tree, the index, or both: what a forced
 * review-branch move resets.
 *
 * Not `git status`, which also reports what the move leaves alone. Most untracked files survive the
 * switch untouched (`untrackedAt` names the ones that do not), and a submodule is never entered, so
 * its state outlives the move whatever it is. Neither is a reason to make a reviewer answer a modal.
 *
 * The index is read separately because `git diff HEAD` compares the working tree against the commit
 * and skips right over it: content staged and then reverted on disk (`git add`, then edit back)
 * differs from HEAD only in the index, which `--discard-changes` resets and no worktree diff names.
 */
export async function changesFromHead(dir: string): Promise<string[]> {
  const [worktree, index] = await Promise.all([
    runGit(['diff', '--name-only', '-z', '--ignore-submodules=all', 'HEAD'], dir),
    runGit(['diff', '--name-only', '-z', '--ignore-submodules=all', '--cached', 'HEAD'], dir),
  ]);
  return [...new Set([...nulSplit(worktree), ...nulSplit(index)])];
}

/**
 * The untracked files whose paths `oid` also carries, which a review-branch move refuses to pass.
 * Every other untracked file is left exactly where it is.
 *
 * `--exclude-standard` keeps gitignored output out of both the question and the answer, matching
 * what a checkout would actually trip over.
 *
 * Intersected against `oid`'s whole tree rather than asked path by path. The narrow query is
 * `cat-file --batch-check`, whose one framing that survives a newline in a path is `-Z`, and that
 * wants git 2.42 while the git Xcode ships is older. Reading the tree costs its size and answers on
 * every git, which is the trade the checkout path wants. Passing the untracked set to `ls-tree` as
 * pathspecs is the other narrow form and is bounded by the command line, which a review tree full of
 * build output can exceed.
 */
export async function untrackedAt(dir: string, oid: string): Promise<string[]> {
  const untracked = nulSplit(await runGit(['ls-files', '--others', '--exclude-standard', '-z'], dir));
  if (untracked.length === 0) {
    return [];
  }
  const carried = new Set(nulSplit(await runGit(['ls-tree', '-r', '-z', '--name-only', oid], dir)));
  return untracked.filter((p) => carried.has(p));
}

export interface Head {
  /** Undefined when HEAD is detached, which git names `HEAD` rather than a ref. */
  branch: string | undefined;
  oid: string;
}

export interface WorktreeState {
  commonDir: string;
  head: Head;
}

const BRANCH_REF_PREFIX = 'refs/heads/';

/**
 * HEAD's branch and commit sha, in one git call that reads refs only. Throws on an unborn branch,
 * which has neither.
 *
 * `--symbolic-full-name` rather than `--abbrev-ref`: the latter shortens only as far as stays
 * unambiguous, so a branch whose name a tag also carries reads back as `heads/v1`, which matches no
 * PR head ref.
 */
/** Every file HEAD tracks: what a repo tour may anchor on. HEAD's tree rather than the index, since
 *  the tour is cached per HEAD. Blobs only, since a submodule's entry is a directory no editor opens. */
export async function filesAtHead(dir: string): Promise<string[]> {
  return parseLsTreeBlobs(await runGit(['ls-tree', '-r', '-z', 'HEAD'], dir));
}

/** The blob paths in `ls-tree -z` output, whose entries read `<mode> <type> <oid>\t<path>`. */
export function parseLsTreeBlobs(out: string): string[] {
  return nulSplit(out).flatMap((entry) => {
    const tab = entry.indexOf('\t');
    return entry.slice(0, tab).split(' ')[1] === 'blob' ? [entry.slice(tab + 1)] : [];
  });
}

export async function readHead(dir: string): Promise<Head> {
  const out = await runGit(['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'], dir);
  return parseHead(out);
}

/** The repository and checkout identity of one worktree, read in one refs-only git process. */
export async function readWorktreeState(dir: string): Promise<WorktreeState> {
  const out = await runGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir', 'HEAD', '--symbolic-full-name', 'HEAD'],
    dir,
  );
  const [commonDir, ...head] = out.split('\n');
  return { commonDir, head: parseHead(head.join('\n')) };
}

function parseHead(out: string): Head {
  const [oid, ref] = out.trim().split('\n');
  const branch = ref?.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : undefined;
  return { branch, oid };
}

/** Whether `ancestor` is an ancestor of `descendant` (false if either is unknown locally). */
export async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(['merge-base', '--is-ancestor', ancestor, descendant], dir);
    return true;
  } catch {
    return false;
  }
}

/** The commit a ref names, or undefined when the ref does not exist locally. */
export async function revParse(dir: string, ref: string): Promise<string | undefined> {
  try {
    return (await runGit(['rev-parse', '--verify', ref], dir)).trim();
  } catch {
    return undefined;
  }
}

/**
 * Update one branch's remote-tracking ref from `origin`. Forced, because a PR branch gets
 * force-pushed as a matter of course, and `--no-tags` because a checkout needs the commits only.
 *
 * `--no-write-fetch-head` because this can run in the background next to another fetch in the same
 * clone (a prefetch the click then joins): letting each rewrite `FETCH_HEAD` races them for no gain,
 * since the tracking ref is all any caller here reads.
 */
export async function fetchBranch(dir: string, branch: string): Promise<void> {
  await fetchRefspec(dir, `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
}

/** Where a fetched PR head lands. Namespaced under `pr/`, which no branch of `origin` can collide
 *  with, since a branch called `pr` would have to be a file where that directory has to be. */
export function pullHeadRef(number: number): string {
  return `refs/remotes/origin/pr/${number}`;
}

/**
 * Land a PR's head commit, wherever it lives. `origin` publishes every PR at `refs/pull/<n>/head`,
 * forks included — the same ref `gh pr checkout` reads — so this reaches a fork's commits without
 * adding its remote, and a fork PR needs no path of its own.
 */
export async function fetchPullHead(dir: string, number: number): Promise<void> {
  await fetchRefspec(dir, `+refs/pull/${number}/head:${pullHeadRef(number)}`);
}

async function fetchRefspec(dir: string, refspec: string): Promise<void> {
  await runGit(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', refspec], dir);
}

export async function switchBranch(dir: string, branch: string): Promise<void> {
  await runGit(['switch', branch], dir);
}

/** Create `branch` from its `origin` counterpart, tracking it, and switch to it. */
export async function switchToNewBranch(dir: string, branch: string): Promise<void> {
  await runGit(['switch', '--create', branch, '--track', `origin/${branch}`], dir);
}

/** Fast-forward the checked-out branch to `commit`. Throws when that is not a fast-forward. */
export async function fastForward(dir: string, commit: string): Promise<void> {
  await runGit(['merge', '--ff-only', commit], dir);
}

/** What checking a PR out locally has to do to the branch named by its head ref. */
export type BranchMove = 'create' | 'switch' | 'fast-forward' | 'diverged';

/**
 * How to move onto a PR's branch, from the local branch's commit (undefined when there is no such
 * branch) and the commit `origin` has it at.
 *
 * `contains` is consulted only when it can change the answer, which is why it is a thunk: asking git
 * whether one commit contains another is a subprocess, and the two commits being equal or the branch
 * being absent already settles it. Keeping the whole decision here is also what stops a caller from
 * having to re-derive those two cases in order to know whether to ask.
 *
 * `diverged` is the case the local path must refuse: the local branch carries commits the PR head
 * does not, so landing the PR means reconciling them, and `gh pr checkout` explains that better than
 * a failed merge would.
 */
export async function planBranchMove(
  local: string | undefined,
  remote: string,
  contains: (local: string) => Promise<boolean>,
): Promise<BranchMove> {
  if (local === undefined) {
    return 'create';
  }
  if (local === remote) {
    return 'switch';
  }
  return (await contains(local)) ? 'fast-forward' : 'diverged';
}

/** Move onto `branch` at `remote`. False when the local branch has diverged from it, which
 *  `gh pr checkout` reports better than a refused merge would. */
export async function switchToPrBranch(dir: string, branch: string, remote: string): Promise<boolean> {
  const local = await revParse(dir, `refs/heads/${branch}`);
  switch (await planBranchMove(local, remote, (l) => isAncestor(dir, l, remote))) {
    case 'create':
      await switchToNewBranch(dir, branch);
      return true;
    case 'switch':
      await switchBranch(dir, branch);
      return true;
    case 'fast-forward':
      await switchBranch(dir, branch);
      await fastForward(dir, remote);
      return true;
    case 'diverged':
      return false;
  }
}

/** The branch `origin/HEAD` names, e.g. `main`; `main` when the clone never recorded one. */
export async function defaultBranch(dir: string): Promise<string> {
  try {
    return (await runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir)).trim().replace(/^origin\//, '');
  } catch {
    return 'main';
  }
}

/**
 * Put the tree at `dir` on `origin`'s default branch at its newest commit, and return the branch's
 * name. Refuses a tree with tracked changes rather than carry them onto another branch.
 *
 * Git checks a branch out in one worktree at most, so when another tree holds it, this tree lands
 * detached at the same commit instead.
 */
export async function checkoutDefaultBranch(dir: string): Promise<string> {
  const branch = await defaultBranch(dir);
  if ((await changesFromHead(dir)).length > 0) {
    throw new Error(`${path.basename(dir)} has uncommitted changes. Commit or stash them before touring ${branch}.`);
  }
  await fetchBranch(dir, branch);
  const remote = (await runGit(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], dir)).trim();
  const held = await worktreeHolding(dir, branch);
  if (held && path.resolve(held) !== path.resolve(dir)) {
    await runGit(['switch', '--detach', remote], dir);
  } else if (!(await switchToPrBranch(dir, branch, remote))) {
    throw new Error(`Local ${branch} has commits origin/${branch} lacks. Reconcile them before touring ${branch}.`);
  }
  return branch;
}

/**
 * Create a worktree at `path`, checked out at `oid` on pr-open's dedicated review branch.
 *
 * `--force` covers a path git still has registered but cannot find — what a crash mid-add, or a
 * review tree removed from under it, leaves behind. Without it that registration is permanent for
 * the PR, since the add that would replace it is the thing being refused. `-B` creates the branch or
 * resets one left by an earlier copy of this same review tree.
 */
export async function addReviewWorktree(dir: string, path: string, branch: string, oid: string): Promise<void> {
  await runGit(['worktree', 'add', '--force', '-B', branch, path, oid], dir);
}

/**
 * Put an existing review worktree on `branch` without changing its files.
 *
 * Used to migrate detached review trees created by older releases. `-C` creates or resets the
 * branch at the commit the tree already holds, while the absence of `--discard-changes` preserves
 * every staged and unstaged edit.
 */
export async function attachReviewBranch(dir: string, branch: string, oid: string): Promise<void> {
  await runGit(['switch', '--force-create', branch, oid], dir);
}

/**
 * Move an existing review worktree and its dedicated branch onto `oid`.
 *
 * `--discard-changes` resets tracked files, so callers check `changesFromHead` first and ask before
 * calling: a review tree is a workspace folder, which makes it somewhere a reviewer edits.
 *
 * It reaches no further. Despite `git checkout(1)` describing `-f` as proceeding "even if there are
 * untracked files in the way", git 2.50 refuses the switch instead — verified in `git.test.ts`, and
 * why `untrackedAt` exists to name that set and `removeFiles` to clear it. Untracked files `oid`
 * does not carry are left alone, which is what keeps a review tree's build output out of the
 * question entirely.
 */
export async function moveReviewBranch(dir: string, branch: string, oid: string): Promise<void> {
  await runGit(['switch', '--discard-changes', '--force-create', branch, oid], dir);
}

/** Record the PR a review branch represents in the format the GitHub Pull Requests extension reads. */
export async function associateBranchWithPr(dir: string, branch: string, ref: OwnedPrRef): Promise<void> {
  await runGit(
    ['config', '--local', `branch.${branch}.github-pr-owner-number`, `${ref.owner}#${ref.repo}#${ref.number}`],
    dir,
  );
}

/**
 * Delete named untracked files, so `moveReviewBranch` is not refused by one of them.
 *
 * Scoped to the paths the caller asked about, rather than the `git clean -fd` across the whole tree
 * this replaced: everything else untracked survives the move, so nothing gives cause to remove it.
 * `--force` because `clean.requireForce` defaults to refusing.
 *
 * `:(literal)` because git reads these as pathspecs, not filenames: without it `a[1].txt` is a glob
 * that also matches `a1.txt`, and this would delete a file the reviewer was never asked about.
 */
export async function removeFiles(dir: string, paths: readonly string[]): Promise<void> {
  await runGit(['clean', '--force', '--', ...paths.map((p) => `:(literal)${p}`)], dir);
}

/**
 * Commit everything in the tree, under the user's own git identity, returning the commit or
 * undefined when there was nothing to stage.
 *
 * `add --all` is safe only on a tree that held nothing before, which is why the review-comment pass
 * refuses to start on a dirty one: everything it sweeps up is then what the pass itself wrote. Hooks
 * run, so a repo whose pre-commit hook rejects the edit fails here rather than pushing past it.
 *
 * The index is checked because a dirty tree does not imply a stageable one: `isDirty` counts a
 * submodule's own modified worktree, which `add --all` stages nothing for, and `git commit` would
 * then fail with "nothing to commit" after the caller had already done its work.
 */
export async function commitAll(dir: string, message: string): Promise<string | undefined> {
  await runGit(['add', '--all'], dir);
  if (!(await runGit(['diff', '--cached', '--name-only'], dir)).trim()) {
    return undefined;
  }
  await runGit(['commit', '-m', message], dir);
  return (await readHead(dir)).oid;
}

/**
 * Push the checked-out commit to `branch` on `origin`.
 *
 * `HEAD:refs/heads/<branch>` rather than a plain `git push`, because a review worktree sits on a
 * `pr-open/review/*` branch of its own and has no upstream to push to. Unforced, so a branch someone
 * else has moved fails here instead of overwriting their commit, and `GIT_TERMINAL_PROMPT=0` so a
 * missing credential fails rather than hanging on a prompt nobody can see.
 */
export async function pushHead(dir: string, branch: string): Promise<void> {
  await runGit(['push', 'origin', `HEAD:refs/heads/${branch}`], dir, { env: { GIT_TERMINAL_PROMPT: '0' } });
}

/**
 * The git directory a repository shares across its worktrees, which is what identifies the
 * repository: every worktree of a clone reports the clone's. Used to tell pr-open's own review tree
 * from a directory that merely sits at the same path — a repo re-cloned since, or a crash mid-add.
 */
export async function repoCommonDir(dir: string): Promise<string> {
  return (await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).trim();
}

/**
 * Remove a worktree and its administrative files, run from inside the tree itself.
 *
 * From inside, because `git worktree remove` only accepts a tree belonging to the repo it runs in,
 * and the set being evicted spans repos: naming the wrong clone fails with "is not a working tree",
 * which would silently defeat the eviction. A tree can remove itself, and doing so still clears the
 * owning repo's entry for it.
 *
 * `--force` because a review tree accumulates gitignored build output, which git otherwise refuses
 * to delete. It will also take a tree holding real work; `worktrees.ts` says why eviction accepts
 * that.
 */
export async function removeWorktree(dir: string): Promise<void> {
  await runGit(['worktree', 'remove', '--force', dir], dir);
}

/** Authored by pr-open, not the user: they did not write this commit, and passing the identity means
 *  a machine with no `user.email` configured still gets its work saved. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'pr-open',
  GIT_AUTHOR_EMAIL: 'pr-open@localhost',
  GIT_COMMITTER_NAME: 'pr-open',
  GIT_COMMITTER_EMAIL: 'pr-open@localhost',
};

let snapshotSeq = 0;

function gitlinkPaths(out: string): Set<string> {
  const paths = new Set<string>();
  for (const record of nulSplit(out)) {
    if (record.startsWith('160000 ')) {
      const tab = record.indexOf('\t');
      if (tab >= 0) {
        paths.add(record.slice(tab + 1));
      }
    }
  }
  return paths;
}

function hasChangedSubmodule(status: string): boolean {
  return nulSplit(status).some((record) => {
    const [kind, , submodule] = record.split(' ', 3);
    return (kind === '1' || kind === '2') && submodule?.length === 4 && submodule[0] === 'S';
  });
}

interface Gitlink {
  path: string;
  oid: string;
}

function trackedGitlinks(index: string): Gitlink[] {
  return nulSplit(index).flatMap((record) => {
    const match = /^160000 ([0-9a-f]+) 0\t([\s\S]+)$/.exec(record);
    return match ? [{ oid: match[1], path: match[2] }] : [];
  });
}

interface GitRef {
  name: string;
  oid: string;
  symref?: string;
}

function parseRefs(out: string): GitRef[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      if (tab < 0) {
        throw new Error(`Git returned an invalid ref record: ${line}`);
      }
      const fields = line.split('\t');
      return {
        name: fields[0],
        oid: fields[1],
        ...(fields[2] ? { symref: fields[2] } : {}),
      };
    });
}

function parseAdvertisedRefs(out: string): GitRef[] {
  return parseRefs(
    out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return tab < 0 ? line : `${line.slice(tab + 1)}\t${line.slice(0, tab)}`;
      })
      .join('\n'),
  );
}

/**
 * Refuse removal when an initialized submodule owns repository state that lives only inside this
 * worktree's gitdir. Parent status cannot see a clean local branch, tag, reflog-only commit, or loose
 * object, and `git worktree remove` deletes the whole worktree-scoped submodule object store.
 *
 * A branch or tag is reproducible when a configured remote advertises the same name and object. A
 * remote-tracking ref is reproducible when its own remote advertises the corresponding branch.
 * Everything else, including a detached HEAD or unreachable object outside that proven history,
 * keeps the worktree in place. Recursing applies the same invariant to nested and deinitialized
 * submodules because their worktree-scoped gitdirs survive after their checkout directories close.
 */
async function assertSubmodulesRemovable(dir: string, prefix = ''): Promise<void> {
  await assertRepositorySubmodulesRemovable({ worktreeDir: dir, commandDir: dir }, prefix);
}

interface LocalRepository {
  worktreeDir: string;
  commandDir: string;
  gitDir?: string;
}

function runRepositoryGit(repo: LocalRepository, args: string[], opts: GitOpts = {}): Promise<string> {
  return runGit(repo.gitDir ? [`--git-dir=${repo.gitDir}`, ...args] : args, repo.commandDir, opts);
}

async function assertRepositorySubmodulesRemovable(repo: LocalRepository, prefix: string): Promise<void> {
  const links = trackedGitlinks(await runRepositoryGit(repo, ['ls-files', '--stage', '-z']));
  for (const link of links) {
    const worktreeDir = path.join(repo.worktreeDir, link.path);
    let child: LocalRepository;
    if (fs.existsSync(path.join(worktreeDir, '.git'))) {
      child = { worktreeDir, commandDir: worktreeDir };
    } else {
      const gitDir = (
        await runRepositoryGit(repo, ['rev-parse', '--path-format=absolute', '--git-path', `modules/${link.path}`])
      ).trim();
      if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
        continue;
      }
      child = { worktreeDir, commandDir: repo.commandDir, gitDir };
    }
    const displayPath = prefix ? `${prefix}/${link.path}` : link.path;
    await assertSubmoduleRemovable(child, link.oid, displayPath);
    await assertRepositorySubmodulesRemovable(child, displayPath);
  }
}

async function assertSubmoduleRemovable(
  repo: LocalRepository,
  expectedOid: string,
  displayPath: string,
): Promise<void> {
  const [head, refs, remoteOutput] = await Promise.all([
    runRepositoryGit(repo, ['rev-parse', 'HEAD']).then((out) => out.trim()),
    runRepositoryGit(repo, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(symref)']).then(parseRefs),
    runRepositoryGit(repo, ['remote']),
  ]);
  if (head !== expectedOid) {
    throw new Error(`Submodule ${displayPath} has a local HEAD that removal cannot preserve.`);
  }

  const remotes = remoteOutput
    .split('\n')
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const localBranches = refs.filter((ref) => ref.name.startsWith('refs/heads/'));
  const tags = refs.filter((ref) => ref.name.startsWith('refs/tags/'));
  const localRemoteRefs = refs.filter((ref) => ref.name.startsWith('refs/remotes/'));
  const remoteBranches = localRemoteRefs.flatMap((ref) => {
    const remote = remotes.find((candidate) => ref.name.startsWith(`refs/remotes/${candidate}/`));
    if (!remote) {
      return [];
    }
    return [{ ref, remote, branch: ref.name.slice(`refs/remotes/${remote}/`.length) }];
  });
  if (remoteBranches.length !== localRemoteRefs.length) {
    const known = new Set(remoteBranches.map(({ ref }) => ref.name));
    const ref = localRemoteRefs.find((candidate) => !known.has(candidate.name));
    throw new Error(`Submodule ${displayPath} has local ref ${ref?.name} that removal cannot preserve.`);
  }
  const requested = new Set([
    ...localBranches.map((ref) => `refs/heads/${ref.name.slice('refs/heads/'.length)}`),
    ...remoteBranches.filter(({ branch }) => branch !== 'HEAD').map(({ branch }) => `refs/heads/${branch}`),
    ...tags.map((ref) => ref.name),
  ]);
  const advertised = new Map<string, Map<string, string>>();
  await Promise.all(
    remotes.map(async (remote) => {
      try {
        const out = await runRepositoryGit(repo, ['ls-remote', '--refs', remote, ...requested], {
          env: { GIT_TERMINAL_PROMPT: '0' },
        });
        advertised.set(remote, new Map(parseAdvertisedRefs(out).map((ref) => [ref.name, ref.oid])));
      } catch {
        // A ref is safe only when some reachable remote below proves it durable.
      }
    }),
  );

  const durableRefs = new Set<string>();
  for (const ref of localBranches) {
    const branch = ref.name.slice('refs/heads/'.length);
    if (ref.symref || !remotes.some((remote) => advertised.get(remote)?.get(`refs/heads/${branch}`) === ref.oid)) {
      throw new Error(`Submodule ${displayPath} has local branch ${branch} that removal cannot preserve.`);
    }
    durableRefs.add(ref.name);
  }
  for (const ref of tags) {
    if (ref.symref || !remotes.some((remote) => advertised.get(remote)?.get(ref.name) === ref.oid)) {
      throw new Error(
        `Submodule ${displayPath} has local tag ${ref.name.slice('refs/tags/'.length)} that removal cannot preserve.`,
      );
    }
    durableRefs.add(ref.name);
  }

  for (const { ref, remote, branch } of remoteBranches.filter(({ branch }) => branch !== 'HEAD')) {
    if (ref.symref || advertised.get(remote)?.get(`refs/heads/${branch}`) !== ref.oid) {
      throw new Error(
        `Submodule ${displayPath} has local remote ref ${remote}/${branch} that removal cannot preserve.`,
      );
    }
    durableRefs.add(ref.name);
  }
  for (const { ref, remote, branch } of remoteBranches.filter(({ branch }) => branch === 'HEAD')) {
    if (!ref.symref || !durableRefs.has(ref.symref)) {
      throw new Error(
        `Submodule ${displayPath} has local remote ref ${remote}/${branch} that removal cannot preserve.`,
      );
    }
    durableRefs.add(ref.name);
  }

  const localRef = refs.find(
    (ref) =>
      !ref.name.startsWith('refs/heads/') &&
      !ref.name.startsWith('refs/remotes/') &&
      !ref.name.startsWith('refs/tags/'),
  );
  if (localRef) {
    throw new Error(`Submodule ${displayPath} has local ref ${localRef.name} that removal cannot preserve.`);
  }

  const containingHead = new Set(
    (await runRepositoryGit(repo, ['for-each-ref', `--contains=${expectedOid}`, '--format=%(refname)']))
      .split('\n')
      .filter(Boolean),
  );
  if (![...durableRefs].some((ref) => containingHead.has(ref))) {
    throw new Error(`Submodule ${displayPath} has a detached HEAD that removal cannot preserve.`);
  }

  const unreachable = await runRepositoryGit(repo, ['fsck', '--unreachable', '--no-reflogs', '--no-progress']);
  if (unreachable.split('\n').some((line) => /^unreachable (?:blob|commit|tag|tree) [0-9a-f]+$/.test(line))) {
    throw new Error(`Submodule ${displayPath} has unreachable local objects that removal cannot preserve.`);
  }
}

/**
 * Commit everything `isDirty` reports in `dir` as a commit no ref points at, and return its oid, or
 * undefined when the tree is clean.
 *
 * What makes an eviction recoverable. Objects belong to the repository rather than the worktree, so
 * the commit outlives the tree it was taken from; nothing references it, so it stays out of the
 * user's history and off their stash stack; and `gc.pruneExpire` (two weeks by default) is what
 * bounds how long it can be recovered.
 *
 * `git stash create` is the obvious shorter form and is wrong here: it captures no untracked file,
 * and an untracked file is precisely what removal cannot otherwise give back. `git add` honours
 * `.gitignore`, so build output stays out of the snapshot for the same reason it never made the tree
 * dirty.
 *
 * The returned commit's tree carries the working tree and untracked files. Its second parent carries
 * the original index, because one file can hold different staged and unstaged versions and no single
 * tree can represent both. The first parent is HEAD, so all three states are reachable from the one
 * oid reported to the reviewer.
 *
 * A scratch index builds the working-tree snapshot without changing the tree's own index. If the
 * original index cannot be written, for example because it contains an unresolved merge, the whole
 * operation fails and callers retain the worktree. The same applies to changed submodules and newly
 * added nested repositories: a gitlink cannot carry the nested repository's objects.
 */
export async function snapshotWorkTree(dir: string, message: string): Promise<string | undefined> {
  const index = path.join(os.tmpdir(), `pr-open-snapshot-${process.pid}-${snapshotSeq++}`);
  const env = { ...SNAPSHOT_IDENTITY, GIT_INDEX_FILE: index };
  try {
    const status = await runGit(
      ['status', '--porcelain=v2', '-z', '--untracked-files=normal', '--ignore-submodules=none'],
      dir,
    );
    if (hasChangedSubmodule(status)) {
      throw new Error('A submodule contains changes that a parent-repository commit cannot save.');
    }
    await assertSubmodulesRemovable(dir);
    if (status === '') {
      return undefined;
    }
    const existingGitlinks = gitlinkPaths(await runGit(['ls-tree', '-r', '-z', 'HEAD'], dir));
    const stagedTree = (await runGit(['write-tree'], dir)).trim();
    // Beginning at the real index makes an ignored, force-staged addition tracked in the scratch
    // index, so `add --all` refreshes its working version instead of silently omitting it.
    await runGit(['read-tree', stagedTree], dir, { env });
    await runGit(['add', '--all'], dir, { env });
    const stagedDeletions = await runGit(
      ['diff', '--cached', '--name-only', '-z', '--diff-filter=D', '--no-renames', 'HEAD'],
      dir,
    );
    if (stagedDeletions !== '') {
      // A staged deletion can leave an ignored working file that `add --all` omits. These paths were
      // tracked at HEAD, so forcing exactly this NUL-framed set captures their working state.
      await runGit(['add', '--all', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], dir, {
        env,
        input: stagedDeletions,
      });
    }
    const capturedGitlinks = gitlinkPaths(await runGit(['ls-files', '--stage', '-z'], dir, { env }));
    if ([...capturedGitlinks].some((gitlink) => !existingGitlinks.has(gitlink))) {
      throw new Error('A newly added nested repository cannot be saved as a parent-repository commit.');
    }
    const staged = (
      await runGit(['commit-tree', stagedTree, '-p', 'HEAD', '-m', `${message} (index)`], dir, {
        env: SNAPSHOT_IDENTITY,
      })
    ).trim();
    const tree = (await runGit(['write-tree'], dir, { env })).trim();
    return (await runGit(['commit-tree', tree, '-p', 'HEAD', '-p', staged, '-m', message], dir, { env })).trim();
  } finally {
    await fs.promises.rm(index, { force: true });
  }
}

/** Remove a review worktree only after every change has a repository-owned recovery commit. */
export async function removeWorktreePreservingChanges(dir: string, message: string): Promise<string | undefined> {
  const rescue = await snapshotWorkTree(dir, message);
  await removeWorktree(dir);
  return rescue;
}

/**
 * Drop administrative entries for worktrees whose directories are gone.
 *
 * Prunes the clone's whole set — git offers no way to name one — which is why callers check
 * `prunableWorktrees` first and decline when any of them is not pr-open's.
 */
export async function pruneWorktrees(dir: string): Promise<void> {
  await runGit(['worktree', 'prune'], dir);
}

/** The worktrees git would drop on the next prune, by path. */
export async function prunableWorktrees(dir: string): Promise<string[]> {
  return parsePrunable(await runGit(['worktree', 'list', '--porcelain'], dir));
}

/** `git worktree list --porcelain` emits a blank-line-separated record per worktree, opening with
 *  `worktree <path>` and carrying a `prunable <reason>` line only when git would drop it. */
export function parsePrunable(out: string): string[] {
  const prunable: string[] = [];
  let current: string | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length);
    } else if (line.startsWith('prunable') && current !== undefined) {
      prunable.push(current);
      current = undefined;
    }
  }
  return prunable;
}

/**
 * The merge base of `baseRef` and HEAD, i.e. where the PR branched. The PR diff (three-dot)
 * is computed against this, matching what GitHub shows. Returns undefined if `baseRef` is
 * not present locally.
 */
export async function mergeBase(dir: string, baseRef: string): Promise<string | undefined> {
  try {
    return (await runGit(['merge-base', baseRef, 'HEAD'], dir)).trim();
  } catch {
    return undefined;
  }
}

/**
 * A PR's merge base from what is already local: its head's base oid, else the remote base branch.
 * Undefined when neither is present, leaving the fetch decision to the caller — the ask surfaces
 * resolve this inside a commenting-range provider, where network I/O would be wrong.
 */
export async function resolvePrBase(dir: string, baseRefOid: string, baseRefName: string): Promise<string | undefined> {
  return (await mergeBase(dir, baseRefOid)) ?? (await mergeBase(dir, `origin/${baseRefName}`));
}

/**
 * Files changed from the merge base to HEAD, classified by status with rename detection.
 * `base` is the merge-base sha (three-dot semantics are already captured by diffing base..HEAD).
 */
export async function changedFiles(dir: string, base: string): Promise<ChangedFile[]> {
  const [raw, numstat] = await Promise.all([
    runGit(['diff', '--raw', '-z', '--no-abbrev', '-M', base, 'HEAD'], dir),
    runGit(['diff', '--numstat', '-z', '-M', base, 'HEAD'], dir),
  ]);

  // A rename's numstat record ends after the second tab, followed by old and new path records.
  // Every path is NUL-delimited so tabs, newlines, quotes, and core.quotePath cannot change it.
  const binary = new Set<string>();
  const stats = numstat.split('\0');
  for (let i = 0; i < stats.length; ) {
    const record = stats[i++];
    if (record === '') {
      continue;
    }
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    const adds = record.slice(0, firstTab);
    const dels = record.slice(firstTab + 1, secondTab);
    let file = record.slice(secondTab + 1);
    if (file === '') {
      i++; // old path
      file = stats[i++] ?? '';
    }
    if (adds === '-' && dels === '-') {
      binary.add(file);
    }
  }

  const files: ChangedFile[] = [];
  const entries = raw.split('\0');
  for (let i = 0; i < entries.length; ) {
    const metadata = entries[i++];
    if (metadata === '') {
      continue;
    }
    const parsed = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])\d*$/.exec(metadata);
    if (parsed === null) {
      throw new Error(`Unexpected git raw diff record: ${metadata}`);
    }
    const [, headMode, headOid, code] = parsed;
    const oldPath = entries[i++];
    if (oldPath === undefined) {
      throw new Error('Git raw diff ended before its path record.');
    }

    let path = oldPath;
    if (code === 'R') {
      const renamedPath = entries[i++];
      if (renamedPath === undefined) {
        throw new Error('Git raw rename record ended before its new path.');
      }
      path = renamedPath;
    }

    const status = code === 'A' ? 'A' : code === 'D' ? 'D' : code === 'R' ? 'R' : 'M';
    const headEntry =
      status === 'D'
        ? undefined
        : headMode === '160000'
          ? { kind: 'gitlink' as const, oid: headOid }
          : headMode === '100644' || headMode === '100755' || headMode === '120000'
            ? { kind: 'blob' as const, oid: headOid }
            : undefined;
    files.push({
      path,
      ...(status === 'R' ? { oldPath } : {}),
      status,
      binary: binary.has(path),
      ...(headEntry === undefined ? {} : { headEntry }),
    });
  }
  return files;
}

/** High-churn, low-signal paths dropped from the review diff: narrating them wastes tokens and
 * generation time, and the walkthrough never anchors a step in them. */
const DIFF_EXCLUDES = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/go.sum',
  '**/*.min.js',
  '**/*.min.css',
];

/** Unified diff from the merge base to the local HEAD, i.e. the tree the tour actually
 * decorates. `base` is the merge-base sha, so this is three-dot vs the PR's base. Lockfiles and
 * other generated noise are excluded so the review focuses on code the reviewer reads. */
export async function localDiff(dir: string, base: string): Promise<string> {
  const excludes = DIFF_EXCLUDES.map((p) => `:(exclude)${p}`);
  return runGit(['diff', base, 'HEAD', '--', '.', ...excludes], dir);
}

/** Whether a changed file belongs in the model-readable review diff. */
export enum ReviewFileDisposition {
  Reviewable = 'reviewable',
  Generated = 'generated',
  Vendored = 'vendored',
  Binary = 'binary',
}

/** Coarse reading order for independently generated review batches. */
export enum ReviewSection {
  Contract = 'contract',
  Production = 'production',
  Test = 'test',
}

/** One changed file, paired with the exact patch and deterministic review classification. */
export interface ReviewFilePatch {
  file: ChangedFile;
  patch: string;
  disposition: ReviewFileDisposition;
  section: ReviewSection;
  additions: number;
  deletions: number;
}

/** The unfiltered local diff and its per-file review representation. */
export interface ReviewDiff {
  rawBytes: number;
  files: ReviewFilePatch[];
}

const GENERATED_PREFIX_BYTES = 8 * 1024;
const ATTRIBUTE_BATCH_SIZE = 128;

const VENDORED_PATH = /(^|\/)vendor(\/|$)/;
const DERIVED_PATH =
  /(^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$|\.(?:min\.js|min\.css|gen\.go|pb\.go)$/;
const GENERATED_HEADER = /\bgenerated\b[\s\S]{0,200}\bdo not edit\b/i;
const FIXTURE_PATH = /(^|\/)fixtures?(\/|$)/;
const TEST_PATH =
  /(^|\/)(?:test|tests|testdata|fixtures?)(\/|$)|(?:^|\/)[^/]*(?:_test\.[^/]+|\.test\.[^/]+|\.spec\.[^/]+)$/;
const CONTRACT_PATH = /(^|\/)(?:api|openapi|proto|protos|schema|schemas|migrations?)(\/|$)|\.(?:proto|graphql|sql)$/;

/** Build the walkthrough's diff. Ask Claude deliberately keeps using {@link localDiff}. */
export async function reviewDiff(dir: string, base: string, changed: readonly ChangedFile[]): Promise<ReviewDiff> {
  const raw = await runGit(['diff', '-M', base, 'HEAD'], dir);
  const patches = splitReviewPatches(raw);
  if (patches.length !== changed.length) {
    throw new Error(
      `Could not align the review diff: git reported ${changed.length} files but emitted ${patches.length} patches.`,
    );
  }

  const attributes = await generatedAttributes(
    dir,
    changed.map((f) => f.path),
  );
  const prefixFiles = changed.filter(
    (file) => file.status !== 'D' && needsGeneratedHeader(file, attributes.get(file.path) ?? 'unspecified'),
  );
  const prefixes = await reviewFilePrefixes(dir, prefixFiles);
  const files: ReviewFilePatch[] = [];
  for (let i = 0; i < changed.length; i++) {
    const file = changed[i];
    const patch = patches[i];
    const attribute = attributes.get(file.path) ?? 'unspecified';
    const prefix = needsGeneratedHeader(file, attribute)
      ? (prefixes.get(file.path) ?? patch.slice(0, GENERATED_PREFIX_BYTES))
      : '';
    const [additions, deletions] = patchLineCounts(patch);
    files.push({
      file,
      patch,
      disposition: classifyReviewFile(file, attribute, prefix),
      section: reviewSection(file.path),
      additions,
      deletions,
    });
  }
  return { rawBytes: Buffer.byteLength(raw), files };
}

/** Split a normal unified diff without parsing quoted paths; name-status and patch output share order. */
export function splitReviewPatches(diff: string): string[] {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((m) => m.index ?? 0);
  return starts.map((start, i) => diff.slice(start, starts[i + 1] ?? diff.length));
}

/** Classify a file from repo-owned attributes first, then path and generated-header conventions. */
export function classifyReviewFile(
  file: ChangedFile,
  linguistGenerated: string,
  prefix: string,
): ReviewFileDisposition {
  if (file.binary) {
    return ReviewFileDisposition.Binary;
  }
  if (linguistGenerated === 'false' || linguistGenerated === 'unset') {
    return ReviewFileDisposition.Reviewable;
  }
  if (linguistGenerated === 'true' || linguistGenerated === 'set') {
    return ReviewFileDisposition.Generated;
  }
  if (FIXTURE_PATH.test(file.path)) {
    return ReviewFileDisposition.Reviewable;
  }
  if (VENDORED_PATH.test(file.path)) {
    return ReviewFileDisposition.Vendored;
  }
  if (DERIVED_PATH.test(file.path) || GENERATED_HEADER.test(prefix)) {
    return ReviewFileDisposition.Generated;
  }
  return ReviewFileDisposition.Reviewable;
}

/** Put contracts first and tests last while preserving git's order inside each section. */
export function reviewSection(file: string): ReviewSection {
  if (TEST_PATH.test(file)) {
    return ReviewSection.Test;
  }
  return CONTRACT_PATH.test(file) ? ReviewSection.Contract : ReviewSection.Production;
}

function needsGeneratedHeader(file: ChangedFile, attribute: string): boolean {
  return (
    !file.binary &&
    attribute === 'unspecified' &&
    !FIXTURE_PATH.test(file.path) &&
    !VENDORED_PATH.test(file.path) &&
    !DERIVED_PATH.test(file.path)
  );
}

type GitObjectType = 'blob' | 'commit' | 'tag' | 'tree';
type UnavailableObjectReason = 'ambiguous' | 'excluded' | 'filtered' | 'missing' | 'promisor' | 'submodule';

export type BatchObjectInfo =
  | { state: 'present'; oid: string; objectType: GitObjectType; size: number }
  | { state: 'unavailable'; oid: string; reason: UnavailableObjectReason };

const UNAVAILABLE_OBJECT = /^([0-9a-f]+) (ambiguous|excluded|filtered|missing|promisor|submodule)$/;
const PRESENT_OBJECT = /^([0-9a-f]+) (blob|commit|tag|tree) (\d+)$/;
const NO_LAZY_FETCH = { GIT_NO_LAZY_FETCH: '1' };

/** Parse one newline-delimited `cat-file --batch-check` record per immutable object ID. */
export function parseBatchObjectInfo(output: string, expected: number): BatchObjectInfo[] {
  const records = output.split('\n');
  if (records.at(-1) === '') {
    records.pop();
  }
  if (records.length !== expected) {
    throw new Error(`Git cat-file returned ${records.length} of ${expected} object records.`);
  }

  return records.map((record) => {
    const present = PRESENT_OBJECT.exec(record);
    if (present !== null) {
      const size = Number(present[3]);
      if (!Number.isSafeInteger(size)) {
        throw new Error(`Git cat-file returned an invalid object size: ${record}`);
      }
      return {
        state: 'present',
        oid: present[1],
        objectType: present[2] as GitObjectType,
        size,
      };
    }
    const unavailable = UNAVAILABLE_OBJECT.exec(record);
    if (unavailable !== null) {
      return {
        state: 'unavailable',
        oid: unavailable[1],
        reason: unavailable[2] as UnavailableObjectReason,
      };
    }
    throw new Error(`Unexpected git cat-file object record: ${record}`);
  });
}

interface ReviewBlob {
  path: string;
  oid: string;
  size: number;
}

const BATCH_PROTOCOL_ERROR = Symbol('batch protocol error');

/** Read reviewed blob prefixes by object ID, so path bytes never enter the batch protocol. */
async function reviewFilePrefixes(dir: string, files: readonly ChangedFile[]): Promise<Map<string, string>> {
  const prefixes = new Map<string, string>();
  const blobs = files.flatMap((file) =>
    file.headEntry?.kind === 'blob' ? [{ path: file.path, oid: file.headEntry.oid }] : [],
  );
  if (blobs.length === 0) {
    return prefixes;
  }

  let output: string;
  try {
    output = await runTool('git', ['cat-file', '--batch-check'], {
      candidates: GIT_CANDIDATES,
      notFound: GIT_NOT_FOUND,
      cwd: dir,
      env: NO_LAZY_FETCH,
      input: `${blobs.map((blob) => blob.oid).join('\n')}\n`,
    });
  } catch {
    return prefixes;
  }

  let info: BatchObjectInfo[];
  try {
    info = parseBatchObjectInfo(output, blobs.length);
  } catch {
    return prefixes;
  }
  const readable: ReviewBlob[] = [];
  for (let i = 0; i < blobs.length; i++) {
    const object = info[i];
    if (object.state === 'present' && object.objectType === 'blob') {
      readable.push({ ...blobs[i], size: object.size });
    }
  }

  const small = readable.filter((blob) => blob.size <= GENERATED_PREFIX_BYTES);
  if (small.length > 0) {
    await readSmallBlobPrefixes(dir, small, prefixes);
  }

  const largePrefixes = new Map<string, string>();
  for (const blob of readable) {
    if (blob.size <= GENERATED_PREFIX_BYTES) {
      continue;
    }
    let prefix = largePrefixes.get(blob.oid);
    if (prefix === undefined) {
      try {
        const bytes = await runToolPrefix(
          'git',
          ['cat-file', 'blob', blob.oid],
          {
            candidates: GIT_CANDIDATES,
            notFound: GIT_NOT_FOUND,
            cwd: dir,
            env: NO_LAZY_FETCH,
          },
          GENERATED_PREFIX_BYTES,
        );
        prefix = bytes.toString('utf8');
        largePrefixes.set(blob.oid, prefix);
      } catch {
        continue;
      }
    }
    prefixes.set(blob.path, prefix);
  }
  return prefixes;
}

/** Stream blobs whose complete contents fit in the prefix window through one framed process. */
async function readSmallBlobPrefixes(
  dir: string,
  blobs: readonly ReviewBlob[],
  prefixes: Map<string, string>,
): Promise<void> {
  const discardBatch = () => {
    for (const blob of blobs) {
      prefixes.delete(blob.path);
    }
  };
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let index = 0;
  let remaining: number | undefined;
  let parts: Buffer<ArrayBufferLike>[] = [];
  let bytes = 0;

  const consume = (data: Buffer) => {
    pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
    while (index < blobs.length) {
      if (remaining === undefined) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) {
          return;
        }
        const header = pending.subarray(0, newline).toString('utf8');
        pending = pending.subarray(newline + 1);
        const [object] = parseBatchObjectInfo(`${header}\n`, 1);
        if (object.state === 'unavailable') {
          index++;
          continue;
        }
        if (object.objectType !== 'blob' || object.size > GENERATED_PREFIX_BYTES) {
          throw BATCH_PROTOCOL_ERROR;
        }
        remaining = object.size;
        parts = [];
        bytes = 0;
      }

      const take = Math.min(remaining, pending.length);
      if (take > 0) {
        parts.push(pending.subarray(0, take));
        bytes += take;
      }
      pending = pending.subarray(take);
      remaining -= take;
      if (remaining > 0 || pending.length === 0) {
        return;
      }
      if (pending[0] !== 0x0a) {
        throw BATCH_PROTOCOL_ERROR;
      }
      pending = pending.subarray(1);
      prefixes.set(blobs[index].path, Buffer.concat(parts, bytes).toString('utf8'));
      index++;
      remaining = undefined;
    }
  };

  try {
    await runToolStreamingBytes(
      'git',
      ['cat-file', '--batch'],
      {
        candidates: GIT_CANDIDATES,
        notFound: GIT_NOT_FOUND,
        cwd: dir,
        env: NO_LAZY_FETCH,
        input: `${blobs.map((blob) => blob.oid).join('\n')}\n`,
      },
      consume,
    );
  } catch {
    discardBatch();
    return;
  }
  if (index !== blobs.length || remaining !== undefined || pending.length !== 0) {
    discardBatch();
  }
}

/** Read `linguist-generated` in bounded argv batches so a PR with thousands of files still fits. */
async function generatedAttributes(dir: string, files: readonly string[]): Promise<Map<string, string>> {
  const attributes = new Map<string, string>();
  for (let i = 0; i < files.length; i += ATTRIBUTE_BATCH_SIZE) {
    const batch = files.slice(i, i + ATTRIBUTE_BATCH_SIZE);
    const fields = nulSplit(
      await runGit(['check-attr', '--source=HEAD', '-z', 'linguist-generated', '--', ...batch], dir),
    );
    for (let j = 0; j + 2 < fields.length; j += 3) {
      attributes.set(fields[j], fields[j + 2]);
    }
  }
  return attributes;
}

/** Added/deleted content lines only; diff headers that also begin with +/- do not count. */
function patchLineCounts(patch: string): [number, number] {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && line.startsWith('+')) {
      additions++;
    } else if (inHunk && line.startsWith('-')) {
      deletions++;
    }
  }
  return [additions, deletions];
}

/** Contents of `path` at `ref`. Empty string if the path does not exist at that ref. */
export async function showFile(dir: string, ref: string, path: string): Promise<string> {
  try {
    return await runGit(['show', `${ref}:${path}`], dir);
  } catch {
    return '';
  }
}
