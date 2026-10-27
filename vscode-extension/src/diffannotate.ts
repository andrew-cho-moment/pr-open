/**
 * Prefix every content line of a unified diff with its authoritative file line number, so a model
 * reading the diff transcribes a line number instead of computing one from hunk headers (arithmetic
 * LLMs get wrong, landing a review on the wrong line). Each line becomes `<marker><number> │ <code>`:
 * `+`/context lines carry their new-file number, `-` lines their old-file number. Headers and the
 * `\ No newline at end of file` marker pass through untouched.
 */

// Hunk header: start line and (optional, default 1) line count on each side.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function annotateDiff(diff: string): string {
  const width = maxLineNumber(diff).toString().length;
  const num = (n: number) => n.toString().padStart(width);

  let oldLine = 0;
  let newLine = 0;
  // Lines still owed to the current hunk per its header counts; both zero means the hunk is done, so
  // a following file's `---`/`+++` header (which start with `-`/`+`) is never taken for content.
  let oldLeft = 0;
  let newLeft = 0;
  const out: string[] = [];

  for (const line of diff.split('\n')) {
    const m = HUNK.exec(line);
    if (m) {
      oldLine = Number(m[1]);
      oldLeft = m[2] ? Number(m[2]) : 1;
      newLine = Number(m[3]);
      newLeft = m[4] ? Number(m[4]) : 1;
      out.push(line);
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      out.push(line); // outside any hunk: diff --git, index, ---, +++, rename/mode, Binary
      continue;
    }
    switch (line[0]) {
      case '+':
        out.push(`+${num(newLine++)} │ ${line.slice(1)}`);
        newLeft--;
        break;
      case '-':
        out.push(`-${num(oldLine++)} │ ${line.slice(1)}`);
        oldLeft--;
        break;
      case ' ':
        out.push(` ${num(newLine++)} │ ${line.slice(1)}`);
        oldLine++;
        oldLeft--;
        newLeft--;
        break;
      default:
        out.push(line); // "\ No newline at end of file" and any anomaly: no number, no advance
    }
  }
  return out.join('\n');
}

/** Largest line number the annotation will print, for right-aligning the number column. */
function maxLineNumber(diff: string): number {
  let max = 1;
  for (const line of diff.split('\n')) {
    const m = HUNK.exec(line);
    if (m) {
      const oldEnd = Number(m[1]) + (m[2] ? Number(m[2]) : 1) - 1;
      const newEnd = Number(m[3]) + (m[4] ? Number(m[4]) : 1) - 1;
      max = Math.max(max, oldEnd, newEnd);
    }
  }
  return max;
}
