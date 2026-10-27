import { readFile } from 'fs/promises';
import { AskAnchor } from './askanchor';
import { AskConversationState, runAskProcess } from './askconversation';
import { aimChange, AskRepo, AskTurn, buildAskPayload, buildFollowUpPayload, diffFitsBudget } from './askpayload';
import { AskEvent, isSessionGone } from './askstream';
import { CLAUDE_CANDIDATES, CLAUDE_NOT_FOUND, claudeStreamArgs, ClaudeSystemPrompt, DEFAULT_MODEL } from './claude';
import { annotateDiff } from './diffannotate';
import { runToolStreaming } from './exec';
import { localDiff } from './git';
import { log } from './logger';
import { errorMessage } from './util';

export type { AskAnchor } from './askanchor';
export type { AskAim, AskRepo, AskTurn } from './askpayload';
export type { AskEvent } from './askstream';

/** Thrown when a turn was cancelled by the caller, so surfaces can stay quiet about it. */
export class AskCancelled extends Error {}

/** Thrown when the CLI has forgotten the session a turn tried to resume, so `ask` can retry it once
 *  from scratch. Never escapes this module. */
class SessionGone extends Error {}

export type AskState = 'streaming' | 'done' | 'error';

/** One question and its answer. `answer` is raw markdown; each surface renders it its own way. */
export interface AskEntry {
  id: string;
  /** The lines it was aimed at. Absent for a question about the PR as a whole. */
  anchor?: AskAnchor;
  question: string;
  answer: string;
  state: AskState;
  error?: string;
  /** Which surface asked. Drives whether the panel section opens itself. */
  origin: 'panel' | 'inline';
}

/** Messages the controller pushes to its views. Answers carry markdown, never HTML. `anchor` is the
 *  lines the compose box would narrow its next question to, absent when it would ask about the PR. */
export type AskMessage =
  | { type: 'askSnapshot'; entries: AskEntry[]; anchor?: AskAnchor }
  | { type: 'askEntry'; entry: AskEntry }
  | { type: 'askAnswer'; id: string; answer: string; state: 'streaming' | 'done' }
  | { type: 'askFailed'; id: string; message: string }
  | { type: 'askAnchor'; anchor?: AskAnchor }
  | { type: 'askCleared' };

export interface AskView {
  postAsk(msg: AskMessage): void;
}

/** What every turn of a conversation is fixed against, whatever the turn asks. */
export interface AskContext {
  repo: AskRepo;
  /** Path to `prompt-ask.md`. */
  promptPath: string;
  model?: string;
}

interface CompletedTurn {
  answer: string;
  session?: string;
}

/**
 * One question-and-follow-ups conversation with claude about a PR.
 *
 * Turn 1 ships the PR diff; every later turn resumes the captured session and ships only the question,
 * plus an anchor block when it re-aims or widens back out to the whole PR. So the diff is sent once
 * per conversation however many questions it carries. One turn at a time: `ask` throws if `busy`, and
 * each surface keeps its own UI from offering a second question.
 */
export class AskConversation {
  private readonly state = new AskConversationState();
  private abort?: AbortController;

  constructor(private readonly context: AskContext) {}

  get busy(): boolean {
    return this.abort !== undefined;
  }

  /** Kill the in-flight subprocess. A no-op when idle. */
  cancel(): void {
    this.abort?.abort();
  }

  /** Run a turn, streaming progress. Resolves with the final answer text. */
  async ask(turn: AskTurn, onProgress: (e: AskEvent) => void): Promise<string> {
    if (this.busy) {
      throw new Error('This conversation is already waiting on an answer.');
    }
    const abort = new AbortController();
    this.abort = abort;
    try {
      const completed = await this.turnWithRecovery(turn, onProgress, abort.signal);
      this.state.complete(turn, completed.answer, completed.session);
      return completed.answer;
    } catch (e) {
      // A failed subprocess may already have appended the question, tools, or a partial answer to
      // its Claude session. Resume only sessions whose last turn entered `history`, so the replayed
      // transcript and Claude's transcript always describe the same conversation.
      this.state.fail();
      throw e;
    } finally {
      this.abort = undefined;
    }
  }

  /** A resumed session the CLI has forgotten is retried once from scratch, with the prior turns
   *  replayed into the payload so the follow-up still reads as a follow-up. */
  private async turnWithRecovery(
    turn: AskTurn,
    onProgress: (e: AskEvent) => void,
    signal: AbortSignal,
  ): Promise<CompletedTurn> {
    try {
      return await this.runTurn(turn, onProgress, signal);
    } catch (e) {
      if (!(e instanceof SessionGone)) {
        throw e;
      }
      log('ask: the resumed session was gone; retrying with full context');
      this.state.fail();
      return this.runTurn(turn, onProgress, signal);
    }
  }

