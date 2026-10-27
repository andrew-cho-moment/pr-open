import * as path from 'path';
import * as vscode from 'vscode';
import { AskCancelled, AskConversation, AskEntry, AskEvent, AskRepo, AskTurn, AskView } from './ask';
import { AskAnchor, docRefFor, sameAnchor, Side, uriParts } from './askanchor';
import { AskRepoRegistry } from './askrepo';
import { BaseContentProvider } from './basecontent';
import { configured } from './config';
import { log } from './logger';
import { repoSlug } from './prref';
import { errorMessage, samePath } from './util';
import { activeDir } from './workspace';

/** Set on `CommentThread.contextValue` so menu `when` clauses can tell an idle thread from a
 *  streaming one. Per-thread rather than a global context key, which is wrong once two are open. */
type ThreadContext = 'prOpenAsk.idle' | 'prOpenAsk.busy';

/** Reassigning `thread.comments` re-renders the whole widget, so streamed text is batched. */
const STREAM_THROTTLE_MS = 150;

/** Context key gating the "ask about these lines" command and its keybinding. */
const CAN_ASK_KEY = 'prOpen.ask.canAsk';

/** A comment widget's text box is a `TextEditor` of its own, over a document of this scheme. Focus
 *  landing there says nothing about which PR line the reviewer is on. */
const COMMENT_BOX_SCHEME = 'comment';

/** What every target has: the conversation a turn continues, and the PR its answers describe. */
interface Conversing {
  conversation: AskConversation;
  /** Holds the tree too, so a moved HEAD drops exactly what it invalidates. */
  repo: AskRepo;
}

/** The panel's box: one continuous conversation about the PR, shown only in the transcript. */
interface Chat extends Conversing {
  kind: 'panel';
}

/** A comment thread: a conversation pinned to one line range, so every turn in it is about those
 *  lines, and mirrored into the widget it was opened on. */
interface Thread extends Conversing {
  kind: 'thread';
  widget: vscode.CommentThread;
  anchor: AskAnchor;
}

/** Where a turn runs. Carrying the widget on the thread is what makes an in-diff turn with nowhere to
 *  render, or a panel turn that plants a comment, unrepresentable. */
type Target = Chat | Thread;

/** Where a turn is shown besides the panel transcript. */
interface Mirror {
  answer(markdown: string): void;
  /** Something pr-open has to say instead of an answer: a failure, or a cancellation. */
  note(markdown: string): void;
  busy(busy: boolean): void;
}

/** A panel turn's mirror: the transcript is the only place it shows. */
const UNMIRRORED: Mirror = { answer: () => {}, note: () => {}, busy: () => {} };

type Resolved = { repo: AskRepo; anchor: AskAnchor };

/** The single argument VS Code hands a command contributed to `editor/lineNumber/context`. */
export interface LineContext {
  uri: vscode.Uri;
  /** 1-based, as editor line numbers are. */
  lineNumber: number;
}

/**
 * Owns the questions a reviewer asks about a PR: the panel's conversation, the comment threads in the
 * diff editors, and the transcript the panel renders. Every turn is its own transcript entry, while
 * the turns of a target share one conversation, so only its first turn pays for the diff.
 *
 * Two kinds of target, because they mean different things. The panel's box is one continuous
 * conversation about the PR, and a selection only narrows the turn it is typed with. A thread is
 * anchored on lines, so its every turn is about those lines.
 *
 * Nothing is persisted and nothing reaches GitHub: both live for the window.
 */
