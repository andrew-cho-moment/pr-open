import * as path from 'path';
import * as vscode from 'vscode';
import { originRepoId } from './git';
import { log } from './logger';
import { holdsRepoAt, waitForRepoAt } from './prext';
import { isGitRepo } from './resolver';
import { errorMessage, samePath } from './util';

/**
 * Getting the GitHub PR extension to take on a repo that reached this window after it started.
 *
 * That extension decides whether to hold a repository inside its `onDidOpenRepository` handler, and
 * under `autoRepositoryDetection: "workspace"` (its default) it drops any repo that sits outside a
 * workspace folder. The folder list it checks against is `workspace.workspaceFolders` read **once**,
 * during its own activation, and the handler closes over that snapshot: a folder added later is not
 * in it and never will be. pr-open adds repos as workspace folders mid-session (`workspace.ts`), so
 * every repo it brings in lands on the wrong side of a list that was fixed before it arrived.
 *
 * What that costs is everything the PR extension provides for the repo. The gutter `+` for review
 * comments, which pr-open leaves entirely to it (`askcomments.ts`), so a guided review of an ignored
 * repo has no way to leave one. And the folder manager `prext.ts` resolves every reveal and every
 * prefetch through, which degrades each of them to the OS deep link.
 *
 * Two steps, because the snapshot cannot be reached and the decision it feeds can. The setting is
 * re-read on every open event, so moving it to `true` drops the folder check entirely and makes the
 * extension take whatever the git extension opens. That alone settles every repo that arrives from
 * then on. What it cannot settle is a repo already dropped, whose decision has been made and will not
 * be revisited, and for that the repo is closed and opened again: `openRepository` on a repo the git
 * extension already holds returns it untouched, so the close is what makes a second event possible.
 */

const GIT_EXTENSION_ID = 'vscode.git';
const DETECTION_SETTING = 'githubPullRequests.autoRepositoryDetection';

/** Directories being adopted right now. Marked while in flight and never memoized: the folder edit and
 *  the review that follows it both ask, and they must share one close/re-open rather than race two.
 *  Once it settles the answer is the extension's to change, so a later ask starts over. */
const inFlight = new Set<string>();

/** Hand `dir` to the GitHub PR extension if it is ignoring the repo there. Fire and forget: see the
 *  module comment above for what it does, and `adopt` for why it reports nothing back. */
export function adoptRepo(dir: string): void {
  // Both callers pass a `uri.fsPath`, so one spelling reaches this and the key only has to resolve
  // relative segments, not reconcile two ways of naming one directory.
  const key = path.resolve(dir);
  if (inFlight.has(key)) {
    return;
  }
  inFlight.add(key);
  void adopt(dir).finally(() => inFlight.delete(key));
}

/** Best-effort throughout, and reported to the log rather than to the caller: nothing an ignored repo
 *  breaks is worth failing a folder edit or a review over, and both callers fire this and move on. */
async function adopt(dir: string): Promise<void> {
  try {
    if (!isGitRepo(dir)) {
      return; // every folder a window gains comes through here, and plenty of them hold no repo
    }
    const repo = await originRepoId(dir);
    if (!repo) {
      log(`adopt: no GitHub origin for ${dir}, so the PR extension can hold nothing for it`);
      return;
    }
    if (await holdsRepoAt(dir)) {
      return; // the ordinary case: the repo was in the window before the PR extension started
    }
    // Before waiting on a manager, not after: the wait below is only worth taking once the rule that
    // would refuse this repo is gone.
    const rule = await allowLateRepos();
    if (rule === FolderRule.InForce) {
      log(`adopt: ${DETECTION_SETTING} is "workspace" by choice, so the PR extension keeps ignoring ${dir}`);
      return;
    }
    // A rule that was already off is a repo the extension takes on its own, so give it the time to.
    // Only a repo it has had that long and still does not hold is one whose decision was made and
    // lost, which is the whole of what the close and re-open below repairs. Spending it on a manager
    // merely still being built would cost a reveal in flight the manager it is waiting on.
    if (rule === FolderRule.AlreadyOff && (await waitForRepoAt(dir))) {
      return;
    }
    const api = await gitApi();
    // An exact root match, never a containing repo: `git.close` resolves its argument through this
    // same list, and a near miss would close a repo nobody asked about.
    if (!api?.repositories.some((r) => samePath(r.rootUri?.fsPath, dir))) {
      return;
    }
    log(`adopt: the PR extension is ignoring ${repo.owner}/${repo.repo}; re-opening ${dir}`);
    await reopen(api, dir);
    // Awaited rather than fired: the `inFlight` mark is held for the whole build, which is what keeps
    // a second ask from closing and re-opening a repo whose manager is already on its way.
    const adopted = await waitForRepoAt(dir);
    log(`adopt: ${repo.owner}/${repo.repo} ${adopted ? 'adopted' : 'still not held'} after re-opening`);
  } catch (e) {
    log(`adopt: could not hand ${dir} to the PR extension: ${errorMessage(e)}`);
  }
}

