import * as path from 'path';
import * as vscode from 'vscode';
import { readConfig } from './config';
import { runGh } from './gh';
import {
  fastForward,
  fetchBranch,
  fetchPullHead,
  Head,
  isAncestor,
  isDirty,
  originRepoId,
  pullHeadRef,
  readHead,
  revParse,
  switchToPrBranch,
  worktreeHolding,
} from './git';
import { log } from './logger';
import { FetchUse, PrefetchedFetches } from './prefetchedfetches';
import { fireAction, isRevealAction, PrAction, RevealAction, waitForPrExtReady } from './prext';
import { OwnedPrRef, PrRef, RepoId } from './prref';
import { Clone, repoId, resolveClone, scanClones } from './resolver';
import {
  cloneMayTakeBranch,
  MAX_REVIEW_TREES,
  reviewTreeFor,
} from './reviewtree';
import { phase } from './timing';
import { delay, errorMessage, samePath, TtlCache } from './util';
import { activeDir, ensureWorkspaceFolder, gitWorkspaceDirs, hasWorkspaceFolder } from './workspace';
import {
  ensureReviewTree,
  moveReviewTree,
  ReviewTreeUi,
  sweepReviewTrees,
} from './worktrees';

const PENDING_KEY = 'prOpen.pending';
const PENDING_TTL_MS = 5 * 60 * 1000;

interface PendingCheckout extends OwnedPrRef {
  action: RevealAction;
  timestamp: number;
}

/** PR metadata needed to build the guided-review diff, from `gh pr view --json`. */
export interface PrMeta {
  number: number;
  title: string;
  /** PR description body; carries the Linear link and "Why" for the business-context summary. */
  body: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
}

// Org convention: a PR title starts with its Linear ticket in brackets, e.g. "[AT-1683] ...".
// Titles without that prefix have no linked ticket.
const LINEAR_ID_RE = /^\[([A-Z][A-Z0-9]+-\d+)\]/;

/** Linear ticket id + issue URL from a PR title's `[TICKET-123]` prefix. Undefined if absent. */
export function linearRef(meta: { title?: string }): { id: string; url: string } | undefined {
  const id = LINEAR_ID_RE.exec((meta.title ?? '').trim())?.[1];
  return id ? { id, url: `https://linear.app/mmnt/issue/${id}` } : undefined;
}

let cloneCache: Clone[] | undefined;

/** Cached scan of the configured roots. */
export function getClones(): Clone[] {
  if (!cloneCache) {
    cloneCache = scanClones(readConfig().searchRoots);
  }
  return cloneCache;
}

export function invalidateClones(): void {
  cloneCache = undefined;
  originRepos.clear();
  // Everything keyed by a clone dir goes with it: a rescan exists because the set of clones changed,
  // and answers cached against the old set are exactly what the user asked to be re-read.
  prHeads.clear();
  branchPrCache.clear();
  headFetches.clear();
}

/** Deduped, alphabetically-sorted repo folder names across the scanned clones. */
export function repoFolders(): string[] {
  return [...new Set(getClones().map((c) => c.folder))].sort((a, b) => a.localeCompare(b));
}

/** Resolve a repo to its local clone against the current scan, or undefined when none matches. */
export function findClone(repo: string): Clone | undefined {
  return resolveClone(repo, getClones());
}

/** Resolve a repo to its local clone, or throw the canonical "no clone" error. */
export function requireClone(repo: string): Clone {
  const clone = findClone(repo);
  if (!clone) {
    throw new Error(`No local clone of "${repo}" found under your search roots.`);
  }
  return clone;
}

/**
 * Show a PR at `dir`, in this window.
 *
 * The folder is *added* to the workspace rather than opened over it, so the extension host survives
 * and every repo visited stays warm; `workspace.ts` covers when that still costs a restart. A reveal
 * that has to outlive one goes through `pending`, which `resumePending` finishes on the other side.
 *
 * Always reuses the current window. A second window is never what the user asked for, and letting
 * the PR extension's checkout URI handler open one of its own is what this replaces.
 */