export class AskController implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('prOpen.ask', 'Ask Claude');
  private readonly threads = new Map<vscode.CommentThread, Thread>();
  /** The panel's conversation, created on its first question and kept until the PR under it changes. */
  private chat?: Chat;
  private readonly entries = new Map<string, { entry: AskEntry; target: Target }>();
  private readonly disposables: vscode.Disposable[] = [];
  /** The last selection made in a document that belongs to a PR. The panel's compose box submits
   *  against this, because a focused webview means `activeTextEditor` is undefined. */
  private pinned?: Resolved;
  private nextId = 1;
  /** Bumped per tracked editor or selection, so a resolve that took a `gh` call can reject stale results. */
  private trackSeq = 0;
  private canAsk = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly view: AskView,
    private readonly repos: AskRepoRegistry,
  ) {
    // Only ever rendered on a follow-up box: every thread of ours opens with a question already in
    // it, and no commenting range means VS Code never opens an empty one.
    this.controller.options = { prompt: 'Ask a follow-up…', placeHolder: 'e.g. what calls this?' };
    // No `commentingRangeProvider` on purpose: the gutter `+` is the GitHub PR extension's. A second
    // controller claiming the same line demotes its comment box behind a "Select Comment Provider"
    // menu and renders a second, inert decoration beside the `+`. Ask has its own entry points.

    this.disposables.push(
      this.controller,
      vscode.window.onDidChangeActiveTextEditor((e) => void this.trackEditor(e)),
      vscode.window.onDidChangeTextEditorSelection((e) => void this.trackSelection(e)),
      // An answer describes one tree; when HEAD moves, the citations behind it no longer hold.
      this.repos.onDidMoveHead((dir) => this.dropFor(dir)),
    );
    void this.trackEditor(vscode.window.activeTextEditor);
  }

  dispose(): void {
    this.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /** Whether selection and line commands are enabled after the latest completed resolution. */
  get selectionCommandsEnabled(): boolean {
    return this.canAsk;
  }

  /** Submit a follow-up typed into one of our own threads' reply boxes. */
  submitReply(reply: vscode.CommentReply): void {
    const state = this.threads.get(reply.thread);
    const question = reply.text.trim();
    if (state && question) {
      void this.run(state, this.turnFor(state.repo, state.anchor, question));
    }
  }

  /** Ask about the active editor's selection, prompting for the question. */
  async askAtSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    await this.promptAndAsk(editor && (await this.anchorFor(editor.document.uri, editor.selection)));
  }

  /** Ask about a line, from the right-click menu on its line number or glyph margin. */
  async askAtLine(ctx: LineContext): Promise<void> {
    await this.promptAndAsk(await this.anchorFor(ctx.uri, clickedLines(ctx)));
  }

  /**
   * Ask about the lines a GitHub review thread is anchored on, using whatever the reviewer already
   * typed in its box as the question.
   *
   * The answer goes into a thread of ours on the same lines rather than into theirs: their thread is
   * a review comment bound for GitHub, and their next refresh owns its comments outright. Their box
   * is left as the reviewer typed it, so a question can be asked and then still posted.
   *
   * Which boxes get the button is decided in `package.json` by their controller ids
   * (`github-browse`, `github-review`). Nothing in the build checks that, so renaming them upstream
   * removes the button silently.
   */
  async askFromThread(reply: vscode.CommentReply): Promise<void> {
    const { thread } = reply;
    if (!thread.range) {
      // GitHub enables file-level comments, which carry no range. An answer needs a line anchor to
      // mean anything; whole-file and whole-PR questions are the panel's job.
      void vscode.window.showWarningMessage(
        'PR Open: that comment covers the whole file. Ask from a comment on specific lines, or use the Ask Claude box in the panel.',
      );
      return;
    }
    await this.promptAndAsk(await this.anchorFor(thread.uri, thread.range), reply.text);
  }

  /** Ask about `resolved`, falling back to an input box when no question came with the click. */
  private async promptAndAsk(resolved: Resolved | undefined, typed?: string): Promise<void> {
    if (!resolved) {
      void vscode.window.showWarningMessage(
        'PR Open: this file is not part of a pull request I can resolve. Check out the PR branch, and check that `origin` names a GitHub repo, then try again.',
      );
      return;
    }
    // An empty (or whitespace-only) box carries no question, so it falls through to the prompt.
    const question =
      typed?.trim() ||
      (
        await vscode.window.showInputBox({
          prompt: `Ask Claude about ${resolved.anchor.file}:${lineLabel(resolved.anchor)}`,
          placeHolder: 'e.g. why is this guard needed?',
        })
      )?.trim();
    if (question) {
      await this.startThread(resolved, question);
    }
  }

  /**
   * Ask from the panel: one more turn in its conversation, carrying the anchor the reviewer saw when
   * they typed. No comment thread, because the conversation spans the PR rather than any line range.
   */
  async askFromPanel(typed: string, anchor?: AskAnchor): Promise<void> {
    const question = typed.trim();
    if (!question) {
      return;
    }
    const chat = await this.panelChat();
    if (!chat) {
      void vscode.window.showWarningMessage(
        'PR Open: I could not tell which pull request to ask about. Check out the PR branch, and check that `origin` names a GitHub repo, then try again.',
      );
      return;
    }
    await this.run(chat, this.turnFor(chat.repo, anchor, question));
  }

  /** Kill the turn an entry belongs to, keeping whatever text already arrived. */
  cancel(id: string): void {
    this.entries.get(id)?.target.conversation.cancel();
  }

  cancelThread(thread: vscode.CommentThread): void {
    this.threads.get(thread)?.conversation.cancel();
  }

  deleteThread(thread: vscode.CommentThread): void {
    this.forget(thread);
    thread.dispose();
    this.pushSnapshot();
  }

  /** Drop every question and the conversations behind them, threads included. Called when a review
   *  starts or ends. */
  clear(): void {
    for (const thread of [...this.threads.keys()]) {
      this.forget(thread);
      thread.dispose();
    }
    this.forgetChat();
    this.view.postAsk({ type: 'askCleared' });
  }

  /** Re-push the whole transcript: a fresh webview, or the panel section being expanded. */
  snapshot(): void {
    this.pushSnapshot();
  }

  /** Open an entry's lines and, when a thread holds it, expand that thread. */
  async jump(
    id: string,
    openLocation: (file: string, start: number, end: number, side: Side) => Promise<void>,
  ): Promise<void> {
    const hit = this.entries.get(id);
    if (!hit?.entry.anchor) {
      return; // a whole-PR question has no lines to open
    }
    const { file, startLine, endLine, side } = hit.entry.anchor;
    await openLocation(file, startLine, endLine, side);
    if (hit.target.kind === 'thread') {
      hit.target.widget.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  // --- asking -------------------------------------------------------------------------------

  /** Create a thread for a brand-new question, then run its first turn. */
  private async startThread(resolved: Resolved, question: string): Promise<void> {
    const { repo, anchor } = resolved;
    const widget = this.controller.createCommentThread(
      this.uriFor(repo, anchor),
      new vscode.Range(anchor.startLine - 1, 0, anchor.endLine - 1, 0),
      [],
    );
    widget.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    widget.label = `Ask Claude · ${anchor.file}:${lineLabel(anchor)}`;
    const state: Thread = { kind: 'thread', conversation: this.conversationFor(repo), repo, anchor, widget };
    this.threads.set(widget, state);
    await this.run(state, this.turnFor(repo, anchor, question));
  }

  /**
   * The panel's conversation, starting one when the PR under the box has changed.
   *
   * The aim decides which tree, so the anchor the chip shows and the diff the answer is about are
   * always the same checkout's. With nothing aimed the reviewer's own checkout answers instead, which
   * is what makes the box live on a bare tree. Which PR that tree is on is always re-read from the
   * registry rather than taken from the aim's snapshot: a checkout that moved underneath a stale aim
   * would otherwise be described as the PR it used to hold. Undefined when no tree resolves, the one
   * case the box cannot serve.
   */
  private async panelChat(): Promise<Chat | undefined> {
    const dir = this.pinned?.repo.cloneDir ?? activeDir();
    const repo = dir ? await this.repos.forDir(dir) : undefined;
    if (!repo) {
      return undefined;
    }
    if (this.chat && !sameTree(this.chat.repo, repo)) {
      log(`ask: the panel is on ${repoSlug(repo)}#${repo.number} now; starting a new conversation`);
      this.forgetChat();
      this.pushSnapshot(); // its answers described another PR, so they go with it
    }
    this.chat ??= { kind: 'panel', conversation: this.conversationFor(repo), repo };
    return this.chat;
  }

  /** A turn: the question, and the lines it is aimed at as the reviewer sees them. */
  private turnFor(repo: AskRepo, anchor: AskAnchor | undefined, question: string): AskTurn {
    return { question, aim: anchor && { anchor, code: this.codeFor(repo, anchor) } };
  }

  /**
   * Run one turn against a target: stream the answer, keep the transcript in step, and mirror it into
   * a comment widget when the turn belongs to a thread. The question is already trimmed and non-empty;
   * taking the target rather than looking it up is what makes a turn without a conversation
   * unrepresentable.
   */
  private async run(target: Target, turn: AskTurn): Promise<void> {
    if (target.conversation.busy) {
      return; // both surfaces already hide their box: this is the invariant, not a user path
    }

    // The answer will describe the files on disk as the PR's "after" state, so the tree has to still
    // be the one this conversation was resolved against. `hasMoved` drops what it invalidates through
    // `onDidMoveHead`, which is why nothing is written anywhere here.
    const { cloneDir } = target.repo;
    if (await this.repos.hasMoved(cloneDir)) {
      void vscode.window.showWarningMessage(
        `PR Open: the checkout in ${path.basename(cloneDir)} has moved, so these answers no longer describe the PR. Start the review again.`,
      );
      return;
    }

    const id = `ask-${this.nextId++}`;
    // Which surface asked and where the turn is mirrored both read off the target, so a panel entry
    // marked as an in-diff question is a state the type rules out.
    const origin: AskEntry['origin'] = target.kind === 'thread' ? 'inline' : 'panel';
    const { question, aim } = turn;
    const entry: AskEntry = { id, anchor: aim?.anchor, question, answer: '', state: 'streaming', origin };
    this.entries.set(id, { entry, target });

    const mirror = target.kind === 'thread' ? threadMirror(target.widget, question) : UNMIRRORED;
    mirror.busy(true);
    this.view.postAsk({ type: 'askEntry', entry });

    let text = '';
    let tool: string | undefined;
    let lastRender = 0;
    const render = (final: boolean) => {
      const now = Date.now();
      if (!final && now - lastRender < STREAM_THROTTLE_MS) {
        return;
      }
      lastRender = now;
      mirror.answer(text || `_${tool ?? 'Thinking'}…_`);
      this.view.postAsk({ type: 'askAnswer', id, answer: text, state: final ? 'done' : 'streaming' });
    };
    // The placeholder lands in the thread at once; the panel already has the entry, so it needs no
    // answer message until there is text.
    mirror.answer('_Thinking…_');

    const onProgress = (e: AskEvent) => {
      if (e.kind === 'delta') {
        text += e.text;
      } else if (e.kind === 'tool' && !text) {
        tool = e.label;
      }
      render(false);
    };

    try {
      text = await target.conversation.ask(turn, onProgress);
      this.update(id, { answer: text, state: 'done' });
      render(true);
    } catch (e) {
      const cancelled = e instanceof AskCancelled;
      const message = cancelled ? 'Cancelled.' : errorMessage(e);
      mirror.note(cancelled ? '_Cancelled._' : message);
      this.update(id, { answer: text, state: 'error', error: message });
      this.view.postAsk({ type: 'askFailed', id, message });
      if (!cancelled) {
        log(`ask: ${message}`);
      }
    } finally {
      mirror.busy(false);
    }
  }

  private conversationFor(repo: AskRepo): AskConversation {
    return new AskConversation({
      repo,
      promptPath: path.join(this.extensionUri.fsPath, 'prompt-ask.md'),
      model: configured((c) => c.askModel),
    });
  }

  /** The anchored lines' text as the editor shows them, when their document is open. */
  private codeFor(repo: AskRepo, anchor: AskAnchor): string | undefined {
    const uri = this.uriFor(repo, anchor).toString();
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    return doc && selectedText(doc, anchor);
  }

  private update(id: string, patch: Partial<AskEntry>): void {
    const hit = this.entries.get(id);
    if (hit) {
      this.entries.set(id, { ...hit, entry: { ...hit.entry, ...patch } });
    }
  }

  /** The anchor a range in a document points at, or undefined when it is not part of a PR. */
  private async anchorFor(uri: vscode.Uri, range: vscode.Range): Promise<Resolved | undefined> {
    const repo = await this.repos.for(uri);
    const ref = repo && docRefFor(uriParts(uri), repo);
    if (!repo || !ref) {
      return undefined;
    }
    return {
      repo,
      anchor: { file: ref.path, side: ref.side, startLine: range.start.line + 1, endLine: range.end.line + 1 },
    };
  }

  private uriFor(repo: AskRepo, anchor: AskAnchor): vscode.Uri {
    return anchor.side === 'base'
      ? BaseContentProvider.uriFor(repo.cloneDir, repo.base, anchor.file)
      : vscode.Uri.file(path.join(repo.cloneDir, anchor.file));
  }

  /** Cancel a thread's turn and drop it and its entries from the transcript. */
  private forget(widget: vscode.CommentThread): void {
    const state = this.threads.get(widget);
    if (state) {
      this.retire(state);
      this.threads.delete(widget);
    }
  }

  /** Cancel the panel's turn and drop its conversation, so the next question starts a new one. */
  private forgetChat(): void {
    if (this.chat) {
      this.retire(this.chat);
      this.chat = undefined;
    }
  }

  /** Kill a target's turn and drop the transcript entries it produced. The entries themselves say
   *  which target they came from, so there is no second list of ids to keep in step. */
  private retire(target: Target): void {
    target.conversation.cancel();
    for (const [id, held] of [...this.entries]) {
      if (held.target === target) {
        this.entries.delete(id);
      }
    }
  }

  private dropFor(dir: string): void {
    let dropped = false;
    for (const [widget, state] of [...this.threads]) {
      if (samePath(state.repo.cloneDir, dir)) {
        this.forget(widget);
        widget.dispose();
        dropped = true;
      }
    }
    if (this.chat && samePath(this.chat.repo.cloneDir, dir)) {
      this.forgetChat();
      dropped = true;
    }
    if (this.pinned && samePath(this.pinned.repo.cloneDir, dir)) {
      this.pinned = undefined; // an aim taken against the old tree names lines that have moved
      dropped = true;
    }
    // Fires for every clone whose HEAD moves, most of which this window never asked about. A snapshot
    // carries every answer's full markdown, so re-pushing one that cannot have changed is real work.
    if (dropped) {
      this.pushSnapshot();
    }
  }

  // --- selection tracking -------------------------------------------------------------------

  private async trackEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    await this.track(editor);
  }

  private async trackSelection(e: vscode.TextEditorSelectionChangeEvent): Promise<void> {
    await this.track(e.textEditor, e.selections[0]);
  }

  private async track(editor: vscode.TextEditor | undefined, selection?: vscode.Selection): Promise<void> {
    if (!editor || editor.document.uri.scheme === COMMENT_BOX_SCHEME) {
      return; // the panel, another view, or a comment box: keep the last aim
    }
    const seq = ++this.trackSeq;
    const trackedSelection = selection ?? editor.selection;
    const resolved = await this.anchorFor(editor.document.uri, trackedSelection);
    if (seq !== this.trackSeq) {
      return; // resolving can cost a `gh` call, and a newer editor or selection has answered since
    }
    const canAsk = resolved !== undefined;
    await vscode.commands.executeCommand('setContext', CAN_ASK_KEY, canAsk);
    if (seq !== this.trackSeq) {
      return;
    }
    this.canAsk = canAsk;
    this.pin(resolved, !trackedSelection.isEmpty);
  }

  /**
   * Remember the lines selected in a PR document, which is what narrows the panel's next question.
   *
   * A bare caret is not an aim: opening a diff leaves the cursor at line 1, so pinning that would
   * scope every panel question to line 1 of the last file focused and leave no way back to the whole
   * PR. Only a real selection aims the box, and collapsing it releases the aim. A document outside
   * any PR leaves the aim alone, so looking something up elsewhere does not re-scope the box.
   *
   * Posts only when the aim actually changed, since selection events fire per drag tick.
   */
  private pin(resolved: Resolved | undefined, aimed: boolean): void {
    if (!resolved) {
      return;
    }
    const next = aimed ? resolved : undefined;
    const moved = !sameAnchor(this.pinned?.anchor, next?.anchor);
    this.pinned = next;
    if (moved) {
      this.view.postAsk({ type: 'askAnchor', anchor: this.pinned?.anchor });
    }
  }

  private pushSnapshot(): void {
    this.view.postAsk({
      type: 'askSnapshot',
      entries: [...this.entries.values()].map((e) => e.entry),
      anchor: this.pinned?.anchor,
    });
  }
}

