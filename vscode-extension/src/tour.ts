import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { adoptRepo } from './adopt';
import { Side } from './askanchor';
import { AskRepoSink } from './askrepo';
import { BaseContentProvider } from './basecontent';
import { readConfig } from './config';
import { ChangedFile, changedFiles, fetchBranch, mergeBase, readHead, resolvePrBase, reviewDiff } from './git';
import { checkoutPr, getPrMeta, PrMeta, repoIdFor, requireClone } from './handoff';
import { log } from './logger';
import { userAction } from './prefetch';
import { Chunk, generateWalkthroughBatches, summarizeContext } from './review';
import { prepareReview } from './reviewbatch';
import { cleanContextSummary } from './reviewparse';
import { delay, errorMessage } from './util';

/** Messages the controller pushes to the panel. Steps stream in one `tourStep` at a time; the
 * first step's `tourState` arrives as soon as it parses, and `tourStreamDone` marks the final total. */
export type TourMessage =
  | { type: 'tourStarted'; repo: string; number: number }
  | { type: 'tourContext'; text: string }
  | { type: 'tourStep'; index: number; title: string; status: FileStatus }
  | {
      type: 'tourState';
      step: number;
      title: string;
      explanation: string;
      status: FileStatus;
      locations: { file: string; startLine: number; endLine: number }[];
    }
  | { type: 'tourStreamDone' }
  | { type: 'tourProgress'; message: string }
  | { type: 'tourError'; message: string; partial: boolean }
  | { type: 'tourEnded' };

type FileStatus = ChangedFile['status'] | 'binary';

export interface TourView {
  postTour(msg: TourMessage): void;
}

interface ActiveTour {
  repo: string;
  cloneDir: string;
  number: number;
  base: string;
  headOid: string;
  chunks: Chunk[];
  byPath: Map<string, ChangedFile>;
  index: number;
}

/** Options for {@link TourController.start}. */
interface StartOptions {
  /** Pin the working tree (e.g. a worktree checkout); omit to resolve it from `repo`. */
  dir?: string;
  /** Rehydrate a saved session: jump to this step once chunks load, and fail silently rather
   * than prompting, since a restore runs unprompted when the panel reopens. */
  restoreIndex?: number;
}

/** The saved-session descriptor, stored in `workspaceState` so a reopened panel restores the
 * review from the per-HEAD chunk cache instead of re-running Claude. Per-window: it points at a
 * clone checked out in this window. */
interface SavedTour {
  repo: string;
  number: number;
  dir?: string;
  index: number;
}

interface CachedReview {
  chunks: Chunk[];
}

const SAVED_KEY = 'prOpen.activeTour';

const DECORATION = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  isWholeLine: true,
});

/** Owns guided-review state: resolves the PR, calls Claude, and drives the diff editors. */
export class TourController {
  private tour?: ActiveTour;
  private generation?: AbortController;

