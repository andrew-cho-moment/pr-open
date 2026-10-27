import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Clone, parseRemote, resolveClone } from '../src/resolver';

test('parseRemote: parses an ssh origin URL', () => {
  assert.deepEqual(parseRemote('git@github.com:moment-technology/pr-open.git'), {
    owner: 'moment-technology',
    slug: 'pr-open',
  });
});

test('parseRemote: parses an https origin URL without a .git suffix', () => {
  assert.deepEqual(parseRemote('https://github.com/moment-technology/accounts'), {
    owner: 'moment-technology',
    slug: 'accounts',
  });
});

test('parseRemote: returns undefined for a non-GitHub URL', () => {
  assert.equal(parseRemote('https://gitlab.com/foo/bar.git'), undefined);
});

const CLONES: Clone[] = [
  { dir: '/dev/accounts', folder: 'accounts', slug: 'accounts', owner: 'moment-technology' },
  { dir: '/dev/pr-open', folder: 'pr-open', slug: 'pr-open', owner: 'moment-technology' },
];

test('resolveClone: matches on the origin slug, case-insensitively', () => {
  assert.equal(resolveClone('Accounts', CLONES)?.dir, '/dev/accounts');
});

test('resolveClone: falls back to the folder name when no slug matches', () => {
  const clones: Clone[] = [{ dir: '/dev/x', folder: 'weird-folder', slug: 'canonical' }];
  assert.equal(resolveClone('weird-folder', clones)?.folder, 'weird-folder');
});

test('resolveClone: returns undefined when nothing matches', () => {
  assert.equal(resolveClone('nope', CLONES), undefined);
});
