import * as vscode from 'vscode';
import { AddressItem, AddressMessage, AddressState } from './address';
import { AdversarialMessage } from './adversarial';
import { AskAnchor, AskEntry, AskMessage } from './ask';
import { renderMarkdown } from './markdown';
import {
  CheckoutStatus,
  getActiveCheckout,
  invalidateClones,
  linearRef,
  repoFolders,
} from './handoff';
import { PrAction } from './prext';
import { TourMessage } from './tour';
import { delay, errorMessage } from './util';

/** The checkout status as sent to the webview, with the PR's Linear link resolved. */
interface CheckoutStatusItem extends Omit<CheckoutStatus, 'pr'> {
  pr?: NonNullable<CheckoutStatus['pr']> & { linear?: string; linearId?: string };
}

export interface PanelHandlers {
  openRepo(action: PrAction, repo: string, number: string): void;
  /** Warm what a click on this repo's PR would otherwise pay for. */
  prefetch(repo: string, number: number): void;
  startTour(repo: string, number: number, dir?: string): void;
  /** Tour the whole repository checked out at `dir`. */
  startRepoTour(dir: string): void;
  tourNav(dir: 'next' | 'prev'): void;
  tourGoto(index: number): void;
  tourRestore(): void;
  tourEnd(): void;
  tourOpenLocation(file: string, startLine: number, endLine: number): void;
  /** `anchor` is absent when the reviewer has selected nothing: the question is about the whole PR. */
  askSubmit(question: string, anchor?: AskAnchor): void;
  askJump(id: string): void;
  askCancel(id: string): void;
  askClear(): void;
  /** Re-push the whole transcript: on a fresh webview, and when the section is expanded. */
  askSnapshot(): void;
  /** Fix, reply to and resolve every unresolved review comment on the checked-out PR. */
  addressStart(): void;
  addressCancel(): void;
  /** Open the file a listed thread hangs off. */
  addressOpen(label: string): void;
  /** Re-push the run's state, alongside `askSnapshot`. */
  addressSnapshot(): void;
  /** Hunt for bugs in the checked-out PR and file them as a draft review. */
  adversarialStart(number: string): void;
  adversarialCancel(): void;
  /** Re-push the run's state, alongside `askSnapshot`. */
  adversarialSnapshot(): void;
  openExternal(url: string): void;
  copyUrl(url: string): void;
  pullPr(dir: string, number: number): void;
}

type Inbound =
  | { type: 'ready' }
  | { type: 'openRepo'; action: PrAction; repo: string; number: string }
  | { type: 'prefetch'; repo: string; number: number }
  | { type: 'tourStart'; repo: string; number: number; dir?: string }
  | { type: 'repoTourStart'; dir: string }
  | { type: 'tourNext' }
  | { type: 'tourPrev' }
  | { type: 'tourGoto'; index: number }
  | { type: 'tourEnd' }
  | { type: 'tourOpenLocation'; file: string; startLine: number; endLine: number }
  | { type: 'askSubmit'; question: string; anchor?: AskAnchor }
  | { type: 'askJump'; id: string }
  | { type: 'askCancel'; id: string }
  | { type: 'askClear' }
  | { type: 'askToggle'; open: boolean }
  | { type: 'addressStart' }
  | { type: 'addressCancel' }
  | { type: 'addressOpen'; label: string }
  | { type: 'adversarialStart'; number: string }
  | { type: 'adversarialCancel' }
  | { type: 'openExternal'; url: string }
  | { type: 'copyUrl'; url: string }
  | { type: 'pullPr'; dir: string; number: number };

/** A transcript entry as sent to the webview: the answer's markdown pre-rendered to escaped HTML. */
interface AskWireEntry extends Omit<AskEntry, 'answer'> {
  html: string;
}

type AskOutbound =
  | { type: 'askSnapshot'; entries: AskWireEntry[]; anchor?: AskAnchor }
  | { type: 'askEntry'; entry: AskWireEntry }
  | { type: 'askAnswer'; id: string; html: string; state: 'streaming' | 'done' }
  | { type: 'askFailed'; id: string; message: string }
  | { type: 'askAnchor'; anchor?: AskAnchor }
  | { type: 'askCleared' };

