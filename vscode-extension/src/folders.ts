import { samePath } from './util';

/**
 * Pure rules over this window's folder list: which repos it should keep, and which one is active.
 *
 * Split from `workspace.ts`, which enacts these decisions through the VS Code API: the rule about
 * what may be dropped is worth stating (and testing) on its own, since getting it wrong takes a
 * folder the user was working in.
 */

/**
 * How many folders pr-open keeps at once. A constant rather than a setting: the useful value is
 * "enough that bouncing between repos stays warm", and each added folder costs a git watcher and
 * widens the default search scope, so there is nothing here a user would want to tune.
 *
 * Three is the working set a stacked change spans — the repo in front of you and the two either side
 * of it — and two is the floor the protections below allow, since the folder the status block is on
 * is never a candidate.
 */
export const MAX_ADDED = 3;

/**
 * How many survive a window opening, which is a different question. A folder pr-open added is written
 * into a saved workspace and comes back with the next launch, so what the cap bounds within a session
 * accumulates across them: every one of them is a git watcher, a search root and a repository the
 * GitHub PR extension resolves, all paid before the window is usable and most of it for repos the
 * next PR will not touch. One is enough to open into, and the others are one reveal away.
 */
export const MAX_ON_STARTUP = 1;

/** A folder pr-open added, with when it was last shown. */
export interface AddedFolder {
  dir: string;
  at: number;
}

/** A workspace folder as the pruner sees it. */
export interface FolderSlot {
  index: number;
  dir: string;
}

/**
 * Which folder to drop to make room for one more, or undefined while there is room.
 *
 * Three folders are never candidates. Index 0, because changing it restarts the extension host, which
 * is the reload this whole path exists to avoid. Any folder pr-open did not add itself, so the folder
 * the user opened the window with cannot be taken from them. And `protect`, the repo the status block
 * currently speaks for, since evicting it is the same silent revert this whole area exists to prevent.
 *
 * `protect` and index 0 remove at most two folders from the owned set, so at the `MAX_ADDED` cap a
 * victim always remains; should protection ever empty the candidates, the undefined return routes back
 * through the same append path used under the cap.
 */
export function pickVictim(
  folders: FolderSlot[],
  added: AddedFolder[],
  protect: string | undefined,
): FolderSlot | undefined {
  const owned = ownedFolders(folders, added);
  if (owned.length < MAX_ADDED) {
    return undefined;
  }
  return owned
    .filter((o) => o.slot.index > 0 && !samePath(protect, o.slot.dir))
    .sort((a, b) => a.at - b.at)[0]?.slot;
}

/**
 * Which of pr-open's folders to drop when a window opens, most recently shown last to go.
 *
 * The same three protections `pickVictim` describes. `protect` matters here even though the window is
 * still opening: a deep link that opened it reveals a PR while the trim is still running, and the
 * folder that reveal claims must survive the removals that follow it.
 *
 * What is particular to this one is that folder 0 can leave more than `MAX_ON_STARTUP` standing, which
 * is the right trade — one extra folder costs a watcher, and dropping folder 0 costs the window.
 */
export function pickStartupDrops(
  folders: FolderSlot[],
  added: AddedFolder[],
  protect: string | undefined,
): FolderSlot[] {
  return ownedFolders(folders, added)
    .sort((a, b) => b.at - a.at)
    .slice(MAX_ON_STARTUP)
    .map((o) => o.slot)
    // Filtered after the slice, not before: a protected folder counts toward the cap, so a window that
    // opens on one of pr-open's folders keeps that one and no second. Reordering these two silently
    // doubles the startup folder count.
    .filter((slot) => slot.index > 0 && !samePath(protect, slot.dir));
}

/**
 * This window's folders that pr-open added, each with when it was last shown.
 *
 * The one place a slot is matched to its record, since that is the relation both pickers rest on: it
 * decides what may be dropped, so `samePath` rather than `===` (a folder list and a stored path can
 * differ in case alone), and a folder pr-open did not add has no record and so is never a candidate.
 */
function ownedFolders(
  folders: FolderSlot[],
  added: AddedFolder[],
): { slot: FolderSlot; at: number }[] {
  return folders.flatMap((slot) => {
    const at = added.find((a) => samePath(a.dir, slot.dir))?.at;
    return at === undefined ? [] : [{ slot, at }];
  });
}

/**
 * Which repo the panel speaks for: the one the user chose, the one their editor is in, or the
 * window's first, in that order.
 *
 * Two signals, ranked rather than merged. `chosen` is the repo the user acted on by opening or
 * checking out its PR; it outranks everything so a stale editor-focus event cannot pull the panel off
 * a checkout the user just asked for. `focused`, the repo the active editor's file lives under, only
 * answers when there is no live choice, which is what lets a fresh window follow the editor.
 *
 * Folder order cannot supply this on its own. VS Code lists folders in the order they were appended,
 * with evicted slots reused in place, so "the first folder holding a PR" is whichever repo pr-open
 * happened to reveal earliest rather than the one in front of the user.
 *
 * `repos` holds only git repos, so a folder with no checkout can never become the answer.
 */
export function pickActiveDir(
  repos: string[],
  chosen: string | undefined,
  focused: string | undefined,
): string | undefined {
  return (
    repos.find((dir) => samePath(chosen, dir)) ??
    repos.find((dir) => samePath(focused, dir)) ??
    repos[0]
  );
}
