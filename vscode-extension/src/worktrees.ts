import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  addReviewWorktree,
  associateBranchWithPr,
  attachReviewBranch,
  changesFromHead,
  moveReviewBranch,
  prunableWorktrees,
  pruneWorktrees,
  readWorktreeState,
  removeFiles,
  removeWorktreePreservingChanges,
  repoCommonDir,
  untrackedAt,
  WorktreeState,
} from './git';
import { log } from './logger';
import { OwnedPrRef } from './prref';
import { Clone, isGitRepo, resolveClone } from './resolver';
import {
  MAX_REVIEW_TREES,
  parseReviewTreeName,
  pickEvictions,
  pruneDropsOnlyOurs,
  reviewBranchName,
  reviewRoot,
  ReviewTree,
  reviewTreeFor,
  reviewTreeName,
} from './reviewtree';
import { errorMessage, samePath } from './util';
import { releaseWorkspaceFolder } from './workspace';

/**
 * The review worktrees on disk: cutting them, re-pointing them, and keeping their number bounded.
 * `reviewtree.ts` holds the rules this carries out.
 *
 * Each tree uses a branch in pr-open's own namespace. It cannot collide with the PR's head branch,
 * and its PR metadata gives the GitHub Pull Requests extension the identity it needs to activate
 * review comments in the diff.
 *
 * A review tree is added to the window as a workspace folder, which makes it somewhere a reviewer
 * edits — trying a suggested fix while reading is the ordinary reason to have the code checked out.
 * Moving a tree therefore asks first. Eviction does not: the cap is what keeps the set bounded, so the
 * least recently reviewed tree goes whether or not it holds work. What it holds is committed out of
 * reach first, because only this window's folders are consulted and the reviewer who has the work may
 * be sitting in another one — a warning can reach nobody, so the recovery cannot depend on it. A
 * directory git cannot use as the expected worktree is moved aside whole before replacement.
 * Gitignored build output is not dirty, so the ordinary eviction is silent and snapshots nothing.
 */

/** Last-reviewed times, keyed by worktree dir. Only the eviction ranking lives here — the trees
 *  themselves are enumerated from disk, so a lost record costs an ordering, never a leaked
 *  worktree. */
const USE_KEY = 'prOpen.reviewTreeUse';

/** How the review trees reach the reviewer. A parameter so the wording and the choice of channel
 *  stay with the checkout path that owns every other notification. */
export interface ReviewTreeUi {
  /** Whether to give up `atRisk` — the files in PR `number`'s tree that moving it would take.
   *  Asked before anything moves it, and never with an empty list. */
  confirmDiscard(number: number, atRisk: readonly string[]): Promise<boolean>;
  /** Report that PR `number`'s evicted tree held work, saved as commit `rescue`. */
  reportRemovedDirty(number: number, rescue: string): void;
  /** Report that an unusable directory was preserved at `saved` before the review tree replaced it. */
  reportMovedAside(number: number, saved: string): void;
}

/**
 * Serializes every read-modify-write of the use record.
 *
 * `globalState` offers no atomic update, so an unsynchronized read-stamp-write loses whichever
 * write started first. The stamp is what keeps `pickEvictions` from selecting a tree that is open:
 * a checkout whose stamp is lost ranks `at: 0`, which is *oldest*, so the next checkout evicts the
 * tree the user is reading. Held for the record only — the removals it decides on run outside, since
 * deleting a checkout takes seconds and a second checkout must not queue behind it.
 */
let pending: Promise<unknown> = Promise.resolve();

function serialized<T>(op: () => Promise<T>): Promise<T> {
  const run = pending.then(op, op);
  pending = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Trees whose removal is under way. They are still on disk, so `listReviewTrees` still finds them;
 *  skipping them keeps a second trim from picking a victim the first is already deleting. */
const removing = new Set<string>();
let recreateSeq = 0;

/** The review trees on disk, in directory order. */
function listReviewTrees(used: Record<string, number>): ReviewTree[] {
  const root = reviewRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // no root yet: nothing has ever needed one
  }
  const trees: ReviewTree[] = [];
  for (const e of entries) {
    const parsed = e.isDirectory() ? parseReviewTreeName(e.name) : undefined;
    if (!parsed) {
      continue;
    }
    const dir = path.join(root, e.name);
    if (isGitRepo(dir)) {
      trees.push({ dir, number: parsed.number, at: used[dir] ?? 0 });
    }
  }
  return trees;
}

