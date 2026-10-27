import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AppendedKind,
  reviewInstructions,
  splitSection,
} from '../src/userinstructions';

/** The section alone: what these cases are about, with `rest` covered by its own tests below. */
const section = (markdown: string, heading: string) => splitSection(markdown, heading)?.section;

const DOC = [
  '# Design',
  'design prose',
  '',
  '# Communication',
  'be terse',
  '',
  '### Tone',
  'no hedging',
  '',
  '# Pull Requests',
  'pr prose',
].join('\n');

test('splitSection: returns the named section with its heading line', () => {
  assert.equal(section(DOC, 'Communication'), '# Communication\nbe terse\n\n### Tone\nno hedging');
});

test('splitSection: ends at the next heading of the same level', () => {
  assert.ok(!section(DOC, 'Communication')?.includes('pr prose'));
});

test('splitSection: ends at a shallower heading', () => {
  const doc = ['## Communication', 'be terse', '# Pull Requests', 'pr prose'].join('\n');
  assert.equal(section(doc, 'Communication'), '## Communication\nbe terse');
});

test('splitSection: keeps a deeper subsection inside the match', () => {
  assert.ok(section(DOC, 'Communication')?.includes('### Tone'));
});

test('splitSection: matches case-insensitively', () => {
  assert.equal(section('# communication\nx', 'Communication'), '# communication\nx');
});

test('splitSection: accepts the closed ATX form', () => {
  assert.equal(section('## Communication ##\nx', 'Communication'), '## Communication ##\nx');
});

test('splitSection: keeps a trailing # that no space precedes', () => {
  assert.equal(section('# C#\nx', 'C#'), '# C#\nx');
});

test('splitSection: a heading inside a fence neither matches nor terminates', () => {
  const doc = ['# Communication', 'be terse', '```sh', '# Pull Requests', 'echo hi', '```', 'still terse'].join('\n');
  const out = section(doc, 'Communication');
  assert.ok(out?.includes('still terse'));
  assert.equal(section(doc, 'Pull Requests'), undefined);
});

test('splitSection: returns undefined for an absent section, which is the whole-file fallback', () => {
  assert.equal(section(DOC, 'Nowhere'), undefined);
});

test('splitSection: the last section in the file runs to EOF', () => {
  assert.equal(section(DOC, 'Pull Requests'), '# Pull Requests\npr prose');
});

test('splitSection: the first match wins when a heading repeats', () => {
  const doc = ['# Communication', 'first', '# Communication', 'second'].join('\n');
  assert.equal(section(doc, 'Communication'), '# Communication\nfirst');
});

test('splitSection: an empty section name matches nothing rather than the first heading', () => {
  assert.equal(section(DOC, ''), undefined);
});

test('splitSection: rest is everything the section did not claim', () => {
  const out = splitSection(DOC, 'Communication');
  assert.equal(out?.section, '# Communication\nbe terse\n\n### Tone\nno hedging');
  assert.equal(out?.rest, '# Design\ndesign prose\n\n# Pull Requests\npr prose');
});

test('splitSection: a section running to EOF leaves the head as rest', () => {
  assert.equal(splitSection(DOC, 'Pull Requests')?.rest, '# Design\ndesign prose\n\n# Communication\nbe terse\n\n### Tone\nno hedging');
});

test('reviewInstructions: both sections present split into two disjoint texts', () => {
  const { appended } = reviewInstructions(DOC, 'Design', 'Communication');
  assert.equal(appended.kind, AppendedKind.Split);
  assert.ok(appended.kind === AppendedKind.Split);
  assert.equal(appended.standard, '# Design\ndesign prose');
  assert.ok(appended.voice.includes('be terse'));
  assert.ok(!appended.voice.includes('design prose'));
});

// The voice keeps the part of the file the standard did not claim, so neither block restates the
// other and the reader's remaining prose still reaches the run.
test('reviewInstructions: a missing voice section takes what the standard left', () => {
  const { appended } = reviewInstructions(DOC, 'Design', 'Absent');
  assert.ok(appended.kind === AppendedKind.Split);
  assert.equal(appended.standard, '# Design\ndesign prose');
  assert.ok(appended.voice.includes('be terse'));
  assert.ok(!appended.voice.includes('design prose'));
});

test('reviewInstructions: a missing standard section leaves the voice alone', () => {
  const { appended } = reviewInstructions(DOC, 'Absent', 'Communication');
  assert.ok(appended.kind === AppendedKind.Split);
  assert.equal(appended.standard, '');
  assert.ok(appended.voice.includes('be terse'));
});

// An unheaded CLAUDE.md still holds design rules. Appending it under the voice heading alone would
// hand the model those rules under a sentence saying they govern nothing about what counts as a
// finding, so one text takes both jobs.
// Two names on one range: the voice heading nests under the standard's, or both settings name the
// same section. Splitting would append the inner text twice, under headings that contradict.
test('reviewInstructions: a voice section nested in the standard serves both jobs', () => {
  const nested = '# Design\nuse enums\n\n## Communication\nbe terse';
  const { appended } = reviewInstructions(nested, 'Design', 'Communication');
  assert.deepEqual(appended, { kind: AppendedKind.Shared, text: nested });
});

test('reviewInstructions: one section named for both jobs is shared, not split', () => {
  const { appended } = reviewInstructions(DOC, 'Design', 'Design');
  assert.deepEqual(appended, { kind: AppendedKind.Shared, text: '# Design\ndesign prose' });
});

test('reviewInstructions: a file naming neither section serves both jobs with one text', () => {
  const prose = 'Use enums for every finite-valued field.\nBe terse.';
  const { appended } = reviewInstructions(prose, 'Design', 'Communication');
  assert.deepEqual(appended, { kind: AppendedKind.Shared, text: prose });
});

test('reviewInstructions: a blank section name means the whole file for both jobs', () => {
  for (const [standard, voice] of [['', 'Communication'], ['Design', '  ']]) {
    const { appended } = reviewInstructions(DOC, standard, voice);
    assert.deepEqual(appended, { kind: AppendedKind.Shared, text: DOC }, `${standard}/${voice}`);
  }
});

test('reviewInstructions: a file that is only the standard serves both jobs with it', () => {
  const only = '# Design\ndesign prose';
  const { appended } = reviewInstructions(only, 'Design', 'Communication');
  assert.deepEqual(appended, { kind: AppendedKind.Shared, text: only });
});

test('reviewInstructions: an empty file appends nothing', () => {
  const { appended, note } = reviewInstructions('   \n', 'Design', 'Communication');
  assert.deepEqual(appended, { kind: AppendedKind.None });
  assert.ok(note.includes('is empty'));
});
