import * as os from 'os';
import * as path from 'path';
import { samePath } from './util';

/**
 * Where a PR gets reviewed, and which review checkouts to keep.
 *
 * Split from `worktrees.ts`, which enacts these decisions through git and the VS Code API: the rule
 * about which tree a review may use is the substance of the change and is worth stating (and
 * testing) on its own, the same way `folders.ts` states the rule `workspace.ts` carries out.
 */

/**
 * How many review worktrees to keep. A constant rather than a setting, for the reason `MAX_ADDED`
 * gives in `folders.ts`: the useful value is "enough that re-opening a recent review is free", and
 * each one costs a checkout's worth of disk. Small, because only a PR whose branch is held
 * elsewhere ever needs one.
 */
export const MAX_REVIEW_TREES = 3;

/** A review worktree on disk. */
export interface ReviewTree {
  dir: string;
  /** The PR it holds, read off the directory name that encodes it. */
  number: number;
  /** When it was last reviewed; 0 when unrecorded, which ranks it for eviction first. */
  at: number;
}

/** Where review worktrees live. Dot-prefixed so `scanClones` skips it (it ignores dotted entries),
 *  and somewhere the user can find, inspect, and delete. */
export function reviewRoot(): string {
  return path.join(os.homedir(), '.pr-open', 'worktrees');
}

/** Directory name for a PR's review tree. One per PR, so re-reviewing reuses rather than adds. */
export function reviewTreeName(repo: string, number: number): string {
  return `${repo.replace(/[^\w.-]/g, '_')}-pr${number}`;
}

/** Local branch held only by a review tree. It gives the GitHub PR extension the checkout identity
 *  its review-comment gutter requires without claiming the PR head branch. */
export function reviewBranchName(repo: string, number: number): string {
  return `pr-open/review/${reviewTreeName(repo, number).replaceAll('.', '_')}`;
}

/** The PR a review tree's directory name encodes, or undefined when the name is not one of ours.
 *  Matched from the right, since a repo slug may itself end in something like `-pr2`. */
export function parseReviewTreeName(name: string): { repo: string; number: number } | undefined {
  const m = /^(.+)-pr(\d+)$/.exec(name);
  return m ? { repo: m[1], number: Number(m[2]) } : undefined;
}

/**
 * The PR a directory is pr-open's review tree for, or undefined when it is not one.
 *
 * Callers use the path instead of asking git so the answer survives a missing or unreadable branch.
 *
 * Answered from the path alone. The directory name *is* the record, so there is no registry to keep
 * in step with the disk and no moment at which the two can disagree.
 */
export function reviewTreeFor(dir: string): { repo: string; number: number } | undefined {
  return samePath(path.dirname(dir), reviewRoot()) ? parseReviewTreeName(path.basename(dir)) : undefined;
}

/**
 * Whether the clone may hold this review, given who has the PR's branch. False sends the review to a
 * worktree pr-open cuts for itself.
 *
 * The rule behind it is that pr-open reviews only in a tree it controls, because a review anchors to
 * the working tree: the diff's right pane is the file on disk, and the ask agent reads that tree as
 * the PR's "after" state. Opening someone else's checkout — an agent's worktree, most often — shows
 * their uncommitted edits as part of the PR, and goes silently wrong when they switch branches. Git
 * cannot lock a branch, so reviewing elsewhere is the only prevention.
 *
 * The clone qualifies when it already holds the branch, or when it is clean enough to be switched
 * onto it. A fork never does: its head exists in `origin` only under `refs/pull/<n>/head`, which
 * lands detached, so there is no branch for the clone to switch to. A `true` here is still only
 * permission to try — the switch can fail on a diverged branch, and the caller falls back to a
 * worktree there too.
 *
 * `cloneDirty` is a thunk for the reason `planBranchMove` gives in `git.ts`: whether the clone is
 * clean cannot change the answer once another tree holds the branch, and asking costs a full
 * worktree scan. Keeping that inside the rule is what stops a caller from having to re-derive the
 * case in order to know whether to ask.
 */
export async function cloneMayTakeBranch(
  crossRepo: boolean,
  heldBy: string | undefined,
  cloneDir: string,
  cloneDirty: () => Promise<boolean>,
): Promise<boolean> {
  if (crossRepo) {
    return false;
  }
  if (heldBy) {
    return samePath(heldBy, cloneDir);
  }
  return !(await cloneDirty());
}

/**
 * Whether `git worktree prune` in a clone would drop nothing but pr-open's own entries.
 *
 * Prune takes no target and honours no grace period: one call drops every prunable entry the clone
 * has. A worktree of the user's on a volume that happens to be unmounted is prunable, and pruning it
 * discards its HEAD, index, and per-worktree refs — so a detached one loses its commits. pr-open
 * cleans up after itself only, and declines the whole call when it cannot.
 */
export function pruneDropsOnlyOurs(prunable: readonly string[]): boolean {
  return prunable.every((dir) => reviewTreeFor(dir) !== undefined);
}

/**
 * Which trees to remove to stay within `cap`, least recently reviewed first.
 *
 * The tree being reviewed is stamped with the current time before this is consulted, so it sorts
 * newest and cannot select itself. That is what makes "never evict the one in use" a property of
 * the ordering rather than a special case someone has to remember.
 */
export function pickEvictions(trees: readonly ReviewTree[], cap: number): ReviewTree[] {
  return [...trees].sort((a, b) => b.at - a.at).slice(cap);
}
