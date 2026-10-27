/** A GitHub repository by the owner and name the PR extension matches its managers on. */
export interface RepoId {
  owner: string;
  repo: string;
}

/**
 * A pull request identified by repo + number. `owner` is optional: the repo+number entry
 * path has no owner (it's derived from the resolved clone's `origin`).
 */
export interface PrRef {
  owner?: string;
  repo: string;
  number: number;
}

/** A ref with a known owner: ready to build a URL / deep link, and to name the repo on its own. */
export type OwnedPrRef = PrRef & RepoId;

const URL_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const OWNER_SHORT_RE = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;
const BARE_SHORT_RE = /^([^/\s#]+)#(\d+)$/;

/** Parse a PR URL, `owner/repo#123`, or bare `repo#123` (owner left undefined). */
export function parsePrRef(input: string): PrRef | undefined {
  const s = input.trim();
  const url = URL_RE.exec(s);
  if (url) {
    return { owner: url[1], repo: stripGit(url[2]), number: Number(url[3]) };
  }
  const owned = OWNER_SHORT_RE.exec(s);
  if (owned) {
    return { owner: owned[1], repo: stripGit(owned[2]), number: Number(owned[3]) };
  }
  const bare = BARE_SHORT_RE.exec(s);
  if (bare) {
    return { repo: stripGit(bare[1]), number: Number(bare[2]) };
  }
  return undefined;
}

function stripGit(repo: string): string {
  return repo.replace(/\.git$/i, '');
}

/** Canonical PR URL, in the exact shape the GitHub PR extension's URI parser accepts. */
export function prUrl(ref: OwnedPrRef): string {
  return `https://github.com/${repoSlug(ref)}/pull/${ref.number}`;
}

/** `owner/repo`, the one string GitHub names a repository by. */
export function repoSlug(id: RepoId): string {
  return `${id.owner}/${id.repo}`;
}
