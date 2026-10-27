import * as path from 'path';
import * as vscode from 'vscode';
import { log } from './logger';
import { OwnedPrRef, prUrl, RepoId } from './prref';
import { phase } from './timing';
import { delay, errorMessage, samePath } from './util';
import { noteActiveChoice } from './workspace';

const PR_EXTENSION_ID = 'GitHub.vscode-pull-request-github';
const READY_TIMEOUT_MS = 20_000;
/**
 * Generous, because `waitForPrExtReady` clearing does not imply this one will: it waits for *some*
 * manager to exist, and a window that already had one gets that for free the moment a folder is
 * added. Building the manager for the repo just added is the part that remains, and it authenticates
 * and resolves the remote over GraphQL. Falling through early costs the deep link, which is slower
 * than waiting and can surface in a different window, so waiting is the better trade.
 */
const RESOLVE_TIMEOUT_MS = 15_000;
// A safety net, not the mechanism: both waits subscribe to the PR extension's own events and only
// fall back to polling when a version does not fire them. Fine-grained at first and coarse after,
// because the sub-second window is where a tick's granularity is pure added latency, while past it the
// poll is only insurance against an event that is not coming — and each tick scans the PR extension's
// open-repo list, fanned out across every workspace folder at warm-up.
const POLL_FAST_MS = 25;
const POLL_FAST_WINDOW_MS = 500;
const POLL_SLOW_MS = 300;
const SETTLE_MS = 300;
/**
 * How long past a dispatch the side bar is held on pr-open. `pr.openDescription` fires its tree
 * reveal without awaiting it, so the reveal can land either side of the command resolving, and a
 * restore timed to the resolution wins only sometimes. Long enough to cover a reveal that has to
 * build the tree's container first, and short enough that a container the user picks a moment later
 * is left alone. Its cost is bounded at one pull-back, and `stealsSideBar` keeps even that off the
 * dispatches with no reveal to undo.
 */
const HOLD_MS = 2_000;

export enum PrAction {
  Page = 'page',
  Diff = 'diff',
  Checkout = 'checkout',
}

/** The actions that only *show* a PR. pr-open checks branches out itself, so `Checkout` never
 * reaches the PR extension, whose handler for it opens a second window of its own. */
export type RevealAction = PrAction.Page | PrAction.Diff;

/**
 * How to drive the GitHub PR extension for each reveal.
 *
 * `command` is preferred: `deepLink` round-trips through the OS URL handler, and the URI handler it
 * reaches resolves the PR with the extension's model cache disabled, so a re-open refetches over
 * GraphQL. The commands take a PR identity directly and resolve cache-first. Every reveal has one,
 * so the deep link is only ever a fallback for a moved command surface.
 *
 * Neither command reports failure to its caller: both resolve after logging or showing their own
 * error, so a dispatch that opened nothing is indistinguishable from one that worked. That is why
 * `fireAction` checks the extension can resolve the PR *before* dispatching, rather than trying to
 * detect a silent no-op afterwards. Commands and argument shape verified against v0.162.0; the
 * deep-link paths share one `?uri=` parser (verified against v0.158.0).
 *
 * One behavior difference the deep link did not have: for a PR that is the folder's checked-out PR,
 * `pr.openDescription` also reveals it in the "Changes in Pull Request" tree with `focus: true`,
 * taking the side bar off pr-open. No argument turns that off, so `fireAction` holds the side bar
 * across the dispatch instead: see `HOLD_MS` and `stealsSideBar`.
 */
const ACTIONS: Record<RevealAction, { path: string; command: string }> = {
  [PrAction.Page]: { path: '/open-pull-request-webview', command: 'pr.openDescription' },
  [PrAction.Diff]: { path: '/open-pull-request-changes', command: 'pr.openChanges' },
};

/** Whether a raw string is one of the known PR actions. */
export function isPrAction(s: string | null): s is PrAction {
  return s !== null && Object.values<string>(PrAction).includes(s);
}

/** Whether `action` is one `ACTIONS` can drive, i.e. safe to hand to `fireAction`. Reads `ACTIONS`
 * itself so it stays true as that table changes. */
export function isRevealAction(action: unknown): action is RevealAction {
  return typeof action === 'string' && Object.hasOwn(ACTIONS, action);
}

/** What the side-bar hold needs of pr-open's view, registered from `activate`. */
export interface Sidebar {
  /** Keep the side bar on pr-open for `ms`, putting the view back once if something reveals over it.
   *  Declines when pr-open is not the view showing. */
  hold(ms: number): void;
}