const wireEntry = ({ answer, ...rest }: AskEntry): AskWireEntry => ({ ...rest, html: renderMarkdown(answer) });

/** A listed thread as sent to the webview: its reply pre-rendered to escaped HTML. */
interface AddressWireItem extends Omit<AddressItem, 'reply'> {
  replyHtml?: string;
}

type AddressOutbound = { type: 'addressState'; state: Omit<AddressState, 'items'> & { items: AddressWireItem[] } };

/**
 * A run's state as sent to the webview, with each reply's markdown rendered once.
 *
 * Once. The whole state goes out on every progress line, and a reply never changes after the turn
 * that wrote it, so re-rendering the list per line would run the markdown renderer over every reply
 * tens of times a second for no new output. Keyed by the reply text, so a re-run's replacement reply
 * renders again rather than serving the answer to a question nobody asked twice.
 */
class AddressWire {
  private rendered = new Map<string, string>();

  next({ state }: AddressMessage): AddressOutbound {
    const fresh = new Map<string, string>();
    const items = state.items.map(({ reply, ...rest }): AddressWireItem => {
      if (reply === undefined) {
        return { ...rest };
      }
      const html = this.rendered.get(reply) ?? renderMarkdown(reply);
      fresh.set(reply, html);
      return { ...rest, replyHtml: html };
    });
    this.rendered = fresh; // only what this state still holds, so a cleared run drops its replies
    return { type: 'addressState', state: { ...state, items } };
  }
}

/** Model output crosses into the webview only as HTML this renderer produced. */
function toWire(msg: AskMessage): AskOutbound {
  switch (msg.type) {
    case 'askSnapshot':
      return { type: 'askSnapshot', entries: msg.entries.map(wireEntry), anchor: msg.anchor };
    case 'askEntry':
      return { type: 'askEntry', entry: wireEntry(msg.entry) };
    case 'askAnswer':
      return { type: 'askAnswer', id: msg.id, html: renderMarkdown(msg.answer), state: msg.state };
    default:
      return msg;
  }
}

