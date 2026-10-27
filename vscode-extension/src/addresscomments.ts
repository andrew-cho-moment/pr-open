import * as path from 'path';
import * as vscode from 'vscode';
import { AddressItem, AddressItemState, AddressState, AddressView, runAddressPass } from './address';
import { labelThreads, lineRange, LabelledThread, ThreadOutcome, ThreadResult } from './addresspayload';
import { annotatedDiffFor } from './ask';
import { AskRepo } from './askpayload';
import { AskRepoRegistry } from './askrepo';
import { BaseContentProvider } from './basecontent';
import { configured } from './config';
import { commitAll, isDirty, pushHead, readHead } from './git';
import { log } from './logger';
import { DiffSide, fetchReviewThreads, replyToThread, resolveThread, ReviewThread } from './prthreads';
import { errorMessage } from './util';
import { activeDir } from './workspace';

/** A progress line arrives per tool call, so pushing every one would re-render the whole list tens of
 *  times a second. The same throttle the streamed answers use. */
const PROGRESS_THROTTLE_MS = 150;

/** Said when the one page read holds nothing unresolved but the PR holds threads past it. */
const UNREAD_EMPTY =
  'nothing unresolved in the review threads read, but more threads than one page holds were left unread.';

/**
 * Answers every unresolved review comment on the checked-out PR, in one pass.
 *
 * One claude subprocess edits the working tree and returns a reply per thread; pr-open then commits
 * what it wrote, pushes that to the PR's head branch, and only then posts the replies and resolves
 * the threads. That order is the point: a reviewer reading "Fixed — the guard now checks…" can see
 * the commit it refers to, because the push happened before the reply existed.
 *
 * Which is also why the run refuses to start on a dirty tree, on a checkout that is not at the PR
 * head, or on a fork PR: each one would leave a reply claiming something pr-open could not do.
 * `declined` threads keep their reply and stay open, since they are what a person still has to answer.
 */