let sidebar: Sidebar | undefined;

export function registerSidebar(view: Sidebar): void {
  sidebar = view;
}

/**
 * Drive the GitHub PR extension for `action`: dispatch its command once the extension can resolve
 * the PR, else fall back to the deep link, whose URI handler fetches the PR itself.
 *
 * Waits for the repo at `dir` first, since every path resolves the PR through it. A rejected
 * dispatch means the command surface has moved on (renamed or unregistered), which the deep link
 * survives.
 *
 * The one point every reveal passes through, which is why the two things a reveal implies live here
 * rather than at its callers: `dir` is now the repo in front of the user, and the side bar stays on
 * pr-open across the dispatch.
 */
export async function fireAction(dir: string, ref: OwnedPrRef, action: RevealAction): Promise<void> {
  // Asking for a PR states where the user is better than the active editor does: the reveal below
  // may open nothing under `dir` at all, so this choice must outrank the editor-focus hint.
  noteActiveChoice(dir);
  phase('pr-ext-ready');
  await waitForPrExtReady(dir);
  const command = ACTIONS[action].command;
  phase('resolve');
  if (await waitForFolderManager(ref)) {
    // Taken here rather than around the long waits above, so a user who navigated away while they
    // ran is left where they went. The window spans the throw too, since a dispatch that failed
    // partway took the side bar just the same.
    if (await stealsSideBar(ref, action)) {
      sidebar?.hold(HOLD_MS);
    }
    try {
      phase('dispatch');
      await vscode.commands.executeCommand(command, prDetailsArg(ref));
      return;
    } catch (e) {
      log(`${command} failed, falling back to the deep link: ${errorMessage(e)}`);
    }
  } else {
    log(`the PR extension holds no repository for ${ref.owner}/${ref.repo}; using the deep link`);
  }
  phase('deep-link');
  await vscode.env.openExternal(deepLink(ref, action));
}

/**
 * Whether dispatching `action` for `ref` will take the side bar off pr-open, which is the only case
 * a hold is worth taking: elsewhere it spends its window undoing the first container switch the user
 * makes inside it. Only `pr.openDescription` reveals in the changes tree, and only for the folder's
 * checked-out PR, so this reads the same `activePullRequest` that reveal is guarded on. A shape that
 * has moved on reads as "no steal", which costs the side bar rather than the user's own click.
 */
async function stealsSideBar(ref: OwnedPrRef, action: RevealAction): Promise<boolean> {
  if (action !== PrAction.Page) {
    return false;
  }
  return (await heldManager(ref))?.activePullRequest?.number === ref.number;
}

/**
 * The manager the PR extension holds for `repo` right now, without waiting for one to be built.
 * Undefined when the extension is missing, its surface has moved on, or it holds no manager — three
 * answers both callers treat alike, since each of them degrades rather than fails.
 */
async function heldManager(repo: RepoId): Promise<FolderManager | undefined> {
  try {
    return reposManager(await prExtApi())?.getManagerForRepository?.(repo.owner, repo.repo);
  } catch (e) {
    log(`could not read the PR extension's manager for ${repo.owner}/${repo.repo}: ${errorMessage(e)}`);
    return undefined;
  }
}

/**
 * Whether the PR extension has built a manager for the repository rooted at `dir`.
 *
 * Keyed on the root, never on `owner/repo`: `getManagerForRepository` scans every manager by remote
 * (verified in v0.162.0), so a review worktree answers yes off its main clone's manager while holding
 * no manager of its own. The per-root manager is what carries the review, and so the gutter `+`.
 */
function heldAtRoot(managers: ReposManager, dir: string): boolean {
  return (managers.folderManagers ?? []).some((m) => samePath(m.repository?.rootUri?.fsPath, dir));
}

/**
 * Whether the PR extension holds the repository at `dir` right now, answered without waiting.
 *
 * The question `adopt.ts` opens with, which is why it does not wait: the ordinary case is a repo the
 * window already had, and answering it costs nothing.
 */
export async function holdsRepoAt(dir: string): Promise<boolean> {
  try {
    const managers = reposManager(await prExtApi());
    return managers !== undefined && heldAtRoot(managers, dir);
  } catch (e) {
    log(`could not query the PR extension's repository managers: ${errorMessage(e)}`);
    return false;
  }
}