async function revealAt(
  context: vscode.ExtensionContext,
  dir: string,
  ref: OwnedPrRef,
  action: RevealAction,
): Promise<void> {
  phase('workspace');
  const placed = await ensureWorkspaceFolder(context, dir, () =>
    queuePending(context, dir, ref, action),
  );
  if (placed === 'restarting') {
    return; // queued by `ensureWorkspaceFolder`; `resumePending` fires it once the host is back
  }
  if (placed === 'failed') {
    // Deliberately not `vscode.openFolder`, which is how this used to reach a clone: on a window that
    // holds folders it replaces all of them, so recovering one reveal would cost the user every repo
    // in the window, their own included. Placement is serialized, so a refusal here is VS Code
    // declining outright rather than an edit arriving too early.
    throw new Error(`Could not add ${dir} to this window's folders, so PR #${ref.number} was not opened.`);
  }
  // A reload was its own progress indicator; a folder edit is silent, and both waits inside
  // `fireAction` can run to tens of seconds when the PR extension is still building or authenticating.
  // Window-location progress, so an already-warm repo costs a flicker in the status bar and no more.
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Opening PR #${ref.number} in ${ref.repo}...`,
    },
    () => fireAction(dir, ref, action),
  );
}

/** What `PENDING_KEY` may actually hold: a record persisted by any past version, whose `action` is
 * therefore any `PrAction` rather than one this version can drive. */
type StoredPending = Omit<PendingCheckout, 'action'> & { action: PrAction };

/**
 * Pending reveals, with what older versions wrote brought forward. Before pr-open performed
 * checkouts itself, it persisted `action: 'checkout'`, which `ACTIONS` no longer has; that record's
 * intent — show the PR page once the folder is open — is exactly `Page` now. Anything else
 * unrecognizable is dropped, since resuming it would throw inside `fireAction`.
 */
function readPending(context: vscode.ExtensionContext): Record<string, PendingCheckout> {
  const stored = context.globalState.get<Record<string, StoredPending>>(PENDING_KEY) ?? {};
  const pending: Record<string, PendingCheckout> = {};
  for (const [dir, entry] of Object.entries(stored)) {
    if (isRevealAction(entry?.action)) {
      pending[dir] = { ...entry, action: entry.action };
    } else if (entry?.action === PrAction.Checkout) {
      pending[dir] = { ...entry, action: PrAction.Page };
    }
  }
  return pending;
}

async function queuePending(
  context: vscode.ExtensionContext,
  dir: string,
  ref: OwnedPrRef,
  action: RevealAction,
): Promise<void> {
  const pending = readPending(context);
  pending[dir] = { ...ref, action, timestamp: Date.now() };
  await context.globalState.update(PENDING_KEY, pending);
}

async function cloneRepo(ref: PrRef, cloneRoot: string): Promise<string> {
  const dest = path.join(cloneRoot, ref.repo);
  await runGh(['repo', 'clone', `${ref.owner}/${ref.repo}`, dest]);
  invalidateClones();
  return dest;
}

/**
 * Pay the click path's fixed costs at activation rather than on the click itself: the clone scan
 * every action resolves through, and the PR extension's readiness for each open repo. Non-repo
 * folders are skipped, since they would only poll until the timeout.
 *
 * This covers the repos pr-open added as well as the one the user opened: they are still workspace
 * folders after a restart, back in the window but cold in the PR extension.
 *
 * Reconciling the review worktrees rides along: it needs the clone scan this already pays for, and
 * activation is the one moment a tree orphaned by a crash is guaranteed to be idle.
 */
export async function warmUp(context: vscode.ExtensionContext): Promise<void> {
  // Yield first: `scanClones` walks the search roots synchronously, and activation shouldn't block
  // on it. Everything below therefore runs after `activate` has returned.
  await delay(0);
  try {
    const clones = getClones();
    await Promise.all([
      ...gitWorkspaceDirs().map(waitForPrExtReady),
      sweepReviewTrees(context, clones),
    ]);
  } catch (e) {
    log(`warm-up skipped: ${errorMessage(e)}`);
  }
}

