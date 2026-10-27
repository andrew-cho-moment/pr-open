import * as vscode from 'vscode';
import { adoptRepo } from './adopt';
import {
  AddedFolder,
  FolderSlot,
  MAX_ADDED,
  pickActiveDir,
  pickStartupDrops,
  pickVictim,
} from './folders';
import { log } from './logger';
import { isGitRepo } from './resolver';
import { isUnder, samePath } from './util';

/**
 * Holding repos as workspace folders, so showing a PR does not reload the window.
 *
 * Replacing the workspace to reach a clone costs a full reload: VS Code pins `workspace.rootPath` to
 * folder 0, so it restarts the extension host whenever that folder changes, taking every cache and
 * the GitHub PR extension's warmed state with it. Appending a folder instead leaves folder 0 alone,
 * so the host survives and each repo visited stays warm. The cost is a window that accumulates
 * roots, which `pickVictim` bounds.
 */

const ADDED_KEY = 'prOpen.addedFolders';

/** Absolute paths of this window's workspace folders. */
export function workspaceDirs(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

export function hasWorkspaceFolder(dir: string): boolean {
  return workspaceDirs().some((d) => samePath(d, dir));
}

/** What placing a folder did. `restarting` means the extension host is going down with the edit, and
 *  `failed` that VS Code refused it, leaving the caller to open the folder outright. */
export type Placement = 'present' | 'added' | 'restarting' | 'failed';

/**
 * Make `dir` a workspace folder for an action the user asked for, displacing the least recently shown
 * repo when the window is full.
 *
 * `beforePossibleRestart` runs, and is awaited, when the edit will take the extension host with it:
 * nothing in memory survives that, so work which must outlive it can only be persisted first. Doing
 * it here rather than asking the caller to check is what keeps the ordering from being a precondition
 * a second caller can forget.
 */
export function ensureWorkspaceFolder(
  context: vscode.ExtensionContext,
  dir: string,
  beforePossibleRestart: () => Promise<void>,
): Promise<Placement> {
  return serialized(async () => {
    if (hasWorkspaceFolder(dir)) {
      void touch(context, dir);
      return 'present';
    }
    const restarting = placingRestartsHost();
    if (restarting) {
      await beforePossibleRestart();
    }
    const folders = folderSlots();
    const placed = apply(context, dir, folders, pickVictim(folders, readAdded(context), chosen));
    return placed === 'added' && restarting ? 'restarting' : placed;
  }, edited);
}

/** Whether a placement result means VS Code has a folder edit to settle. */
function edited(placed: Placement): boolean {
  return placed === 'added' || placed === 'restarting';
}

/**
 * Make `dir` a workspace folder on a guess, or decline. A guess may add to what the window holds and
 * nothing more: it never restarts the host, and it never displaces a folder, since the repo it would
 * drop is one the user chose and this one is one they merely might. A saved workspace declines
 * outright, because its folder list is a file on disk.
 */
export function offerWorkspaceFolder(
  context: vscode.ExtensionContext,
  dir: string,
): Promise<'present' | 'added' | 'declined' | 'failed'> {
  return serialized(async () => {
    if (hasWorkspaceFolder(dir)) {
      void touch(context, dir);
      return 'present';
    }
    const folders = folderSlots();
    // A guess declines the moment the window is full: it protects nothing, because it never displaces
    // a folder, so a full window means decline rather than grow past the cap for a repo the user merely
    // might want.
    if (savedWorkspace() || pickVictim(folders, readAdded(context), undefined) || placingRestartsHost()) {
      return 'declined';
    }
    return apply(context, dir, folders, undefined);
  }, (placed) => placed === 'added');
}

/**
 * Trim pr-open's folders back to `MAX_ON_STARTUP` as the window opens, newest kept. See that constant
 * for what each surviving folder costs, and so why the startup cap is tighter than `MAX_ADDED`.
 *
 * A saved workspace is left alone, on the same grounds as `offerWorkspaceFolder`: its folder list is a
 * file the user may have committed, and a window opening is not an action they asked for, so this is
 * not a trim worth leaving in their `git status`.
 *
 * One removal at a time, because `updateWorkspaceFolders` refuses an edit while an earlier one is
 * unsettled — and the pick is taken again before each one rather than walked from a single list. The
 * window can be opening on a deep link, so a reveal can land between two removals, and re-reading is
 * what lets the folder it claims win: `noteActiveChoice` protects it and `touch` makes it the newest.
 * `tried` is what ends the loop, since a folder that refuses to go stays a candidate.
 *
 * Best-effort: a folder that will not go is one the user still has, which is no worse than the state
 * this trims from.
 */
export async function trimAddedFolders(context: vscode.ExtensionContext): Promise<void> {
  if (savedWorkspace()) {
    return;
  }
  const tried = new Set<string>();
  for (;;) {
    const next = pickStartupDrops(folderSlots(), readAdded(context), chosen).find(
      (slot) => !tried.has(slot.dir),
    );
    if (!next) {
      return;
    }
    tried.add(next.dir);
    const released = await releaseWorkspaceFolder(next.dir);
    log(`workspace: startup trim ${released} ${next.dir}`);
  }
}

/** What releasing a folder did. `root` means `dir` is folder 0: VS Code pins `workspace.rootPath`
 *  to it, so removing it restarts the extension host, which the caller would rather not take. */
export type Release = 'released' | 'absent' | 'root' | 'refused';

/**
 * Drop `dir` from this window's folders, for a directory that is about to stop existing. The
 * directory is free to go on everything but `root` and `refused`.
 *
 * The outcomes stay distinct rather than collapsing to a boolean so the caller can say which one it
 * hit, and so only `released` waits on a settle — `absent` edited nothing, and waiting for a folder
 * change that will never come costs the full `SETTLE_TIMEOUT_MS` while holding the edit lock.
 */
export function releaseWorkspaceFolder(dir: string): Promise<Release> {
  return serialized(async () => {
    const slot = folderSlots().find((f) => samePath(f.dir, dir));
    if (!slot) {
      return 'absent';
    }
    if (slot.index === 0) {
      return 'root';
    }
    if (!vscode.workspace.updateWorkspaceFolders(slot.index, 1)) {
      log(`workspace: VS Code refused to remove ${dir}`);
      return 'refused';
    }
    // No bookkeeping to undo: `prune` keeps the added-folder list to what the window still holds,
    // so this entry goes with the next write to it.
    return 'released';
  }, (result) => result === 'released');
}

/**
 * A window whose folder list is a `.code-workspace` file rather than window state: VS Code writes
 * every folder edit back to that file, which the user may well have committed and shared. A
 * deliberate action may edit it, the way VS Code's own "Add Folder to Workspace" does. A guess from a
 * hover may not, which is the one thing that separates the two placement paths here from each other.
 *
 * The scheme, not just the presence: VS Code also sets `workspaceFile` for an *untitled* workspace,
 * whose folder list lives in its own storage and reaches no file the user owns. That is the shape a
 * window takes the moment pr-open makes a single-folder window multi-root, so reading presence alone
 * would treat every window pr-open has ever placed a folder in as a file on disk.
 */
function savedWorkspace(): boolean {
  const file = vscode.workspace.workspaceFile;
  return file !== undefined && file.scheme !== 'untitled';
}

let settling: Promise<void> = Promise.resolve();

/**
 * Run one folder edit at a time, each waiting for VS Code to apply its edit before the next begins.
 *
 * `updateWorkspaceFolders` is refused while an earlier edit is still unsettled, and being refused
 * costs the window reload this whole path exists to avoid. Two placements overlapping is the ordinary
 * case, not a rare one: a hover warms one repo while the click that follows lands in another. The old
 * design got this serialization from `vscode.openFolder`, which VS Code sequenced itself.
 *
 * `edited` reports whether the outcome actually changed the folder list, since only then is there
 * anything to settle. Asking the caller keeps "what happened" and "does it need to settle" apart:
 * reading it back off the result meant a removal had to describe itself as a placement to be waited
 * for.
 */
async function serialized<T>(edit: () => Promise<T>, edited: (result: T) => boolean): Promise<T> {
  const earlier = settling;
  let done!: () => void;
  settling = new Promise<void>((resolve) => {
    done = resolve;
  });
  try {
    await earlier;
    const result = await edit();
    if (edited(result)) {
      await folderChange();
    }
    return result;
  } finally {
    done();
  }
}

/** How long to wait for a folder edit to land before letting the next one go anyway. */
const SETTLE_TIMEOUT_MS = 2_000;

/** Resolves when VS Code has applied a folder edit. The timeout keeps a missing event from wedging
 *  every later placement — including the restart case, where the host goes down with the edit and no
 *  event is ever delivered. */
function folderChange(): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = () => {
      sub.dispose();
      clearTimeout(timer);
      resolve();
    };
    const sub = vscode.workspace.onDidChangeWorkspaceFolders(finish);
    const timer = setTimeout(finish, SETTLE_TIMEOUT_MS);
  });
}

