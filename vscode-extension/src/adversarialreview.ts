import * as path from 'path';
import * as vscode from 'vscode';
import { AdversarialPhase, AdversarialState, AdversarialView, runAdversarialPass } from './adversarial';
import { annotatedDiffFor } from './ask';
import { AskRepo, diffFitsBudget } from './askpayload';
import { AskRepoRegistry } from './askrepo';
import { ADVERSARIAL_DEFAULT_MODEL } from './claude';
import { adversarialSections, configured } from './config';
import { diffAnchors } from './diffanchors';
import { readHead } from './git';
import { log } from './logger';
import {
  createPendingReview,
  deletePendingReview,
  fetchPendingReviewTarget,
  planThreads,
  PendingReviewTarget,
  reviewBody,
  ReviewFinding,
} from './prreview';
import { readReviewInstructions } from './userinstructions';
import { errorMessage } from './util';
import { activeDir } from './workspace';

/** The same throttle the address pass uses: a progress line per tool call outruns any reader. */
const PROGRESS_THROTTLE_MS = 150;

/** Ends a run without painting an error: the user chose this, so it is an instruction, not a fault. */
class Stopped extends Error {}

const IDLE: AdversarialState = { phase: AdversarialPhase.Idle, message: '', found: 0, filed: 0, dropped: 0 };

/**
 * Hunts the checked-out PR for bugs, for designs the next change will fight, and for prose a later
 * reader pays for, and files what it finds as a pending GitHub review.
 *
 * Pending is the point: the comments are a draft only their author can see, and they reach the PR
 * author when that person presses Submit on github.com. pr-open never publishes, approves, or
 * requests changes.
 *
 * A finding is checked against the diff before it is sent, because GitHub rejects the whole review
 * when one comment sits off-diff, and one hallucinated line number would otherwise discard every
 * real finding beside it. What could not be placed goes in the review's summary comment rather than
 * being dropped in silence.
 *
 * Unlike the address pass this writes nothing to the tree and pushes nothing, so it does not care
 * about a dirty worktree or a fork PR. It does care that the local checkout is at the PR's head:
 * the line numbers come from the local diff, and GitHub anchors them against its own head, so
 * different shas make every anchor suspect.
 */
