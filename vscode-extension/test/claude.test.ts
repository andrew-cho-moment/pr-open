import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeSessionPersistence, isolationArgs, supportedIsolationFlags } from '../src/claude';

// These arrays are the only thing between a flag rename and a subprocess that can write to disk,
// so they are asserted whole rather than probed.
test('isolationArgs("none") grants no tools at all', () => {
  assert.deepEqual(isolationArgs('none'), [
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--tools',
    '',
    '--allowed-tools',
    '',
    '--permission-mode',
    'dontAsk',
  ]);
});

test('isolationArgs("read-only") grants exactly Read, Grep and Glob', () => {
  assert.deepEqual(isolationArgs('read-only'), [
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--tools',
    'Read,Grep,Glob',
    '--allowed-tools',
    'Read,Grep,Glob',
    '--permission-mode',
    'dontAsk',
  ]);
});

test('no isolation mode grants a writing tool', () => {
  for (const tools of ['none', 'read-only'] as const) {
    const names = isolationArgs(tools)[isolationArgs(tools).indexOf('--tools') + 1];
    for (const banned of ['Write', 'Edit', 'Bash', 'WebFetch', 'default']) {
      assert.ok(!names.includes(banned), `${tools} must not grant ${banned}`);
    }
  }
});

test('supportedIsolationFlags strips custom context and only drops ephemeral session state', () => {
  const help = '--safe-mode\n--disable-slash-commands\n--no-session-persistence\n';
  assert.deepEqual(supportedIsolationFlags(help, ClaudeSessionPersistence.Ephemeral), [
    '--safe-mode',
    '--disable-slash-commands',
    '--no-session-persistence',
  ]);
  assert.deepEqual(supportedIsolationFlags(help, ClaudeSessionPersistence.Persistent), [
    '--safe-mode',
    '--disable-slash-commands',
  ]);
});

test('supportedIsolationFlags passes no unknown flags to an older CLI', () => {
  assert.deepEqual(supportedIsolationFlags('Usage: claude', ClaudeSessionPersistence.Ephemeral), []);
});
