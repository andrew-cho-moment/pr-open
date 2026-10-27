import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AskConversationState, AskProcessResult, runAskProcess } from '../src/askconversation';

const anchor = { file: 'src/ask.ts', startLine: 10, endLine: 12, side: 'head' as const };

test('failed turns discard their partial session and keep only completed history', () => {
  const state = new AskConversationState();
  state.complete({ question: 'first?', aim: { anchor } }, 'first answer', 'session-a');

  assert.equal(state.session, 'session-a');
  assert.deepEqual(state.sent, anchor);
  assert.deepEqual(state.history, [{ question: 'first?', answer: 'first answer' }]);

  // Claude has captured a second question in this session, but pr-open has no completed answer for
  // it. The whole resumable state goes together while the successful transcript stays replayable.
  state.fail();

  assert.equal(state.session, undefined);
  assert.equal(state.sent, undefined);
  assert.deepEqual(state.history, [{ question: 'first?', answer: 'first answer' }]);
});

interface PendingRun {
  stdout(data: string): void;
  resolve(): void;
  reject(error: Error): void;
}

function pendingRun(session?: string): { run: Promise<AskProcessResult>; process: PendingRun } {
  let stdout = (_data: string) => {};
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const process = new Promise<void>((resolveRun, rejectRun) => {
    resolve = resolveRun;
    reject = rejectRun;
  });
  const run = runAskProcess(
    session,
    (onStdout) => {
      stdout = onStdout;
      return process;
    },
    () => {},
  );
  return { run, process: { stdout: (data) => stdout(data), resolve, reject } };
}

function init(session: string): string {
  return `${JSON.stringify({ type: 'system', subtype: 'init', session_id: session })}\n`;
}

function success(session: string, result: string): string {
  return `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: session, result })}\n`;
}

test('an aborted runner cannot restore its session while the next question runs', async () => {
  const state = new AskConversationState();
  const first = pendingRun();
  first.process.reject(new DOMException('aborted', 'AbortError'));
  const aborted = await first.run;
  assert.equal(aborted.ok, false);
  state.fail();

  const second = pendingRun(state.session);

  // `spawn` can reject from AbortError before stdout closes. This callback belongs to the canceled
  // process and arrives while the next question owns the conversation.
  first.process.stdout(init('stale-session') + success('stale-session', 'stale answer'));
  second.process.stdout(init('fresh-session') + success('fresh-session', 'second answer'));
  second.process.resolve();
  const completed = await second.run;
  assert.equal(completed.ok, true);
  if (!completed.ok) {
    return;
  }
  state.complete({ question: 'second?' }, completed.output.final ?? '', completed.output.session);
  assert.equal(state.session, 'fresh-session');
  assert.deepEqual(state.history, [{ question: 'second?', answer: 'second answer' }]);
});

test('a failed runner never makes its partial session resumable', async () => {
  const state = new AskConversationState();
  const failed = pendingRun();
  failed.process.stdout(init('partial-session'));
  failed.process.reject(new Error('runner failed'));
  const failure = await failed.run;
  assert.equal(failure.ok, false);
  state.fail();
  failed.process.stdout(success('partial-session', 'late answer'));

  const next = pendingRun(state.session);
  next.process.stdout(init('retry-session') + success('retry-session', 'retry answer'));
  next.process.resolve();
  const completed = await next.run;
  assert.equal(completed.ok, true);
  if (!completed.ok) {
    return;
  }
  state.complete({ question: 'retry?' }, completed.output.final ?? '', completed.output.session);
  assert.equal(state.session, 'retry-session');
  assert.deepEqual(state.history, [{ question: 'retry?', answer: 'retry answer' }]);
});