/** The branch (and PR, if any) checked out in an open workspace folder. */
export interface CheckoutStatus {
  /** Absolute path of the workspace folder — the tree that actions (review, pull) operate on. */
  dir: string;
  /** Repo slug from `origin` (falls back to the folder name), used to resolve clone-based actions. */
  repo: string;
  branch: string;
  /** Set when a PR is checked out; `behind` means the remote PR head has commits not local. */
  pr?: { number: number; title: string; url: string; behind: boolean };
}

// Successful reads only: a directory's origin does not change under us and every status refresh asks
// again, while an unreadable one is usually transient (git missing from PATH) and must be able to
// heal on the next refresh. Cleared with the clone scan, whose repos seed it.
const originRepos = new Map<string, RepoId>();

/**
 * The owner and repo a dir's `origin` remote names (works in worktrees), or undefined when `origin`
 * is unreadable or is not GitHub's.
 *
 * Both halves, never the bare repo name: a `gh api graphql` query about the repo takes an owner, and
 * a clone's folder name alone cannot supply one.
 */
export async function repoIdFor(dir: string): Promise<RepoId | undefined> {
  const hit = originRepos.get(dir);
  if (hit) {
    return hit;
  }
  // A scanned clone whose origin parsed already carries the answer, no subprocess needed. `repoId`
  // returns undefined for every other clone: `Clone.slug` then holds the folder name, and the scan
  // reads no origin at all for a worktree, whose `.git` is a pointer file it does not follow.
  const scanned = getClones().find((c) => samePath(c.dir, dir));
  const id = (scanned && repoId(scanned)) ?? (await originRepoId(dir));
  if (id) {
    originRepos.set(dir, id);
  }
  return id;
}

/**
 * `gh pr view --json` for a PR, or for whichever PR `dir` is checked out for when `number` is
 * omitted, parsed. Undefined when `gh` fails, which includes a checkout that has no PR.
 *
 * Resolving "the checkout's PR" is this function's job rather than each caller's. The path remains
 * authoritative for a review tree even if its branch is unreadable, because pr-open cut it for one
 * known PR.
 */
async function prView<T>(dir: string, fields: string, number?: number): Promise<T | undefined> {
  const pr = number ?? reviewTreeFor(dir)?.number;
  const target = pr === undefined ? [] : [String(pr)];
  try {
    return JSON.parse(await runGh(['pr', 'view', ...target, '--json', fields], dir)) as T;
  } catch {
    return undefined;
  }
}

interface BranchPr {
  number: number;
  title: string;
  url: string;
  headRefOid: string;
}

/**
 * How long an answer about the current branch's PR stays good for. Long, because the key already
 * carries the checkout it describes: a switch or a pull misses by construction, so the only thing
 * the TTL bounds is the `behind` flag against a remote head that moved. Short enough to notice a
 * force-push, long enough that the cache survives repeat refreshes.
 */
const BRANCH_PR_TTL_MS = 60 * 1000;

// The one `gh` round trip on the panel's own path, paid once per status refresh.
//
// Successful lookups only, and keyed by branch *and* commit. `gh pr view` with no argument resolves
// the PR from the checked-out branch's name, so the commit alone does not identify the answer: two
// refs at one commit (a PR branch that just fast-forwarded and the `main` it caught up to) would
// otherwise share an entry and label one with the other's PR. And `prView` reports every failure as
// `undefined`, so caching a negative would pin "no PR" for a minute on nothing worse than an expired
// token, with Refresh unable to heal it — the same reasoning `originRepos` above gives.
const branchPrCache = new TtlCache<BranchPr>(BRANCH_PR_TTL_MS);

async function branchPr(dir: string, head: Head): Promise<BranchPr | undefined> {
  const key = `${dir}@${head.branch ?? 'HEAD'}@${head.oid}`;
  const cached = branchPrCache.get(key);
  if (cached) {
    return cached;
  }
  const view = await prView<BranchPr>(dir, 'number,title,url,headRefOid');
  if (view) {
    branchPrCache.set(key, view);
  }
  return view;
}

