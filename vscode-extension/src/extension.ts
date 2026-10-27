import * as vscode from 'vscode';
import { AddressController } from './addresscomments';
import { AdversarialReviewController } from './adversarialreview';
import { AskController, LineContext } from './askcomments';
import { AskRepoRegistry } from './askrepo';
import { BaseContentProvider } from './basecontent';
import { ConfigError, readConfig } from './config';
import { checkoutPr, openPr, pullPr, repoFolders, resumePending, warmUp } from './handoff';
import { showLog } from './logger';
import { PanelProvider } from './panel';
import { prefetch, userAction } from './prefetch';
import { isPrAction, PrAction, registerSidebar } from './prext';
import { parsePrRef, PrRef } from './prref';
import { traced } from './timing';
import { TourController } from './tour';
import { maybeCheckOnStartup } from './update';
import { errorMessage } from './util';
import { activeDir, onDidChangeActiveFolder, trackActiveFolder, trimAddedFolders } from './workspace';

export function activate(context: vscode.ExtensionContext): void {
  validateConfig();

  const run = (ref: PrRef | undefined, action: PrAction) => {
    if (!ref) {
      void vscode.window.showErrorMessage('PR Open: could not parse that as a GitHub pull request.');
      return;
    }
    const act = () =>
      action === PrAction.Checkout
        ? // A checkout moves the tree, so anything resolved against it — the status readout, and any
          // anchor an ask took — no longer holds. `unseed` fires the event that re-reads both.
          checkoutPr(context, ref).then((dir) =>
            dir ? askRepos.unseed(dir) : panel.refreshCheckoutStatus(),
          )
        : openPr(context, ref, action);
    void userAction(`${action} ${ref.repo}#${ref.number}`, act).catch((e) => reportError(e));
  };

  const baseContent = new BaseContentProvider();
  const askRepos = new AskRepoRegistry();
  // `tour`, `ask`, `address` and `adversarial` are assigned just below; handlers capture them
  // lazily and only run after activation.
  let tour: TourController;
  let ask: AskController;
  let address: AddressController;
  let adversarial: AdversarialReviewController;

  const panel = new PanelProvider(context.extensionUri, {
    openRepo: (action, repo, number) => run(parsePrRef(`${repo}#${number}`), action),
    prefetch: (repo, number) => prefetch(context, repo, number),
    startTour: (repo, number, dir) => void tour.start(repo, number, { dir }),
    tourNav: (dir) => (dir === 'next' ? tour.next() : tour.prev()),
    tourGoto: (index) => tour.goto(index),
    tourRestore: () => tour.restore(),
    tourEnd: () => tour.end(),
    tourOpenLocation: (file, startLine, endLine) => void tour.openLocation(file, startLine, endLine),
    askSubmit: (question, anchor) => void ask.askFromPanel(question, anchor),
    askJump: (id) => void ask.jump(id, (file, start, end, side) => tour.openLocation(file, start, end, side)),
    askCancel: (id) => ask.cancel(id),
    askClear: () => ask.clear(),
    askSnapshot: () => ask.snapshot(),
    addressStart: () => void address.start(),
    addressCancel: () => address.cancel(),
    addressOpen: (label) => void address.open(label),
    addressSnapshot: () => address.snapshot(),
    adversarialStart: (number) => void adversarial.start(Number(number)),
    adversarialCancel: () => adversarial.cancel(),
    adversarialSnapshot: () => adversarial.snapshot(),
    openExternal: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
    copyUrl: (url) => void vscode.env.clipboard.writeText(url),
    pullPr: (dir, number) => {
      void userAction(`pull #${number}`, () =>
        // A pull moves the tree, so anchors taken against the old head no longer hold. Saying so
        // here is what keeps the next question from reporting pr-open's own move as a tree that
        // went stale underneath it. `unseed` fires `onDidMoveHead`, which refreshes the status row.
        pullPr(dir, number).then(() => askRepos.unseed(dir)),
      ).catch((e) => reportError(e));
    },
  });

  registerSidebar(panel);

  tour = new TourController(context, panel, baseContent, askRepos);
  ask = new AskController(context.extensionUri, panel, askRepos);
  address = new AddressController(context.extensionUri, panel, askRepos);
  adversarial = new AdversarialReviewController(context.extensionUri, panel, askRepos);

  // A review starting or ending resets the questions: a new PR must not inherit the old transcript,
  // and when a review restarts the line numbers behind old answers may have moved.
  context.subscriptions.push(tour.onDidChangeReview(() => ask.clear()));
  // A tree that moved under us is also a status row claiming a branch it no longer has.
  context.subscriptions.push(askRepos.onDidMoveHead(() => panel.refreshCheckoutStatus()));
  // The status block reports one repo, so moving to another one leaves it describing the wrong tree.
  context.subscriptions.push(onDidChangeActiveFolder(() => panel.refreshCheckoutStatus()));

  context.subscriptions.push(
    ask,
    address,
    adversarial,
    tour,
    askRepos,
    trackActiveFolder(context),
    vscode.commands.registerCommand('prOpen.ask.selection', () => void ask.askAtSelection()),
    vscode.commands.registerCommand('prOpen.ask.atLine', (ctx: LineContext) => void ask.askAtLine(ctx)),
    vscode.commands.registerCommand('prOpen.ask.fromThread', (r: vscode.CommentReply) => void ask.askFromThread(r)),
    vscode.commands.registerCommand('prOpen.ask.submit', (reply: vscode.CommentReply) => ask.submitReply(reply)),
    vscode.commands.registerCommand('prOpen.ask.cancel', (thread: vscode.CommentThread) => ask.cancelThread(thread)),
    vscode.commands.registerCommand('prOpen.ask.delete', (thread: vscode.CommentThread) => ask.deleteThread(thread)),

    vscode.window.registerWebviewViewProvider(PanelProvider.viewId, panel, {
      // Keep the review's steps and current position alive when the panel is hidden or
      // collapsed, so switching away and back does not drop the walkthrough.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(BaseContentProvider.scheme, baseContent),

    vscode.commands.registerCommand('prOpen.startReview', async () => {
      const picked = await promptRepoAndNumber();
      if (picked) {
        void tour.start(picked.repo, picked.number);
      }
    }),

    vscode.commands.registerCommand('prOpen.startRepoTour', () => {
      const dir = activeDir();
      if (dir) {
        void tour.startRepo(dir);
      } else {
        void vscode.window.showWarningMessage('Open a repository folder to tour it.');
      }
    }),

    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        const params = new URLSearchParams(uri.query);
        const actionParam = params.get('action');
        const action = isPrAction(actionParam) ? actionParam : PrAction.Page;
        const built =
          params.get('url') ??
          params.get('uri') ??
          `${params.get('owner') ?? ''}/${params.get('repo') ?? ''}#${params.get('pr') ?? params.get('number') ?? ''}`;
        run(parsePrRef(built), action);
      },
    }),

    vscode.commands.registerCommand('prOpen.openByUrl', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'GitHub pull request URL',
        placeHolder: 'https://github.com/owner/repo/pull/123',
        validateInput: (v) => (parsePrRef(v) ? undefined : 'Not a recognizable PR URL'),
      });
      if (value) {
        run(parsePrRef(value), PrAction.Page);
      }
    }),

    vscode.commands.registerCommand('prOpen.openByRepoNumber', async () => {
      const picked = await promptRepoAndNumber();
      if (picked) {
        run(parsePrRef(`${picked.repo}#${picked.number}`), PrAction.Page);
      }
    }),

    // Rescan and status refresh are one action: a stale clone list and a stale status row are the
    // same staleness to whoever clicked the one refresh icon the panel has.
    vscode.commands.registerCommand('prOpen.rescanRepos', () => {
      panel.rescan();
      panel.refreshCheckoutStatus();
    }),

    vscode.commands.registerCommand('prOpen.showLog', () => showLog()),

    vscode.commands.registerCommand('prOpen.openSettings', () =>
      void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:andrewcho.pr-open'),
    ),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('prOpen')) {
        return;
      }
      validateConfig();
      // Only the roots decide which clones exist. Rescanning on any other setting would throw away
      // every warm cache to re-walk the disk for the same answer.
      if (e.affectsConfiguration('prOpen.searchRoots') || e.affectsConfiguration('prOpen.cloneRoot')) {
        panel.rescan();
      }
    }),
  );

  // Resume first, then trim, each reported on its own so neither failure takes the other with it.
  //
  // That order, because a pending checkout resumes only into a folder the window already holds
  // (`resumePending`), so a trim that went first could take that folder and drop the reveal outright.
  // Waiting costs the trim nothing: every folder a window opens with has already paid for its watcher
  // by the time `activate` runs, so what the trim buys is a cheaper *next* launch. And by then the
  // reveal has claimed its folder, which `pickStartupDrops` protects.
  void traced('resume', () =>
    resumePending(context, (repo, number) => {
      panel.prefill(repo, number);
      // Awaited by `resumePending` before it fires the reveal, so the side-bar hold sees pr-open
      // showing rather than a view that has not resolved yet.
      return panel.reveal();
    }),
  )
    .catch((e) => reportError(e))
    .then(() => trimAddedFolders(context))
    .catch((e) => reportError(e));

  // Pay the first click's fixed costs now, while the user is still reading.
  void warmUp(context);

  // Check for a newer published release on startup (throttled to once/day, silent unless one exists).
  void maybeCheckOnStartup(context);
}

/** Validate config at activation / on change so a bad value surfaces immediately. */
function validateConfig(): void {
  try {
    readConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      void vscode.window
        .showErrorMessage(`PR Open: ${e.message}`, 'Open Settings')
        .then((c) => {
          if (c === 'Open Settings') {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'prOpen.searchRoots');
          }
        });
    } else {
      throw e;
    }
  }
}

function reportError(e: unknown): void {
  void vscode.window.showErrorMessage(`PR Open: ${errorMessage(e)}`);
}

/** Prompt for a repo (from the scanned clones) and a PR number. Undefined if cancelled. */
async function promptRepoAndNumber(): Promise<{ repo: string; number: number } | undefined> {
  let folders: string[];
  try {
    folders = repoFolders();
  } catch (e) {
    reportError(e);
    return undefined;
  }
  const repo = await vscode.window.showQuickPick(folders, { placeHolder: 'Repository' });
  if (!repo) {
    return undefined;
  }
  const number = await vscode.window.showInputBox({
    prompt: `PR number in ${repo}`,
    validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'Enter a positive number'),
  });
  return number ? { repo, number: Number(number.trim()) } : undefined;
}
