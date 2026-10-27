import * as vscode from 'vscode';
import { findClone, hasPrefetchedPrHead, prefetchPrHead, prHead } from './handoff';
import { log } from './logger';
import { waitForPrExtReady, warmAssignableUsers, warmPrFiles, warmPrModel } from './prext';
import { OwnedPrRef } from './prref';
import { Clone, repoId } from './resolver';
import { traced } from './timing';
import { delay, errorMessage, TtlCache } from './util';
import { offerWorkspaceFolder } from './workspace';

/**
 * Pay a click's costs before the click.
 *
 * Everything here acts on a guess, so it runs on strictly weaker terms than a click. One job at a
 * time, and only while no real action is in flight, because competing for `gh`, `git`, the extension
 * host and the GitHub API would slow the very click it is trying to serve. It abandons a job the
 * moment a newer guess arrives, so a short debounce costs at most one round trip rather than one per
 * keystroke. And it only ever adds to what the window holds, never displaces it, so a number typed
 * and thought better of cannot reload the window or evict the repo the user is working in.
 */

/** Long enough that retyping a reference costs one fetch, short enough that a force-push lands. */
const REPEAT_TTL_MS = 60_000;

let foreground = 0;

/**
 * Run a real user action: timed as one line, and holding background work off for its duration.
 *
 * The two go together and are applied here rather than per call site, because a mutating action that
 * takes only one of them is the bug — a prefetch running `git fetch` in the repo a checkout is moving
 * contends over the same ref locks.
 */
export async function userAction<T>(label: string, fn: () => Promise<T>): Promise<T> {
  // A guess still waiting for a slot was a guess about what the user was about to do, and the user
  // has now done it. Dropping it is what keeps a half-typed number from warming after the click that
  // typed past it: `drain` exits its loop on `foreground`, so anything left queued would otherwise
  // run in full the moment this action returns. Guesses that arrive from here on are about whatever
  // comes next, and survive.
  queued = undefined;
  foreground++;
  try {
    return await traced(label, fn);
  } finally {
    foreground--;
    void drain();
  }
}

/**
 * Warm what a click on the PR would pay for: the clone in the window, the PR extension ready for it,
 * the PR's head commits, which is what makes a Checkout a local branch switch, and the PR itself
 * inside the PR extension, which is what makes the page appear on the click rather than a round trip
 * later. Returns immediately; the work happens when nothing else is running.
 */
export function prefetch(context: vscode.ExtensionContext, repo: string, number: number): void {
  const clone = findClone(repo);
  if (!clone) {
    return;
  }
  const key = jobKey(clone.dir, number);
  if (hasPrefetchedPrHead(clone.dir, number) && warmed.get(key)) {
    return;
  }
  // One slot, latest wins: typing a PR number one digit at a time should warm the reference the
  // user settles on, not queue a fetch for every prefix it passed through.
  queued = { context, clone, number };
  void drain();
}

interface Job {
  context: vscode.ExtensionContext;
  /** The whole clone, not just its path: the PR extension is addressed by the owner and slug that
   *  `findClone` already read from `origin`. */
  clone: Clone;
  number: number;
}

let queued: Job | undefined;
let draining = false;

/**
 * What is already warm, so a repeat guess costs nothing.
 *
 * The Git warm lives in the head-fetch coordinator, whose completed prefetch is also the value
 * checkout consumes. This cache covers only the independent PR-extension half, which can fail
 * because the window is signed out or its session has not been restored yet.
 */
const warmed = new TtlCache<true>(REPEAT_TTL_MS);

/** Long enough for a cold `gh pr view` and a `git fetch` over a slow link, short enough that the one
 *  slot comes back. The PR extension memoizes an in-flight `getAssignableUsers` and leaves it pending
 *  for good if the fetch rejects, so a job really can wait forever. */
const JOB_TIMEOUT_MS = 30_000;

function jobKey(dir: string, number: number): string {
  return `${dir}#${number}`;
}

async function drain(): Promise<void> {
  if (draining) {
    return;
  }
  draining = true;
  try {
    while (queued && foreground === 0) {
      const job = queued;
      queued = undefined;
      await bounded(jobKey(job.clone.dir, job.number), warm(job));
    }
  } finally {
    draining = false;
  }
}

/**
 * Whether a running job should give up the rest of its work. A click wants `gh` and this repo's ref
 * locks to itself, and a newer reference makes everything left in this job work for a PR the user has
 * typed past. `drain` clears `queued` as it dequeues, so anything sitting there arrived after this
 * job started.
 */