/**
 * Current checkout for the repo the panel speaks for: branch always, PR best-effort via `gh`.
 *
 * One repo rather than every workspace folder. The window holds several so bouncing between PRs
 * stays warm, but the status block answers "what am I reviewing?", and that has one answer — the
 * one every control on the block acts on.
 */
export async function getActiveCheckout(): Promise<CheckoutStatus | undefined> {
  const dir = activeDir();
  if (!dir) {
    return undefined;
  }
  // HEAD first, since it keys the cached `gh` answer: a refs-only read, so it costs far less than
  // the round trip it lets a repeat refresh skip. The origin read joins it, cached once warm.
  const [head, id] = await Promise.all([readHead(dir).catch(() => undefined), repoIdFor(dir)]);
  if (!head) {
    return undefined;
  }
  const view = await branchPr(dir, head);
  let pr: CheckoutStatus['pr'];
  if (view) {
    // Behind when the remote PR head is not contained in local history (missing => behind).
    const behind =
      head.oid !== view.headRefOid && !(await isAncestor(dir, view.headRefOid, head.oid));
    pr = { number: view.number, title: view.title, url: view.url, behind };
  }
  return { dir, repo: id?.repo ?? path.basename(dir), branch: head.branch ?? 'HEAD', pr };
}

/** Where a PR's commits live. */
export interface PrHead {
  /** The head branch's name. For a fork PR this names a branch in the fork, not one in `origin`. */
  ref: string;
  /** The PR comes from a fork, so `ref` says nothing about any local branch of the same name. */
  crossRepo: boolean;
}

// Untimed: a PR's head is effectively immutable, and a stale entry costs a
// missed worktree match at worst. Keyed `<dir>#<number>`.
const prHeads = new Map<string, PrHead>();

/** The PR's head, or undefined if it can't be resolved. A listed row is already known, making the
 * click a local read rather than a ~500ms round trip. */
export async function prHead(dir: string, number: number): Promise<PrHead | undefined> {
  const known = prHeads.get(`${dir}#${number}`);
  if (known) {
    return known;
  }
  const view = await prView<{ headRefName?: string; isCrossRepository?: boolean }>(
    dir,
    'headRefName,isCrossRepository',
    number,
  );
  if (!view?.headRefName) {
    return undefined;
  }
  const head = { ref: view.headRefName, crossRepo: view.isCrossRepository ?? false };
  prHeads.set(`${dir}#${number}`, head);
  return head;
}

/** The repo's local clone, cloning it with the user's consent when there is none. Undefined when
 * the user declines. */
