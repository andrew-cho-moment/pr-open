// Runs inside a real VS Code extension host, so `vscode` here is the live API rather than a stub.
//
// What it covers is the selection tracking behind the panel's Ask box: which lines, if any, the
// compose box is aimed at. That is decided by editor events (`onDidChangeActiveTextEditor`,
// `onDidChangeTextEditorSelection`) and by `vscode.Selection.isEmpty`, none of which the unit tests
// can reach, and it is where a caret was once mistaken for an aim.
//
// The repo registry is seeded directly, so nothing here shells out to `gh` or `git`. Review
// cancellation cases stop before prompt I/O, so `claude` is never spawned.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const { AskController } = require('../../dist/askcomments');
const { AskRepoRegistry } = require('../../dist/askrepo');
const { generateWalkthrough, summarizeContext } = require('../../dist/review');

/** Collects what the controller would have pushed to the panel webview. */
function recordingView() {
  const messages = [];
  return {
    messages,
    postAsk(msg) {
      messages.push(msg);
    },
    /** The aim as of the last `askAnchor`/`askSnapshot`, or `undefined` when none has been sent. */
    lastAim() {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.type === 'askAnchor' || m.type === 'askSnapshot') {
          return { sent: true, anchor: m.anchor };
        }
      }
      return { sent: false, anchor: undefined };
    },
  };
}

/** Editor events are async and the controller resolves a repo before it pins, so assertions wait for
 *  the state they expect rather than for a fixed delay. */
