import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adversarialPrompt, isDoneSentinel, validateFinding } from '../src/adversarialpayload';
import { DiffSide } from '../src/prthreads';
import { Appended, AppendedKind } from '../src/userinstructions';

const FILES = new Set(['foo.ts']);
const ok = { file: 'foo.ts', line: 12, side: 'RIGHT', body: 'boom' };

test('validateFinding: accepts a well-formed finding', () => {
  assert.deepEqual(validateFinding(ok, FILES), { file: 'foo.ts', line: 12, side: DiffSide.Right, body: 'boom' });
});

test('validateFinding: rejects a non-object', () => {
  assert.equal(validateFinding('nope', FILES), undefined);
});

test('validateFinding: rejects a file the diff never carried', () => {
  assert.equal(validateFinding({ ...ok, file: 'invented.ts' }, FILES), undefined);
});

test('validateFinding: rejects a non-integer, zero, or negative line', () => {
  for (const line of [0, -1, 1.5, NaN, '12']) {
    assert.equal(validateFinding({ ...ok, line }, FILES), undefined, `accepted line ${String(line)}`);
  }
});

test('validateFinding: rejects a side outside the enum', () => {
  assert.equal(validateFinding({ ...ok, side: 'MIDDLE' }, FILES), undefined);
});

test('validateFinding: rejects an empty or whitespace body', () => {
  assert.equal(validateFinding({ ...ok, body: '   ' }, FILES), undefined);
});

test('validateFinding: rejects a range the model got backwards rather than flipping it', () => {
  assert.equal(validateFinding({ ...ok, startLine: 20 }, FILES), undefined);
});

test('validateFinding: keeps a startLine at or before the line', () => {
  assert.equal(validateFinding({ ...ok, startLine: 10 }, FILES)?.startLine, 10);
});

test('validateFinding: caps an over-long body rather than sending a design document', () => {
  const body = validateFinding({ ...ok, body: 'x'.repeat(5_000) }, FILES)?.body ?? '';
  assert.ok(body.length < 5_000);
  assert.ok(body.endsWith('truncated'));
});

test('isDoneSentinel: recognises the closing line and nothing else', () => {
  assert.ok(isDoneSentinel({ done: true }));
  assert.equal(isDoneSentinel({ done: false }), false);
  assert.equal(isDoneSentinel(ok), false);
});

const split = (standard: string, voice: string): Appended => ({ kind: AppendedKind.Split, standard, voice });

test('adversarialPrompt: returns the prompt untouched when there is nothing to append', () => {
  assert.equal(adversarialPrompt('PROMPT', { kind: AppendedKind.None }), 'PROMPT');
});

test('adversarialPrompt: appends each block under a heading that bounds what it governs', () => {
  const out = adversarialPrompt('PROMPT', split('# Design\nuse enums', '# Communication\nbe terse'));
  assert.ok(out.startsWith('PROMPT'));
  // The boundary is what stops a CLAUDE.md that says "respond in prose" from breaking the JSONL.
  assert.equal(out.match(/It governs nothing else/g)?.length, 2);
  // Standard first: what to report is settled before how to word it.
  assert.ok(out.indexOf('use enums') < out.indexOf('be terse'));
});

test('adversarialPrompt: omits the heading of a block with no text', () => {
  const standardOnly = adversarialPrompt('PROMPT', split('use enums', ''));
  assert.ok(standardOnly.includes('design standard'));
  assert.ok(!standardOnly.includes("reader's own writing guidance"));

  const voiceOnly = adversarialPrompt('PROMPT', split('', 'be terse'));
  assert.ok(voiceOnly.includes("reader's own writing guidance"));
  assert.ok(!voiceOnly.includes('design standard'));
});

// One text doing both jobs gets one heading that says so, rather than the voice heading alone,
// which would deny that the design rules it carries govern what counts as a finding.
test('adversarialPrompt: a shared text is one block under the both-jobs heading', () => {
  const text = '# Design\nuse enums\n\n# Pull Requests\nlead with why';
  const out = adversarialPrompt('PROMPT', { kind: AppendedKind.Shared, text });
  assert.equal(out.match(/use enums/g)?.length, 1);
  assert.equal(out.match(/^## /gm)?.length, 1);
  assert.ok(out.includes("The reader's own `CLAUDE.md`"));
});

// splitSection hands back the section with its own `# ` heading line. Unfenced, every boundary
// below it would parse as a subsection of the reader's text rather than as pr-open's own.
test('adversarialPrompt: fences the reader text so its headings cannot swallow a boundary', () => {
  const out = adversarialPrompt('PROMPT', split('# Design\nuse enums', '# Communication\nbe terse'));
  for (const heading of ['# Design', '# Communication']) {
    const before = out.slice(0, out.indexOf(heading));
    // An odd number of fences before the heading means it sits inside one.
    assert.equal((before.match(/^`{3,}$/gm) ?? []).length % 2, 1, `${heading} is not fenced`);
  }
});

test('adversarialPrompt: picks a fence longer than any backtick run in the reader text', () => {
  const text = 'run:\n```sh\nls\n```';
  const out = adversarialPrompt('PROMPT', split('', text));
  assert.ok(out.includes('````\n' + text + '\n````'));
});
