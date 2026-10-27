import { AskAnchor, sameAnchor, Side } from './askanchor';
import { OwnedPrRef, repoSlug } from './prref';

/** The PR a question is asked against, and the tree it is read in: which repo, which two commits.
 *  Owner included, because a `gh` query about the PR takes both halves of `owner/repo` and the bare
 *  repo name a clone's folder carries supplies neither. */
export interface AskRepo extends OwnedPrRef {
  cloneDir: string;
  base: string;
  headOid: string;
  title: string;
  body: string;
}

/** The lines a question is aimed at, and their text as the editor shows them. */
export interface AskAim {
  anchor: AskAnchor;
  /** The aimed lines' source text, unnumbered; numbering happens here. Absent when the document
   *  behind them is not open. */
  code?: string;
}

/** One question, and the lines it is aimed at when the reviewer aimed it at any. */
export interface AskTurn {
  question: string;
  /** Absent for a question about the PR as a whole. */
  aim?: AskAim;
}

export interface AskPayloadInput extends AskTurn {
  repo: AskRepo;
  /** The whole PR diff, already run through `annotateDiff`. */
  annotatedDiff: string;
  /** Prior turns, replayed only when a resumed session was lost. */
  history?: readonly { question: string; answer: string }[];
}

/** A PR description past this is more boilerplate (templates, checklists) than intent. */
const MAX_BODY_CHARS = 4_000;

/**
 * Beyond this the full diff stops earning its tokens and the model reads what it needs at HEAD.
 * ~60k tokens, which leaves room alongside the system prompt on a 200k-context model. Set from
 * measurement: a 30-file feature PR annotates to ~135k chars, and dropping its diff costs the model
 * any view of the before state, so the ceiling has to sit well above that.
 */
const FULL_DIFF_BUDGET = 240_000;

/** Whether the full diff fits, so callers can report the fallback instead of silently truncating. */
export function diffFitsBudget(annotatedDiff: string): boolean {
  return annotatedDiff.length <= FULL_DIFF_BUDGET;
}

/** Enough to cover any range a reviewer selects on purpose. */
const MAX_ANCHOR_LINES = 200;

/** Prior answers are context, not the record; enough to keep a follow-up coherent. */
const MAX_HISTORY_ANSWER_CHARS = 1_200;

/**
 * The turn-1 stdin payload.
 *
 * With only Read/Grep/Glob and no Bash, the model cannot see the diff at all: it can read the
 * working tree at HEAD and has no way to learn what changed. So the diff is sent, and everything
 * that *is* reachable from cwd (whole files, history) is left out for it to fetch on demand.
 */
export function buildAskPayload(input: AskPayloadInput): string {
  const { repo, aim, annotatedDiff, question, history } = input;
  const out: string[] = [...repoSection(repo)];

  if (aim) {
    out.push('', ...anchorSection(aim));

    const patch = filePatchFor(annotatedDiff, aim.anchor.file);
    if (patch) {
      out.push('', `### DIFF: ${aim.anchor.file}`);
      out.push(patch);
    }
  }

  // Duplicating the anchored file's patch above is a few hundred bytes that keep the relevant hunks
  // next to the question instead of buried mid-diff.
  if (diffFitsBudget(annotatedDiff)) {
    out.push('', '### FULL PR DIFF');
    out.push(annotatedDiff);
  } else {
    out.push('', '### CHANGED FILES');
    out.push(
      // "anchored" rather than "aimed": `### ANCHOR` is the vocabulary the model was given.
      `This PR is too large to include in full, so you have ${aim ? "the anchored file's patch and " : ''}this list.`,
      'You can Read any of these at HEAD (the after state), but you have no view of their before',
      'state. Say so rather than guessing what a file used to contain.',
    );
    out.push(changedFileIndex(annotatedDiff));
  }

  if (history?.length) {
    out.push('', '### EARLIER IN THIS CONVERSATION');
    for (const turn of history) {
      out.push(`Q: ${turn.question}`);
      out.push(`A: ${cap(turn.answer, MAX_HISTORY_ANSWER_CHARS, '(truncated)')}`, '');
    }
  }

  out.push('', '### QUESTION', question.trim());
  return out.join('\n');
}

/**
 * What a follow-up says about where it is aimed, against the anchor its session was last shown.
 *
 * A resumed session still holds that anchor, so silence means "still those lines" and widening back
 * out to the whole PR has to be said out loud. Three cases rather than an optional anchor, because
 * "no anchor" on its own cannot tell a turn that repeats the aim from one that drops it.
 */
export type AimChange = { kind: 'unchanged' } | { kind: 'moved'; aim: AskAim } | { kind: 'released' };