async function until(describe, predicate, timeoutMs = 5_000) {
  const started = Date.now();
  for (;;) {
    let last;
    try {
      last = predicate();
      if (last) {
        return;
      }
    } catch (e) {
      last = e;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${describe}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Settle: give the controller's in-flight event handlers a chance to run before asserting that
 *  nothing happened, so "no aim" is not just "not yet". */
const settle = () => new Promise((r) => setTimeout(r, 750));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// --- fixture ---------------------------------------------------------------------------------

/** A directory standing in for a PR checkout, seeded into the registry so resolution needs no `gh`. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-open-itest-'));
  const file = path.join(dir, 'sample.ts');
  fs.writeFileSync(file, Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n'));
  const outside = path.join(os.tmpdir(), `pr-open-outside-${process.pid}-${path.basename(dir)}.ts`);
  fs.writeFileSync(outside, 'const elsewhere = true;\n');
  return {
    dir,
    file,
    outside,
    repo: {
      owner: 'moment-technology',
      repo: 'pr-open',
      cloneDir: dir,
      number: 25,
      base: 'a'.repeat(40),
      headOid: 'b'.repeat(40),
      title: 'a pull request',
      body: 'why',
    },
  };
}

async function openAt(file, selection) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  if (selection) {
    editor.selection = selection;
  }
  return editor;
}

async function closeAll() {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

function deferRepoLookups(repos) {
  const pending = [];
  repos.for = (uri) => new Promise((resolve) => pending.push({ uri, resolve }));
  return pending;
}

// --- cases -----------------------------------------------------------------------------------

test('opening a PR document with a bare caret does not aim the box at line 1', async (fx, view) => {
  await openAt(fx.file);
  await settle();

  const { anchor } = view.lastAim();
  assert.equal(
    anchor,
    undefined,
    `opening a diff must leave the box asking about the whole PR, got ${JSON.stringify(anchor)}`,
  );
});

test('selecting lines aims the box at exactly those lines', async (fx, view) => {
  await openAt(fx.file);
  await settle();
  const editor = vscode.window.activeTextEditor;
  editor.selection = new vscode.Selection(9, 0, 11, 5); // 0-based; lines 10-12 as the reviewer counts

  await until('the aim to reach lines 10-12', () => {
    const { anchor } = view.lastAim();
    return anchor && anchor.startLine === 10 && anchor.endLine === 12;
  });

  const { anchor } = view.lastAim();
  assert.equal(anchor.file, 'sample.ts');
  assert.equal(anchor.side, 'head');
});

test('collapsing the selection releases the aim back to the whole PR', async (fx, view) => {
  await openAt(fx.file);
  const editor = vscode.window.activeTextEditor;
  editor.selection = new vscode.Selection(9, 0, 11, 5);
  await until('an aim to release', () => view.lastAim().anchor !== undefined);

  editor.selection = new vscode.Selection(11, 5, 11, 5); // click: a caret, no range
  await until('the aim to be released', () => view.lastAim().anchor === undefined);
});

test('a document outside any PR leaves the aim alone', async (fx, view) => {
  await openAt(fx.file);
  const editor = vscode.window.activeTextEditor;
  editor.selection = new vscode.Selection(9, 0, 11, 5);
  await until('an aim to preserve', () => view.lastAim().anchor !== undefined);

  await openAt(fx.outside, new vscode.Selection(0, 0, 0, 5));
  await settle();

  const { anchor } = view.lastAim();
  assert.ok(anchor, 'looking at a file outside the PR must not drop what the reviewer aimed at');
  assert.equal(anchor.startLine, 10);
});

test('a winning outside selection hides commands before its delayed editor lookup returns', async (fx, _view, controller, repos) => {
  await openAt(fx.file);
  await until('selection commands to become enabled', () => controller.selectionCommandsEnabled);
  const pending = deferRepoLookups(repos);

  const editor = await openAt(fx.outside);
  await until('the outside editor lookup to start', () => pending.length >= 1);
  const beforeSelection = pending.length;
  editor.selection = new vscode.Selection(0, 0, 0, 5);
  await until('the outside selection lookup to start', () => pending.length > beforeSelection);
  await settle();

  const winner = pending.at(-1);
  winner.resolve(undefined);
  await until('selection commands to become hidden', () => !controller.selectionCommandsEnabled);
  for (const lookup of pending.slice(0, -1)) {
    lookup.resolve(undefined);
  }
  await settle();
  assert.equal(controller.selectionCommandsEnabled, false);
});

test('a winning PR selection enables commands before its delayed editor lookup returns', async (fx, _view, controller, repos) => {
  await openAt(fx.outside);
  await settle();
  assert.equal(controller.selectionCommandsEnabled, false);
  const pending = deferRepoLookups(repos);

  const editor = await openAt(fx.file);
  await until('the PR editor lookup to start', () => pending.length >= 1);
  const beforeSelection = pending.length;
  editor.selection = new vscode.Selection(9, 0, 11, 5);
  await until('the PR selection lookup to start', () => pending.length > beforeSelection);
  await settle();

  const winner = pending.at(-1);
  winner.resolve(fx.repo);
  await until('selection commands to become enabled', () => controller.selectionCommandsEnabled);
  for (const lookup of pending.slice(0, -1)) {
    lookup.resolve(fx.repo);
  }
  await settle();
  assert.equal(controller.selectionCommandsEnabled, true);
});

test('leaving the editor preserves a PR selection whose lookup is still pending', async (fx, view, controller, repos) => {
  const editor = await openAt(fx.file);
  await settle();
  const pending = deferRepoLookups(repos);

  editor.selection = new vscode.Selection(9, 0, 11, 5);
  await until('the PR selection lookup to start', () => pending.length >= 1);
  await closeAll();
  pending.at(-1).resolve(fx.repo);

  await until('the pending aim to reach lines 10-12', () => {
    const { anchor } = view.lastAim();
    return anchor && anchor.startLine === 10 && anchor.endLine === 12;
  });
  assert.equal(controller.selectionCommandsEnabled, true);
});

test('an already canceled walkthrough stops before prompt setup', async (fx) => {
  const controller = new AbortController();
  const reason = new Error('superseded walkthrough');
  controller.abort(reason);

  await assert.rejects(
    generateWalkthrough(
      'diff',
      path.join(fx.dir, 'missing-prompt.md'),
      undefined,
      undefined,
      undefined,
      controller.signal,
    ),
    (error) => error === reason,
  );
});

test('an already canceled context summary stops before prompt setup', async (fx) => {
  const controller = new AbortController();
  const reason = new Error('superseded context');
  controller.abort(reason);

  await assert.rejects(
    summarizeContext('title', 'body', path.join(fx.dir, 'missing-prompt.md'), undefined, controller.signal),
    (error) => error === reason,
  );
});

// --- runner ----------------------------------------------------------------------------------

exports.run = async function run() {
  const failures = [];
  for (const { name, fn } of cases) {
    const fx = fixture();
    const view = recordingView();
    const repos = new AskRepoRegistry();
    repos.seed(fx.repo);
    const controller = new AskController(vscode.Uri.file(path.resolve(__dirname, '../..')), view, repos);
    try {
      await fn(fx, view, controller, repos);
      console.log(`  ok   ${name}`);
    } catch (e) {
      failures.push({ name, e });
      console.log(`  FAIL ${name}\n       ${e && e.message}`);
    } finally {
      controller.dispose();
      repos.dispose();
      await closeAll();
      fs.rmSync(fx.dir, { recursive: true, force: true });
      fs.rmSync(fx.outside, { force: true });
    }
  }

  console.log(`\nintegration: ${cases.length - failures.length}/${cases.length} passed`);
  if (failures.length) {
    throw new Error(failures.map((f) => `${f.name}: ${f.e && f.e.message}`).join('\n'));
  }
};
