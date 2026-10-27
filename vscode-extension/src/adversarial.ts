import { readFile } from 'fs/promises';
import { adversarialPrompt, buildAdversarialPayload, isDoneSentinel, validateFinding } from './adversarialpayload';
import { AskRepo } from './askpayload';
import { ADVERSARIAL_DEFAULT_MODEL, ClaudeSessionPersistence, claudeStreamArgs, ClaudeSystemPrompt } from './claude';
import { streamClaudeJsonl } from './claudejsonl';
import { log } from './logger';
import { ReviewFinding } from './prreview';
import { Appended } from './userinstructions';

/** Where a run got to, for the panel's one status line. */
export enum AdversarialPhase {
  Idle = 'idle',
  Hunting = 'hunting',
  Filing = 'filing',
  Done = 'done',
  Failed = 'failed',
}

export interface AdversarialState {
  phase: AdversarialPhase;
  /** What the run is doing, or what it finished with. */
  message: string;
  /** Findings the model has turned up so far, which is what the hunt counts up. */
  found: number;
  /** Comments actually on the draft review, which is only known once GitHub has accepted it. */
  filed: number;
  /** Findings the diff could not carry; they live on in the review's summary comment. */
  dropped: number;
  /** The draft review on GitHub, once it exists. */
  url?: string;
  error?: string;
}

/** The panel is handed the whole state on every change, so it has no partial update to keep in step. */
export type AdversarialMessage = { type: 'adversarialState'; state: AdversarialState };

export interface AdversarialView {
  postAdversarial(msg: AdversarialMessage): void;
}

export interface AdversarialPassInput {
  repo: AskRepo;
  /** The whole PR diff, already run through `annotateDiff`. */
  annotatedDiff: string;
  /** Paths the diff carries. A finding outside this set can never be placed. */
  files: ReadonlySet<string>;
  /** Path to `prompt-adversarial.md`. */
  promptPath: string;
  /** The reader's own `CLAUDE.md`, resolved into the blocks this prompt appends. */
  appended: Appended;
  model?: string;
  signal?: AbortSignal;
  /** One finding arrived. Fires as its line completes, so the panel counts up as the pass runs. */
  onFinding(finding: ReviewFinding): void;
  /** A tool call, for a progress line while the model reads. */
  onTool(label: string): void;
}

/**
 * Run one `claude` subprocess over the PR diff, returning every finding it could place.
 *
 * Read-only tools rather than none: a bug is usually only visible once you have read the caller the
 * diff does not show, and a design finding usually needs the helper this hunk reimplements. The tier
 * carries no Edit, Write or Bash, so a run that writes to the tree is unrepresentable rather than
 * merely denied.
 *
 * A finding naming a file outside the diff is dropped and logged. The prompt's closing `{"done":true}`
 * is what distinguishes a clean empty review from a model that wandered off, since the JSONL runner
 * treats a stream that yielded nothing at all as a failure.
 */
export async function runAdversarialPass(input: AdversarialPassInput): Promise<ReviewFinding[]> {
  const { repo, annotatedDiff, files, promptPath, appended, model, signal, onFinding, onTool } = input;
  const findings: ReviewFinding[] = [];
  const seen = new Set<string>();
  let done = false;

  const emit = (obj: unknown) => {
    if (isDoneSentinel(obj)) {
      done = true;
      return;
    }
    const finding = validateFinding(obj, files);
    if (!finding) {
      if (obj !== undefined) {
        log(`adversarial: dropped an unusable finding line: ${JSON.stringify(obj).slice(0, 300)}`);
      }
      return;
    }
    const key = `${finding.file}:${finding.line}:${finding.side}`;
    if (seen.has(key)) {
      log(`adversarial: ${key} reported twice; keeping the first`);
      return;
    }
    seen.add(key);
    findings.push(finding);
    onFinding(finding);
  };

  const args = await claudeStreamArgs({
    model,
    systemPrompt: {
      mode: ClaudeSystemPrompt.Append,
      text: adversarialPrompt(await readFile(promptPath, 'utf8'), appended),
    },
    tools: 'read-only',
    // Nothing resumes this pass: a second run reads the diff again and starts over.
    persistence: ClaudeSessionPersistence.Ephemeral,
  });

  const payload = buildAdversarialPayload({ repo, annotatedDiff });
  log(`adversarial: claude --model ${model ?? ADVERSARIAL_DEFAULT_MODEL}, stdin ${payload.length} bytes`);
  await streamClaudeJsonl({
    args,
    input: payload,
    cwd: repo.cloneDir,
    signal,
    label: 'adversarial',
    onObject: emit,
    // The sentinel counts, so "found nothing" reads as a finished run rather than an empty stream.
    accepted: () => findings.length + (done ? 1 : 0),
    emptyMessage: 'Claude did not finish the review',
    onEvent: (e) => {
      if (e.kind === 'tool') {
        onTool(e.label);
      }
    },
  });
  if (!done) {
    log(`adversarial: the stream ended without a done line; keeping ${findings.length} finding(s)`);
  }
  return findings;
}
