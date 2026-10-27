import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPO_TOUR_LISTING_BUDGET, repoTourPayload } from '../src/repotour';

test('repoTourPayload: lists every tracked file when they fit the budget', () => {
  const out = repoTourPayload('acme', ['README.md', 'src/main.ts']);
  assert.match(out, /### TRACKED FILES\nREADME\.md\nsrc\/main\.ts$/);
});

test('repoTourPayload: falls back to per-directory counts when the files overflow the budget', () => {
  const files = Array.from({ length: 5_000 }, (_, i) => `vendor/pkg/file-with-a-long-name-${i}.go`).concat('cmd/main.go');
  const out = repoTourPayload('acme', files);
  assert.match(out, /HEAD tracks 5001 files\./);
  assert.match(out, /^cmd\/ \(1 files\)$/m);
  assert.match(out, /^vendor\/pkg\/ \(5000 files\)$/m);
  assert.doesNotMatch(out, /file-with-a-long-name/);
});

test('repoTourPayload: cuts the directory list at the budget and says how many it left out', () => {
  const files = Array.from({ length: 20_000 }, (_, i) => `some/deeply/nested/directory/number-${i}/f.ts`);
  const out = repoTourPayload('acme', files);
  assert.ok(out.length < REPO_TOUR_LISTING_BUDGET + 500);
  assert.match(out, /\.\.\. \d+ more directories; use Glob to list them\.$/);
});
