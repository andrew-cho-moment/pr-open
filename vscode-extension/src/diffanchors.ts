import { DiffSide } from './prthreads';

/**
 * Which `(file, line, side)` triples GitHub will accept as review-comment anchors, read off the same
 * unified diff the model was shown.
 *
 * A review comment must land on a line the pull request's diff actually carries; one that does not
 * fails the whole mutation, taking every other finding with it. Checking here turns that into a
 * dropped finding and a log line. The line numbers match what `annotateDiff` prints, since both walk
 * the hunk headers the same way.
 */

// Hunk header: start line and (optional, default 1) line count on each side. Same shape as diffannotate.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** One hunk's reach on each side, inclusive. A multi-line comment may not straddle two of these. */
export interface HunkSpan {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** The commentable lines of one file: `right` is HEAD, `left` is the merge base. */
export interface FileAnchors {
  right: Set<number>;
  left: Set<number>;
  hunks: HunkSpan[];
}

export type DiffAnchors = ReadonlyMap<string, FileAnchors>;

/**
 * Index a unified diff by the lines each file exposes to a comment.
 *
 * Added and context lines are commentable on the right; deleted lines on the left. A context line is
 * deliberately **not** added to the left: GitHub documents the right side as covering "unchanged
 * lines" and says nothing about the left, and a finding about removed code is a finding about a `-`
 * line anyway, so the narrower set costs nothing and cannot provoke a rejection.
 *
 * Files key on their new path, falling back to the old one for a delete, which is the path GitHub
 * shows and therefore the path a comment must name.
 */
export function diffAnchors(diff: string): Map<string, FileAnchors> {
  const files = new Map<string, FileAnchors>();
  let current: FileAnchors | undefined;
  let oldPath: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  // Lines still owed to the current hunk. Both zero means we are between hunks, so a following
  // file's `---`/`+++` header is read as a header rather than as deleted and added content.
  let oldLeft = 0;
  let newLeft = 0;

  const open = (path: string): void => {
    current = files.get(path) ?? { right: new Set(), left: new Set(), hunks: [] };
    files.set(path, current);
  };

  for (const line of diff.split('\n')) {
    const m = HUNK.exec(line);
    if (m) {
      oldLine = Number(m[1]);
      oldLeft = m[2] ? Number(m[2]) : 1;
      newLine = Number(m[3]);
      newLeft = m[4] ? Number(m[4]) : 1;
      current?.hunks.push({
        oldStart: oldLine,
        oldEnd: oldLine + oldLeft - 1,
        newStart: newLine,
        newEnd: newLine + newLeft - 1,
      });
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      if (line.startsWith('diff --git ')) {
        current = undefined;
        oldPath = undefined;
      } else if (line.startsWith('--- ')) {
        oldPath = stripPrefix(line.slice(4));
      } else if (line.startsWith('+++ ')) {
        const newPath = stripPrefix(line.slice(4));
        const path = newPath ?? oldPath;
        if (path !== undefined) {
          open(path);
        }
      }
      continue;
    }
    switch (line[0]) {
      case '+':
        current?.right.add(newLine++);
        newLeft--;
        break;
      case '-':
        current?.left.add(oldLine++);
        oldLeft--;
        break;
      case ' ':
        current?.right.add(newLine++);
        oldLine++;
        oldLeft--;
        newLeft--;
        break;
      default:
        break; // "\ No newline at end of file" and any anomaly: no number, no advance
    }
  }
  return files;
}

/**
 * A diff header's path, or undefined for `/dev/null`. Strips git's `a/` and `b/` prefixes.
 *
 * `core.quotePath` is on by default, so a path holding a non-ASCII byte arrives C-quoted, as
 * `"b/caf\303\251.ts"`. Unquoting it is what lets the key match the path the model transcribes:
 * the model reads the same header and reports `café.ts`, and a mismatch drops every finding in the
 * file with only a log line to show for it.
 */
function stripPrefix(raw: string): string | undefined {
  const path = unquote(raw.split('\t')[0].trim());
  if (path === '' || path === '/dev/null') {
    return undefined;
  }
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

/** Decode git's C-style quoting: octal escapes are UTF-8 bytes, so they are decoded as a group. */
function unquote(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) {
    return raw;
  }
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      bytes.push(...new TextEncoder().encode(body[i]));
      continue;
    }
    const escape = body[++i];
    const octal = /[0-7]/.test(escape) ? body.slice(i, i + 3) : undefined;
    if (octal && octal.length === 3 && /^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 2;
      continue;
    }
    const named: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 };
    bytes.push(named[escape] ?? new TextEncoder().encode(escape)[0]);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Whether a single-line comment on `path:line` on `side` lands on the diff. */
export function isAnchorLegal(anchors: DiffAnchors, path: string, line: number, side: DiffSide): boolean {
  const file = anchors.get(path);
  if (!file) {
    return false;
  }
  return (side === DiffSide.Right ? file.right : file.left).has(line);
}

/**
 * Whether a multi-line comment spanning `startLine`..`line` lands on the diff. Both ends must be
 * commentable and must sit in one hunk: a range across a gap covers lines the diff never showed.
 */
export function isRangeLegal(
  anchors: DiffAnchors,
  path: string,
  startLine: number,
  line: number,
  side: DiffSide,
): boolean {
  if (startLine > line) {
    return false;
  }
  if (!isAnchorLegal(anchors, path, startLine, side) || !isAnchorLegal(anchors, path, line, side)) {
    return false;
  }
  const hunks = anchors.get(path)?.hunks ?? [];
  return hunks.some((h) => {
    const [lo, hi] = side === DiffSide.Right ? [h.newStart, h.newEnd] : [h.oldStart, h.oldEnd];
    return startLine >= lo && line <= hi;
  });
}
