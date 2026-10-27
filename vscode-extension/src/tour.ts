import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { adoptRepo } from './adopt';
import { Side } from './askanchor';
import { AskRepoSink } from './askrepo';
import { BaseContentProvider } from './basecontent';
import { readConfig } from './config';
import {
  ChangedFile,
  changedFiles,
  checkoutDefaultBranch,
  fetchBranch,
  filesAtHead,
  isDirty, mergeBase, readHead, resolvePrBase, reviewDiff } from './git';
import { checkoutPr, getPrMeta, PrMeta, repoIdFor, requireClone } from './handoff';
import { log } from './logger';
import { userAction } from './prefetch';
import { Chunk, generateRepoTour, generateWalkthroughBatches, summarizeContext } from './review';
import { prepareReview } from './reviewbatch';
import { cleanContextSummary } from './reviewparse';
import { repoTourPayload } from './repotour';
import { delay, errorMessage } from './util';

/** Messages the controller pushes to the panel. Steps stream in one `tourStep` at a time; the
 * first step's `tourState` arrives as soon as it parses, and `tourStreamDone` marks the final total.
 * `status` is the step's primary file's change in a PR review, and absent in a repo tour, where
 * nothing changed. */
export type TourMessage =
  | { type: 'tourStarted'; heading: string }
  | { type: 'tourContext'; text: string }
  | { type: 'tourStep'; index: number; title: string; status?: FileStatus }
  | {
      type: 'tourState';
      step: number;
      title: string;
      explanation: string;
      status?: FileStatus;
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

/** What a guided tour walks through. */
enum TourKind {
  /** A PR's diff against its merge base: each step opens a diff. */
  Pr = 'pr',
  /** The whole repository at HEAD: each step opens the file itself. */
  Repo = 'repo',
}

interface PrSubject {
  kind: TourKind.Pr;
  number: number;
  base: string;
  byPath: Map<string, ChangedFile>;
}

type TourSubject = PrSubject | { kind: TourKind.Repo };

interface ActiveTour {
  repo: string;
  cloneDir: string;
  headOid: string;
  subject: TourSubject;
  chunks: Chunk[];
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
type SavedTour =
  | { kind: TourKind.Pr; repo: string; number: number; dir?: string; index: number }
  | { kind: TourKind.Repo; dir: string; index: number };

interface CachedReview {
  chunks: Chunk[];
}

// `activeTour2` tags each session with its kind; an untagged `activeTour` session is simply dropped.
const SAVED_KEY = 'prOpen.activeTour2';

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

  start(repo: string, number: number, opts: StartOptions = {}): Promise<void> {
    return this.begin(opts.restoreIndex, (signal) => this.startInner(repo, number, opts, signal));
  }

  /** Check out the default branch at `dir` and tour the whole repository at its newest commit. A
   *  restore tours whatever HEAD is, since it runs unprompted and must not move the tree. */
  startRepo(dir: string, restoreIndex?: number): Promise<void> {
    return this.begin(restoreIndex, (signal) => this.startRepoInner(dir, restoreIndex, signal));
  }

  /** Replace whatever tour is running with the one `run` sets up, and report how it ends. */
  private async begin(restoreIndex: number | undefined, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    this.generation?.abort();
    const generation = new AbortController();
    this.generation = generation;
    const replaced = this.clearTour();
    if (replaced) {
      this.view.postTour({ type: 'tourEnded' });
    }
    try {
      await run(generation.signal);
    } catch (e) {
      if (this.generation !== generation) {
        return;
      }
      if (restoreIndex !== undefined) {
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
    switch (saved?.kind) {
      case TourKind.Pr:
        void this.start(saved.repo, saved.number, { dir: saved.dir, restoreIndex: saved.index });
        break;
      case TourKind.Repo:
        void this.startRepo(saved.dir, saved.index);
        break;
    }
  }

  next(): void {
    this.goto((this.tour?.index ?? 0) + 1);
  }
  prev(): void {
    this.goto((this.tour?.index ?? 0) - 1);
  }
  /** A step that fails to open is reported as partial, so the panel keeps the steps it has. */
  goto(index: number): void {
    void this.show(index).catch((e) => this.report(e, true));
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
    const cleared = this.tour;
    this.tour = undefined;
    this.base.clear();
    this.clearSaved();
    // Only a PR review owns the ask transcript; a repo tour starting or ending leaves it alone.
    if (cleared?.subject.kind === TourKind.Pr) {
      this.reviewChanged.fire({ active: false });
    }
    return cleared !== undefined;
  }

  /** Persist the current step so a reopened panel lands back here without re-running Claude. */
  private save(): void {
    const t = this.tour;
    if (!t) {
      return;
    }
    const saved: SavedTour =
      t.subject.kind === TourKind.Pr
        ? { kind: TourKind.Pr, repo: t.repo, number: t.subject.number, dir: t.cloneDir, index: t.index }
        : { kind: TourKind.Repo, dir: t.cloneDir, index: t.index };
    void this.context.workspaceState.update(SAVED_KEY, saved);
  }

  private clearSaved(): void {
    void this.context.workspaceState.update(SAVED_KEY, undefined);
  }

  /** Open a chunk's file (real, on-disk) at a line so go-to-def works. Used for jump links.
   *  `side` is 'base' when the lines were read from the diff's left pane, which is where they must
   *  be highlighted — the same numbers mean different code on the right. */
  async openLocation(file: string, startLine: number, endLine: number, side: Side = 'head'): Promise<void> {
    const tour = this.tour;
    if (!tour) {
      return;
    }
    try {
      if (tour.subject.kind === TourKind.Repo) {
        // Base-side lines come from an ask about a PR diff's left pane: they number code HEAD lacks.
        if (side === 'head') {
          await this.openFile(tour, { file, startLine, endLine });
        }
        return;
      }
      const cf = tour.subject.byPath.get(file);
      const status: FileStatus = cf ? (cf.binary ? 'binary' : cf.status) : 'M';
      await this.openDiff(tour, tour.subject, cf, { file, startLine, endLine }, status, side);
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
    const subject: PrSubject = { kind: TourKind.Pr, number, base, byPath };
    const tour: ActiveTour = {
      repo,
      cloneDir,
      headOid: head.oid,
      subject,
      chunks: [],
      index: 0,
    };
    this.tour = tour;
    this.view.postTour({ type: 'tourStarted', heading: `${repo} [PR #${number}]` });
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
    await this.loadChunks(tour, subject, model, signal);
    await this.finish(tour, restoreIndex);
  }

  private async startRepoInner(dir: string, restoreIndex: number | undefined, signal: AbortSignal): Promise<void> {
    if (restoreIndex === undefined) {
      const branch = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Checking out the default branch...' },
        () => checkoutDefaultBranch(dir),
      );
      log(`repo tour: checked out ${branch} in ${dir}`);
      // The tree moved: drop anchors asked against the old HEAD and refresh the status row.
      this.askRepos.unseed(dir);
      signal.throwIfAborted();
    }
    const [head, id, files, dirty] = await Promise.all([
      readHead(dir),
      repoIdFor(dir),
      filesAtHead(dir),
      isDirty(dir),
    ]);
    signal.throwIfAborted();
    const repo = id?.repo ?? path.basename(dir);
    const tour: ActiveTour = {
      repo,
      cloneDir: dir,
      headOid: head.oid,
      subject: { kind: TourKind.Repo },
      chunks: [],
      index: 0,
    };
    this.tour = tour;
    this.view.postTour({ type: 'tourStarted', heading: `${repo} [${head.branch ?? head.oid.slice(0, 7)}]` });

    const model = readConfig().reviewModel;
    // Keyed on HEAD like a PR review: the tour describes committed code, so new commits re-tour.
    const key = `prOpen.repoTour1:${dir}|${head.oid}|${model ?? ''}`;
    if (!this.replayCached(tour, key, signal)) {
      if (restoreIndex !== undefined) {
        // HEAD moved since the saved tour. A restore runs unprompted, so it never starts a run.
        this.clearTour();
        this.view.postTour({ type: 'tourEnded' });
        return;
      }
      this.view.postTour({ type: 'tourProgress', message: 'Exploring the repository with Claude...' });
      const promptPath = path.join(this.context.extensionUri.fsPath, 'prompt-repo-tour.md');
      const chunks = await generateRepoTour(
        dir,
        repoTourPayload(repo, files),
        promptPath,
        model,
        new Set(files),
        (chunk) => this.addChunk(tour, chunk),
        (label) => {
          if (this.tour === tour) {
            this.view.postTour({ type: 'tourProgress', message: `${label}...` });
          }
        },
        signal,
      );
      signal.throwIfAborted();
      // The model reads the working tree, so a tour of uncommitted edits would mis-anchor HEAD's.
      if (!dirty) {
        await this.context.globalState.update(key, { chunks } satisfies CachedReview);
      }
    }
    await this.finish(tour, restoreIndex);
  }

  /** Mark a tour's steps complete, and land a restored one back on its saved step. */
  private async finish(tour: ActiveTour, restoreIndex: number | undefined): Promise<void> {
    if (this.tour !== tour) {
      return; // ended, or superseded by a later review, while this one was generating
    }
    this.view.postTour({ type: 'tourStreamDone' });
    if (restoreIndex !== undefined && restoreIndex < tour.chunks.length) {
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
    const key = `prOpen.reviewContext3:${tour.cloneDir}|${meta.number}|${sourceHash}|${model ?? ''}`;
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
    this.view.postTour({ type: 'tourStep', index, title: chunk.title, status: statusFor(tour.subject, chunk) });
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

  private async loadChunks(
    tour: ActiveTour,
    subject: PrSubject,
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const { cloneDir: dir, headOid: head } = tour;
    const { number, base } = subject;
    // Key on the local HEAD, since that (not the remote PR head) is the tree being diffed.
    // `review3` excludes generated artifacts from the reviewed diff; older chunks did not.
    const key = `prOpen.review3:${dir}|${number}|${head}|${model ?? ''}`;
    if (this.replayCached(tour, key, signal)) {
      return;
    }
    const completed = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Analyzing PR #${number} with Claude...`, cancellable: false },
      async () => {
        this.view.postTour({ type: 'tourProgress', message: 'Classifying the diff...' });
        const prepared = prepareReview(await reviewDiff(dir, base, [...subject.byPath.values()]));
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

  /** Stream the steps cached under `key` into `tour`; false on a miss. */
  private replayCached(tour: ActiveTour, key: string, signal: AbortSignal): boolean {
    const cached = this.context.globalState.get<CachedReview>(key);
    if (!cached) {
      return false;
    }
    for (const c of cached.chunks) {
      signal.throwIfAborted();
      this.addChunk(tour, c);
    }
    return true;
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
    const status = statusFor(tour.subject, chunk);

    this.view.postTour({
      type: 'tourState',
      step: index,
      title: chunk.title,
      explanation: chunk.explanation,
      status,
      locations: chunk.locations.map((l) => ({ file: l.file, startLine: l.startLine, endLine: l.endLine })),
    });

    if (tour.subject.kind === TourKind.Repo) {
      await this.openFile(tour, loc);
    } else {
      await this.openDiff(tour, tour.subject, tour.subject.byPath.get(loc.file), loc, status ?? 'M');
    }
  }

  /** Open a repo tour's file on disk, so go-to-definition works, and highlight the step's lines. */
  private async openFile(tour: ActiveTour, loc: { file: string; startLine: number; endLine: number }): Promise<void> {
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(path.join(tour.cloneDir, loc.file)), {
      preview: true,
    });
    reveal(editor, loc.startLine, loc.endLine);
    editor.setDecorations(DECORATION, [lineRange(editor, loc.startLine, loc.endLine)]);
  }

  private async openDiff(
    tour: ActiveTour,
    subject: PrSubject,
    cf: ChangedFile | undefined,
    loc: { file: string; startLine: number; endLine: number },
    status: FileStatus,
    side: Side = 'head',
  ): Promise<void> {
    if (status === 'binary') {
      return; // nothing sensible to diff; the panel note explains it
    }

    const leftPath = cf?.oldPath ?? loc.file;
    const left = BaseContentProvider.uriFor(tour.cloneDir, subject.base, leftPath);
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

/** Status of a PR chunk's primary file, or 'M' when the model referenced an unknown path. Undefined
 *  in a repo tour, where nothing changed. */
function statusFor(subject: TourSubject, chunk: Chunk): FileStatus | undefined {
  if (subject.kind === TourKind.Repo) {
    return undefined;
  }
  const cf = subject.byPath.get(chunk.locations[0].file);
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