async function ensureClone(ref: PrRef): Promise<Clone | undefined> {
  const existing = findClone(ref.repo);
  if (existing) {
    return existing;
  }
  if (!ref.owner) {
    throw new Error(
      `No local clone of "${ref.repo}" found, and no owner to clone from. Paste the full PR URL instead.`,
    );
  }
  const config = readConfig();
  const choice = await vscode.window.showWarningMessage(
    `No local clone of "${ref.repo}" found under your search roots. Clone ${ref.owner}/${ref.repo} into ${config.cloneRoot}?`,
    { modal: true },
    'Clone',
  );
  if (choice !== 'Clone') {
    return undefined;
  }
  const dir = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Cloning ${ref.owner}/${ref.repo}...` },
    () => cloneRepo(ref, config.cloneRoot),
  );
  return findClone(ref.repo) ?? { dir, folder: ref.repo, slug: ref.repo, owner: ref.owner };
}

/**
 * The canonical owner/repo/number to drive the PR extension with. The clone's `origin` owner wins
 * over the PR URL's: clones point at `moment-technology/*` while PR URLs say `moment/*`, and the
 * extension matches on the checked-out repo's manager.
 */
function ownedRef(clone: Clone, ref: PrRef): OwnedPrRef {
  const owner = clone.owner ?? ref.owner;
  if (!owner) {
    throw new Error(`Could not determine the GitHub owner for "${clone.slug}" (unreadable origin remote).`);
  }
  return { owner, repo: clone.slug, number: ref.number };
}

/** Long enough for a completed prefetch to serve the click it predicted, short enough to bound how
 * long a force-push can be missed. The result is consumed by one checkout, so later actions fetch. */
const HEAD_PREFETCH_TTL_MS = 60_000;

// A successful prefetch has to survive completion: the common case is that it finishes before the
// click. Live fetches are also joined so concurrent work cannot contend on the same ref lock.
const headFetches = new PrefetchedFetches<string>(HEAD_PREFETCH_TTL_MS);

function prHeadFetchRef(number: number, head: PrHead): string {
  return head.crossRepo ? pullHeadRef(number) : `refs/remotes/origin/${head.ref}`;
}

/**
 * Run `land` to fetch `ref`, then resolve `ref` to an oid. Undefined once it has logged why it could
 * not. `use` decides whether a completed prefetch may satisfy this call; live work is always joined.
 */
function fetchOid(
  dir: string,
  ref: string,
  use: FetchUse,
  land: () => Promise<unknown>,
): Promise<string | undefined> {
  return headFetches.run(`${dir}#${ref}`, use, async () => {
    try {
      await land();
      return await revParse(dir, ref);
    } catch (e) {
      log(`checkout: could not fetch ${ref}: ${errorMessage(e)}`);
      return undefined;
    }
  });
}

/** Freshen the PR head via `refs/pull/<n>/head` and resolve it to an oid. */
function fetchPullHeadOid(dir: string, number: number): Promise<string | undefined> {
  return fetchOid(dir, pullHeadRef(number), FetchUse.Fresh, () => fetchPullHead(dir, number));
}

/**
 * Land the PR's head commit and report what it is. Undefined once it has logged why it could not.
 *
 * A same-repo PR is fetched by branch, so the clone can then switch onto it. A fork's head exists in
 * `origin` only under `refs/pull/<n>/head`, which lands detached: there is no branch there to switch
 * to, which is why a fork is always reviewed in a worktree.
 */
function fetchPrHeadWithUse(
  dir: string,
  number: number,
  head: PrHead,
  use: FetchUse,
): Promise<string | undefined> {
  const ref = prHeadFetchRef(number, head);
  return head.crossRepo
    ? fetchOid(dir, ref, use, () => fetchPullHead(dir, number))
    : fetchOid(dir, ref, use, () => fetchBranch(dir, head.ref));
}

/** Fetch a PR head for an explicit refresh, ignoring any completed prefetch. */
export function fetchPrHead(dir: string, number: number, head: PrHead): Promise<string | undefined> {
  return fetchPrHeadWithUse(dir, number, head, FetchUse.Fresh);
}

/** Warm a PR head for one later checkout. */
export function prefetchPrHead(
  dir: string,
  number: number,
  head: PrHead,
): Promise<string | undefined> {
  return fetchPrHeadWithUse(dir, number, head, FetchUse.Prefetch);
}

/** Whether the PR head is ready for one checkout without another network fetch. */
export function hasPrefetchedPrHead(dir: string, number: number): boolean {
  const head = prHeads.get(`${dir}#${number}`);
  return head !== undefined && headFetches.hasCompleted(`${dir}#${prHeadFetchRef(number, head)}`);
}

/** Use a completed prefetch when available, and consume it so later actions refresh. */
function fetchPrHeadForCheckout(
  dir: string,
  number: number,
  head: PrHead,
): Promise<string | undefined> {
  return fetchPrHeadWithUse(dir, number, head, FetchUse.ReusePrefetch);
}

/**
 * Move the clone itself onto `head.ref`, returning its dir. Undefined when it won't go — a diverged
 * local branch, or a `gh pr checkout` that failed — which is not a dead end any more: the caller
 * cuts a review worktree instead.
 *
 * `remote` is the commit `origin` has the branch at. Always known, because only a same-repo PR whose
 * head has already been fetched reaches here.
 */
async function takeBranch(
  clone: Clone,
  number: number,
  head: PrHead,
  remote: string,
): Promise<string | undefined> {
  phase('switch');
  try {
    if (await switchToPrBranch(clone.dir, head.ref, remote)) {
      return clone.dir;
    }
    log(`checkout: ${head.ref} has diverged from origin/${head.ref}; using gh pr checkout`);
  } catch (e) {
    // `gh` either succeeds or names the real obstacle, so it gets the next attempt.
    log(`checkout: local switch to ${head.ref} failed: ${errorMessage(e)}`);
  }
  return ghCheckout(clone, number);
}

/**
 * Hand the checkout to `gh`, returning the clone's dir.
 *
 * Kept reachable when the fetch itself failed, not just when the switch did: `gh` speaks HTTPS with
 * its own token, so it works in a clone whose `origin` is SSH with no key unlocked — the case where
 * every `git fetch` fails and the clone would otherwise have no way to show a PR at all.
 */
async function ghCheckout(clone: Clone, number: number): Promise<string | undefined> {
  phase('gh-checkout');
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking out PR #${number}...` },
      () => runGh(['pr', 'checkout', String(number)], clone.dir),
    );
    return clone.dir;
  } catch (e) {
    log(`checkout: gh pr checkout failed in ${clone.folder}: ${errorMessage(e)}`);
    return undefined;
  }
}

