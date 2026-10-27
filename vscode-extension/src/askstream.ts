import { parseObjectLine } from './reviewparse';

/** One thing observed on `claude --output-format stream-json` stdout. Unknown event types drop. */
export type AskEvent =
  | { kind: 'session'; id: string }
  | { kind: 'delta'; text: string }
  /** A tool call starting, e.g. `Read src/foo.ts`, for a progress line while no answer text exists. */
  | { kind: 'tool'; label: string }
  /** One assistant message, complete: authoritative over the deltas that built it, and a boundary
   *  the text either side of it never runs together across. */
  | { kind: 'message'; text: string }
  | { kind: 'error'; message: string }
  /** The final assistant text, authoritative over the accumulated deltas. */
  | { kind: 'done'; text: string; denials: string[] };

export interface AskStreamParser {
  feed(data: string): void;
  /** Flush a trailing line with no newline after it. */
  end(): void;
}

/**
 * Parse claude's stream-json stdout into typed events, emitting each as its line completes. A single
 * stdout write may split a JSON object, so partial lines are buffered.
 */
export function parseAskStream(onEvent: (e: AskEvent) => void): AskStreamParser {
  let buf = '';

  const handle = (line: string) => {
    const s = line.trim();
    if (!s) {
      return;
    }
    let ev: StreamEvent;
    try {
      ev = JSON.parse(s) as StreamEvent;
    } catch {
      return; // non-JSON noise on the stream
    }
    // The session id arrives on `system`/init before any text, and again on `result`. Take the
    // latest of those two, so nothing desyncs if a turn ever forks. Every other event type echoes
    // the id too; ignoring them keeps the event stream to things a surface acts on.
    const carriesSession = (ev.type === 'system' && ev.subtype === 'init') || ev.type === 'result';
    if (typeof ev.session_id === 'string' && carriesSession) {
      onEvent({ kind: 'session', id: ev.session_id });
    }
    if (ev.type === 'stream_event') {
      const delta = ev.event?.delta;
      if (ev.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        onEvent({ kind: 'delta', text: delta.text });
      }
      return;
    }
    if (ev.type === 'assistant') {
      // Tool calls are complete here, unlike in the partial `content_block_start` events.
      const blocks = ev.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.name) {
          onEvent({ kind: 'tool', label: toolLabel(block.name, block.input) });
        }
      }
      const text = blocks.map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
      onEvent({ kind: 'message', text });
      return;
    }
    if (ev.type === 'result') {
      if (ev.is_error) {
        // An errored result carries no `result` field: the reason is in `errors`.
        onEvent({ kind: 'error', message: ev.errors?.[0] ?? ev.result ?? 'Claude reported an error.' });
      } else {
        onEvent({ kind: 'done', text: ev.result ?? '', denials: (ev.permission_denials ?? []).map(denialLabel) });
      }
    }
  };

  return {
    feed(data: string): void {
      buf += data;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    },
    end(): void {
      handle(buf);
      buf = '';
    },
  };
}

/** Splits the model's own newline-delimited JSON out of the stream claude wraps it in. */
export interface JsonlFramer {
  feed(e: AskEvent): void;
  /** No more events: a trailing line no message ever closed is still a line. */
  end(): void;
  /** Everything the model said, for a caller that has to re-read the whole answer. */
  text(): string;
}

/**
 * Frame the model's JSONL out of the events above, calling `onObject` as each line completes.
 *
 * A message boundary ends a line: a run that calls tools writes its answer over several messages,
 * and a model that ends one on `{"thread":"T1",…}` with no newline after it would otherwise have
 * that glued onto the next message's first line, losing both objects.
 */
export function jsonlFramer(onObject: (obj: unknown) => void): JsonlFramer {
  // Only the tail being scanned for a newline is held as a string: appending to one long `text` and
  // then calling indexOf on it flattens the whole accumulation per delta, which is quadratic in an
  // answer's length. `messages` keeps each finished message, where joining once is cheap.
  const messages: string[] = [];
  let pending = ''; // the current message's text after its last complete line
  let seen = 0; // how much of it arrived as deltas, which says whether the message itself held more
  let consumed = 0; // how much of it has already been split into lines

  const drain = (final: boolean) => {
    let nl = pending.indexOf('\n');
    while (nl >= 0) {
      onObject(parseObjectLine(pending.slice(0, nl)));
      consumed += nl + 1;
      pending = pending.slice(nl + 1);
      nl = pending.indexOf('\n');
    }
    if (final && pending) {
      onObject(parseObjectLine(pending));
      consumed += pending.length;
      pending = '';
    }
  };

  /** One assistant message is over, so whatever is left of it is a complete line. Its text is also
   *  authoritative over the deltas that built it, so anything they missed is drained here. */
  const endMessage = (text: string) => {
    if (text.length > seen) {
      pending = text.slice(consumed);
    }
    drain(true);
    messages.push(text);
    seen = 0;
    consumed = 0;
  };

  return {
    feed(e: AskEvent): void {
      switch (e.kind) {
        case 'delta':
          seen += e.text.length;
          pending += e.text;
          drain(false);
          break;
        case 'message':
          endMessage(e.text);
          break;
        case 'done':
          // `result` repeats the last assistant message, which that message's own event already
          // framed. It is the whole answer only when no assistant message reached us at all.
          if (!messages.some((m) => m.trim())) {
            endMessage(e.text);
          }
          break;
      }
    },
    end(): void {
      drain(true);
    },
    text(): string {
      return messages.join('\n');
    },
  };
}

/** Whether a failure means the resumed session is gone, so the caller should retry from scratch. */
export function isSessionGone(message: string): boolean {
  return /No conversation found with session ID/i.test(message);
}

/** How much raw stdout to keep for diagnosing a failure claude reported on its stream, not stderr. */
const RAW_TAIL_LIMIT = 16_000;

/** The tail of a claude subprocess's stdout, which is where it reports a failure that never reaches
 *  stderr. Bounded, since the stream runs to megabytes and only its end says why. */
export interface RawTail {
  append(data: string): void;
  /** The tail, or `(none)` when the subprocess wrote nothing — both callers log it either way. */
  text(): string;
}

export function rawTail(): RawTail {
  let tail = '';
  return {
    append(data: string): void {
      tail = (tail + data).slice(-RAW_TAIL_LIMIT);
    },
    text(): string {
      return tail || '(none)';
    },
  };
}

/** Human label for a tool call, for the progress line under a streaming answer. */
export function toolLabel(name: string, input: unknown): string {
  const arg = input as Record<string, unknown> | undefined;
  const str = (key: string) => (typeof arg?.[key] === 'string' ? (arg[key] as string) : undefined);
  const target = str('file_path') ?? str('pattern') ?? str('path') ?? str('query');
  return target ? `${name} ${basename(target)}` : name;
}

function denialLabel(d: PermissionDenial): string {
  return typeof d === 'string' ? d : (d.tool_name ?? JSON.stringify(d));
}

function basename(p: string): string {
  return p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
}

type PermissionDenial = string | { tool_name?: string };

interface StreamEvent {
  type: string;
  /** `system` events are many; only `init` carries the session id authoritatively. */
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  permission_denials?: PermissionDenial[];
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: {
    content?: {
      type?: string;
      name?: string;
      text?: string;
      input?: unknown;
    }[];
  };
}
