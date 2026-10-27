import { AskAnchor } from './askanchor';
import { AskTurn } from './askpayload';
import { AskEvent, parseAskStream, rawTail } from './askstream';

interface ResumeState {
  session: string;
  /** The anchor the resumable session has already seen. */
  sent?: AskAnchor;
}

/** The transcript pr-open can safely resume. A failed in-flight turn clears `resume` as one value,
 * so no anchor can survive after its Claude session has been discarded. */
export class AskConversationState {
  private resume?: ResumeState;
  private readonly completed: { question: string; answer: string }[] = [];

  get session(): string | undefined {
    return this.resume?.session;
  }

  get sent(): AskAnchor | undefined {
    return this.resume?.sent;
  }

  get history(): readonly { question: string; answer: string }[] {
    return this.completed;
  }

  complete(turn: AskTurn, answer: string, session: string | undefined): void {
    this.completed.push({ question: turn.question, answer });
    this.resume = session ? { session, sent: turn.aim?.anchor } : undefined;
  }

  fail(): void {
    this.resume = undefined;
  }
}

export interface AskProcessOutput {
  session?: string;
  deltas: string;
  final?: string;
  errored?: string;
  denials: string[];
  tail: string;
}

export type AskProcessResult =
  { ok: true; output: AskProcessOutput } | { ok: false; output: AskProcessOutput; error: unknown };

/** Capture one subprocess stream locally, then fence its callbacks when the subprocess settles. */
export async function runAskProcess(
  resumedSession: string | undefined,
  run: (onStdout: (data: string) => void) => Promise<void>,
  onProgress: (event: AskEvent) => void,
): Promise<AskProcessResult> {
  let session = resumedSession;
  let deltas = '';
  let final: string | undefined;
  let errored: string | undefined;
  let denials: string[] = [];
  const tail = rawTail();
  let accepting = true;
  const parser = parseAskStream((event) => {
    if (!accepting) {
      return;
    }
    switch (event.kind) {
      case 'session':
        session = event.id;
        break;
      case 'delta':
        deltas += event.text;
        onProgress(event);
        break;
      case 'tool':
        onProgress(event);
        break;
      case 'error':
        errored = event.message;
        break;
      case 'done':
        final = event.text;
        denials = event.denials;
        break;
    }
  });
  const output = (): AskProcessOutput => ({
    session,
    deltas,
    final,
    errored,
    denials,
    tail: tail.text(),
  });

  try {
    await run((data) => {
      if (!accepting) {
        return;
      }
      tail.append(data);
      parser.feed(data);
    });
    parser.end();
    return { ok: true, output: output() };
  } catch (error) {
    parser.end();
    return { ok: false, output: output(), error };
  } finally {
    accepting = false;
  }
}