/**
 * The review worktree for a PR, checked out at `oid`, creating or re-pointing it as needed.
 * Undefined when the reviewer declined to give up what an existing tree holds, which leaves that
 * tree on its old commit and so is not a checkout of the PR to hand back.
 *
 * The tree's use is recorded before this returns, because that record is the only thing standing
 * between it and a concurrent checkout's eviction pass. Recorded on a decline too: the tree still
 * holds the work they chose to keep, and eviction is what would take it next. Trimming back to
 * `MAX_REVIEW_TREES` then runs behind the click: deleting a checkout full of build output takes
 * seconds, and the click is waiting on this to show the PR.
 */
export async function ensureReviewTree(
  context: vscode.ExtensionContext,
  cloneDir: string,
  ref: OwnedPrRef,
  oid: string,
  ui: ReviewTreeUi,
): Promise<string | undefined> {
  const { repo, number } = ref;
  const dir = path.join(reviewRoot(), reviewTreeName(repo, number));
  const branch = reviewBranchName(repo, number);
  const checkout = await ownedCheckout(dir, cloneDir);
  let holdsPr = true;
  if (checkout) {
    // Already ours: moving it costs the difference between two commits rather than a full checkout.
    //
    // A move that fails leaves a tree that is not a checkout of the PR, which is what `recreate`
    // exists to replace — and reaching it is what keeps the failure from being permanent, since
    // `ownedCheckout` stays true and every retry would otherwise take this same branch forever. git
    // refuses a switch over untracked collisions `untrackedAt` cannot name (a case-only difference
    // on a case-insensitive filesystem, or a path one side holds as a file and the other as a
    // directory), so this is reachable without anything being wrong with the tree.
    holdsPr = await moveReviewTreeAtState(dir, ref, oid, ui, checkout).catch(async (e) => {
      log(`review tree: could not move ${dir} to ${oid} (${errorMessage(e)}); cutting a fresh one`);
      await recreate(cloneDir, dir, branch, number, oid, ui);
      return true;
    });
  } else {
    // Written before the branch appears so the Git extension's HEAD event cannot make the PR
    // extension validate the new branch in the gap between checkout and association.
    await associateBranchWithPr(cloneDir, branch, ref);
    await recreate(cloneDir, dir, branch, number, oid, ui);
  }
  await stampUse(context, dir);
  void trim(context, ui).catch((e) => log(`review tree: trim failed: ${errorMessage(e)}`));
  return holdsPr ? dir : undefined;
}

/**
 * Point an existing review tree at `oid`, asking first about whatever that destroys. False means the
 * reviewer declined, and the tree is exactly as it was found.
 *
 * The whole move lives here rather than being assembled by each caller, because its three steps only
 * make sense together: a checkout and a pull both reach a review tree the same way, and either one
 * that skipped a step would ask a question it should not or discard work it should have asked about.
 *
 * Already-there costs only the one-time branch migration and asks nothing. Re-opening a PR whose
 * head has not moved is the ordinary way here, and a forced branch move resets tracked files
 * whatever commit it is handed, so the compare avoids asking the reviewer to change nothing.
 */
export async function moveReviewTree(
  dir: string,
  ref: OwnedPrRef,
  oid: string,
  ui: ReviewTreeUi,
): Promise<boolean> {
  return moveReviewTreeAtState(dir, ref, oid, ui, await readWorktreeState(dir));
}

async function moveReviewTreeAtState(
  dir: string,
  ref: OwnedPrRef,
  oid: string,
  ui: ReviewTreeUi,
  state: WorktreeState,
): Promise<boolean> {
  const branch = reviewBranchName(ref.repo, ref.number);
  const { head } = state;
  if (head.branch !== branch) {
    // Before the switch so the Git extension's HEAD event cannot make the PR extension validate the
    // new branch in the gap between checkout and association.
    await associateBranchWithPr(dir, branch, ref);
  }
  if (head.oid === oid) {
    if (head.branch !== branch) {
      await attachReviewBranch(dir, branch, oid);
    }
    return true;
  }
  if (!(await clearForMove(dir, oid, ref.number, ui))) {
    log(`review tree: ${dir} stays on its commit, the reviewer kept what a move would discard`);
    return false;
  }
  await moveReviewBranch(dir, branch, oid);
  return true;
}

