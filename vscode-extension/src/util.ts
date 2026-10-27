import * as path from 'path';

/** The message of an unknown thrown value. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Whether two paths name the same file, ignoring case as macOS and Windows do. */
export function samePath(a: string | undefined, b: string): boolean {
  return !!a && canonical(a) === canonical(b);
}

/** Whether `p` is `dir` itself or sits inside it. Compares path segments, so `/dev/foo` does not
 *  swallow `/dev/foobar`, and folds case as macOS and Windows do. */
export function isUnder(dir: string, p: string): boolean {
  const rel = path.relative(canonical(dir), canonical(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function canonical(p: string): string {
  return path.resolve(p).toLowerCase();
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A map whose entries expire, for caching against a key set that grows without bound — a directory, a
 * commit, a PR number. Expired entries are dropped on write, so the map stays the size of what is
 * live rather than of everything ever asked about.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; at: number }>();

  constructor(private readonly ttlMs: number) {}

  /** The live value for `key`, or undefined when nothing live is stored. */
  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    return hit && Date.now() - hit.at < this.ttlMs ? hit.value : undefined;
  }

  /** Remove and return the live value for `key`. */
  take(key: string): V | undefined {
    const value = this.get(key);
    this.entries.delete(key);
    return value;
  }

  set(key: string, value: V): void {
    const now = Date.now();
    for (const [k, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) {
        this.entries.delete(k);
      }
    }
    this.entries.set(key, { value, at: now });
  }

  clear(): void {
    this.entries.clear();
  }

  /** Entries held, live or not yet swept. */
  get size(): number {
    return this.entries.size;
  }
}