/** Where the PR extension's workspace-folder rule stands once `allowLateRepos` has had its say. */
enum FolderRule {
  /** Off, and off because this call turned it off: a repo already dropped is still dropped. */
  JustDropped = 'just-dropped',
  /** Off before this call, so the extension takes on its own every repo the git extension opens. */
  AlreadyOff = 'already-off',
  /** Still in force, held there by a choice this does not overwrite. */
  InForce = 'in-force',
}

/**
 * Drop the PR extension's workspace-folder rule, globally and for good.
 *
 * Only the schema default is rewritten, and only to the one other value that schema offers. An
 * explicit `"workspace"` is a choice this knows nothing about — the user's, or a repo's
 * `.vscode/settings.json` — so it stays. Reading it off `inspect` rather than `get` is what tells the
 * two apart: `get` merges the scopes, so the default and a deliberate value read alike. It also
 * outranks: a workspace-scoped `"workspace"` survives a global write, which `get` would then keep
 * reporting, and the write would repeat on every folder add for as long as that workspace is open.
 *
 * Global rather than per-workspace, because the rule bites in every window pr-open adds a folder to,
 * and one write that holds beats one per workspace. What it costs is the PR extension resolving
 * repos the window does not hold, which is a few GraphQL calls against repos already on disk.
 */
async function allowLateRepos(): Promise<FolderRule> {
  const config = vscode.workspace.getConfiguration();
  if (config.get(DETECTION_SETTING) !== 'workspace') {
    return FolderRule.AlreadyOff;
  }
  const scopes = config.inspect(DETECTION_SETTING);
  if (
    scopes?.globalValue !== undefined ||
    scopes?.workspaceValue !== undefined ||
    scopes?.workspaceFolderValue !== undefined
  ) {
    return FolderRule.InForce;
  }
  await config.update(DETECTION_SETTING, true, vscode.ConfigurationTarget.Global);
  log(`adopt: set ${DETECTION_SETTING} = true, so the PR extension takes repos that arrive after it starts`);
  return FolderRule.JustDropped;
}

/**
 * Close `dir` and open it again, which is the only way to put the repo back in front of the PR
 * extension's handler.
 *
 * The window between the two is the one moment this can leave a repo worse than it found it, so a
 * re-open that fails says so where the user is rather than in a log: `git.close` persists the root in
 * the git extension's closed-repository list, so a repo left closed stays closed across reloads, and
 * the command that brings it back is not one a user would think to look for.
 *
 * Which means checking what `openRepository` returned, not just that it did not throw. It hands back
 * the repository it opened or `null`, and swallows every reason it might have declined — `git.enabled`
 * off, an ignored or unsafe repository, a dismissed trust prompt (verified in the git extension
 * shipped with VS Code 1.10x). A throw is the rarer path and reads the same here.
 */
async function reopen(api: GitApi, dir: string): Promise<void> {
  await vscode.commands.executeCommand('git.close', vscode.Uri.file(dir));
  const reopened = await api.openRepository(vscode.Uri.file(dir)).catch((e: unknown) => {
    log(`adopt: openRepository threw for ${dir}: ${errorMessage(e)}`);
    return null;
  });
  if (!reopened) {
    void vscode.window.showWarningMessage(
      `PR Open: could not re-open ${path.basename(dir)} in Source Control. Run "Git: Reopen Closed Repositories" to bring it back.`,
    );
    throw new Error(`the git extension declined to re-open ${dir}`);
  }
}

/**
 * The slice of the built-in Git extension's API this module uses, as `gitApi` has already verified it.
 * Feature-detected on the same terms as `prext.ts`: its `git.d.ts` ships inside that extension rather
 * than in a package we depend on, so a shape that has moved on reads as "can't tell" and costs the
 * re-open. Both members are required, because that is what passing `gitApi` means — a repo left closed
 * by an `openRepository` that quietly was not there is the one outcome worth making unrepresentable.
 */
interface GitApi {
  repositories: readonly { readonly rootUri?: vscode.Uri }[];
  /** Opens even a repo that has been closed, which is what `reopen` needs of it, and hands back the
   *  repository it opened or `null` — the only report of failure it makes; see `reopen`. */
  openRepository(uri: vscode.Uri): Promise<{ readonly rootUri?: vscode.Uri } | null>;
}

interface GitExports {
  getAPI?: (version: number) => GitApi;
}

/** The one place the shape above is checked. */
async function gitApi(): Promise<GitApi | undefined> {
  // VS Code caches activation, so repeat calls are free after the first.
  const exports = await vscode.extensions.getExtension<GitExports>(GIT_EXTENSION_ID)?.activate();
  const api = exports?.getAPI?.(1);
  return Array.isArray(api?.repositories) && typeof api.openRepository === 'function' ? api : undefined;
}