/** The state of `dir` when it is a live worktree of `cloneDir`. A directory can sit at a review
 * tree's path without being one: a crash between `worktree add` and its first use, a repo re-cloned
 * since, or a `git worktree prune` the user ran themselves, all of which leave git unable to work
 * there at all. Reading ownership and HEAD together saves a serialized git process on every reuse. */
async function ownedCheckout(dir: string, cloneDir: string): Promise<WorktreeState | undefined> {
  if (!isGitRepo(dir)) {
    return undefined;
  }
  try {
    const [tree, clone] = await Promise.all([readWorktreeState(dir), repoCommonDir(cloneDir)]);
    return samePath(tree.commonDir, clone) ? tree : undefined;
  } catch {
    return undefined; // a wedged gitdir link: git cannot read it, so neither can we use it
  }
}

/**
 * Replace whatever is at `dir` with a fresh worktree of `cloneDir`.
 *
 * Removing first is what makes a wedged tree recoverable: `git worktree add` refuses a path that
 * exists, so without this a single failed checkout would make the PR unopenable for good. The
 * registration the removal orphans is `--force`'s to override, so this depends on no prune.
 *
 * A directory at this path which is not the expected live worktree could be a broken checkout or an
 * unrelated repository. Moving it aside whole preserves every file and object store, then frees the
 * expected path for a fresh checkout without trying to infer which contents matter.
 */
async function recreate(
  cloneDir: string,
  dir: string,
  branch: string,
  number: number,
  oid: string,
  ui: ReviewTreeUi,
): Promise<void> {
  if (fs.existsSync(dir)) {
    const saved = `${dir}.saved-${Date.now()}-${recreateSeq++}`;
    log(`review tree: ${dir} is not a usable worktree of ${cloneDir}; moving it to ${saved}`);
    await fs.promises.rename(dir, saved);
    ui.reportMovedAside(number, saved);
  }
  await fs.promises.mkdir(reviewRoot(), { recursive: true });
  await addReviewWorktree(cloneDir, dir, branch, oid);
}

/**
 * Get the reviewer's consent to what moving `dir` onto `oid` destroys, then leave the tree in a
 * state `moveReviewBranch` can move. False means they declined, and the tree is exactly as found.
 *
 * Two sets go, and they are the whole of it: the tracked files `--discard-changes` resets, and the
 * untracked files `oid` carries, which block the switch and so have to be cleared to honour a yes.
 * Every other untracked file survives the move untouched and is never mentioned. Asking about those
 * as well is what made this fire on ordinary checkouts — a review tree is a workspace folder, so
 * language servers and build tools drop files into it that are nobody's work.
 *
 * A tree git cannot read reports nothing and so asks nothing.
 */
async function clearForMove(
  dir: string,
  oid: string,
  number: number,
  ui: ReviewTreeUi,
): Promise<boolean> {
  const [changed, blocking] = await Promise.all([
    changesFromHead(dir).catch(() => []),
    untrackedAt(dir, oid).catch(() => []),
  ]);
  // Blocking first, and deduplicated: a path can be both (`git rm --cached` leaves the file on disk
  // and out of the index), and the modal names only the first few. The untracked ones are the entries
  // that must survive that truncation, since they are the ones no commit can give back.
  const atRisk = [...new Set([...blocking, ...changed])];
  if (atRisk.length === 0) {
    return true;
  }
  log(`review tree: moving ${dir} to ${oid} discards ${atRisk.length}: ${atRisk.join(', ')}`);
  if (!(await ui.confirmDiscard(number, atRisk))) {
    return false;
  }
  if (blocking.length > 0) {
    await removeFiles(dir, blocking);
  }
  return true;
}

/** Prune a clone's stale worktree entries, or decline when doing so would take one of the user's. */
async function safePrune(cloneDir: string): Promise<void> {
  const prunable = await prunableWorktrees(cloneDir);
  if (prunable.length === 0) {
    return;
  }
  if (!pruneDropsOnlyOurs(prunable)) {
    log(`review tree: not pruning ${cloneDir}, it holds prunable worktrees that are not pr-open's`);
    return;
  }
  await pruneWorktrees(cloneDir);
}