/**
 * Whether adding a folder changes folder 0, and so restarts the host. Two cases qualify: an empty
 * window has no folder 0 yet, so the first one added becomes it; and a single-folder window with no
 * workspace file has to become a multi-root workspace to hold a second. Anything already multi-root
 * just gains a folder, saved workspace file or not. Both callers have established that the folder is
 * not already held, which is the remaining way this is free.
 */
function placingRestartsHost(): boolean {
  const count = folderSlots().length;
  return count === 0 || (!vscode.workspace.workspaceFile && count === 1);
}

/** Land `dir`, taking `victim`'s slot when there is one. */
function apply(
  context: vscode.ExtensionContext,
  dir: string,
  folders: FolderSlot[],
  victim: FolderSlot | undefined,
): 'added' | 'failed' {
  const uri = vscode.Uri.file(dir);
  // One edit, even when a folder has to go: replacing the victim in place both frees its slot and
  // lands the new folder, so eviction needs no edit of its own to be refused for arriving too early.
  // Edits across separate placements are what `serialized` keeps apart.
  const applied = victim
    ? vscode.workspace.updateWorkspaceFolders(victim.index, 1, { uri })
    : vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri });
  if (!applied) {
    log(`workspace: VS Code refused to add ${dir}`);
    return 'failed';
  }
  if (victim) {
    log(`workspace: dropped ${victim.dir} to stay under ${MAX_ADDED} added folders`);
  }
  // Not awaited: the reveal this precedes does not depend on it, and losing the write costs one
  // missed eviction rather than anything the user sees.
  void claim(context, dir, victim?.dir);
  return 'added';
}

