import * as path from 'path';

/** Characters of file listing a repo tour's input carries. The model has Glob and Grep for the rest,
 *  so the listing only has to orient it, and a bigger one buys slower first steps. */
export const REPO_TOUR_LISTING_BUDGET = 60_000;

/**
 * The repo tour's input: the repo's name and an orienting listing of what HEAD tracks.
 *
 * Every path when they fit the budget. Otherwise one line per directory with its file count, which
 * keeps a repo that vendors tens of thousands of files to a map the model can read in one pass; the
 * directories are cut at the budget as a last resort, with a line saying how many were left out.
 */
export function repoTourPayload(repo: string, files: readonly string[]): string {
  const header = [`### REPOSITORY ${repo}`, `HEAD tracks ${files.length} files.`, ''];
  const all = files.join('\n');
  if (all.length <= REPO_TOUR_LISTING_BUDGET) {
    return [...header, '### TRACKED FILES', all].join('\n');
  }
  const counts = new Map<string, number>();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const lines: string[] = [];
  let length = 0;
  for (const [dir, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    const line = `${dir}/ (${n} files)`;
    if (length + line.length + 1 > REPO_TOUR_LISTING_BUDGET) {
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  if (lines.length < counts.size) {
    lines.push(`... ${counts.size - lines.length} more directories; use Glob to list them.`);
  }
  return [...header, '### TRACKED DIRECTORIES (too many files to list; use Glob to see inside one)', ...lines].join(
    '\n',
  );
}
