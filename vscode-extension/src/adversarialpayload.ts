import { AskRepo, cap, repoSection } from './askpayload';
import { DiffSide } from './prthreads';
import { Appended, AppendedKind } from './userinstructions';
import { ReviewFinding } from './prreview';

/**
 * What an adversarial review is handed, and what it is allowed to hand back.
 *
 * Validation rejects rather than repairs, for the same reason `validateThreadResult` does: a finding
 * naming a line the diff never showed is a comment GitHub refuses, and guessing at where the model
 * meant would file a bug report on unrelated code.
 */

/** A body past this is a design document, not a review comment. */
const MAX_BODY_CHARS = 2_000;

export interface AdversarialPayloadInput {
  repo: AskRepo;
  annotatedDiff: string;
}

export function buildAdversarialPayload({ repo, annotatedDiff }: AdversarialPayloadInput): string {
  return [...repoSection(repo), '', '### FULL PR DIFF', annotatedDiff].join('\n');
}

/**
 * A backtick run longer than any inside `text`, so a fence built from it cannot be closed early by
 * the shell snippets a CLAUDE.md is mostly made of.
 */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** One appended section: its heading, what it governs, then the reader's own text, fenced. */
function quoted(heading: string, governs: readonly string[], text: string): string[] {
  const fence = fenceFor(text);
  return ['', `## ${heading}`, '', ...governs, '', fence, text, fence];
}

/**
 * What a block carrying a design standard does not govern. `GOVERNS_VOICE` ends on a wider claim
 * instead, and deliberately: a standard governs design findings, where a voice governs no kind of
 * finding at all.
 */
const GOVERNS_TAIL = [
  'It governs nothing else: not the output format, not the anchoring rules, not what counts as a',
  'correctness or style finding.',
];

const GOVERNS_STANDARD = [
  "The fenced text below is a section of the reader's `CLAUDE.md`. Judge a design finding against",
  'it: code that breaks one of its rules costs this reader something, and that cost is the finding.',
  ...GOVERNS_TAIL,
];

const GOVERNS_VOICE = [
  "The fenced text below is a section of the reader's `CLAUDE.md`. Follow it for the voice and",
  "phrasing of a finding's `body`. It governs nothing else: not the output format, not the",
  'anchoring rules, not what counts as a finding.',
];

const GOVERNS_BOTH = [
  "The fenced text below is from the reader's `CLAUDE.md` and serves both jobs here. Judge a design",
  'finding against its design rules: code that breaks one costs this reader something, and that',
  "cost is the finding. Follow the rest for the voice and phrasing of a finding's `body`.",
  ...GOVERNS_TAIL,
];

/**
 * Join the shipped prompt to the reader's own `CLAUDE.md`: the standard a design finding is judged
 * against, then the voice its `body` is written in.
 *
 * A heading per block is not decoration. The appended text is a file pr-open did not write, and
 * without a boundary saying what it governs, a CLAUDE.md that opens "respond in prose" reads as an
 * instruction to abandon the output format the lines above depend on. The text is fenced for the
 * same reason: a CLAUDE.md section arrives with its own `#` heading, and an unfenced one would make
 * every boundary below it read as its subsection.
 *
 * `Appended` decides how many blocks there are, so nothing here tests one text against the other:
 * the reader already knows whether the file split into two jobs or serves both with one.
 */
export function adversarialPrompt(prompt: string, appended: Appended): string {
  const head = prompt.trim();
  switch (appended.kind) {
    case AppendedKind.None:
      return head;
    case AppendedKind.Shared:
      return [head, ...quoted("The reader's own `CLAUDE.md`", GOVERNS_BOTH, appended.text)].join('\n');
    case AppendedKind.Split: {
      const parts = [head];
      if (appended.standard !== '') {
        parts.push(...quoted("The design standard this PR's reader holds", GOVERNS_STANDARD, appended.standard));
      }
      if (appended.voice !== '') {
        parts.push(...quoted("The reader's own writing guidance", GOVERNS_VOICE, appended.voice));
      }
      return parts.join('\n');
    }
  }
}

/** The sentinel the prompt requires as its last line. Finding nothing is a good outcome, and the
 *  JSONL runner treats a stream that yielded nothing at all as a failure, so the run says so. */
export function isDoneSentinel(obj: unknown): boolean {
  return !!obj && typeof obj === 'object' && (obj as { done?: unknown }).done === true;
}

/**
 * Validate one finding line. `files` is the set of paths the diff carries: a finding outside it can
 * never be placed, so it is rejected here rather than travelling to the anchor check.
 */
export function validateFinding(obj: unknown, files: ReadonlySet<string>): ReviewFinding | undefined {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  const f = obj as { file?: unknown; line?: unknown; startLine?: unknown; side?: unknown; body?: unknown };
  const body = typeof f.body === 'string' ? f.body.trim() : '';
  if (typeof f.file !== 'string' || !files.has(f.file) || !body || !isSide(f.side)) {
    return undefined;
  }
  // Integer, not merely finite: GitHub's line is an Int, and 12.5 would be coerced out of sight.
  if (!isLine(f.line)) {
    return undefined;
  }
  const finding: ReviewFinding = { file: f.file, line: f.line, side: f.side, body: cap(body, MAX_BODY_CHARS, 'truncated') };
  if (f.startLine === undefined) {
    return finding;
  }
  // A start past the end is a range the model got backwards, not one to silently flip.
  return isLine(f.startLine) && f.startLine <= f.line ? { ...finding, startLine: f.startLine } : undefined;
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isSide(value: unknown): value is DiffSide {
  return Object.values<unknown>(DiffSide).includes(value);
}
