import { readFile } from 'fs/promises';
import { LabelledThread, ThreadOutcome, ThreadResult, buildAddressPayload, validateThreadResult } from './addresspayload';
import { AskRepo } from './askpayload';
import { ClaudeSessionPersistence, claudeStreamArgs, ClaudeSystemPrompt, DEFAULT_MODEL } from './claude';
import { streamClaudeJsonl } from './claudejsonl';
import { log } from './logger';

/** Where a thread got to. One run walks every item from `Pending` to one of the last three. */
export enum AddressItemState {
  /** Sent to claude, no answer yet. A run that ends with one of these left it alone. */
  Pending = 'pending',
  /** Claude answered; nothing has reached GitHub yet. */
  Drafted = 'drafted',
  /** Reply posted and the thread marked resolved. */
  Resolved = 'resolved',
  /** Reply posted, thread still open: claude declined it, or resolving it failed (see `error`). */
  Replied = 'replied',
  /** Nothing was posted for this thread; `error` says why. */
  Failed = 'failed',
}

/** One thread, as the panel lists it. */
export interface AddressItem {
  label: string;
  file: string;
  /** Where the thread hangs, as GitHub places it: `12`, `12-14`, or `whole file`. */
  lines: string;
  /** Line to open the file at; absent on a thread GitHub could not place on one. */
  line?: number;
  /** A thread on the merge-base side opens the before state, where its numbers mean something. */
  base: boolean;
  /** The lines have moved since the comment was written. */
  outdated: boolean;
  state: AddressItemState;
  outcome?: ThreadOutcome;
  /** Markdown, exactly as posted. */
  reply?: string;
  error?: string;
}

export interface AddressState {
  running: boolean;
  /** What the run is doing, or what it finished with. */
  message: string;
  items: AddressItem[];
  /** Set when the run as a whole failed. A single thread's failure lives on its item. */
  error?: string;
}

/** The panel is handed the whole state on every change, so it has no partial update to keep in step. */
export type AddressMessage = { type: 'addressState'; state: AddressState };

export interface AddressView {
  postAddress(msg: AddressMessage): void;
}

export interface AddressPassInput {
  repo: AskRepo;
  /** The whole PR diff, already run through `annotateDiff`. */
  annotatedDiff: string;
  threads: readonly LabelledThread[];
  /** Path to `prompt-address.md`. */
  promptPath: string;
  model?: string;
  signal?: AbortSignal;
  /** One thread finished. Fires as its line completes, so the panel fills in as the pass runs. */
  onResult(result: ThreadResult): void;
  /** A tool call, for a progress line while the model reads and edits. */
  onTool(label: string): void;
}

/**
 * Run one `claude` subprocess over every thread, returning a result per thread by label.
 *
 * One subprocess rather than one per thread: the threads share a diff and often the same code, and
 * two subprocesses editing one tree in parallel would each write over the other's fix. Results come
 * back as newline-delimited JSON so a thread's reply is known the moment the model moves on, while
 * the edits it made are already on disk.
 *
 * A result naming a thread that was never sent, or one repeating a label, is dropped and logged: the
 * caller reports every thread it got no usable answer for and leaves it open.
 */
export async function runAddressPass(input: AddressPassInput): Promise<Map<string, ThreadResult>> {
  const { repo, annotatedDiff, threads, promptPath, model, signal, onResult, onTool } = input;
  const labels = new Set(threads.map((t) => t.label));
  const results = new Map<string, ThreadResult>();

  const emit = (obj: unknown) => {
    const result = validateThreadResult(obj, labels);
    if (!result) {
      if (obj !== undefined) {
        log(`address: dropped an unusable result line: ${JSON.stringify(obj).slice(0, 300)}`);
      }
      return;
    }
    if (results.has(result.label)) {
      log(`address: ${result.label} answered twice; keeping the first reply`);
      return;
    }
    results.set(result.label, result);
    onResult(result);
  };

  const args = await claudeStreamArgs({
    model,
    systemPrompt: { mode: ClaudeSystemPrompt.Append, text: await readFile(promptPath, 'utf8') },
    tools: 'edit',
    // Nothing resumes this pass: a second run reads the threads again and starts over.
    persistence: ClaudeSessionPersistence.Ephemeral,
  });

  const payload = buildAddressPayload({ repo, annotatedDiff, threads });
  log(`address: claude --model ${model ?? DEFAULT_MODEL}, ${threads.length} threads, stdin ${payload.length} bytes`);
  await streamClaudeJsonl({
    args,
    input: payload,
    cwd: repo.cloneDir,
    signal,
    label: 'address',
    onObject: emit,
    accepted: () => results.size,
    emptyMessage: 'Claude did not answer any review comments',
    onEvent: (e) => {
      if (e.kind === 'tool') {
        onTool(e.label);
      } else if (e.kind === 'done' && e.denials.length) {
        // The one pass whose tools write, so a denied Edit is exactly why a thread can report a fix
        // the tree does not have.
        log(`address: claude was denied tools: ${e.denials.join(', ')}`);
      }
    },
  });
  return results;
}