/** Whether two resolutions describe the same PR at the same commit: anything else is a conversation
 *  whose diff no longer holds. */
function sameTree(a: AskRepo, b: AskRepo): boolean {
  return samePath(a.cloneDir, b.cloneDir) && a.number === b.number && a.headOid === b.headOid;
}

/**
 * A turn's reflection in a comment thread: the question appended, and one reply comment the streamed
 * answer is rewritten into. Panel turns have no widget, so they get no mirror at all.
 */
function threadMirror(thread: vscode.CommentThread, question: string): Mirror {
  thread.comments = [...thread.comments, asked(question)];
  const at = thread.comments.length;
  return {
    answer: (markdown) => replaceAt(thread, at, answered(markdown)),
    note: (markdown) => replaceAt(thread, at, note(markdown)),
    busy: (busy) => {
      const state: ThreadContext = busy ? 'prOpenAsk.busy' : 'prOpenAsk.idle';
      thread.contextValue = state;
      // Hiding the reply box is what makes a second concurrent question unrepresentable.
      thread.canReply = !busy;
    },
  };
}

/**
 * The lines a gutter right-click means: the clicked line, widened to the editor's selection when
 * that selection covers it. Same rule VS Code applies before showing the menu, so right-clicking
 * inside a multi-line selection asks about all of it rather than silently narrowing to one line.
 */