/** What a turn does to the aim, given the anchor its session was last shown. */
export function aimChange(turn: AskTurn, sent: AskAnchor | undefined): AimChange {
  if (sameAnchor(turn.aim?.anchor, sent)) {
    return { kind: 'unchanged' };
  }
  return turn.aim ? { kind: 'moved', aim: turn.aim } : { kind: 'released' };
}

/**
 * A follow-up turn's stdin: the question, and an anchor block only when this turn aims somewhere the
 * conversation has not been told about. The repo, the PR and the diff are already in the resumed
 * session, so re-sending them would pay for the same tokens twice.
 */
export function buildFollowUpPayload(question: string, change: AimChange): string {
  const out: string[] = [];
  if (change.kind === 'moved') {
    out.push(...anchorSection(change.aim), '');
  } else if (change.kind === 'released') {
    out.push('### ANCHOR', 'none — this question is about the pull request as a whole.', '');
  }
  out.push('### QUESTION', question.trim());
  return out.join('\n');
}

/** Which tree the model is standing in, and which PR it is looking at. Every payload about a PR opens
 *  with this, so a run reading one is reading the same identity another one described. */
export function repoSection(repo: AskRepo): string[] {
  return [
    '### REPO',
    `slug: ${repoSlug(repo)}`,
    `checkout: ${repo.cloneDir}   (your cwd; the files on disk are this PR's "after" state)`,
    `head: ${repo.headOid}`,
    `merge-base: ${repo.base}`,
    '',
    `### PULL REQUEST #${repo.number}`,
    `title: ${repo.title}`,
    'description:',
    cap(repo.body.trim() || '(no description provided)', MAX_BODY_CHARS, '(description truncated)'),
  ];
}

/** Which lines a question is aimed at, and which revision their numbers belong to. */
function anchorSection({ anchor, code }: AskAim): string[] {
  const out = [
    '### ANCHOR',
    `file: ${anchor.file}`,
    `lines: ${anchor.startLine}-${anchor.endLine}`,
    `revision: ${revisionNote(anchor.side)}`,
  ];
  if (code !== undefined) {
    out.push('code:', numberLines(code, anchor.startLine));
  }
  return out;
}

/** Mistaking which revision an anchor's numbers belong to is the likeliest source of a confidently
 *  wrong answer, so this is a sentence rather than a label. */
function revisionNote(side: Side): string {
  return side === 'head'
    ? 'HEAD (after) — these numbers match the file on disk, so Read gives you exactly this content.'
    : 'MERGE BASE (before) — these numbers do NOT match the file on disk, which holds the after state. ' +
        "Use the annotated diff's `-` numbers for this content.";
}

/**
 * The section of a multi-file annotated diff covering one path, or '' when it is not in the diff.
 * Matches either side of the `diff --git` header, so a rename or delete is found under its old path.
 */
export function filePatchFor(annotatedDiff: string, file: string): string {
  const lines = annotatedDiff.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('diff --git ')) {
      continue;
    }
    if (start >= 0) {
      return lines.slice(start, i).join('\n').trimEnd();
    }
    if (headerNames(lines[i]).includes(file)) {
      start = i;
    }
  }
  return start >= 0 ? lines.slice(start).join('\n').trimEnd() : '';
}

/** The `a/x b/y` paths of a `diff --git` header, stripped of their prefixes. */
function headerNames(header: string): string[] {
  return header
    .slice('diff --git '.length)
    .split(' ')
    .map((p) => p.replace(/^[ab]\//, ''));
}

/** One line per changed file, for when the full diff is over budget. */
function changedFileIndex(annotatedDiff: string): string {
  const names = new Set<string>();
  for (const line of annotatedDiff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      for (const name of headerNames(line)) {
        names.add(name);
      }
    }
  }
  return [...names].map((n) => `- ${n}`).join('\n');
}

/** Prefix each line with its 1-based file line number, in the `<number> │ <code>` form the annotated
 *  diff uses, so a transcribed number means the same thing in both places. */
export function numberLines(text: string, startLine: number): string {
  const lines = text.replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, MAX_ANCHOR_LINES);
  const width = String(startLine + shown.length - 1).length;
  const out = shown.map((l, i) => `${String(startLine + i).padStart(width)} │ ${l}`);
  if (lines.length > shown.length) {
    out.push(`… (${lines.length - shown.length} more selected lines omitted)`);
  }
  return out.join('\n');
}

/** Truncate with a note, so a payload never trails off mid-sentence with nothing saying it did. */
export function cap(text: string, limit: number, note: string): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… ${note}`;
}
