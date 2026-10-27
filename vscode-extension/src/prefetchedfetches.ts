import { TtlCache } from './util';

/** How a caller may use a completed prefetch. */
export enum FetchUse {
  /** Populate the one-shot cache without repeating live or completed work. */
  Prefetch = 'prefetch',
  /** Consume a completed prefetch, or join one still running. */
  ReusePrefetch = 'reuse-prefetch',
  /** Join live work but replace a completed prefetch with a new fetch. */
  Fresh = 'fresh',
}

interface RunningFetch<V> {
  token: symbol;
  promise: Promise<V | undefined>;
  consumeOnCompletion(): void;
}

/** Deduplicate live fetches and make a completed prefetch reusable exactly once. */
export class PrefetchedFetches<V> {
  private readonly completed: TtlCache<V>;
  private readonly running = new Map<string, RunningFetch<V>>();

  constructor(ttlMs: number) {
    this.completed = new TtlCache(ttlMs);
  }

  run(key: string, use: FetchUse, fetch: () => Promise<V | undefined>): Promise<V | undefined> {
    if (use === FetchUse.Prefetch) {
      const completed = this.completed.get(key);
      if (completed !== undefined) {
        return Promise.resolve(completed);
      }
    } else {
      const completed = this.completed.take(key);
      if (use === FetchUse.ReusePrefetch && completed !== undefined) {
        return Promise.resolve(completed);
      }
    }

    const running = this.running.get(key);
    if (running) {
      if (use !== FetchUse.Prefetch) {
        running.consumeOnCompletion();
      }
      return running.promise;
    }

    let cacheOnCompletion = use === FetchUse.Prefetch;
    const token = Symbol();
    const promise = Promise.resolve()
      .then(fetch)
      .then((value) => {
        if (value !== undefined && cacheOnCompletion) {
          this.completed.set(key, value);
        }
        return value;
      })
      .finally(() => {
        if (this.running.get(key)?.token === token) {
          this.running.delete(key);
        }
      });
    const entry: RunningFetch<V> = {
      token,
      promise,
      consumeOnCompletion: () => {
        cacheOnCompletion = false;
      },
    };
    this.running.set(key, entry);
    return promise;
  }

  /** Whether a completed prefetch can satisfy a later consumer. */
  hasCompleted(key: string): boolean {
    return this.completed.get(key) !== undefined;
  }

  clear(): void {
    this.completed.clear();
    for (const fetch of this.running.values()) {
      fetch.consumeOnCompletion();
    }
    this.running.clear();
  }
}