/** How many paths the modal names before it counts the rest. Enough to recognise the work by, short
 *  enough that the buttons stay on screen. */
const NAMED_PATHS = 5;

function namePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, NAMED_PATHS).join(', ');
  const rest = paths.length - NAMED_PATHS;
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
}

/** Modal: it is the only warning, and what goes is the reviewer's own work. Naming the files is what
 *  makes the question answerable — each one is something they can go and look at.
 *
 *  "Uncommitted", not "changed": the list mixes edits to tracked files with untracked files the move
 *  has to delete, and the second kind is in no commit to be recovered from. That is the warning worth
 *  keeping, so it is what the sentence says rather than the weaker claim that they are modified. */
async function confirmDiscard(number: number, atRisk: readonly string[]): Promise<boolean> {
  const discard = 'Discard Changes';
  const one = atRisk.length === 1;
  const answer = await vscode.window.showWarningMessage(
    `PR #${number}'s review checkout has ${atRisk.length} uncommitted ${one ? 'file' : 'files'}.`,
    {
      modal: true,
      detail:
        `${namePaths(atRisk)}\n\nUpdating it to the latest commit discards ` +
        `${one ? 'it' : 'them'}, and nothing keeps a copy.`,
    },
    discard,
  );
  return answer === discard;
}

/** Told rather than asked: the cap has removed the tree, and this otherwise-unfindable oid is the
 * route back to both versions of its work. */
function reportRemovedDirty(number: number, rescue: string): void {
  const removed =
    `PR #${number}'s review checkout held uncommitted changes and was removed ` +
    `to keep the ${MAX_REVIEW_TREES} most recent review checkouts.`;
  const copy = 'Copy Commit';
  void vscode.window
    .showWarningMessage(
      `${removed} The working tree is saved as commit ${rescue.slice(0, 8)}; its second parent preserves the index.`,
      copy,
    )
    .then((answer) => {
      if (answer === copy) {
        void vscode.env.clipboard.writeText(rescue);
      }
    });
}

function reportMovedAside(number: number, saved: string): void {
  const copy = 'Copy Path';
  void vscode.window
    .showWarningMessage(`PR #${number}'s previous review directory could not be reused and was moved to ${saved}.`, copy)
    .then((answer) => {
      if (answer === copy) {
        void vscode.env.clipboard.writeText(saved);
      }
    });
}

const reviewTreeUi: ReviewTreeUi = { confirmDiscard, reportRemovedDirty, reportMovedAside };

/** Cut (or re-point) pr-open's own review worktree for the PR. Undefined when it could not, having
 *  first explained why — this is the last resort, so there is no other tree left to try. A reviewer
 *  who declines the discard is the one silent case: they were just asked, and cancelling a modal is
 *  not a failure to report back to them. */
