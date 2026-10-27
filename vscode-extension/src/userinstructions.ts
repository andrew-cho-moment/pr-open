import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The user's own `~/.claude/CLAUDE.md`, read by pr-open rather than by the subprocess.
 *
 * `isolationArgs` passes `--setting-sources ''` (`claude.ts`), which is what keeps a run sealed
 * against hooks, project permissions and MCP servers, and which also turns CLAUDE.md off. Reading
 * the file here restores the guidance without reopening any of the rest: the text arrives as
 * prompt bytes the subprocess cannot act on, not as a settings source it loads.
 *
 * The adversarial review reads two sections of it, for two jobs: the design standard a finding is
 * judged against, and the voice a finding is written in. `Appended` is the shape that keeps those
 * two from restating each other, whichever sections the file turns out to carry.
 */

/** Where the personal instructions live. Symlinks resolve on read, so a linked file needs no care. */
export const USER_INSTRUCTIONS_PATH = path.join(os.homedir(), '.claude', 'CLAUDE.md');

/**
 * ATX headings only: `#` through `######`, one space, optionally closed by a run of `#`. The closing
 * run must be preceded by a space, so `# C#` keeps its `#` and `## Tone ##` does not. Setext headings
 * (`===` underlines) are not recognized.
 */
const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * The named section of a markdown document, heading line included, alongside everything outside it,
 * or undefined when no heading matches. The section runs to the next heading of the same level or
 * shallower, so subsections stay inside it and the next sibling ends it.
 *
 * `rest` is what makes the two appended blocks disjoint: a voice read that finds no section of its
 * own takes the part of the file the standard did not already claim, rather than the whole file.
 *
 * Fence-aware: a `# comment` inside a code block neither matches nor terminates, which matters for a
 * CLAUDE.md whose prose is mostly shell snippets.
 */
export interface Section {
  /** The heading line and everything under it. */
  section: string;
  /** Everything outside it, which a second job can take without restating the first. */
  rest: string;
  /** Line bounds, half-open. Two sections of one scan either nest or stay apart, never straddle. */
  start: number;
  end: number;
}

export function splitSection(markdown: string, heading: string): Section | undefined {
  const wanted = heading.trim().toLowerCase();
  if (wanted === '') {
    return undefined;
  }
  const lines = markdown.split('\n');
  let fenced = false;
  let start = -1;
  let end = lines.length;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    const m = HEADING.exec(lines[i]);
    if (!m) {
      continue;
    }
    if (start === -1) {
      if (m[2].trim().toLowerCase() === wanted) {
        start = i;
        level = m[1].length;
      }
      continue;
    }
    if (m[1].length <= level) {
      end = i;
      break;
    }
  }
  if (start === -1) {
    return undefined;
  }
  return {
    section: lines.slice(start, end).join('\n').trimEnd(),
    rest: [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim(),
    start,
    end,
  };
}

/** Which shape the reader's CLAUDE.md takes once both section names have been resolved against it. */
export enum AppendedKind {
  /** Nothing to append: no file, or an empty one. */
  None = 'none',
  /** One text doing both jobs, because no split of the file separates them. */
  Shared = 'shared',
  /** Two texts that share no line, one per job. Either may be empty; both never are. */
  Split = 'split',
}

/**
 * What an adversarial run appends to its prompt.
 *
 * A discriminated union rather than two strings: the rule the feature turns on is that the two
 * blocks never restate each other, and `Split` is the only variant that can carry two. Nothing
 * downstream has to test one text against the other to find out which case it holds.
 */
export type Appended =
  | { kind: AppendedKind.None }
  | { kind: AppendedKind.Shared; text: string }
  | { kind: AppendedKind.Split; standard: string; voice: string };

/** What `readReviewInstructions` resolved, with a line for the log so the choice has an address. */
export interface ReviewInstructions {
  appended: Appended;
  note: string;
}

const NONE: Appended = { kind: AppendedKind.None };

/**
 * Resolve both section names against one CLAUDE.md.
 *
 * `Shared` is what a file that names neither section gets: its prose still holds design rules, and
 * appending it under the voice heading alone would hand the model those rules under a sentence
 * saying they govern nothing about what counts as a finding.
 *
 * A blank name means the whole file, and one whole file cannot be split, so it yields `Shared` too.
 */
export function reviewInstructions(raw: string, standardName: string, voiceName: string): ReviewInstructions {
  const whole = raw.trim();
  if (whole === '') {
    return { appended: NONE, note: `${USER_INSTRUCTIONS_PATH} is empty` };
  }
  const shared = (text: string, note: string): ReviewInstructions => ({ appended: { kind: AppendedKind.Shared, text }, note });
  if (standardName.trim() === '' || voiceName.trim() === '') {
    return shared(whole, `${USER_INSTRUCTIONS_PATH}: whole file for both jobs, a section name is blank`);
  }

  const standard = splitSection(raw, standardName);
  const voice = splitSection(raw, voiceName);
  if (!standard && !voice) {
    return shared(whole, `${USER_INSTRUCTIONS_PATH}: no "${standardName}" or "${voiceName}" section, whole file for both`);
  }
  if (!standard) {
    return {
      appended: { kind: AppendedKind.Split, standard: '', voice: voice!.section },
      note: `${USER_INSTRUCTIONS_PATH}: no "${standardName}" section, "${voiceName}" as the voice`,
    };
  }
  if (voice) {
    // Two names can land on one range: the same name twice, or a voice heading nested under the
    // standard's. Ranges from one scan either nest or stay apart, so an overlap means the outer
    // section already carries the inner, and splitting them would append the inner text twice.
    if (standard.start < voice.end && voice.start < standard.end) {
      const outer = standard.start <= voice.start ? standard : voice;
      return shared(
        outer.section,
        `${USER_INSTRUCTIONS_PATH}: "${standardName}" and "${voiceName}" overlap, the outer one serving both jobs`,
      );
    }
    return {
      appended: { kind: AppendedKind.Split, standard: standard.section, voice: voice.section },
      note: `${USER_INSTRUCTIONS_PATH}: "${standardName}" as the standard, "${voiceName}" as the voice`,
    };
  }
  // No voice section, so the voice takes what the standard left. A file that is only the standard
  // leaves nothing, and one text serving both jobs is `Shared`.
  if (standard.rest === '') {
    return shared(standard.section, `${USER_INSTRUCTIONS_PATH}: "${standardName}" is the whole file, serving both jobs`);
  }
  return {
    appended: { kind: AppendedKind.Split, standard: standard.section, voice: standard.rest },
    note: `${USER_INSTRUCTIONS_PATH}: "${standardName}" as the standard, the rest of the file as the voice`,
  };
}

/**
 * The reader's CLAUDE.md, resolved against both section names.
 *
 * One read, because the two blocks are slices of one text and an edit landing between two reads
 * would let them overlap. Never throws: a missing or unreadable personal CLAUDE.md is the common
 * case on a fresh machine and must not fail a review.
 */
export async function readReviewInstructions(standardName: string, voiceName: string): Promise<ReviewInstructions> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(USER_INSTRUCTIONS_PATH, 'utf8');
  } catch (e) {
    return { appended: NONE, note: `no user instructions at ${USER_INSTRUCTIONS_PATH} (${(e as Error).message})` };
  }
  return reviewInstructions(raw, standardName, voiceName);
}