export class AdversarialReviewController implements vscode.Disposable {
  private state: AdversarialState = { ...IDLE };
  private abort?: AbortController;
  private repo?: AskRepo;
  private lastProgress = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly view: AdversarialView,
    private readonly repos: AskRepoRegistry,
  ) {}

  dispose(): void {
    this.abort?.abort();
  }

  /** Re-push the run's state: a fresh webview, or the ask section being expanded. */
  snapshot(): void {
    this.push();
  }

  /** Stop an active review or dismiss its status without changing the draft on GitHub. */
  cancel(): void {
    if (this.abort) {
      this.abort.abort();
      return;
    }
    this.state = { ...IDLE };
    this.push();
  }

  async start(number: number): Promise<void> {
    if (this.abort) {
      return; // the panel disables the button while a run is live: this is the invariant, not a user path
    }
    const abort = new AbortController();
    this.abort = abort;
    this.repo = undefined;
    this.state = { phase: AdversarialPhase.Hunting, message: 'Reading the diff…', found: 0, filed: 0, dropped: 0 };
    this.push();
    try {
      await this.runInner(number, abort.signal);
    } catch (e) {
      if (abort.signal.aborted) {
        this.state.phase = AdversarialPhase.Idle;
        this.state.message = 'Stopped. Nothing was filed.';
      } else if (e instanceof Stopped) {
        this.state.phase = AdversarialPhase.Idle;
        this.note(e.message);
      } else {
        const message = errorMessage(e);
        this.state.phase = AdversarialPhase.Failed;
        this.state.error = message;
        log(`adversarial: ${message}`);
      }
    } finally {
      this.abort = undefined;
      this.push();
    }
  }

  private async runInner(number: number, signal: AbortSignal): Promise<void> {
    const dir = activeDir();
    const repo = dir ? await this.repos.forDir(dir) : undefined;
    if (!dir || !repo) {
      throw new Error(
        'I could not tell which pull request to review. Check out the PR branch, and check that `origin` names a GitHub repo, then try again.',
      );
    }
    if (repo.number !== number) {
      throw new Error(
        `PR #${number} is not checked out: ${path.basename(dir)} is on PR #${repo.number}. Check #${number} out first, or review the one you have.`,
      );
    }
    this.repo = repo;
    if (await this.repos.hasMoved(dir)) {
      throw new Error(
        `The checkout in ${path.basename(dir)} has moved, so a review of it would anchor on lines that have shifted. Refresh and try again.`,
      );
    }

    // Ask GitHub first: a draft the user already holds blocks the create, and finding that out after
    // spending minutes in the model would waste the whole run.
    const target = await fetchPendingReviewTarget(dir, repo);
    signal.throwIfAborted();
    await this.clearPending(dir, target, repo.number);
    signal.throwIfAborted();

    const local = await readHead(dir);
    if (local.oid !== target.headOid) {
      throw new Error(
        `${path.basename(dir)} is at ${local.oid.slice(0, 8)} but PR #${repo.number} is at ${target.headOid.slice(0, 8)}. Pull the PR first, so the comments land on the lines Claude read.`,
      );
    }

    const annotatedDiff = await annotatedDiffFor(repo);
    signal.throwIfAborted();
    const anchors = diffAnchors(annotatedDiff);
    if (anchors.size === 0) {
      throw new Error(`PR #${repo.number} has no diff to review against ${repo.base}.`);
    }
    // Every comment must anchor on a line of the diff, so a payload that dropped the diff could
    // only produce findings this run would throw away. Refuse before spending minutes in the model
    // rather than after, and say the real reason rather than reporting drift nothing observed.
    if (!diffFitsBudget(annotatedDiff)) {
      throw new Error(
        `PR #${repo.number}'s diff is too large to review in one pass (${Math.round(annotatedDiff.length / 1000)}k characters). Review it a few files at a time by hand.`,
      );
    }

    const findings = await this.hunt(repo, annotatedDiff, new Set(anchors.keys()), signal);
    signal.throwIfAborted();
    if (findings.length === 0) {
      this.state.phase = AdversarialPhase.Done;
      this.say('nothing worth reporting. Nothing was filed.');
      return;
    }

    const { threads, dropped } = planThreads(findings, anchors);
    this.state.dropped = dropped.length;
    for (const d of dropped) {
      log(`adversarial: dropped ${d.finding.file}:${d.finding.line} (${d.finding.side}) — ${d.reason}`);
    }
    if (threads.length === 0) {
      // Every anchor missing is diff drift, not one bad number, and an empty review is worse than none.
      throw new Error(
        `None of the ${findings.length} findings landed on a line in PR #${repo.number}'s diff, so the review was written against a different tree. Pull the PR and run it again.`,
      );
    }

    this.state.phase = AdversarialPhase.Filing;
    this.say(`filing ${threads.length} comment${threads.length === 1 ? '' : 's'}…`);
    const review = await createPendingReview(
      dir,
      {
        pullRequestId: target.pullRequestId,
        commitOID: target.headOid,
        body: reviewBody(dropped),
        threads,
      },
      signal,
    );

    this.state.phase = AdversarialPhase.Done;
    this.state.filed = threads.length;
    this.state.url = review.url;
    const lost = dropped.length ? `, ${dropped.length} in the summary it could not place` : '';
    this.say(`${threads.length} comment${threads.length === 1 ? '' : 's'} in a draft review${lost}. Submit it on GitHub to publish.`);
    log(`adversarial: filed ${threads.length}, dropped ${dropped.length}, review ${review.url}`);
  }

  /**
   * Clear the way for the create, which fails outright when the user already holds a draft.
   *
   * Never discards one unprompted: the draft in the way may be the user's own hand-written review,
   * and this run has no way to tell it from a stale one of its own.
   */
  private async clearPending(dir: string, target: PendingReviewTarget, number: number): Promise<void> {
    if (!target.pending) {
      return;
    }
    const discard = 'Discard it';
    const open = 'Open it';
    const choice = await vscode.window.showWarningMessage(
      `You already have a pending review on PR #${number}. GitHub allows one at a time.`,
      { modal: true, detail: 'Discarding deletes its comments for good.' },
      discard,
      open,
    );
    if (choice === open) {
      await vscode.env.openExternal(vscode.Uri.parse(target.pending.url));
      // The user picked this branch, so it ends the run as an instruction rather than as a failure
      // in the red error row.
      throw new Stopped('opened your existing draft. Submit or discard it, then run this again.');
    }
    if (choice !== discard) {
      throw new Error(`PR #${number} already has a pending review of yours. Submit or discard it, then try again.`);
    }
    await deletePendingReview(dir, target.pending.id);
    target.pending = undefined;
  }

  /** The claude pass: read-only, and a finding per line of its output. */
  private async hunt(
    repo: AskRepo,
    annotatedDiff: string,
    files: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<ReviewFinding[]> {
    // One read of the CLAUDE.md, resolved into blocks that share no line whichever sections it
    // carries. `reviewInstructions` settles that, so nothing downstream compares the two texts.
    const sections = adversarialSections();
    const instructions = await readReviewInstructions(sections.standard, sections.voice);
    log(`adversarial: ${instructions.note}`);
    let found = 0;
    return runAdversarialPass({
      repo,
      annotatedDiff,
      files,
      promptPath: path.join(this.extensionUri.fsPath, 'prompt-adversarial.md'),
      appended: instructions.appended,
      model: configured((c) => c.adversarialReviewModel) ?? ADVERSARIAL_DEFAULT_MODEL,
      signal,
      onFinding: () => {
        found += 1;
        this.state.found = found;
        // say, not note: a finding is rare enough to be worth a render, and note alone would sit in
        // the state until some later tool call happened to push it.
        this.say(`Claude found ${found} so far…`);
      },
      onTool: (label) => this.progress(`Claude: ${label}`),
    });
  }

  private note(message: string): void {
    this.state.message = this.repo ? `#${this.repo.number}: ${message}` : message;
  }

  private say(message: string): void {
    this.note(message);
    this.push();
  }

  private progress(message: string): void {
    const now = Date.now();
    if (now - this.lastProgress < PROGRESS_THROTTLE_MS) {
      this.note(message);
      return;
    }
    this.lastProgress = now;
    this.say(message);
  }

  private push(): void {
    this.view.postAdversarial({ type: 'adversarialState', state: this.state });
  }
}
