import * as fs from 'fs';
import * as path from 'path';
import { RepoId } from './prref';

const IGNORE_DIRS = new Set(['node_modules', 'vendor', '.terraform']);

export interface Clone {
  /** Absolute path to the clone. */
  dir: string;
  /** Folder name (equals the GitHub repo name for standard clones). */
  folder: string;
  /** Repo slug from the `origin` remote, if readable; else the folder name. */
  slug: string;
  /**
   * Canonical owner from the `origin` remote (e.g. `moment-technology`), if readable. The
   * deep link must use this, not the PR URL's shorthand owner, so the PR extension matches
   * the checked-out repo's manager.
   */
  owner?: string;
}

/** The owner/repo the PR extension matches a clone's manager on: the `origin` slug rather than the
 *  folder name, because the extension matches the repo `origin` points at. Undefined when `origin`
 *  was unreadable, which is the one case the extension can resolve nothing through. */
export function repoId(clone: Clone): RepoId | undefined {
  return clone.owner ? { owner: clone.owner, repo: clone.slug } : undefined;
}

/** Extract owner + repo slug from an `origin` URL (ssh or https), minus `.git`. */
export function parseRemote(url: string): { owner: string; slug: string } | undefined {
  const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\s*$/i.exec(url.trim());
  return m ? { owner: m[1], slug: m[2] } : undefined;
}

/** Read `origin` from `<dir>/.git/config` without spawning git. Returns undefined if unreadable. */
function readOrigin(dir: string): { owner: string; slug: string } | undefined {
  const gitPath = path.join(dir, '.git');
  let cfgPath: string;
  try {
    const st = fs.statSync(gitPath);
    if (!st.isDirectory()) {
      return undefined; // worktree/submodule pointer file; skip remote read
    }
    cfgPath = path.join(gitPath, 'config');
  } catch {
    return undefined;
  }
  let text: string;
  try {
    text = fs.readFileSync(cfgPath, 'utf8');
  } catch {
    return undefined;
  }
  // Find the [remote "origin"] section's url line.
  const section = /\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/.exec(text);
  if (!section) {
    return undefined;
  }
  const url = /^\s*url\s*=\s*(.+)$/m.exec(section[1]);
  return url ? parseRemote(url[1]) : undefined;
}

/** Whether `dir` is a git checkout: a `.git` directory, or a worktree's `.git` pointer file. */
export function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/** Scan each root's direct children for git clones. */
export function scanClones(roots: string[]): Clone[] {
  const clones: Clone[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) {
        continue;
      }
      const dir = path.join(root, e.name);
      if (seen.has(dir) || !isGitRepo(dir)) {
        continue;
      }
      seen.add(dir);
      const origin = readOrigin(dir);
      clones.push({ dir, folder: e.name, slug: origin?.slug ?? e.name, owner: origin?.owner });
    }
  }
  return clones;
}

/**
 * Resolve a repo name to a local clone. Matches on the repo NAME, never the owner: PR URLs
 * use the shorthand org (`moment/...`) while clones point at the canonical org
 * (`moment-technology/...`). Prefers an `origin` slug match, falls back to folder name.
 */
export function resolveClone(repo: string, clones: readonly Clone[]): Clone | undefined {
  const target = repo.toLowerCase();
  return (
    clones.find((c) => c.slug.toLowerCase() === target) ??
    clones.find((c) => c.folder.toLowerCase() === target)
  );
}
