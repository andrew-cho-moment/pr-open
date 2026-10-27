import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanContextSummary, parseArray, parseObjectLine, restrictChunkFiles, validateChunk } from '../src/reviewparse';

test('validateChunk: accepts a well-formed chunk', () => {
  const c = validateChunk({ title: 'T', explanation: 'E', locations: [{ file: 'a.ts', startLine: 1, endLine: 2 }] });
  assert.deepEqual(c, { title: 'T', explanation: 'E', locations: [{ file: 'a.ts', startLine: 1, endLine: 2 }] });
});

test('validateChunk: defaults a missing explanation to an empty string', () => {
  const c = validateChunk({ title: 'T', locations: [{ file: 'a.ts', startLine: 1, endLine: 1 }] });
  assert.equal(c?.explanation, '');
});

test('validateChunk: drops locations with non-finite line numbers, rejecting if none remain', () => {
  assert.equal(validateChunk({ title: 'T', locations: [{ file: 'a.ts', startLine: NaN, endLine: 1 }] }), undefined);
});

test('validateChunk: rejects a non-object', () => {
  assert.equal(validateChunk('nope'), undefined);
});

test('restrictChunkFiles: removes manifest-only anchors and rejects a chunk with none left', () => {
  const chunk = {
    title: 'T',
    explanation: 'E',
    locations: [
      { file: 'src/reviewed.ts', startLine: 1, endLine: 2 },
      { file: 'vendor/omitted.ts', startLine: 3, endLine: 4 },
    ],
  };
  assert.deepEqual(restrictChunkFiles(chunk, new Set(['src/reviewed.ts'])), {
    ...chunk,
    locations: [chunk.locations[0]],
  });
  assert.equal(restrictChunkFiles(chunk, new Set(['other.ts'])), undefined);
});

test('parseObjectLine: parses a bare JSON object line', () => {
  assert.deepEqual(parseObjectLine('{"title":"T"}'), { title: 'T' });
});

test('parseObjectLine: tolerates a leading [ from an array first line', () => {
  assert.deepEqual(parseObjectLine('[{"a":1}'), { a: 1 });
});

test('parseObjectLine: tolerates a trailing comma', () => {
  assert.deepEqual(parseObjectLine('{"a":1},'), { a: 1 });
});

test('parseObjectLine: ignores a code-fence line', () => {
  assert.equal(parseObjectLine('```json'), undefined);
});

test('parseObjectLine: ignores non-JSON noise', () => {
  assert.equal(parseObjectLine('hello'), undefined);
});

test('parseArray: parses a JSON array of chunks', () => {
  assert.deepEqual(parseArray('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]);
});

test('parseArray: unwraps a ```json fenced array', () => {
  assert.deepEqual(parseArray('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
});

test('parseArray: returns [] for invalid JSON or a non-array', () => {
  assert.deepEqual(parseArray('not json'), []);
  assert.deepEqual(parseArray('{"a":1}'), []);
});

test('cleanContextSummary: strips a stray code fence', () => {
  assert.equal(
    cleanContextSummary('```\nCustomers saw stale balances. The worker now refreshes them.\n```'),
    'Customers saw stale balances. The worker now refreshes them.',
  );
});

test('cleanContextSummary: folds a hard-wrapped summary onto one line, abbreviations intact', () => {
  assert.equal(
    cleanContextSummary('  Callers pass a flag (e.g. Retry) today.\nIt broke settlement.  '),
    'Callers pass a flag (e.g. Retry) today. It broke settlement.',
  );
});