/** Whether the PR extension holds the repository at `dir` once it has had `RESOLVE_TIMEOUT_MS` to
 *  build the manager: what `adopt.ts` gives it before deciding a repo was dropped, and what a re-open
 *  then waits to see. */
export async function waitForRepoAt(dir: string): Promise<boolean> {
  try {
    const managers = reposManager(await prExtApi());
    if (!managers) {
      return false;
    }
    return await waitUntil(
      () => heldAtRoot(managers, dir),
      managers.onDidChangeFolderRepositories,
      Date.now() + RESOLVE_TIMEOUT_MS,
    );
  } catch (e) {
    log(`could not wait for the PR extension's manager for ${dir}: ${errorMessage(e)}`);
    return false;
  }
}

/** The argument shape the `ACTIONS` commands take a PR identity in. */
function prDetailsArg(ref: OwnedPrRef): { pullRequestDetails: unknown } {
  return {
    pullRequestDetails: {
      repository: { owner: { login: ref.owner }, name: ref.repo },
      number: ref.number,
    },
  };
}

/** Deep link that drives the GitHub Pull Requests extension for the given action. */
function deepLink(ref: OwnedPrRef, action: RevealAction): vscode.Uri {
  const target = encodeURIComponent(prUrl(ref));
  return vscode.Uri.parse(
    `${vscode.env.uriScheme}://${PR_EXTENSION_ID}${ACTIONS[action].path}?uri=${target}`,
  );
}

/**
 * The slice of the PR extension's exported API this module uses. All of it is undocumented (there is
 * no published `.d.ts`), so every field is optional and feature-detected: a shape that has moved on
 * reads as "can't tell", which costs the deep link rather than a broken click.
 */
interface PrExtApi {
  repositories?: { rootUri?: vscode.Uri }[];
  onDidOpenRepository?: Subscribe;
  onDidCloseRepository?: Subscribe;
  repositoriesManager?: ReposManager;
}

/** The PR extension's own repository managers: what the commands resolve a PR through. */
interface ReposManager {
  folderManagers?: readonly FolderManager[];
  getManagerForRepository?: (owner: string, repo: string) => FolderManager | undefined;
  onDidChangeFolderRepositories?: Subscribe;
  /** The one session store, shared with every folder manager. */
  readonly credentialStore?: { isAnyAuthenticated?: () => boolean };
}

/** One repository's manager: what both reveal commands resolve their PR through. The declared return
 *  of `getManagerForRepository` asserts nothing — every member is optional and checked at its call
 *  site, on the same feature-detected terms as `PrExtApi`. */
interface FolderManager {
  resolvePullRequest?: (
    owner: string,
    repo: string,
    number: number,
    useCache: boolean,
  ) => Promise<PrModel | undefined>;
  getAssignableUsers?: () => Promise<unknown>;
  activePullRequest?: { number?: number };
  /** The repository this manager was built for. The PR extension builds one per repository root, so
   *  this is the only member that answers *which* repo a manager is for; see `heldAtRoot`. */
  repository?: { rootUri?: vscode.Uri };
}

/** A PR as the extension models it: the handle `warmPrModel` hands back, typed by the two members
 *  read off it. */
export interface PrModel {
  /** The file list `pr.openChanges` reads. It fetches only while this is empty, so a populated map is
   *  the whole warm. */
  readonly fileChanges?: { readonly size?: number };
  getFileChangesInfo?: () => Promise<unknown>;
}

type Subscribe = (listener: () => void) => vscode.Disposable;

async function prExtApi(): Promise<PrExtApi> {
  const ext = vscode.extensions.getExtension<PrExtApi>(PR_EXTENSION_ID);
  if (!ext) {
    throw new Error(`The GitHub Pull Requests extension (${PR_EXTENSION_ID}) is not installed.`);
  }
  // VS Code caches activation, so repeat calls are free after the first.
  return ext.activate();
}

/** The repos manager, when it still looks like the surface we rely on. */
function reposManager(api: PrExtApi): ReposManager | undefined {
  const m = api.repositoriesManager;
  return typeof m?.getManagerForRepository === 'function' && Array.isArray(m.folderManagers)
    ? m
    : undefined;
}