export class AddressController implements vscode.Disposable {
  private state: AddressState = { running: false, message: '', items: [] };
  private abort?: AbortController;
  /** The PR the listed items belong to, for opening a thread's file. */
  private repo?: AskRepo;
  /** The checkout being addressed, and whether claude has begun writing to it. */
  private dir?: string;
  private wrote = false;
  /** When the last progress line was posted, which is what `progress` throttles against. */
  private lastProgress = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly view: AddressView,
    private readonly repos: AskRepoRegistry,
  ) {}

  dispose(): void {
    this.abort?.abort();
  }

  /** Re-push the run's state: a fresh webview, or the ask section being expanded. */
  snapshot(): void {
    this.push();
  }

  /** Kill the claude subprocess. Replies already posted stay posted, and so does whatever it had
   *  already written to the tree, which the run then names rather than reverting. */
  cancel(): void {
    this.abort?.abort();
  }

  /**
   * Open the file a listed thread hangs off, at its line.
   *
   * A base-side thread opens the merge base's copy of the file rather than the one on disk: its line
   * numbers are the before state's, so the head file would scroll to a line the reviewer never read.
   */
  async open(label: string): Promise<void> {
    const item = this.state.items.find((i) => i.label === label);
    const repo = this.repo;
    if (!item || !repo) {
      return;
    }
    const uri = item.base
      ? BaseContentProvider.uriFor(repo.cloneDir, repo.base, item.file)
      : vscode.Uri.file(path.join(repo.cloneDir, item.file));
    const line = Math.max(0, (item.line ?? 1) - 1);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
    } catch (e) {
      void vscode.window.showWarningMessage(`PR Open: could not open ${item.file}: ${errorMessage(e)}`);
    }
  }

  async start(): Promise<void> {
    if (this.abort) {
      return; // the panel hides the button while a run is live: this is the invariant, not a user path
    }
    const abort = new AbortController();
    this.abort = abort;
    this.repo = undefined;
    this.dir = undefined;
    this.wrote = false;
    this.state = { running: true, message: 'Reading the review comments…', items: [] };
    this.push();
    try {
      await this.runInner(abort.signal);
    } catch (e) {
      const stranded = await this.strandedEdits();
      if (abort.signal.aborted) {
        this.state.message = ['Stopped.', stranded].filter(Boolean).join(' ');
      } else {
        const message = errorMessage(e);
        this.state.error = message;
        this.state.message = stranded ?? '';
        log(`address: ${message}`);
      }
    } finally {
      this.abort = undefined;
      this.state.running = false;
      this.push();
    }
  }

  /**
   * What the pass wrote before the run failed, which is still on disk: the commit only happens once
   * every reply is drafted, and Stop kills the subprocess mid-edit.
   *
   * Naming the tree here is what keeps the *next* run's "you have uncommitted changes, commit or
   * stash yours first" from reading as an accusation about edits pr-open made.
   */
  private async strandedEdits(): Promise<string | undefined> {
    if (!this.wrote || !this.dir) {
      return undefined;
    }
    try {
      return (await isDirty(this.dir))
        ? `Claude's edits are still in ${path.basename(this.dir)}, uncommitted: review them, then commit or discard them.`
        : undefined;
    } catch {
      return undefined; // the tree's state is a footnote here; the failure being reported is the news
    }
  }

  private async runInner(signal: AbortSignal): Promise<void> {
    const dir = activeDir();
    const repo = dir ? await this.repos.forDir(dir) : undefined;
    if (!dir || !repo) {
      throw new Error(
        'I could not tell which pull request to address. Check out the PR branch, and check that `origin` names a GitHub repo, then try again.',
      );
    }
    this.repo = repo;
    this.dir = dir;
    if (await this.repos.hasMoved(dir)) {
      throw new Error(
        `The checkout in ${path.basename(dir)} has moved, so its review comments no longer describe it. Refresh and try again.`,
      );
    }

    // Read the threads before checking the tree: a PR with nothing left to answer should say so
    // rather than send the reviewer off to stash work this run was never going to touch.
    const { head, threads, truncated } = await fetchReviewThreads(dir, repo);
    signal.throwIfAborted();
    if (truncated) {
      log('address: this PR has more review threads than one page holds; the rest were not read');
    }
    const unresolved = threads.filter((t) => !t.resolved);
    if (unresolved.length === 0) {
      // The page read carried none, which is not the same as the PR having none: an unresolved thread
      // can sit behind a first page of a hundred resolved ones.
      this.say(truncated ? UNREAD_EMPTY : 'no unresolved review comments.');
      return;
    }
    if (await isDirty(dir)) {
      throw new Error(
        `${path.basename(dir)} has uncommitted changes. This pass commits everything it writes, so commit or stash yours first.`,
      );
    }
    const local = await readHead(dir);
    if (local.oid !== head.oid) {
      throw new Error(
        `${path.basename(dir)} is at ${local.oid.slice(0, 8)} but PR #${repo.number} is at ${head.oid.slice(0, 8)}. Pull the PR first, so a pushed fix cannot drop a commit.`,
      );
    }
    if (head.crossRepo) {
      throw new Error(
        `PR #${repo.number} is from a fork, so pr-open cannot push a fix to its branch. Address these comments by hand.`,
      );
    }

    const labelled = labelThreads(unresolved);
    this.state.items = labelled.map(({ label, thread }) => item(label, thread));
    this.say(`Claude is working through ${labelled.length} comment${labelled.length === 1 ? '' : 's'}…`);

    const results = await this.think(repo, labelled, signal);
    signal.throwIfAborted();

    const sha = await this.land(dir, head.refName, labelled, results, signal);
    signal.throwIfAborted();
    await this.publish(dir, labelled, results, sha, signal);
    this.say(this.summary(sha, truncated));
  }

  /** The claude pass: edits on disk, and a reply per thread. */
  private async think(
    repo: AskRepo,
    labelled: readonly LabelledThread[],
    signal: AbortSignal,
  ): Promise<Map<string, ThreadResult>> {
    const annotatedDiff = await annotatedDiffFor(repo);
    signal.throwIfAborted();
    this.wrote = true; // from here on the tree can carry edits nothing has committed yet
    let done = 0;
    return runAddressPass({
      repo,
      annotatedDiff,
      threads: labelled,
      promptPath: path.join(this.extensionUri.fsPath, 'prompt-address.md'),
      model: configured((c) => c.addressModel),
      signal,
      onResult: (result) => {
        done += 1;
        this.note(`Claude answered ${done} of ${labelled.length}…`);
        this.patch(result.label, { state: AddressItemState.Drafted, outcome: result.outcome, reply: result.reply });
      },
      onTool: (label) => this.progress(`Claude: ${label}`),
    });
  }

  /**
   * Commit and push whatever the pass wrote, returning the commit. Undefined when it wrote nothing,
   * which is the whole-tree answer rather than a per-thread claim: a thread claiming `fixed` while the
   * tree is untouched is a model that did not do what it said, and its reply must not cite a commit.
   */
  private async land(
    dir: string,
    branch: string,
    labelled: readonly LabelledThread[],
    results: ReadonlyMap<string, ThreadResult>,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (!(await isDirty(dir))) {
      return undefined;
    }
    signal.throwIfAborted();
    this.say('committing and pushing the fix…');
    const sha = await commitAll(dir, commitMessage(labelled, results));
    if (sha === undefined) {
      log('address: the tree reads dirty but nothing staged, so there is no commit to push');
      return undefined;
    }
    await pushHead(dir, branch);
    log(`address: pushed ${sha.slice(0, 8)} to ${branch}`);
    // The tree moved, so every anchor and answer taken against the old head is stale, and the panel's
    // status row is describing a commit that is no longer checked out.
    this.repos.unseed(dir);
    return sha;
  }

  /** Post each reply, then resolve every thread whose answer is backed by something a reviewer can see. */
  private async publish(
    dir: string,
    labelled: readonly LabelledThread[],
    results: ReadonlyMap<string, ThreadResult>,
    sha: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    for (const { label, thread } of labelled) {
      const result = results.get(label);
      if (!result) {
        continue; // no answer came back for it; it stays Pending and open
      }
      signal.throwIfAborted();
      this.say(`replying to ${label}…`);
      try {
        await replyToThread(dir, thread.id, replyBody(result, sha));
      } catch (e) {
        this.patch(label, { state: AddressItemState.Failed, error: errorMessage(e) });
        continue;
      }
      if (result.outcome === ThreadOutcome.Declined) {
        this.patch(label, { state: AddressItemState.Replied }); // a person still has to answer it
        continue;
      }
      if (result.outcome === ThreadOutcome.Fixed && sha === undefined) {
        // It claims a fix the tree does not carry, so resolving the thread would bury that: a denied
        // Edit and a model that only said it edited both land here.
        this.patch(label, { state: AddressItemState.Replied, error: 'reports a fix, but no file changed' });
        continue;
      }
      try {
        await resolveThread(dir, thread.id);
        this.patch(label, { state: AddressItemState.Resolved });
      } catch (e) {
        // The reply is already on GitHub, so this is a thread left open, not a thread untouched.
        this.patch(label, { state: AddressItemState.Replied, error: `not resolved: ${errorMessage(e)}` });
      }
    }
  }

  private summary(sha: string | undefined, truncated: boolean): string {
    const count = (state: AddressItemState) => this.state.items.filter((i) => i.state === state).length;
    const parts = [`${count(AddressItemState.Resolved)} resolved`];
    for (const [state, said] of TALLY) {
      const n = count(state);
      if (n) {
        parts.push(`${n} ${said}`);
      }
    }
    const claimedFix = this.state.items.some((i) => i.outcome === ThreadOutcome.Fixed);
    const notes = [
      sha ? `pushed ${sha.slice(0, 8)}` : claimedFix ? 'no file changed, so nothing was pushed' : 'no code change',
    ];
    if (truncated) {
      notes.push('more threads than one page holds were left unread');
    }
    return `${parts.join(', ')} (${notes.join('; ')}).`;
  }

  /** Record what the run is doing, always against the PR it is doing it to: the block outlives the
   *  run, and a reviewer who has moved on must not read these rows as being about the PR in front of
   *  them. Silent, for a caller whose next call posts anyway. */
  private note(message: string): void {
    this.state.message = this.repo ? `#${this.repo.number}: ${message}` : message;
  }

  private say(message: string): void {
    this.note(message);
    this.push();
  }

  /** A progress line worth dropping when they arrive faster than anyone can read them. */
  private progress(message: string): void {
    const now = Date.now();
    if (now - this.lastProgress < PROGRESS_THROTTLE_MS) {
      this.note(message);
      return;
    }
    this.lastProgress = now;
    this.say(message);
  }

  private patch(label: string, patch: Partial<AddressItem>): void {
    this.state.items = this.state.items.map((i) => (i.label === label ? { ...i, ...patch } : i));
    this.push();
  }

  private push(): void {
    this.view.postAddress({ type: 'addressState', state: this.state });
  }
}

