import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { runTool, runToolPrefix, runToolStreaming } from '../src/exec';

const childProcess = require('node:child_process') as typeof import('node:child_process');
let toolId = 0;

function nodeTool() {
  return {
    name: `node-exec-test-${toolId++}`,
    opts: { candidates: [process.execPath], notFound: 'node not found' },
  };
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(file)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${file}`);
}

test('runToolPrefix: closes the producer after retaining the requested prefix', { timeout: 5_000 }, async () => {
  const holdOpenMs = 3_000;
  const started = performance.now();
  const prefix = await runToolPrefix(
    process.execPath,
    ['-e', `process.stdout.write(Buffer.alloc(8192, 120)); setTimeout(() => {}, ${holdOpenMs})`],
    { candidates: [process.execPath], notFound: 'Node.js not found.' },
    8_192,
  );

  assert.equal(prefix.length, 8_192);
  assert.ok(prefix.every((byte) => byte === 120));
  assert.ok(performance.now() - started < holdOpenMs - 500, 'producer should close before its hold-open timer');
});

test('runTool rejects an existing abort before launching a child', async (context) => {
  const launched = new Error('execFile called');
  const launch = context.mock.method(childProcess, 'execFile', (() => {
    throw launched;
  }) as typeof childProcess.execFile);
  const controller = new AbortController();
  const reason = new Error('already canceled');
  controller.abort(reason);
  const tool = nodeTool();

  await assert.rejects(
    runTool(tool.name, [], { ...tool.opts, signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(launch.mock.callCount(), 0);

  await assert.rejects(runTool(tool.name, [], tool.opts), (error) => error === launched);
  assert.equal(launch.mock.callCount(), 1);
});

test('runToolStreaming rejects an existing abort before launching a child', async (context) => {
  const launched = new Error('spawn called');
  const launch = context.mock.method(childProcess, 'spawn', (() => {
    throw launched;
  }) as typeof childProcess.spawn);
  const controller = new AbortController();
  const reason = new Error('already canceled');
  controller.abort(reason);
  const tool = nodeTool();

  await assert.rejects(
    runToolStreaming(tool.name, [], { ...tool.opts, signal: controller.signal }, () => {}),
    (error) => error === reason,
  );
  assert.equal(launch.mock.callCount(), 0);

  await assert.rejects(
    runToolStreaming(tool.name, [], tool.opts, () => {}),
    (error) => error === launched,
  );
  assert.equal(launch.mock.callCount(), 1);
});

test('runTool aborts a child that has already started', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-open-exec-'));
  try {
    const marker = path.join(dir, 'started');
    const controller = new AbortController();
    const tool = nodeTool();
    const running = runTool(
      tool.name,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); setInterval(() => {}, 1000)`],
      { ...tool.opts, signal: controller.signal },
    );
    await waitForFile(marker);
    controller.abort();

    await assert.rejects(running, (error: Error) => error.name === 'AbortError');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runToolStreaming preserves AbortError after the child starts', async () => {
  const controller = new AbortController();
  const tool = nodeTool();
  const running = runToolStreaming(
    tool.name,
    ['-e', `process.stdout.write('ready'); setInterval(() => {}, 1000)`],
    { ...tool.opts, signal: controller.signal },
    () => controller.abort(),
  );

  await assert.rejects(running, (error: Error) => error.name === 'AbortError');
});