/**
 * Wait until the PR extension holds the repository `repo` lives in, and hand back the manager it
 * holds it through. Undefined when the surface is unrecognizable or the wait runs out.
 *
 * That manager is exactly what a reveal needs: both commands resolve through
 * `getManagerForRepository(owner, repo)` and give up quietly when it misses. Warming needs the same
 * object, which is why this returns it rather than answering yes or no.
 *
 * No `?? folderManagers[0]` fallback, which the commands' own resolver does take. A click that takes
 * it still opens the PR the user named; a warm that took it would resolve an unrelated repo's PR of
 * the same number and cache it there.
 *
 * Worth waiting on rather than testing once. `waitForPrExtReady` only establishes that *some*
 * manager exists, so a repo whose folder was just added still has its own to build.
 */
async function waitForFolderManager(repo: RepoId): Promise<FolderManager | undefined> {
  try {
    const api = await prExtApi();
    const managers = reposManager(api);
    if (!managers) {
      return undefined;
    }
    const held = () => managers.getManagerForRepository?.(repo.owner, repo.repo);
    const ready = await waitUntil(
      () => held() !== undefined,
      managers.onDidChangeFolderRepositories,
      Date.now() + RESOLVE_TIMEOUT_MS,
    );
    return ready ? held() : undefined;
  } catch (e) {
    log(`could not query the PR extension's repositories: ${errorMessage(e)}`);
    return undefined;
  }
}

/**
 * Warm what a reveal of `ref` will ask the PR extension for, and hand back the PR it resolved.
 *
 * Both commands in `ACTIONS` resolve the PR before doing anything else, and `pr.openDescription`
 * builds its webview panel only afterwards, so a resolve that misses is a round trip with an empty
 * editor area behind it. Resolving here on the same `useCache: true` terms fills the entry that
 * resolve reads, leaving the resolve the click blocks on a map lookup.
 *
 * This PR, its file list and the assignable-users list are the whole of what is worth a speculative
 * round trip: they are the only answers the PR extension remembers. The timeline, status checks,
 * review requests and mergeability re-query on every open, so warming those would spend the API quota
 * twice and save the click nothing.
 *
 * Undefined when nothing was warmed — no manager yet, no session, no route to GitHub — which is a
 * reason to try again rather than to remember this PR as warm.
 */
export async function warmPrModel(ref: OwnedPrRef): Promise<PrModel | undefined> {
  try {
    const manager = await signedInManager(ref);
    return await manager?.resolvePullRequest?.(ref.owner, ref.repo, ref.number, true);
  } catch (e) {
    log(`could not warm ${ref.owner}/${ref.repo}#${ref.number}: ${errorMessage(e)}`);
    return undefined;
  }
}

/**
 * Warm the file list `pr.openChanges` needs before it can open anything, which is what makes Diff
 * open locally. Split from `warmPrModel`, and taking its result rather than re-resolving, so a caller
 * can put its own decisions between the two: the model is what the page waits on, the file list only
 * serves a Diff that may never be clicked.
 */
export async function warmPrFiles(ref: OwnedPrRef, pr: PrModel): Promise<boolean> {
  // The same test the command itself makes, so a skip here is exactly the case where the click would
  // not fetch either. It earns its place twice over: the fetch below opens by clearing the map, so
  // re-running it on an already-warm PR would empty the very list the next click reads.
  if ((pr.fileChanges?.size ?? 0) > 0) {
    return true;
  }
  try {
    await pr.getFileChangesInfo?.();
    return true;
  } catch (e) {
    log(`could not warm the file list for #${ref.number}: ${errorMessage(e)}`);
    return false;
  }
}

/** Warm the one per-repo request a PR page blocks on that the PR extension remembers in both its
 *  manager and its global state, so the first page opened in a repo pays for it and no later one
 *  does. */
export async function warmAssignableUsers(repo: RepoId): Promise<boolean> {
  try {
    const manager = await signedInManager(repo);
    if (!manager) {
      return false;
    }
    await manager.getAssignableUsers?.();
    return true;
  } catch (e) {
    log(`could not warm assignable users for ${repo.owner}/${repo.repo}: ${errorMessage(e)}`);
    return false;
  }
}

/**
 * The manager to warm through, held back until there is a session: resolving without one reaches the
 * PR extension's `ensure()`, which prompts for a sign-in. That is a fine answer to a click and never
 * one to typing.
 *
 * Asked of the repos manager up front rather than of the folder manager the wait produces, because a
 * signed-out window keeps every repo out of the `gitHubRepositories` list that
 * `getManagerForRepository` matches on. Waiting first would spend the whole `RESOLVE_TIMEOUT_MS`, on
 * every guess, to learn what the credential store answers immediately.
 */