/** Everything a summary counts besides the resolved threads it leads with. */
const TALLY: readonly [AddressItemState, string][] = [
  [AddressItemState.Replied, 'replied and left open'],
  [AddressItemState.Failed, 'failed'],
  [AddressItemState.Pending, 'unanswered'],
  [AddressItemState.Drafted, 'answered but not posted'],
];

function item(label: string, thread: ReviewThread): AddressItem {
  return {
    label,
    file: thread.path,
    lines: lineRange(thread),
    line: thread.line,
    base: thread.side === DiffSide.Left,
    outdated: thread.outdated,
    state: AddressItemState.Pending,
  };
}

/** The reply as posted, with the commit that carries a fix when one exists. */
function replyBody(result: ThreadResult, sha: string | undefined): string {
  const fixed = result.outcome === ThreadOutcome.Fixed && sha !== undefined;
  return fixed ? `${result.reply}\n\n_Fixed in \`${sha.slice(0, 8)}\`_` : result.reply;
}

function commitMessage(labelled: readonly LabelledThread[], results: ReadonlyMap<string, ThreadResult>): string {
  const fixed = labelled.filter(({ label }) => results.get(label)?.outcome === ThreadOutcome.Fixed);
  const lines = ['Address review comments'];
  if (fixed.length) {
    lines.push('');
    for (const { thread } of fixed) {
      lines.push(`- ${thread.path}:${lineRange(thread)}`);
    }
  }
  return lines.join('\n');
}
