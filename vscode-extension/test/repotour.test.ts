import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPO_TOUR_CONFIG_LIMIT, REPO_TOUR_LISTING_BUDGET, configFiles, repoTourPayload } from '../src/repotour';

test('repoTourPayload: lists every tracked file when they fit the budget', () => {
  const out = repoTourPayload('acme', ['README.md', 'src/main.ts']);
  assert.match(out, /### TRACKED FILES\nREADME\.md\nsrc\/main\.ts\n\n### CONFIGURATION FILES/);
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
  assert.match(out, /^\.\.\. \d+ more directories; use Glob to list them\.$/m);
});

test('configFiles: picks build, quality, CI, runtime, container and ownership files, not source', () => {
  const files = [
    'package.json',
    'tsconfig.json',
    'src/main.ts',
    'src/config.ts',
    '.github/workflows/ci.yml',
    '.github/CODEOWNERS',
    'eslint.config.mjs',
    'services/api/Dockerfile',
    'services/api/go.mod',
    'infra/main.tf',
    'CLAUDE.md',
    'docs/guide.md',
  ];
  assert.deepEqual(configFiles(files), [
    'package.json',
    'tsconfig.json',
    '.github/workflows/ci.yml',
    '.github/CODEOWNERS',
    'eslint.config.mjs',
    'services/api/Dockerfile',
    'services/api/go.mod',
    'infra/main.tf',
    'CLAUDE.md',
  ]);
});

test('repoTourPayload: lists the configuration files in both listing shapes', () => {
  assert.match(repoTourPayload('acme', ['src/a.ts', 'justfile']), /### CONFIGURATION FILES[^\n]*\njustfile$/);
  const files = Array.from({ length: 5_000 }, (_, i) => `vendor/pkg/file-with-a-long-name-${i}.go`).concat('go.mod');
  assert.match(repoTourPayload('acme', files), /### CONFIGURATION FILES[^\n]*\ngo\.mod$/);
});

test('repoTourPayload: caps the configuration list and says how many it left out', () => {
  const files = Array.from({ length: REPO_TOUR_CONFIG_LIMIT + 7 }, (_, i) => `pkgs/p${i}/package.json`);
  const out = repoTourPayload('acme', files);
  assert.match(out, /\.\.\. 7 more; use Glob to find them\.$/);
});

test('repoTourPayload: says when no configuration file matched', () => {
  assert.match(repoTourPayload('acme', ['src/a.ts']), /None matched by name/);
});
