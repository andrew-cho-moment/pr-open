import { AsyncLocalStorage } from 'async_hooks';
import { readConfig } from './config';
import { log } from './logger';

/**
 * Where a click's time went, logged as one line per user action.
 *
 * The total is always logged. The phase breakdown is opt-in, because carrying phases means
 * `AsyncLocalStorage`, and the first `run()` turns on async context tracking for the whole extension
 * host, permanently, for every extension sharing it. That is a real cost to impose by default on a
 * change whose subject is latency, and a total per click already answers "is this fast now".
 *
 * When it is on, phases ride in async context rather than being threaded through every signature: the
 * path runs `openPr` -> `revealAt` -> `fireAction` -> `waitForPrExtReady`, and passing a recorder down
 * all of it would put the instrumentation in the shape of the code. `phase()` with no span in scope is
 * a no-op, which is also how warm-up and prefetch call the same functions untraced.
 */
interface Span {
  label: string;
  start: number;
  /** Phase boundaries in call order; each entry's duration runs to the next one (or to the end). */
  marks: { name: string; at: number }[];
}

const current = new AsyncLocalStorage<Span>();

/**
 * Read per call rather than cached: toggling the setting should take effect on the next click. Read
 * through `readConfig`, so the value is type-checked where every other setting is; an unreadable
 * config has already been reported to the user by `validateConfig`, and measuring is not worth failing
 * the action over.
 */
function phasesWanted(): boolean {
  try {
    return readConfig().logTimings === true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` as one traced user action. The line lands whether `fn` resolves or throws, since a click
 * that failed slowly is exactly the one worth measuring.
 */
export async function traced<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const span: Span = { label, start: now(), marks: [] };
  try {
    return await (phasesWanted() ? current.run(span, fn) : fn());
  } finally {
    log(format(span));
  }
}

/**
 * Attribute the time from here to the next `phase()` (or to the end of the action) to `name`.
 *
 * A phase inside a memoized promise is attributed to whichever action created it, not to the one
 * awaiting it, so a second click that shares `waitForPrExtReady`'s wait shows it as a phase of the
 * first. That is the honest reading: the second click did not pay for it.
 */
export function phase(name: string): void {
  current.getStore()?.marks.push({ name, at: now() });
}

function format(span: Span): string {
  const end = now();
  const parts = span.marks.map(
    (mark, i) => `${mark.name} ${ms((span.marks[i + 1]?.at ?? end) - mark.at)}ms`,
  );
  const breakdown = parts.length ? ` (${parts.join(', ')})` : '';
  return `${span.label}: ${ms(end - span.start)}ms${breakdown}`;
}

const now = () => performance.now();
const ms = (value: number) => Math.round(value);
