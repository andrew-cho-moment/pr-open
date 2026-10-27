import { AskRepo, cap, diffFitsBudget, repoSection } from './askpayload';
import { DiffSide, ReviewThread } from './prthreads';

/**
 * What claude is handed when it works through a PR's review comments, and what it must hand back.
 *
 * Threads are labelled `T1`, `T2`, … rather than named by their GraphQL node id: the model has to
 * echo the label back on every result line, and a mistyped `PRRT_kwDOM…` would attach a reply to
 * nothing. The labels are this module's only contract with the prompt.
 */

/** What claude did about one thread. */
export enum ThreadOutcome {
  /** Code changed in the working tree. */
  Fixed = 'fixed',
  /** No change needed; the reply answers the comment. */
  Answered = 'answered',
  /** Needs a person: the reply says why, and the thread stays open. */
  Declined = 'declined',
}

/** A thread under the label the payload gives it. */
export interface LabelledThread {
  label: string;
  thread: ReviewThread;
}

/** One result line from the model, already checked against the labels that were sent. */
export interface ThreadResult {
  label: string;
  outcome: ThreadOutcome;
  /** Markdown, posted verbatim as the thread's reply. */
  reply: string;
}

export interface AddressPayloadInput {
  repo: AskRepo;
  /** The whole PR diff, already run through `annotateDiff`. */
  annotatedDiff: string;
  threads: readonly LabelledThread[];
}

/** A comment past this is a design document; the model has the code for the rest. */
const MAX_COMMENT_CHARS = 2_000;

/** GitHub's hunk covers a few lines either side of the comment; more than this is a rewritten file. */
const MAX_HUNK_LINES = 40;

/** Label threads in the order GitHub returned them, which is the order the panel lists them in. */
export function labelThreads(threads: readonly ReviewThread[]): LabelledThread[] {
  return threads.map((thread, i) => ({ label: `T${i + 1}`, thread }));
}

/** The stdin payload: the PR, its diff, and every thread to work through. */
export function buildAddressPayload({ repo, annotatedDiff, threads }: AddressPayloadInput): string {
  const out: string[] = [...repoSection(repo)];

  if (diffFitsBudget(annotatedDiff)) {
    out.push('', '### FULL PR DIFF');
    out.push(annotatedDiff);
  } else {
    out.push('', '### NO FULL DIFF');
    out.push(
      'This PR is too large to include, so each thread below carries only the hunk GitHub shows',
      'above it. Read the files you need at HEAD (the after state); you have no view of the before',
      'state beyond those hunks.',
    );
  }

  out.push('', `### REVIEW THREADS (${threads.length})`);
  for (const { label, thread } of threads) {
    out.push('', ...threadSection(label, thread));
  }
  return out.join('\n');
}

function threadSection(label: string, thread: ReviewThread): string[] {
  const out = [`--- ${label}`, `file: ${thread.path}`, `lines: ${lineRange(thread)}`, `side: ${sideNote(thread.side)}`];
  if (thread.outdated) {
    out.push(
      'outdated: the code under this comment has changed since it was written, so those line numbers',
      'no longer point at what the reviewer read. Find the code they meant before changing anything.',
    );
  }
  if (thread.hunk) {
    out.push('hunk:', capLines(thread.hunk, MAX_HUNK_LINES));
  }
  out.push('comments:');
  for (const comment of thread.comments) {
    out.push(`@${comment.author}:`, cap(comment.body.trim(), MAX_COMMENT_CHARS, '(comment truncated)'));
  }
  return out;
}

/** A thread's lines as GitHub places them, or the file itself when it hangs off no line. */
export function lineRange(thread: Pick<ReviewThread, 'line' | 'startLine'>): string {
  if (thread.line === undefined) {
    return 'whole file';
  }
  return thread.startLine !== undefined && thread.startLine < thread.line
    ? `${thread.startLine}-${thread.line}`
    : String(thread.line);
}

function sideNote(side: DiffSide): string {
  return side === DiffSide.Right
    ? 'RIGHT (after) — these numbers match the file on disk.'
    : 'LEFT (before) — these numbers are the merge base\'s, not the file on disk. The reviewer is ' +
        'commenting on a line this PR removed or changed.';
}

/**
 * Validate one result line against the labels that were sent.
 *
 * Rejects rather than repairs: a result naming a thread that was never sent, or an outcome outside
 * the enum, is a reply pr-open cannot place, and posting a guess is worse than reporting the gap.
 */
export function validateThreadResult(obj: unknown, labels: ReadonlySet<string>): ThreadResult | undefined {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  const r = obj as { thread?: unknown; outcome?: unknown; reply?: unknown };
  const reply = typeof r.reply === 'string' ? r.reply.trim() : '';
  if (typeof r.thread !== 'string' || !labels.has(r.thread) || !reply || !isOutcome(r.outcome)) {
    return undefined;
  }
  return { label: r.thread, outcome: r.outcome, reply };
}

function isOutcome(value: unknown): value is ThreadOutcome {
  return Object.values<unknown>(ThreadOutcome).includes(value);
}

function capLines(text: string, limit: number): string {
  const lines = text.replace(/\n$/, '').split('\n');
  return lines.length <= limit ? lines.join('\n') : [...lines.slice(0, limit), '… (hunk truncated)'].join('\n');
}