function clickedLines(ctx: LineContext): vscode.Range {
  const line = ctx.lineNumber - 1;
  const editor = vscode.window.activeTextEditor;
  const selection = editor?.document.uri.toString() === ctx.uri.toString() ? editor?.selection : undefined;
  return selection && !selection.isEmpty && selection.start.line <= line && line <= selection.end.line
    ? selection
    : new vscode.Range(line, 0, line, 0);
}

function lineLabel(anchor: AskAnchor): string {
  return anchor.startLine === anchor.endLine ? String(anchor.startLine) : `${anchor.startLine}-${anchor.endLine}`;
}

/** The anchored lines' text, so the model is handed exactly what the reviewer selected. */
function selectedText(doc: vscode.TextDocument, anchor: AskAnchor): string {
  const last = Math.max(0, doc.lineCount - 1);
  const start = Math.min(anchor.startLine - 1, last);
  const end = Math.min(anchor.endLine - 1, last);
  return doc.getText(new vscode.Range(start, 0, end, doc.lineAt(end).text.length));
}

function asked(question: string): vscode.Comment {
  return { author: { name: 'You' }, body: new vscode.MarkdownString(question), mode: vscode.CommentMode.Preview };
}

function answered(markdown: string): vscode.Comment {
  return { author: { name: 'Claude' }, body: new vscode.MarkdownString(markdown), mode: vscode.CommentMode.Preview };
}

function note(markdown: string): vscode.Comment {
  return { author: { name: 'PR Open' }, body: new vscode.MarkdownString(markdown), mode: vscode.CommentMode.Preview };
}

/** Replace one comment in a thread; `comments` is only re-read through its setter. */
function replaceAt(thread: vscode.CommentThread, index: number, comment: vscode.Comment): void {
  const next = [...thread.comments];
  next[index] = comment;
  thread.comments = next;
}
