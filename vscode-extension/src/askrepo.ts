import * as vscode from 'vscode';
import { AskRepo } from './ask';
import { cloneDirFor, uriParts } from './askanchor';
import { getPrMetaForCheckout, repoIdFor } from './handoff';
import { readHead, resolvePrBase } from './git';
import { log } from './logger';
import { isGitRepo } from './resolver';
import { workspaceDirs } from './workspace';
import { errorMessage, samePath } from './util';

/** How the guided review hands its already-resolved tree to the ask surfaces. */
export interface AskRepoSink {
  seed(repo: AskRepo): void;
  unseed(dir: string): void;
}

/** Long enough that opening files in a review costs no `gh` calls, short enough that checking out a
 *  PR branch makes asking possible on its own. Applies to misses too. */
const TTL_MS = 60_000;

interface Entry {
  repo?: AskRepo;
  at: number;
}

/**
 * Resolves which PR a document belongs to.
 *
 * The guided review seeds this the moment it resolves a tree, so its diff editors need no discovery
 * at all. Everything else is discovered from the checked-out branch, so asking works with no
 * walkthrough running. Resolution is memoized per clone, misses included, because selection
 * tracking asks again on every cursor move.
 */
export class AskRepoRegistry implements AskRepoSink {
  private readonly entries = new Map<string, Entry>();
  private readonly seeded = new Map<string, AskRepo>();
  private readonly inflight = new Map<string, Promise<AskRepo | undefined>>();

  /** Fires when what was resolved against a clone stops holding — its HEAD moved, or a review found
   *  no PR to resolve for it — since anchors taken against that tree are stale either way. */
  private readonly headMoved = new vscode.EventEmitter<string>();
  readonly onDidMoveHead = this.headMoved.event;

  seed(repo: AskRepo): void {
    const previous = this.seeded.get(repo.cloneDir);
    this.seeded.set(repo.cloneDir, repo);
    this.entries.set(repo.cloneDir, { repo, at: Date.now() });
    if (previous && previous.headOid !== repo.headOid) {
      this.headMoved.fire(repo.cloneDir);
    }
  }

  /**
   * Whether `dir`'s HEAD has moved since whatever was resolved against it, forgetting that answer
   * when it has.
   *
   * Called before a question is asked rather than on a timer, because that is the one path where a
   * stale tree turns into a confident wrong answer: the model is told the files on disk are the
   * PR's "after" state and has no way to check. Reads refs only, so it costs a few milliseconds.
   */
  async hasMoved(dir: string): Promise<boolean> {
    const known = lookup(this.seeded, dir) ?? lookup(this.entries, dir)?.repo;
    if (!known) {
      return false;
    }
    const head = await readHead(dir).catch(() => undefined);
    if (!head || head.oid === known.headOid) {
      return false;
    }
    log(`ask: ${dir} moved to ${head.oid.slice(0, 8)}; dropping what was resolved against it`);
    this.unseed(dir);
    return true;
  }

  /** Forget everything resolved against `dir` and tell subscribers their anchors no longer hold.
   *  Public because pr-open moves a tree itself when the reviewer pulls a PR. */
  unseed(dir: string): void {
    drop(this.seeded, dir);
    drop(this.entries, dir);
    this.headMoved.fire(dir);
  }

  dispose(): void {
    this.headMoved.dispose();
  }

  /** The PR a document belongs to, or undefined when it is not part of one we can describe. */
  async for(uri: vscode.Uri): Promise<AskRepo | undefined> {
    const dir = cloneDirFor(uriParts(uri), this.knownDirs());
    return dir ? this.forDir(dir) : undefined;
  }

  /** The PR a checkout is on, for a question that names no document: the panel's compose box. */
  async forDir(dir: string): Promise<AskRepo | undefined> {
    const seeded = lookup(this.seeded, dir);
    if (seeded) {
      return seeded;
    }
    // Both maps are read by path, not by string: a `pr-open-base:` fragment carries the dir verbatim and
    // can differ from the key in case alone, which would otherwise miss and re-run discovery.
    const cached = lookup(this.entries, dir);
    if (cached && Date.now() - cached.at < TTL_MS) {
      return cached.repo;
    }
    // Collapse the burst a freshly-opened diff produces — both panes, plus a cursor move in each —
    // into one discovery.
    let pending = this.inflight.get(dir);
    if (!pending) {
      pending = this.discover(dir).finally(() => this.inflight.delete(dir));
      this.inflight.set(dir, pending);
    }
    return pending;
  }

  private async discover(dir: string): Promise<AskRepo | undefined> {
    const repo = await this.resolve(dir);
    this.entries.set(dir, { repo, at: Date.now() });
    return repo;
  }

  private async resolve(dir: string): Promise<AskRepo | undefined> {
    if (!isGitRepo(dir)) {
      return undefined;
    }
    try {
      // The two reads that can end this, before the two that only a resolvable PR needs.
      const [meta, id] = await Promise.all([getPrMetaForCheckout(dir), repoIdFor(dir)]);
      if (!meta) {
        return undefined;
      }
      if (!id) {
        // No owner, so nothing here could query the PR's review threads or name the repo to the
        // model. `origin` is either unreadable or points somewhere other than GitHub.
        log(`ask: ${dir} has no readable GitHub origin, so its PR cannot be described`);
        return undefined;
      }
      const [base, head] = await Promise.all([
        resolvePrBase(dir, meta.baseRefOid, meta.baseRefName),
        readHead(dir),
      ]);
      if (!base) {
        // Fetching here would mean network I/O on every cursor move. Starting a guided review
        // fetches and seeds, which is what makes asking possible.
        log(`ask: no local merge base for PR #${meta.number} in ${dir}; start a review to fetch it`);
        return undefined;
      }
      return {
        ...id,
        cloneDir: dir,
        number: meta.number,
        base,
        headOid: head.oid,
        title: meta.title,
        body: meta.body,
      };
    } catch (e) {
      log(`ask: could not resolve a PR for ${dir}: ${errorMessage(e)}`);
      return undefined;
    }
  }

  private knownDirs(): string[] {
    return [...new Set([...this.seeded.keys(), ...workspaceDirs()])];
  }
}

/** Map lookup by path rather than by string, since a `pr-open-base:` fragment carries the dir verbatim
 *  and may differ from the key in case alone. */
function lookup<V>(map: ReadonlyMap<string, V>, dir: string): V | undefined {
  for (const [key, value] of map) {
    if (samePath(key, dir)) {
      return value;
    }
  }
  return undefined;
}

function drop<V>(map: Map<string, V>, dir: string): void {
  for (const key of [...map.keys()]) {
    if (samePath(key, dir)) {
      map.delete(key);
    }
  }
}