async function cutReviewTree(
  context: vscode.ExtensionContext,
  clone: Clone,
  ref: OwnedPrRef,
  oid: string,
): Promise<string | undefined> {
  const number = ref.number;
  phase('review-tree');
  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Preparing a review checkout for PR #${number}...`,
      },
      () => ensureReviewTree(context, clone.dir, ref, oid, reviewTreeUi),
    );
  } catch (e) {
    void vscode.window.showWarningMessage(
      `PR #${number}: could not prepare a review checkout (${errorMessage(e)}).`,
    );
    return undefined;
  }
}

/**
 * The tree to review a PR in: the clone when it can have it, and otherwise a dedicated worktree
 * pr-open cuts for itself. `cloneMayTakeBranch` states that rule and says why pr-open reviews only
 * in a tree it controls; everything here is the work of enacting it.
 */
async function resolveReviewTree(
  context: vscode.ExtensionContext,
  clone: Clone,
  ref: OwnedPrRef,
  head: PrHead,
): Promise<string | undefined> {
  const number = ref.number;
  phase('plan');
  // Independent reads, and the fetch is needed whichever tree wins, so neither waits on the other.
  // A fork has no origin branch to take, so there is nothing to ask about before cutting our own.
  const [held, oid] = await Promise.all([
    head.crossRepo ? undefined : worktreeHolding(clone.dir, head.ref),
    fetchPrHeadForCheckout(clone.dir, number, head),
  ]);
  const mayTake = await cloneMayTakeBranch(head.crossRepo, held, clone.dir, () => isDirty(clone.dir));
  if (!oid) {
    // No commit means no worktree can be cut, but `gh` may still reach what `git fetch` could not.
    const dir = mayTake ? await ghCheckout(clone, number) : undefined;
    if (!dir) {
      void vscode.window.showWarningMessage(
        `PR #${number}: could not fetch its head commit, so there is nothing to review yet.`,
      );
    }
    return dir;
  }
  if (mayTake) {
    const dir = await takeBranch(clone, number, head, oid);
    if (dir) {
      return dir;
    }
  }
  return cutReviewTree(context, clone, ref, oid);
}

/** Put a PR in front of the user, in this window, in a tree pr-open controls. Returns the tree it
 *  landed in, which has just moved: anything resolved against it no longer holds. */
export async function checkoutPr(
  context: vscode.ExtensionContext,
  ref: PrRef,
): Promise<string | undefined> {
  phase('clone');
  const clone = await ensureClone(ref);
  if (!clone) {
    return undefined;
  }
  // Resolved before anything is moved: an unreadable owner should fail the click, not a checkout.
  const owned = ownedRef(clone, ref);
  const number = ref.number;
  phase('head');
  const head = await prHead(clone.dir, number);
  if (!head) {
    void vscode.window.showWarningMessage(`PR #${number}: could not resolve its head branch.`);
    return undefined;
  }

  const dir = await resolveReviewTree(context, clone, owned, head);
  if (dir) {
    await revealAt(context, dir, owned, PrAction.Page);
  }
  return dir;
}

/**
 * Bring `dir` up to the PR's remote head.
 *
 * A review worktree's branch has no upstream, so it is re-pointed at the new commit instead. Same
 * outcome either way: the tree now holds what `origin` has.
 */
