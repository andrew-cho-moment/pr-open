import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, isNewerVersion, parseVersion } from '../src/version';

test('parseVersion: parses a CalVer string', () => {
  assert.deepEqual(parseVersion('2026.7.6'), [2026, 7, 6]);
});

test('parseVersion: rejects a non-numeric part (dev build)', () => {
  assert.equal(parseVersion('0.0.0-dev'), null);
});

test('compareVersions: orders by micro then treats missing parts as 0', () => {
  assert.ok(compareVersions([2026, 7, 6], [2026, 7, 5]) > 0);
  assert.ok(compareVersions([2026, 8], [2026, 7, 9]) > 0);
  assert.equal(compareVersions([2026, 7], [2026, 7, 0]), 0);
});

test('isNewerVersion: true only when latest release is ahead', () => {
  assert.equal(isNewerVersion('2026.7.5', '2026.7.6'), true);
  assert.equal(isNewerVersion('2026.7.6', '2026.7.6'), false);
  assert.equal(isNewerVersion('2026.7.7', '2026.7.6'), false);
});

test('isNewerVersion: a dev build is behind any differently-named release', () => {
  assert.equal(isNewerVersion('0.0.0-dev', '2026.7.6'), true);
  assert.equal(isNewerVersion('0.0.0-dev', '0.0.0-dev'), false);
});