async function signedInManager(repo: RepoId): Promise<FolderManager | undefined> {
  const managers = reposManager(await prExtApi());
  if (managers?.credentialStore?.isAnyAuthenticated?.() !== true) {
    return undefined;
  }
  return waitForFolderManager(repo);
}

const prExtReady = new Map<string, Promise<void>>();
let unregisterWatch: vscode.Disposable | undefined;

/**
 * Wait until the GitHub PR extension can act on the git repo at `dir`: the repo registered with the
 * extension, and the extension's own repository managers built. Best-effort, so it gives up after
 * `READY_TIMEOUT_MS` and lets the caller fire anyway.
 *
 * Memoized per repo so the warm-up and the click that follows it share one wait. Entries are dropped
 * when the wait fails and whenever a repo unregisters, since readiness is only permanent for as long
 * as the repo stays in the workspace.
 */
export function waitForPrExtReady(dir: string): Promise<void> {
  // Resolved but not case-folded: two clones whose paths differ only in case are the same repo on a
  // case-insensitive filesystem and different repos elsewhere, and sharing readiness across two
  // real repos would skip the wait for one of them.
  const key = path.resolve(dir);
  const cached = prExtReady.get(key);
  if (cached) {
    return cached;
  }
  const wait = pollPrExtReady(dir).then(
    (ready) => {
      if (!ready) {
        prExtReady.delete(key);
      }
    },
    (e) => {
      prExtReady.delete(key);
      throw e;
    },
  );
  prExtReady.set(key, wait);
  return wait;
}

async function pollPrExtReady(dir: string): Promise<boolean> {
  phase('pr-ext-activate');
  const api = await prExtApi();
  watchUnregistration(api);
  const deadline = Date.now() + READY_TIMEOUT_MS;

  phase('pr-ext-register');
  const registered = () =>
    Array.isArray(api.repositories) &&
    api.repositories.some((r) => samePath(r.rootUri?.fsPath, dir));
  if (!(await waitUntil(registered, api.onDidOpenRepository, deadline))) {
    log(`the PR extension did not register ${dir} within ${READY_TIMEOUT_MS}ms`);
    return false;
  }

  // A registered repo is only half of it: the extension mirrors the git extension's repo list well
  // before it finishes building the managers its commands resolve PRs through.
  phase('pr-ext-managers');
  const managers = reposManager(api);
  if (!managers) {
    // Nothing to watch, so settle briefly and hope, which is all this code could do before the
    // manager surface was known.
    await delay(SETTLE_MS);
    return true;
  }
  const built = () => (managers.folderManagers?.length ?? 0) > 0;
  if (!(await waitUntil(built, managers.onDidChangeFolderRepositories, deadline))) {
    log(`the PR extension built no repository managers within ${READY_TIMEOUT_MS}ms`);
    return false;
  }
  return true;
}

/** Drop memoized readiness when a repo leaves, so a re-added folder waits again. */
function watchUnregistration(api: PrExtApi): void {
  if (unregisterWatch || typeof api.onDidCloseRepository !== 'function') {
    return;
  }
  // Coarse on purpose: re-waiting on an already-ready repo is cheap, holding a stale entry is not.
  unregisterWatch = api.onDidCloseRepository(() => prExtReady.clear());
}

/**
 * Resolve once `holds()` is true, woken by `subscribe`'s event when the API offers one and polled
 * regardless in case it does not fire. False if `deadline` passes first.
 */
function waitUntil(holds: () => boolean, subscribe: Subscribe | undefined, deadline: number): Promise<boolean> {
  // The predicates read the PR extension's undocumented API, and here they run from timer and event
  // callbacks: a throw would escape into the extension host and leave this promise pending for good.
  // "Can't tell" is the same answer as "not yet", and costs the deep link at worst.
  const test = () => {
    try {
      return holds();
    } catch {
      return false;
    }
  };
  if (test()) {
    return Promise.resolve(true);
  }
  const started = Date.now();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      sub?.dispose();
      clearTimeout(poll);
      clearTimeout(timer);
      resolve(test());
    };
    const tick = () => {
      if (test()) {
        finish();
        return;
      }
      const fast = Date.now() - started < POLL_FAST_WINDOW_MS;
      poll = setTimeout(tick, fast ? POLL_FAST_MS : POLL_SLOW_MS);
    };
    const sub = subscribe?.(() => test() && finish());
    poll = setTimeout(tick, POLL_FAST_MS);
    const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
  });
}