/** Record that `dir` was just reviewed, so it sorts newest and cannot be evicted. */
function stampUse(context: vscode.ExtensionContext, dir: string): Promise<void> {
  return serialized(async () => {
    await context.globalState.update(USE_KEY, { ...readUse(context), [dir]: Date.now() });
  });
}

/** Evict down to the cap, least recently reviewed first. */
async function trim(context: vscode.ExtensionContext, ui: ReviewTreeUi): Promise<void> {
  const victims = await serialized(async () => {
    const trees = listReviewTrees(readUse(context)).filter((t) => !removing.has(t.dir));
    const picked = pickEvictions(trees, MAX_REVIEW_TREES);
    for (const tree of picked) {
      removing.add(tree.dir);
    }
    return picked;
  });
  try {
    for (const tree of victims) {
      await evict(tree, ui);
    }
  } finally {
    for (const tree of victims) {
      removing.delete(tree.dir);
    }
  }
  await reconcile(context);
}

async function evict(tree: ReviewTree, ui: ReviewTreeUi): Promise<void> {
  const dir = tree.dir;
  // The window's root folder cannot be dropped without restarting the extension host, which is a
  // worse outcome than one extra worktree. It stays until it is no longer folder 0, and the next
  // review tries again.
  //
  // Only this window's folders are consulted, and removal is forced: a tree another window holds
  // open is taken anyway, leaving that window a dead folder its next activation sweeps up. Windows
  // share no state to coordinate through, and the alternative is an unbounded set.
  const release = await releaseWorkspaceFolder(dir);
  if (release === 'root' || release === 'refused') {
    log(`review tree: keeping ${dir}, this window still holds it (${release})`);
    return;
  }
  // The helper snapshots and removes as one ordered operation. Any inspection or snapshot failure
  // leaves the tree intact for the next sweep rather than making recovery depend on this caller.
  try {
    const rescue = await removeWorktreePreservingChanges(
      dir,
      `uncommitted work from PR #${tree.number}'s review checkout`,
    );
    log(`review tree: removed ${dir}`);
    if (rescue !== undefined) {
      log(`review tree: ${dir} held uncommitted changes, saved as ${rescue}`);
      ui.reportRemovedDirty(tree.number, rescue);
    }
  } catch (e) {
    log(`review tree: keeping ${dir}, its work could not be saved and removed: ${errorMessage(e)}`);
  }
}

/**
 * Reconcile the recorded set with disk at activation, catching whatever a crash or a manual
 * `rm -rf` left: administrative entries with no directory, and records with no tree.
 *
 * Only a record whose directory is gone can have left an entry behind, so in the steady state this
 * inspects no clone at all.
 */
export async function sweepReviewTrees(
  context: vscode.ExtensionContext,
  clones: readonly Clone[],
): Promise<void> {
  const used = readUse(context);
  const onDisk = new Set(listReviewTrees(used).map((t) => t.dir));
  const repos = new Set(
    Object.keys(used)
      .filter((dir) => !onDisk.has(dir))
      .map((dir) => reviewTreeFor(dir)?.repo)
      .filter((repo) => repo !== undefined),
  );
  const owners = [...repos].map((repo) => resolveClone(repo, clones)).filter((c) => c !== undefined);
  await Promise.all(
    owners.map((c) =>
      safePrune(c.dir).catch((e) => log(`review tree: prune ${c.dir}: ${errorMessage(e)}`)),
    ),
  );
  await reconcile(context);
}

/** Drop the use records of trees that are no longer on disk. */
function reconcile(context: vscode.ExtensionContext): Promise<void> {
  return serialized(async () => {
    const used = readUse(context);
    const live = new Set(listReviewTrees(used).map((t) => t.dir));
    const kept = Object.fromEntries(Object.entries(used).filter(([dir]) => live.has(dir)));
    if (Object.keys(kept).length !== Object.keys(used).length) {
      await context.globalState.update(USE_KEY, kept);
    }
  });
}

function readUse(context: vscode.ExtensionContext): Record<string, number> {
  const stored = context.globalState.get<unknown>(USE_KEY);
  if (typeof stored !== 'object' || stored === null) {
    return {};
  }
  const entries = Object.entries(stored as Record<string, unknown>);
  return Object.fromEntries(entries.filter(([, at]) => typeof at === 'number')) as Record<string, number>;
}