export async function pullPr(dir: string, number: number): Promise<void> {
  // `reviewTreeFor`, not "is HEAD detached": this asks whether the tree is pr-open's to move, and
  // `--discard-changes` on a clone the user left detached would throw their work away.
  const tree = reviewTreeFor(dir);
  if (tree && tree.number !== number) {
    throw new Error(`Review checkout ${dir} belongs to PR #${tree.number}, not PR #${number}.`);
  }
  const head = await prHead(dir, number);
  if (!head) {
    throw new Error(`Could not resolve the head branch for PR #${number}.`);
  }
  if (!tree) {
    // Fast-forward the checked-out branch to the PR head. The commit is landed via
    // `refs/pull/<n>/head` rather than by branch name: `origin` may not carry the head branch (a
    // fork PR, a clone whose `origin` is a mirror org, or a branch deleted after merge), and that
    // ref exists for every open PR regardless.
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Pulling PR #${number}...` },
      async () => {
        const oid = await fetchPullHeadOid(dir, number);
        if (!oid) {
          throw new Error(`Could not fetch PR #${number}'s head commit.`);
        }
        await fastForward(dir, oid);
      },
    );
  }
  // Fetched in the clone, not in the worktree. Remote-tracking refs belong to the repository, so
  // naming the worktree would give one refspec two fetch keys and defeat live-fetch deduplication.
  const clone = findClone(tree.repo);
  const fetchDir = clone?.dir ?? dir;
  const owner = clone?.owner ?? (await repoIdFor(dir))?.owner;
  if (!owner) {
    throw new Error(`Could not determine the GitHub owner for review checkout ${dir}.`);
  }
  const ref: OwnedPrRef = { owner, repo: tree.repo, number };
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Pulling PR #${number}...` },
    async () => {
      const oid = await fetchPrHead(fetchDir, number, head);
      if (!oid) {
        throw new Error(`Could not fetch PR #${number}'s head commit.`);
      }
      // Moved after the fetch, not before: which files the move takes depends on the commit it moves
      // to, and until it is in hand there is no question to put in front of the reviewer. A decline
      // is not an error here — the pull was optional, so nothing is left half-done.
      await moveReviewTree(dir, ref, oid, reviewTreeUi);
    },
  );
}

const PR_META_FIELDS = 'number,title,body,headRefName,headRefOid,baseRefName,baseRefOid';

/** PR metadata for the guided review, via `gh pr view`, run inside the local clone. */
export async function getPrMeta(dir: string, number: number): Promise<PrMeta> {
  return JSON.parse(await runGh(['pr', 'view', String(number), '--json', PR_META_FIELDS], dir)) as PrMeta;
}

/** The same fields for whichever PR `dir` is checked out for. Undefined when it belongs to none (or
 *  `gh` fails), which is how the ask surfaces decide a document is not part of a review. */
export function getPrMetaForCheckout(dir: string): Promise<PrMeta | undefined> {
  return prView<PrMeta>(dir, PR_META_FIELDS);
}

/** Resolve a PR to its local clone and hand off to the GitHub PR extension via `revealAt`, which adds
 *  the clone to this window's folders when it is not already one. */
export async function openPr(
  context: vscode.ExtensionContext,
  ref: PrRef,
  action: RevealAction,
): Promise<void> {
  phase('clone');
  const clone = await ensureClone(ref);
  if (clone) {
    await revealAt(context, clone.dir, ownedRef(clone, ref), action);
  }
}

/**
 * On activation, complete any checkout whose folder is now open. Keyed by clone path so each
 * window only fires its own; stale entries (>5min) are purged.
 */
export async function resumePending(
  context: vscode.ExtensionContext,
  onResumed?: (repo: string, number: number) => Thenable<void> | void,
): Promise<void> {
  const pending = readPending(context);
  const mine: [string, PendingCheckout][] = [];
  const keep: Record<string, PendingCheckout> = {};
  for (const [dir, entry] of Object.entries(pending)) {
    if (Date.now() - entry.timestamp > PENDING_TTL_MS) {
      continue; // stale: dropped by omission from `keep`
    }
    if (hasWorkspaceFolder(dir)) {
      mine.push([dir, entry]);
    } else {
      keep[dir] = entry; // another window's, still fresh
    }
  }

  // Persist the pruned map *before* firing anything. `fireAction` can wait tens of seconds, and an
  // entry still in globalState when the window reloads again would fire a second time. A failure
  // below therefore drops its reveal rather than re-firing on every activation.
  if (Object.keys(keep).length !== Object.keys(pending).length) {
    await context.globalState.update(PENDING_KEY, keep);
  }

  let firstError: unknown;
  for (const [dir, entry] of mine) {
    await onResumed?.(entry.repo, entry.number);
    try {
      await fireAction(dir, { owner: entry.owner, repo: entry.repo, number: entry.number }, entry.action);
    } catch (e) {
      firstError ??= e;
    }
  }
  if (firstError) {
    throw firstError;
  }
}
