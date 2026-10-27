import { AskEvent, jsonlFramer, parseAskStream, rawTail } from './askstream';
import { CLAUDE_CANDIDATES, CLAUDE_NOT_FOUND } from './claude';
import { runToolStreaming } from './exec';
import { log } from './logger';
import { parseArray } from './reviewparse';
import { errorMessage } from './util';

/**
 * Run a `claude` subprocess whose answer is newline-delimited JSON, and hand each object over the
 * moment its line completes.
 *
 * The stream carries the model's JSONL through two layers of newline framing: claude's own event
 * objects, which `parseAskStream` unwraps, and the object lines inside the text those events carry,
 * which `jsonlFramer` splits. Both the guided review and the review-comment pass want exactly that,
 * so the framing, the array fallback, the "nothing usable came back" failure and the stdout tail
 * live here once.
 */
export interface JsonlRunOptions {
  args: string[];
  input: string;
  cwd?: string;
  signal?: AbortSignal;
  /** Prefixes every log line, e.g. `review`. */
  label: string;
  /** One parsed object. Undefined for a line that was not one, which callers ignore. */
  onObject(obj: unknown): void;
  /** How many objects the caller has accepted so far: what decides the fallback and the failure. */
  accepted(): number;
  /** Thrown when the run produced no object the caller could accept. */
  emptyMessage: string;
  /** Tool calls and other stream events, for a progress line while the model works. */
  onEvent?(e: AskEvent): void;
}

export async function streamClaudeJsonl(opts: JsonlRunOptions): Promise<void> {
  const { args, input, cwd, signal, label, onObject, accepted, emptyMessage, onEvent } = opts;
  signal?.throwIfAborted();

  const framer = jsonlFramer(onObject);
  let errored: string | undefined;
  const parser = parseAskStream((e) => {
    if (e.kind === 'error') {
      errored = e.message;
    } else {
      framer.feed(e);
    }
    onEvent?.(e);
  });

  const tail = rawTail();
  try {
    await runToolStreaming(
      'claude',
      args,
      { candidates: CLAUDE_CANDIDATES, notFound: CLAUDE_NOT_FOUND, cwd, input, signal },
      (data) => {
        tail.append(data);
        parser.feed(data);
      },
    );
    parser.end();
  } catch (e) {
    // Flushed here too: a reason claude wrote without a trailing newline is still in the parser's
    // buffer, and it names the failure better than "claude exited with code N" does.
    parser.end();
    signal?.throwIfAborted();
    const message = errored ?? errorMessage(e);
    log(`${label}: claude failed: ${message}`);
    log(`${label}: last stdout from claude:\n${tail.text()}`);
    throw new Error(`${message} (see Output → "PR Open" for claude's output)`);
  }
  framer.end();

  if (errored) {
    log(`${label}: claude reported an error: ${errored}`);
    throw new Error(errored);
  }
  if (accepted() === 0) {
    // Fallback: the model emitted one JSON array instead of newline-delimited objects.
    for (const obj of parseArray(framer.text())) {
      onObject(obj);
    }
  }
  if (accepted() === 0) {
    log(`${label}: nothing usable was parsed. Raw stdout tail:\n${tail.text()}`);
    throw new Error(`${emptyMessage} (see Output → "PR Open").`);
  }
}