/** Record `dir` as a folder pr-open holds, releasing the one it displaced. */
async function claim(
  context: vscode.ExtensionContext,
  dir: string,
  dropped: string | undefined,
): Promise<void> {
  const added = prune(readAdded(context)).filter(
    (a) => !samePath(a.dir, dir) && (dropped === undefined || !samePath(a.dir, dropped)),
  );
  added.push({ dir, at: Date.now() });
  await context.workspaceState.update(ADDED_KEY, added);
}

/**
 * The repo the panel reports on, held as two ranked signals rather than one slot.
 *
 * `chosen` is the repo the user acted on by opening or checking out its PR; `focused` is the repo the
 * active editor's file lives under. Two variables rather than one because editor focus re-fires every
 * time an old editor re-surfaces behind a reveal's webview: merged into a single slot it would clobber
 * the checkout a second later, so the slots stay apart and `pickActiveDir` ranks `chosen` first.
 *
 * Both are deliberately separate from the `at` stamps. Those rank *pr-open's own* folders for eviction
 * and must keep ignoring the folder the user opened the window with, which is not ours to drop. That
 * same folder can perfectly well be the one they are working in.
 */
let chosen: string | undefined;
let focused: string | undefined;

/** The last answer announced, so the event can fire on the answer rather than on its inputs. */
let announced: string | undefined;

const activeFolder = new vscode.EventEmitter<void>();

/**
 * Fires when the repo the panel speaks for changes.
 *
 * On the derived answer rather than on its inputs, because three move it: the repo the user chose, the
 * repo their editor is in, and the window's folder list. Evicting a review tree can drop the active
 * repo out from under the status block, which watching the choice alone would miss; and a write that
 * leaves the answer alone costs no refresh, which matters because a refresh is a `gh` round trip.
 */