function stop(): boolean {
  return foreground > 0 || queued !== undefined;
}

/**
 * Wait for `job`, but only so long, and only for the slot's sake: a job hanging on a promise the PR
 * extension never settles would otherwise hold the one slot for the rest of the window, in silence.
 *
 * The abandoned job keeps running and may still land its half. Its failure is logged here rather than
 * thrown, since once the race is decided there is no caller left to throw to.
 */
async function bounded(key: string, job: Promise<void>): Promise<void> {
  const ran = job.catch((e: unknown) => log(`prefetch: ${key}: ${errorMessage(e)}`));
  if (await Promise.race([ran.then(() => false), delay(JOB_TIMEOUT_MS).then(() => true)])) {
    log(`prefetch: ${key}: still running after ${JOB_TIMEOUT_MS}ms, giving up the slot`);
  }
}

/** Warm what the job named, remembering each half as it lands. Each is remembered on its own terms,
 *  because the two fail for different reasons and cost different amounts to redo. */
async function warm(job: Job): Promise<void> {
  const dir = job.clone.dir;
  const number = job.number;
  const key = jobKey(dir, number);
  const placed = await offerWorkspaceFolder(job.context, dir);
  const held = placed === 'present' || placed === 'added';
  if (held) {
    // Only worth waiting on for a folder the window actually holds; for any other dir the PR
    // extension will never register it and the wait would just run to its timeout.
    await waitForPrExtReady(dir);
  }
  // Re-checked after the wait above, not only before the job started: `drain` sees only the clicks
  // that arrived before it, while everything below holds `gh`, this repo's ref locks or the PR
  // extension's API client for seconds afterwards.
  if (stop()) {
    return;
  }
  // The PR extension resolves only through a folder this window holds, under the owner `origin`
  // names, so either one missing leaves the git side to warm alone.
  const repo = held ? repoId(job.clone) : undefined;
  // A half that has already landed is skipped, so a repeat that only one half failed at redoes only
  // that half rather than paying for a `git fetch` again to retry a resolve. Read here and written
  // below from what the calls returned, so an entry is only ever written for work this job really
  // did: re-`set`ting a live one would slide `REPEAT_TTL_MS` forward on every keystroke, and the
  // fetch it guards would stop picking up a force-push.
  const doGit = !hasPrefetchedPrHead(dir, number);
  // The PR-extension half only for a folder the window holds. A window that declined it may accept
  // later, so that is a failure to retry rather than a state to remember.
  const doPrExt = held && !warmed.get(key);
  // Concurrent because they contend on nothing: the git half spawns `gh` and takes this repo's ref
  // locks, while the PR-extension half is in-process requests through its own client.
  const [, prExt] = await Promise.all([
    doGit ? warmGit(dir, number) : false,
    doPrExt ? warmPrExt(repo && { ...repo, number }) : false,
  ]);
  if (prExt) {
    warmed.set(key, true);
  }
}

/** Land the PR's head commits, which is what makes a later Checkout a local branch switch. */
async function warmGit(dir: string, number: number): Promise<boolean> {
  const head = await prHead(dir, number);
  if (!head || stop()) {
    return false;
  }
  // `prefetchPrHead` reports rather than throws, and a fetch that could not reach `origin` landed no
  // commits: remembering it would leave the click to discover that for itself a minute later.
  return (await prefetchPrHead(dir, number, head)) !== undefined;
}

/** Hand the PR extension what a reveal will ask it for. Undefined `ref` means an unreadable `origin`:
 *  the extension can resolve nothing under an owner it cannot name, and no retry would change that,
 *  so that reads as warm rather than as a failure to redo on the next keystroke. */
async function warmPrExt(ref: OwnedPrRef | undefined): Promise<boolean> {
  if (!ref) {
    return true;
  }
  // The page's two, together: the model the reveal blocks on, and the one per-repo request its panel
  // blocks on afterwards.
  const [pr, users] = await Promise.all([warmPrModel(ref), warmAssignableUsers(ref)]);
  // These report rather than throw, and one that found no session or no manager answered nothing.
  // Saying so is what brings the next keystroke back to try again, in the window a session takes to
  // restore — and it is why this is remembered apart from the fetch above, which a window signed out
  // for good would otherwise repeat on every keystroke.
  if (pr === undefined || !users || stop()) {
    return false;
  }
  // The file list last, and behind the bail: it serves a Diff the user may never click, so a newer
  // reference or a click that has already landed outranks it.
  return warmPrFiles(ref, pr);
}