  /** One subprocess. */
  private async runTurn(turn: AskTurn, onProgress: (e: AskEvent) => void, signal: AbortSignal): Promise<CompletedTurn> {
    const resumedSession = this.state.session;
    const resuming = resumedSession !== undefined;
    let input: string;
    if (resuming) {
      input = buildFollowUpPayload(turn.question, aimChange(turn, this.state.sent));
    } else {
      const annotatedDiff = await annotatedDiffFor(this.context.repo);
      if (!diffFitsBudget(annotatedDiff)) {
        // Never truncate quietly: a reviewer should be able to tell why an answer knows less.
        log(`ask: PR diff is ${annotatedDiff.length} bytes, over budget; sending a changed-file index instead`);
      }
      // A fresh payload always carries the aim, so a recovered session is re-aimed where the lost one
      // was. `buildAskPayload` ignores an empty history, so the first turn needs no special case.
      input = buildAskPayload({ ...turn, repo: this.context.repo, annotatedDiff, history: this.state.history });
    }

    const model = this.context.model ?? DEFAULT_MODEL;
    const args = await claudeStreamArgs({
      model,
      systemPrompt: { mode: ClaudeSystemPrompt.Append, text: await readFile(this.context.promptPath, 'utf8') },
      tools: 'read-only',
      resume: resumedSession,
    });

    log(`ask: claude --model ${model}${resuming ? ' --resume' : ''}, stdin ${input.length} bytes`);
    const result = await runAskProcess(
      resumedSession,
      (onStdout) =>
        runToolStreaming(
          'claude',
          args,
          {
            candidates: CLAUDE_CANDIDATES,
            notFound: CLAUDE_NOT_FOUND,
            cwd: this.context.repo.cloneDir,
            input,
            signal,
          },
          onStdout,
        ),
      onProgress,
    );
    const { session, deltas, final, errored, denials, tail } = result.output;
    if (denials.length) {
      log(`ask: claude was denied tools: ${denials.join(', ')}`);
    }
    if (!result.ok) {
      if (signal.aborted) {
        throw new AskCancelled('cancelled');
      }
      const message = errored ?? errorMessage(result.error);
      if (resuming && isSessionGone(message)) {
        throw new SessionGone(message);
      }
      log(`ask: claude failed: ${message}`);
      log(`ask: last stdout from claude:\n${tail}`);
      throw new Error(`${message} (see Output → "PR Open" for claude's output)`);
    }

    if (errored) {
      if (resuming && isSessionGone(errored)) {
        throw new SessionGone(errored);
      }
      log(`ask: claude reported an error: ${errored}`);
      throw new Error(errored);
    }
    // Prefer the result text: with tools on, the deltas also carry the model's pre-tool asides,
    // which are useful as progress and wrong as the finished answer.
    const answer = (final || deltas).trim();
    if (!answer) {
      log(`ask: no answer text. Raw stdout tail:\n${tail}`);
      throw new Error('Claude did not return an answer (see Output → "PR Open").');
    }
    return { answer, session };
  }
}

/**
 * One `git diff` + annotation per tree, shared by every conversation about that PR.
 *
 * Keyed by clone and stamped with the commits it was taken between, so a tree that moves replaces its
 * diff rather than adding one: a long review would otherwise leave every commit's annotated diff (up
 * to the 240k budget each) resident for the window's life.
 */
const diffCache = new Map<string, { stamp: string; diff: Promise<string> }>();

/** Shared with the review-comment pass, which describes the same tree at the same two commits. */
export function annotatedDiffFor(repo: AskRepo): Promise<string> {
  const stamp = `${repo.base}..${repo.headOid}`;
  const hit = diffCache.get(repo.cloneDir);
  if (hit?.stamp === stamp) {
    return hit.diff;
  }
  // Drop a failed diff so the next question retries instead of inheriting the error forever.
  const diff = localDiff(repo.cloneDir, repo.base)
    .then(annotateDiff)
    .catch((e) => {
      if (diffCache.get(repo.cloneDir)?.stamp === stamp) {
        diffCache.delete(repo.cloneDir);
      }
      throw e;
    });
  diffCache.set(repo.cloneDir, { stamp, diff });
  return diff;
}