export const onDidChangeActiveFolder = activeFolder.event;

/** Record `dir` as the repo the user acted on, for a reveal they asked for. Outranks editor focus. */
export function noteActiveChoice(dir: string): void {
  chosen = dir;
  announceActive();
}

/** Record `dir` as the repo the active editor is in: a hint, used only when no choice is live. */
export function noteFocusedDir(dir: string): void {
  focused = dir;
  announceActive();
}

/** The repo the panel speaks for, or undefined when the window holds none. */
export function activeDir(): string | undefined {
  return pickActiveDir(gitWorkspaceDirs(), chosen, focused);
}

/** This window's folders that are git repos. */
export function gitWorkspaceDirs(): string[] {
  return workspaceDirs().filter(isGitRepo);
}

// Both sides come from `gitWorkspaceDirs()`, i.e. the same `uri.fsPath` strings, so `===` is enough.
function announceActive(): void {
  const now = activeDir();
  if (now === announced) {
    return;
  }
  announced = now;
  activeFolder.fire();
}

/**
 * Follow the active editor, for the two things that depend on where the user is.
 *
 * Eviction ranking, so it stays on what the user is *using* rather than on what pr-open last
 * revealed: a repo revealed an hour ago and worked in ever since would otherwise be the least
 * recently shown folder, and so the next one dropped — out of the Explorer, out of Source Control,
 * watchers and search scope with it, while its files are open. Any folder counts here, git repo or
 * not, since any of them can be one pr-open added.
 *
 * And the active repo, which the status block reports on. That one takes git repos only, so a docs
 * folder in the window cannot make the status read "no repo" while a review is in progress.
 */
export function trackActiveFolder(context: vscode.ExtensionContext): vscode.Disposable {
  // Seed the mirror with the answer that already holds, so the first note or folder edit does not
  // fire a change the webview's own `ready` refresh has already covered.
  announced = activeDir();
  return vscode.Disposable.from(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const file = editor?.document.uri.fsPath;
      const dir = file ? workspaceDirs().find((d) => isUnder(d, file)) : undefined;
      if (!dir) {
        return;
      }
      void touch(context, dir);
      if (isGitRepo(dir)) {
        noteFocusedDir(dir); // a hint, never the explicit choice: it may be a stale editor re-surfacing
      }
    }),
    // The other input: a folder edit can drop the repo the status block is describing.
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      announceActive();
      // A repo that arrives after the GitHub PR extension started is one it ignores, whoever added
      // the folder. Wired to the event rather than to the two placement call sites so a third one
      // cannot forget it, and so folders the user adds themselves are covered too.
      for (const folder of e.added) {
        adoptRepo(folder.uri.fsPath);
      }
    }),
  );
}

/** Note that `dir` was used just now, so eviction prefers repos the user has moved away from. A
 *  folder the user opened themselves stays untracked: it is not ours to evict, so not ours to rank. */
async function touch(context: vscode.ExtensionContext, dir: string): Promise<void> {
  const added = readAdded(context);
  const entry = added.find((a) => samePath(a.dir, dir));
  if (!entry) {
    return;
  }
  entry.at = Date.now();
  await context.workspaceState.update(ADDED_KEY, prune(added));
}

/** Drop entries for folders this window no longer holds: the list is per-window state, so a stale
 *  entry can only grow it. */
function prune(added: AddedFolder[]): AddedFolder[] {
  return added.filter((a) => hasWorkspaceFolder(a.dir));
}

function readAdded(context: vscode.ExtensionContext): AddedFolder[] {
  const stored = context.workspaceState.get<unknown>(ADDED_KEY);
  return Array.isArray(stored) ? stored.filter(isAddedFolder) : [];
}

function isAddedFolder(value: unknown): value is AddedFolder {
  const folder = value as AddedFolder | undefined;
  return typeof folder?.dir === 'string' && typeof folder.at === 'number';
}

function folderSlots(): FolderSlot[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f, index) => ({ index, dir: f.uri.fsPath }));
}
