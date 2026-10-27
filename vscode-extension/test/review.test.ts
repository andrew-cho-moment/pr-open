import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReviewDiff, ReviewFileDisposition, ReviewFilePatch, ReviewSection } from '../src/git';
import { prepareReview, REVIEW_MANIFEST_BUDGET, REVIEW_PAYLOAD_BUDGET, runReviewBatches } from '../src/reviewbatch';
import { Chunk } from '../src/reviewparse';

function patch(
  file: string,
  lines: readonly string[],
  disposition = ReviewFileDisposition.Reviewable,
  section = ReviewSection.Production,
): ReviewFilePatch {
  const body = lines.map((line) => `+${line}`).join('\n');
  return {
    file: {
      path: file,
      status: 'A',
      binary: disposition === ReviewFileDisposition.Binary,
    },
    patch: `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`,
    disposition,
    section,
    additions: lines.length,
    deletions: 0,
  };
}

const review = (files: ReviewFilePatch[]): ReviewDiff => ({
  rawBytes: files.reduce((n, file) => n + file.patch.length, 0),
  files,
});

test('prepareReview: omits derived patches but keeps their bounded manifest and exact totals', () => {
  const files = [
    ...Array.from({ length: 20 }, (_, i) => patch(`src/file-${i}.go`, [`line ${i}`])),
    ...Array.from({ length: 36 }, (_, i) =>
      patch(
        `vendor/generated-${i}.go`,
        Array.from({ length: i + 1 }, () => 'generated'),
        ReviewFileDisposition.Vendored,
      ),
    ),
  ];
  const prepared = prepareReview(review(files));
  assert.equal(prepared.scope.reviewedFiles, 20);
  assert.equal(prepared.scope.omittedFiles, 36);
  assert.equal(prepared.scope.omittedAdditions, 666);
  assert.equal(prepared.scope.omittedDeletions, 0);
  assert.ok(prepared.scope.manifestBytes <= REVIEW_MANIFEST_BUDGET);
  assert.ok(prepared.batches.every((batch) => batch.input.length <= REVIEW_PAYLOAD_BUDGET));
  assert.ok(prepared.batches[0].input.includes('vendor/generated-0.go'));
  assert.ok(!prepared.batches[0].input.includes('diff --git a/vendor/generated-0.go'));
});

test('prepareReview: orders contracts before production and tests', () => {
  const prepared = prepareReview(
    review([
      patch('tests/service_test.go', ['test'], ReviewFileDisposition.Reviewable, ReviewSection.Test),
      patch('internal/service.go', ['production']),
      patch('api/openapi.yaml', ['contract'], ReviewFileDisposition.Reviewable, ReviewSection.Contract),
    ]),
  );
  const input = prepared.batches[0].input;
  assert.ok(input.indexOf('api/openapi.yaml') < input.indexOf('internal/service.go'));
  assert.ok(input.indexOf('internal/service.go') < input.indexOf('tests/service_test.go'));
});

test('prepareReview: sends the derived manifest once across independent batches', () => {
  const reviewable = patch(
    'src/large.go',
    Array.from({ length: 5_000 }, (_, i) => `${i} ${'x'.repeat(45)}`),
  );
  const prepared = prepareReview(
    review([reviewable, patch('vendor/generated.go', ['generated'], ReviewFileDisposition.Vendored)]),
  );
  assert.ok(prepared.batches.length > 1);
  assert.match(prepared.batches[0].input, /OMITTED DERIVED ARTIFACTS/);
  for (const batch of prepared.batches.slice(1)) {
    assert.doesNotMatch(batch.input, /OMITTED DERIVED ARTIFACTS/);
  }
});

test('prepareReview: splits an oversized hunk into bounded batches without dropping content lines', () => {
  const lines = Array.from({ length: 5_000 }, (_, i) => `${i.toString().padStart(4, '0')} ${'x'.repeat(45)}`);
  const prepared = prepareReview(review([patch('src/large.go', lines)]));
  assert.ok(prepared.batches.length > 1);
  assert.ok(prepared.batches.every((batch) => batch.input.length <= REVIEW_PAYLOAD_BUDGET));
  const input = prepared.batches.map((batch) => batch.input).join('\n');
  const carried = [...input.matchAll(/^\+\s*\d+ │ (\d{4} x+)$/gm)].map((match) => match[1]);
  assert.deepEqual(carried, lines);
});

test('prepareReview: rejects one reviewable line larger than the request budget', () => {
  assert.throws(
    () =>
      prepareReview(review([patch('src/generated-looking-but-reviewable.go', ['x'.repeat(REVIEW_PAYLOAD_BUDGET)])])),
    /reviewable line.*exceeds/i,
  );
});

test('prepareReview: caps a huge manifest while retaining aggregate scope', () => {
  const files = Array.from({ length: 1_000 }, (_, i) =>
    patch(`vendor/${i}-${'long-directory/'.repeat(8)}generated.go`, ['x'], ReviewFileDisposition.Vendored),
  );
  const prepared = prepareReview(review(files));
  assert.equal(prepared.batches.length, 0);
  assert.equal(prepared.scope.omittedFiles, 1_000);
  assert.equal(prepared.scope.omittedAdditions, 1_000);
  assert.ok(prepared.scope.manifestBytes <= REVIEW_MANIFEST_BUDGET);
});

test('runReviewBatches: deduplicates chunks and identifies each call', async () => {
  const batches = [
    { input: 'one', files: ['one.go'] },
    { input: 'two', files: ['two.go'] },
  ];
  const emitted: Chunk[] = [];
  const duplicate: Chunk = {
    title: 'same',
    explanation: 'same',
    locations: [{ file: 'one.go', startLine: 1, endLine: 1 }],
  };
  const calls: string[] = [];
  const chunks = await runReviewBatches(
    batches,
    async (batch, index, total, onChunk) => {
      calls.push(`${index + 1}/${total}:${batch.files[0]}`);
      onChunk(duplicate);
    },
    (chunk) => emitted.push(chunk),
  );
  assert.deepEqual(calls, ['1/2:one.go', '2/2:two.go']);
  assert.deepEqual(chunks, [duplicate]);
  assert.deepEqual(emitted, [duplicate]);
});

test('runReviewBatches: reports the failed batch after preserving streamed chunks', async () => {
  const emitted: Chunk[] = [];
  const first: Chunk = {
    title: 'first',
    explanation: '',
    locations: [{ file: 'one.go', startLine: 1, endLine: 1 }],
  };
  let call = 0;
  await assert.rejects(
    runReviewBatches(
      [
        { input: 'one', files: ['one.go'] },
        { input: 'two', files: ['two.go'] },
      ],
      async (_batch, _index, _total, onChunk) => {
        call++;
        if (call === 2) {
          throw new Error('synthetic failure');
        }
        onChunk(first);
      },
      (chunk) => emitted.push(chunk),
    ),
    /Review batch 2\/2 failed: synthetic failure/,
  );
  assert.deepEqual(emitted, [first]);
});

test('runReviewBatches: an abort stops before the next model call', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    runReviewBatches(
      [
        { input: 'first', files: ['first.ts'] },
        { input: 'second', files: ['second.ts'] },
      ],
      async () => {
        calls++;
        controller.abort(new Error('superseded'));
      },
      undefined,
      controller.signal,
    ),
    /superseded/,
  );
  assert.equal(calls, 1);
});