export class PanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'prOpen.panel';
  private view?: vscode.WebviewView;
  private pendingPrefill?: { repo: string; number: number };
  /** Mirrors the webview's Ask section so streaming re-renders can be skipped while it is collapsed.
   *  Collapsed is both the default and the safe fallback, so a lost mirror costs nothing. */
  private askOpen = false;
  /** A status refresh that came in while nobody could read it, deferred to the next time they can.
   *  `retainContextWhenHidden` keeps `view` set once resolved, so hidden refreshes would otherwise
   *  keep paying a `gh` round trip for output on a side bar the user has closed. */
  private statusStale = false;
  /** Ticket for the newest status request, so a slower earlier one cannot post over it. */
  private statusSeq = 0;
  /** Armed while a reveal pr-open asked for is in flight: see `hold`. */
  private held = false;
  private readonly addressWire = new AddressWire();
  /** Ticket for the newest hold, so a lapsed one cannot release the hold that replaced it. */
  private holdSeq = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: PanelHandlers,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // Hiding the view from its context menu disposes it, and every later use of a disposed view
    // throws. Guarded on identity, so a dispose that arrives after the view was resolved again drops
    // the old one rather than the live one.
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        if (this.statusStale) {
          void this.sendCheckoutStatus();
        }
      } else if (this.held) {
        // Disarmed before the restore: one per hold, since a second hide inside the same window is
        // the user picking a container, not the reveal landing twice.
        this.held = false;
        view.show(true);
      }
    });
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: Inbound) => {
      switch (msg.type) {
        case 'ready':
          this.sendRepos();
          this.flushPrefill();
          void this.sendCheckoutStatus();
          // The webview was (re)created; rehydrate a saved review if the panel had one. The review
          // restores from its per-HEAD chunk cache, but questions are in-memory only, so a window
          // reload lands on an empty transcript by design.
          this.handlers.tourRestore();
          this.handlers.askSnapshot();
          this.handlers.addressSnapshot();
          this.handlers.adversarialSnapshot();
          break;

        case 'openRepo':
          this.handlers.openRepo(msg.action, msg.repo, msg.number);
          break;
        case 'prefetch':
          this.handlers.prefetch(msg.repo, msg.number);
          break;
        case 'tourStart':
          this.handlers.startTour(msg.repo, msg.number, msg.dir);
          break;
        case 'repoTourStart':
          this.handlers.startRepoTour(msg.dir);
          break;
        case 'tourNext':
          this.handlers.tourNav('next');
          break;
        case 'tourPrev':
          this.handlers.tourNav('prev');
          break;
        case 'tourGoto':
          this.handlers.tourGoto(msg.index);
          break;
        case 'tourEnd':
          this.handlers.tourEnd();
          break;
        case 'tourOpenLocation':
          this.handlers.tourOpenLocation(msg.file, msg.startLine, msg.endLine);
          break;
        case 'askSubmit':
          this.handlers.askSubmit(msg.question, msg.anchor);
          break;
        case 'askJump':
          this.handlers.askJump(msg.id);
          break;
        case 'askCancel':
          this.handlers.askCancel(msg.id);
          break;
        case 'askClear':
          this.handlers.askClear();
          break;
        case 'askToggle':
          // Serviced in-provider, like `checkoutStatus`: expanding backfills whatever streaming
          // updates were suppressed while the section was closed.
          this.askOpen = msg.open;
          if (msg.open) {
            this.handlers.askSnapshot();
            this.handlers.addressSnapshot();
            this.handlers.adversarialSnapshot();
          }
          break;
        case 'addressStart':
          this.handlers.addressStart();
          break;
        case 'addressCancel':
          this.handlers.addressCancel();
          break;
        case 'addressOpen':
          this.handlers.addressOpen(msg.label);
          break;
        case 'adversarialStart':
          this.handlers.adversarialStart(msg.number);
          break;
        case 'adversarialCancel':
          this.handlers.adversarialCancel();
          break;
        case 'openExternal':
          this.handlers.openExternal(msg.url);
          break;
        case 'copyUrl':
          this.handlers.copyUrl(msg.url);
          break;
        case 'pullPr':
          this.handlers.pullPr(msg.dir, msg.number);
          break;
      }
    });
  }

  /** Forward a tour update from the controller to the webview. */
  postTour(msg: TourMessage): void {
    void this.view?.webview.postMessage(msg);
  }

  /** Forward an ask update, rendering the answer's markdown to escaped HTML on the way out. */
  postAsk(msg: AskMessage): void {
    if (!this.askOpen && msg.type === 'askAnswer' && msg.state === 'streaming') {
      return; // nobody can see it; the 'done' flush and the next snapshot carry the text
    }
    void this.view?.webview.postMessage(toWire(msg));
  }

  /** Forward the review-comment run's state, rendering each reply's markdown on the way out. */
  postAddress(msg: AddressMessage): void {
    void this.view?.webview.postMessage(this.addressWire.next(msg));
  }

  /** Forward the adversarial run's state. No markdown crosses here: the findings live on GitHub,
   *  and the panel carries a status line, the counts, and a link to the draft. */
  postAdversarial(msg: AdversarialMessage): void {
    void this.view?.webview.postMessage(msg);
  }

  /** Re-query and push the checked-out branch/PR status (e.g. after a checkout). */
  refreshCheckoutStatus(): void {
    void this.sendCheckoutStatus();
  }

  /** Whether pr-open is the view showing in its container. */
  private get visible(): boolean {
    return this.view?.visible ?? false;
  }

  /**
   * Keep the side bar on pr-open for `ms`: a reveal that lands inside that window puts the view back
   * once, without taking keyboard focus, so the restore does not pull the user out of what the
   * reveal just opened.
   *
   * Declines while pr-open is not the view showing, so a hold never opens a side bar the user had
   * closed, and leaves a live hold armed rather than releasing it.
   */
  hold(ms: number): void {
    if (!this.visible) {
      return;
    }
    this.held = true;
    const seq = ++this.holdSeq;
    void delay(ms).then(() => {
      if (this.holdSeq === seq) {
        this.held = false;
      }
    });
  }

  /** Reveal pr-open and give it focus. The command rather than `show`, because this runs on a window
   *  that has just come back up, where the view may not exist yet for `show` to reveal. Awaitable so
   *  a caller that reveals before firing an action finds the view showing rather than racing it. */
  reveal(): Thenable<void> {
    return vscode.commands.executeCommand(`${PanelProvider.viewId}.focus`);
  }

  /** Rescan clones and refresh the repo dropdown. */
  rescan(): void {
    invalidateClones();
    this.sendRepos();
  }

  /** Pre-fill the repo + number fields (used after the flow opens a repo's window). */
  prefill(repo: string, number: number): void {
    this.pendingPrefill = { repo, number };
    this.flushPrefill();
  }

  private flushPrefill(): void {
    if (this.view && this.pendingPrefill) {
      void this.view.webview.postMessage({ type: 'prefill', ...this.pendingPrefill });
      this.pendingPrefill = undefined;
    }
  }

  private async sendCheckoutStatus(): Promise<void> {
    if (!this.view) {
      return;
    }
    if (!this.visible) {
      this.statusStale = true;
      return;
    }
    this.statusStale = false;
    // Only the newest request may post. `getActiveCheckout` spans an order of magnitude — a cached
    // `branchPr` costs one git spawn, a miss adds a `gh` round trip — so switching repos twice can
    // land the first answer last, leaving the block and every control on it aimed at the repo the
    // user moved away from. That is the bug the single-item status exists to prevent.
    const seq = ++this.statusSeq;
    let item: CheckoutStatusItem | undefined;
    let error: string | undefined;
    try {
      item = await getActiveCheckout();
      if (item?.pr) {
        const ref = linearRef({ title: item.pr.title });
        item = { ...item, pr: { ...item.pr, linear: ref?.url, linearId: ref?.id } };
      }
    } catch (e) {
      error = errorMessage(e);
    }
    if (seq !== this.statusSeq) {
      return;
    }
    void this.view.webview.postMessage({ type: 'checkoutStatus', item, error });
  }

  private sendRepos(): void {
    if (!this.view) {
      return;
    }
    let repos: string[] = [];
    let error: string | undefined;
    try {
      repos = repoFolders();
    } catch (e) {
      error = errorMessage(e);
    }
    void this.view.webview.postMessage({ type: 'repos', repos, error });
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
    const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${asset('codicon.css')}" />
<link rel="stylesheet" href="${asset('panel.css')}" />
</head>
<body>
  <!-- Everything above the ask dock scrolls as one region, so nothing can spill into the dock. -->
  <div id="panelScroll">
    <div id="topSection">
      <div id="status">
        <!-- Before the text, not after it: the icons float, and a float only pushes the line boxes
             that follow it. This is what lets a long PR title wrap under them. -->
        <div id="statusActions">
          <a id="statusFill" class="codicon codicon-arrow-circle-down" aria-label="Fill the repo + number fields with this PR" aria-disabled="true"></a>
          <a id="statusCopy" class="codicon codicon-copy" aria-label="Copy the PR link" aria-disabled="true"></a>
        </div>
        <span id="statusText">Loading checkout status...</span>
      </div>

      <label for="url">Paste a PR link</label>
      <input id="url" type="text" placeholder="https://github.com/owner/repo/pull/123" />

      <label>or pick a repo + number</label>
      <div class="repo-row">
        <!-- .combo wraps the input so createCombo can anchor its suggestion popup under it. -->
        <div class="combo"><input id="repo" placeholder="type to filter repos" autocomplete="off" /></div>
        <input id="num" type="number" min="1" placeholder="#" />
      </div>
      <div class="actions">
        <button data-action="page">PR page</button>
        <button class="secondary" data-action="diff">Diff</button>
        <button class="secondary" data-action="checkout">Checkout</button>
      </div>
      <!-- Its own row: four flex-sized buttons cannot shrink below their own text, and the body
           clips that overflow rather than scrolling it, so a fourth would be unreachable in a
           narrow panel. It also keeps the one button that writes to GitHub off the row that only
           navigates. -->
      <div class="actions">
        <button class="secondary" id="advBtn"
                title="Review the checked-out PR for bugs, design and style, and file each finding as a draft review you approve on GitHub">Adversarial review</button>
        <button class="secondary" id="advStopBtn" style="display:none;">Stop</button>
      </div>
      <div id="advStatus"></div>
      <div id="advErr" class="err"></div>
      <div id="err" class="err"></div>

      <hr />
    </div>

    <!-- One sticky block rather than several: stacking two sticky siblings would mean hardcoding the
         first one's height as the second one's top offset. -->
    <div id="tourPinned">
      <div id="tourHead">
        <label id="tourHeading"></label>
        <span id="tourHeadActions">
          <a id="tourContextToggle" role="button" aria-expanded="true" title="Show or hide the PR context" style="display:none;">Context</a>
          <a id="focusToggle" class="codicon codicon-fold-up" title="Hide everything above and focus on the review"></a>
        </span>
      </div>
      <div id="tourErr" class="err"></div>
      <div id="tourNav" style="display:none;">
        <div id="tourStep" class="meta num"></div>
        <div class="actions" style="margin-top:6px;">
          <button class="secondary" id="tourPrevBtn">Prev</button>
          <button id="tourNextBtn">Next</button>
        </div>
        <div class="actions">
          <button class="secondary" id="tourEndBtn">End</button>
        </div>
      </div>
    </div>
    <div id="tourIdle">
      <div class="actions"><button id="tourStartBtn" disabled>Review checked-out PR</button></div>
      <div class="actions">
        <button class="secondary" id="repoTourBtn" disabled
                title="Walk through the whole repository open in this window, as of its HEAD commit">Tour this repo</button>
      </div>
    </div>
    <div id="tourActive" style="display:none;">
      <div id="tourContext" style="display:none;">
        <div id="tourContextBody"></div>
      </div>
      <div id="tourTitle" style="font-weight:600; margin:8px 0 4px;"></div>
      <div id="tourExpl"></div>
      <div id="tourLocs" class="links"></div>
      <ul id="tourSteps"></ul>
    </div>
  </div>

  <!-- Outside #tourActive: a question about the checked-out PR works with no walkthrough running,
       so its transcript must not be hidden with the review's controls. -->
  <div id="askSection">
    <div id="askResize" role="separator" aria-label="Resize the Ask Claude area" title="Drag to resize"></div>
    <div id="askHead">
      <a id="askToggle" role="button" aria-expanded="false" aria-controls="askBody"
         title="Ask Claude about the checked-out pull request"><span id="askChevron" class="codicon codicon-chevron-right"></span>Ask Claude<span id="askCount"></span></a>
      <a id="askClear" class="codicon codicon-clear-all" title="Clear the conversation" aria-label="Clear the conversation" style="display:none;"></a>
    </div>
    <div id="askBody">
      <!-- The review-comment run, above the transcript: it reports on the PR rather than on any one
           question, and it must not scroll away under a streaming answer. -->
      <div id="addressBox" style="display:none;">
        <div id="addressHead">
          <span id="addressStatus"></span>
          <a id="addressCancel" class="codicon codicon-stop-circle" title="Stop addressing comments"
             aria-label="Stop addressing comments" style="display:none;"></a>
        </div>
        <div id="addressErr" class="err"></div>
        <ul id="addressList"></ul>
      </div>
      <ul id="askList"></ul>
      <!-- The compose box grows upward, since its bottom is pinned above the Ask button: the grip
           belongs on its top edge, where it stays under the pointer for the whole drag. -->
      <div id="askComposeResize" role="separator" aria-orientation="horizontal" tabindex="0"
           aria-label="Resize the question box" title="Drag to resize"></div>
      <div id="askAnchor" class="ask-anchor"></div>
      <textarea id="askInput" rows="2" placeholder="Ask about this PR; select lines to narrow it... (Enter to send)"></textarea>
      <div class="actions">
        <button id="askBtn" disabled>Ask</button>
        <button class="secondary" id="askStopBtn" style="display:none;">Stop</button>
      </div>
      <div class="actions">
        <button class="secondary" id="addressBtn" disabled
                title="Fix and reply to every unresolved review comment on the checked-out PR, then resolve them">Address PR comments</button>
      </div>
    </div>
  </div>

<script nonce="${nonce}" src="${asset('panel.js')}"></script>
</body>
</html>`;
  }
}