  /** Fires when a review becomes active or is torn down, so the ask surfaces can reset. One event
   *  covers every entry point, including the not-checked-out bail, which per-call-site wiring would miss. */
  private readonly reviewChanged = new vscode.EventEmitter<{ active: boolean }>();
  readonly onDidChangeReview = this.reviewChanged.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly view: TourView,
    private readonly base: BaseContentProvider,
    /** Handed the resolved tree so line-anchored questions need no discovery of their own. */
    private readonly askRepos: AskRepoSink,
  ) {}

  dispose(): void {
    this.generation?.abort();
    this.generation = undefined;
    this.reviewChanged.dispose();
  }

  async start(repo: string, number: number, opts: StartOptions = {}): Promise<void> {
    this.generation?.abort();
    const generation = new AbortController();
    this.generation = generation;
    const replaced = this.clearTour();
    if (replaced) {
      this.view.postTour({ type: 'tourEnded' });
    }
    try {
      await this.startInner(repo, number, opts, generation.signal);
    } catch (e) {
      if (this.generation !== generation) {
        return;
      }
      if (opts.restoreIndex !== undefined) {
        // A restore runs unprompted when the panel reopens; fail quietly and forget the session.
        log(`tour: restore failed, clearing saved session: ${errorMessage(e)}`);
        this.clearTour();
        this.view.postTour({ type: 'tourEnded' });
      } else {
        const partial = (this.tour?.chunks.length ?? 0) > 0;
        this.report(e, partial);
      }
    }
  }

  /** Rehydrate a saved review after the panel is recreated (e.g. a window reload). No-op when
   * nothing is saved or a tour is already live (the panel kept its state while merely hidden). */
  restore(): void {
    if (this.tour) {
      return;
    }
    const saved = this.context.workspaceState.get<SavedTour>(SAVED_KEY);
    if (saved) {
      void this.start(saved.repo, saved.number, {
        dir: saved.dir,
        restoreIndex: saved.index,
      });
    }
  }

  next(): void {
    this.goto((this.tour?.index ?? 0) + 1);
  }
  prev(): void {
    this.goto((this.tour?.index ?? 0) - 1);
  }
  goto(index: number): void {
    void this.show(index).catch((e) => this.report(e));
  }

  private report(e: unknown, partial = false): void {
    this.view.postTour({ type: 'tourError', message: errorMessage(e), partial });
  }

  end(): void {
    this.generation?.abort();
    this.generation = undefined;
    this.clearTour();
    this.view.postTour({ type: 'tourEnded' });
  }

  /** Drop the active review state. Returns whether a review was present, so replacement can avoid
   * posting an extra end event while the panel is already idle. */
  private clearTour(): boolean {
    const active = this.tour !== undefined;
    this.tour = undefined;
    this.base.clear();
    this.clearSaved();
    if (active) {
      this.reviewChanged.fire({ active: false });
    }
    return active;
  }

  /** Persist the current step so a reopened panel lands back here without re-running Claude. */
  private save(): void {
    const t = this.tour;
    if (!t) {
      return;
    }
    const saved: SavedTour = {
      repo: t.repo,
      number: t.number,
      dir: t.cloneDir,
      index: t.index,
    };
    void this.context.workspaceState.update(SAVED_KEY, saved);
  }

  private clearSaved(): void {
    void this.context.workspaceState.update(SAVED_KEY, undefined);
  }

  /** Open a chunk's file (real, on-disk) at a line so go-to-def works. Used for jump links.
   *  `side` is 'base' when the lines were read from the diff's left pane, which is where they must
   *  be highlighted — the same numbers mean different code on the right. */
  async openLocation(file: string, startLine: number, endLine: number, side: Side = 'head'): Promise<void> {
    if (!this.tour) {
      return;
    }
    const cf = this.tour.byPath.get(file);
    const status: FileStatus = cf ? (cf.binary ? 'binary' : cf.status) : 'M';
    try {
      await this.openDiff(this.tour, cf, { file, startLine, endLine }, status, side);
    } catch (e) {
      this.report(e);
    }
  }

  private async startInner(repo: string, number: number, opts: StartOptions, signal: AbortSignal): Promise<void> {
    const { dir, restoreIndex } = opts;
    const restoring = restoreIndex !== undefined;
    // Use the caller's working tree when given (a worktree may hold the PR branch); otherwise
    // resolve the repo's main clone.
    const cloneDir = dir ?? requireClone(repo).dir;

    // Consider the PR checked out if we're on its branch, or HEAD is exactly its head commit.
    // (A local branch slightly behind the remote head is still the right tree to review.)
    // The PR metadata and the local checkout are independent, so fetch them together.
    const [meta, head] = await Promise.all([getPrMeta(cloneDir, number), readHead(cloneDir)]);
    signal.throwIfAborted();
    if (head.branch !== meta.headRefName && head.oid !== meta.headRefOid) {
      if (restoring) {
        // The branch moved on since the saved session; drop it rather than nag on every reopen.
        this.clearSaved();
        this.view.postTour({ type: 'tourEnded' });
        return;
      }
      const pick = await vscode.window.showWarningMessage(
        `PR #${number}'s branch is not checked out, so the review would show other code. Check out the PR first?`,
        { modal: true },
        'Check out',
      );
      signal.throwIfAborted();
      if (pick === 'Check out') {
        await userAction(`checkout ${repo}#${number}`, () =>
          checkoutPr(this.context, { repo, number }),
        );
        signal.throwIfAborted();
      }
      this.view.postTour({ type: 'tourEnded' });
      return;
    }

    // The review's diffs carry no `+` of their own: leaving a comment on one is the GitHub PR
    // extension's gutter, and it renders nothing for a repo it is ignoring. Runs in the background,
    // since generating the walkthrough takes longer than the re-open and no step's gutter is read
    // before then. Folder edits ask this too (`workspace.ts`); asking again here is what recovers a
    // window that was already in that state when the review started.
    adoptRepo(cloneDir);

    const base = await this.resolveBase(cloneDir, meta);
    signal.throwIfAborted();
    const files = await changedFiles(cloneDir, base);
    signal.throwIfAborted();
    const byPath = new Map(files.map((f) => [f.path, f]));

    // Set the tour shell up before generating so streamed chunks render as they parse. Held in a
    // local as well, and carried through generation: every later step is about *this* review, so a
    // second `start` overwriting the field cannot make the first one's chunks land in the second's.
    const tour: ActiveTour = {
      repo,
      cloneDir,
      number,
      base,
      headOid: head.oid,
      chunks: [],
      byPath,
      index: 0,
    };
    this.tour = tour;
    this.view.postTour({ type: 'tourStarted', repo, number });
    // Hand the resolved tree over before any diff opens, so asking works on step 1 with no `gh`
    // round-trip of its own. `active: true` also clears questions from a previous review. Skipped
    // with no GitHub owner, which asking cannot resolve a PR without either; the walkthrough reads
    // only the local tree, so that is no reason to refuse the review.
    const id = await repoIdFor(cloneDir);
    signal.throwIfAborted(); // End Review during this read would otherwise seed the tree it tore down
    if (id) {
      this.askRepos.seed({
        ...id,
        cloneDir,
        number,
        base,
        headOid: head.oid,
        title: meta.title,
        body: meta.body,
      });
    } else {
      // Cleared, not merely skipped: what a previous review of this same tree seeded would otherwise
      // answer questions about *its* PR while the reviewer walks through this one. `askrepo.ts` logs
      // the unreadable origin when a question is actually asked.
      this.askRepos.unseed(cloneDir);
    }
    this.reviewChanged.fire({ active: true });

    const cfg = readConfig();
    const model = cfg.reviewModel;
    if (cfg.includeBusinessContext) {
      void this.loadContext(tour, meta, model, signal);
    }
    await this.loadChunks(tour, model, signal);
    if (this.tour !== tour) {
      return; // ended, or superseded by a later review, while this one was generating
    }
    this.view.postTour({ type: 'tourStreamDone' });

    // Restoring replays cached chunks synchronously; land back on the saved step.
    if (restoring && restoreIndex < tour.chunks.length) {
      await this.show(restoreIndex);
    }
  }

  /** Generate and cache context independently so a failure or slow response never gates the review. */
  private async loadContext(
    tour: ActiveTour,
    meta: PrMeta,
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const sourceHash = createHash('sha256').update(meta.title).update('\0').update(meta.body).digest('hex');
    // `reviewContext3` holds the summary as the model wrote it; the `2` ones were clamped to two
    // sentences, which cut them off at their first abbreviation.
    const key = `prOpen.reviewContext3:${tour.cloneDir}|${tour.number}|${sourceHash}|${model ?? ''}`;
    try {
      let summary = this.context.globalState.get<string>(key);
      if (summary === undefined) {
        const promptPath = path.join(this.context.extensionUri.fsPath, 'prompt-context.md');
        summary = await summarizeContext(meta.title, meta.body, promptPath, model, signal);
        signal.throwIfAborted();
        await this.context.globalState.update(key, summary);
      }
      const text = cleanContextSummary(summary);
      if (text && this.tour === tour) {
        this.view.postTour({ type: 'tourContext', text });
      }
    } catch (e) {
      if (signal.aborted) {
        return;
      }
      log(`context: summary unavailable: ${errorMessage(e)}`);
    }
  }

  /**
   * Append one generated chunk to the review it was generated for: clamp its ranges, push it, tell
   * the panel, and open step 0 at once.
   *
   * `tour` is the review that started this generation, not whatever is current. A review that has
   * since ended or been superseded still has a `claude` subprocess streaming into this, and its
   * chunks describe the old PR's files at the old PR's line numbers.
   */
  private addChunk(tour: ActiveTour, chunk: Chunk): void {
    if (this.tour !== tour) {
      return;
    }
    // Clamp model-supplied ranges to a floor of 1 so reveal never underflows.
    for (const loc of chunk.locations) {
      loc.startLine = Math.max(1, loc.startLine);
      loc.endLine = Math.max(loc.startLine, loc.endLine);
    }
    const index = tour.chunks.length;
    tour.chunks.push(chunk);
    this.view.postTour({ type: 'tourStep', index, title: chunk.title, status: statusFor(tour.byPath, chunk) });
    if (index === 0) {
      this.goto(0);
    }
  }

  /** Merge base of the PR, falling back to the remote base branch, fetching it if absent. */
  private async resolveBase(dir: string, meta: PrMeta): Promise<string> {
    let base = await resolvePrBase(dir, meta.baseRefOid, meta.baseRefName);
    if (!base) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Fetching ${meta.baseRefName}...` },
        () => fetchBranch(dir, meta.baseRefName),
      );
      base = await mergeBase(dir, `origin/${meta.baseRefName}`);
    }
    if (!base) {
      throw new Error(`Could not determine the base commit for PR #${meta.number}.`);
    }
    return base;
  }

  private async loadChunks(tour: ActiveTour, model: string | undefined, signal: AbortSignal): Promise<void> {
    const { cloneDir: dir, number, base, headOid: head } = tour;
    // Key on the local HEAD, since that (not the remote PR head) is the tree being diffed.
    // `review3` excludes generated artifacts from the reviewed diff; older chunks did not.
    const key = `prOpen.review3:${dir}|${number}|${head}|${model ?? ''}`;
    const cached = this.context.globalState.get<CachedReview>(key);
    if (cached) {
      for (const c of cached.chunks) {
        signal.throwIfAborted();
        this.addChunk(tour, c);
      }
      return;
    }
    const completed = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Analyzing PR #${number} with Claude...`, cancellable: false },
      async () => {
        this.view.postTour({ type: 'tourProgress', message: 'Classifying the diff...' });
        const prepared = prepareReview(await reviewDiff(dir, base, [...tour.byPath.values()]));
        signal.throwIfAborted();
        const s = prepared.scope;
        log(
          `review: raw ${s.rawBytes} bytes; reviewable ${s.reviewableBytes} bytes across ${s.reviewedFiles} files; ` +
          `manifest ${s.manifestBytes} bytes for ${s.omittedFiles} derived files; ${s.batches} batches`,
        );
        this.view.postTour({
          type: 'tourProgress',
          message: s.batches === 0 ? 'No reviewable source changes.' : 'Analyzing the reviewable diff with Claude...',
        });
        const promptPath = path.join(this.context.extensionUri.fsPath, 'prompt-review.md');
        const chunks = await generateWalkthroughBatches(
          prepared.batches,
          promptPath,
          model,
          (chunk) => this.addChunk(tour, chunk),
          signal,
        );
        return { chunks };
      },
    );
    signal.throwIfAborted();
    await this.context.globalState.update(key, completed);
  }

  private async show(index: number): Promise<void> {
    const tour = this.tour;
    if (!tour || index < 0 || index >= tour.chunks.length) {
      return;
    }
    tour.index = index;
    this.save();
    const chunk = tour.chunks[index];
    const loc = chunk.locations[0];
    const cf = tour.byPath.get(loc.file);
    const status = statusFor(tour.byPath, chunk);

    this.view.postTour({
      type: 'tourState',
      step: index,
      title: chunk.title,
      explanation: chunk.explanation,
      status,
      locations: chunk.locations.map((l) => ({ file: l.file, startLine: l.startLine, endLine: l.endLine })),
    });

    await this.openDiff(tour, cf, loc, status);
  }

  private async openDiff(
    tour: ActiveTour,
    cf: ChangedFile | undefined,
    loc: { file: string; startLine: number; endLine: number },
    status: FileStatus,
    side: Side = 'head',
  ): Promise<void> {
    if (status === 'binary') {
      return; // nothing sensible to diff; the panel note explains it
    }

    const leftPath = cf?.oldPath ?? loc.file;
    const left = BaseContentProvider.uriFor(tour.cloneDir, tour.base, leftPath);
    const right =
      status === 'D'
        ? BaseContentProvider.uriFor(tour.cloneDir, tour.headOid, loc.file) // gone at HEAD => empty
        : vscode.Uri.file(path.join(tour.cloneDir, loc.file));

    const title = `${loc.file} (${tour.index + 1}/${tour.chunks.length})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });

    // Deleted files carry their changed lines (old numbering) on the base/left side, as does any
    // range the caller read from the left pane; everything else is anchored in the right pane.
    const anchor = status === 'D' || side === 'base' ? left : right;
    const editor = await findDiffEditor(anchor);
    if (editor) {
      reveal(editor, loc.startLine, loc.endLine);
      editor.setDecorations(DECORATION, [lineRange(editor, loc.startLine, loc.endLine)]);
    }
  }
}

/** The visible editor for `uri`, waiting briefly since `vscode.diff` can resolve before the
 * editor is listed. Undefined if it never appears. */
async function findDiffEditor(uri: vscode.Uri): Promise<vscode.TextEditor | undefined> {
  const target = uri.toString();
  for (let i = 0; i < 20; i++) {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === target);
    if (editor) {
      return editor;
    }
    await delay(25);
  }
  return undefined;
}

/** Status of a chunk's primary file, or 'M' when the model referenced an unknown path. */
function statusFor(byPath: Map<string, ChangedFile>, chunk: Chunk): FileStatus {
  const cf = byPath.get(chunk.locations[0].file);
  if (!cf) {
    return 'M';
  }
  return cf.binary ? 'binary' : cf.status;
}

/** Reveal + select a 1-based line range, clamped to the document. */
function reveal(editor: vscode.TextEditor, startLine: number, endLine: number): void {
  const range = lineRange(editor, startLine, endLine);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(range.start, range.start);
}

function lineRange(editor: vscode.TextEditor, startLine: number, endLine: number): vscode.Range {
  const last = Math.max(0, editor.document.lineCount - 1);
  const s = Math.min(Math.max(0, startLine - 1), last);
  const e = Math.min(Math.max(s, endLine - 1), last);
  return new vscode.Range(s, 0, e, editor.document.lineAt(e).text.length);
}
