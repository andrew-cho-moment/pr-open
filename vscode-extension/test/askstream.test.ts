import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AskEvent, isSessionGone, jsonlFramer, parseAskStream, rawTail, toolLabel } from '../src/askstream';

const SID = 'b633c94e-1a98-417a-9071-26a4406363c0';

/** Event lines captured verbatim from `claude 2.1.221 -p --output-format stream-json`, trimmed of
 *  the usage and diagnostics fields the parser ignores. */
const INIT = `{"type":"system","subtype":"init","cwd":"/dev/pr-open","session_id":"${SID}","tools":["Glob","Grep","Read"],"model":"claude-sonnet-5","permissionMode":"dontAsk"}`;
const STATUS = `{"type":"system","subtype":"status","status":"requesting","session_id":"${SID}"}`;
const RATE_LIMIT = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"${SID}"}`;
const MESSAGE_START = `{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[]}},"session_id":"${SID}"}`;

function delta(text: string): string {
  return `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}},"session_id":"${SID}"}`;
}

function toolUse(name: string, input: unknown): string {
  return `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"${name}","input":${JSON.stringify(input)}}]},"session_id":"${SID}"}`;
}

function assistantText(text: string): string {
  return `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":${JSON.stringify(text)}}]},"session_id":"${SID}"}`;
}

function success(result: string, denials: unknown[] = []): string {
  return `{"is_error":false,"session_id":"${SID}","permission_denials":${JSON.stringify(denials)},"subtype":"success","result":${JSON.stringify(result)},"type":"result"}`;
}

/** The dead-session failure, captured verbatim: `is_error`, no `result`, reason in `errors`. */
const DEAD_SESSION = `{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"00000000-0000-4000-8000-000000000000","permission_denials":[],"errors":["No conversation found with session ID: 00000000-0000-4000-8000-000000000000"]}`;

function collect(lines: string[]): AskEvent[] {
  const events: AskEvent[] = [];
  const parser = parseAskStream((e) => events.push(e));
  parser.feed(lines.join('\n') + '\n');
  parser.end();
  return events;
}

test('the session id comes from init and is confirmed by the result', () => {
  const ids = collect([INIT, delta('OK'), success('OK')])
    .filter((e) => e.kind === 'session')
    .map((e) => (e.kind === 'session' ? e.id : ''));
  assert.deepEqual(ids, [SID, SID]);
});

test('deltas accumulate across a tool call, and the result wins over them', () => {
  const events = collect([
    INIT,
    MESSAGE_START,
    delta('Let me check the caller. '),
    toolUse('Read', { file_path: '/dev/pr-open/src/tour.ts' }),
    delta('The guard exists because `mergeBase` can fail.'),
    success('The guard exists because `mergeBase` can fail.'),
  ]);

  const text = events.filter((e) => e.kind === 'delta').map((e) => (e.kind === 'delta' ? e.text : '')).join('');
  assert.equal(text, 'Let me check the caller. The guard exists because `mergeBase` can fail.');

  const done = events.find((e) => e.kind === 'done');
  assert.ok(done && done.kind === 'done');
  // The pre-tool aside is good progress feedback and wrong as the finished answer.
  assert.equal(done.text, 'The guard exists because `mergeBase` can fail.');
  assert.ok(!done.text.includes('Let me check'));

  assert.deepEqual(
    events.filter((e) => e.kind === 'tool').map((e) => (e.kind === 'tool' ? e.label : '')),
    ['Read tour.ts'],
  );
});

test('each assistant message reports its own text, which is where one answer ends and the next begins', () => {
  const events = collect([
    INIT,
    MESSAGE_START,
    delta('{"n":1}'),
    assistantText('{"n":1}'),
    toolUse('Read', { file_path: '/dev/pr-open/src/tour.ts' }),
    delta('{"n":2}'),
    assistantText('{"n":2}'),
    success('{"n":2}'),
  ]);

  // The tool call is a message of its own and carries no text, so a boundary lands there too.
  assert.deepEqual(
    events.filter((e) => e.kind === 'message').map((e) => (e.kind === 'message' ? e.text : '')),
    ['{"n":1}', '', '{"n":2}'],
  );
});

test('an errored result reports the reason from errors, not a generic message', () => {
  const events = collect([DEAD_SESSION]);
  const err = events.find((e) => e.kind === 'error');
  assert.ok(err && err.kind === 'error');
  assert.match(err.message, /No conversation found with session ID/);
  assert.ok(!events.some((e) => e.kind === 'done'));
});

test('denied tools are reported on the done event', () => {
  const events = collect([INIT, delta('x'), success('x', [{ tool_name: 'Bash' }])]);
  const done = events.find((e) => e.kind === 'done');
  assert.ok(done && done.kind === 'done');
  assert.deepEqual(done.denials, ['Bash']);
});

test('status, rate-limit and non-text stream events produce nothing', () => {
  // Regression guard: new event types must be ignored, not misread.
  assert.deepEqual(collect([STATUS, RATE_LIMIT, MESSAGE_START]), []);
});

test('the same bytes split at any offset parse identically', () => {
  const lines = [INIT, MESSAGE_START, delta('a'), toolUse('Grep', { pattern: 'useSleeve' }), delta('b'), success('ab')];
  const stream = lines.join('\n') + '\n';
  const expected = collect(lines);

  for (const chunk of [1, 7, 64, 999]) {
    const events: AskEvent[] = [];
    const parser = parseAskStream((e) => events.push(e));
    for (let i = 0; i < stream.length; i += chunk) {
      parser.feed(stream.slice(i, i + chunk));
    }
    parser.end();
    assert.deepEqual(events, expected, `chunk size ${chunk}`);
  }
});

test('a final line with no trailing newline is flushed by end()', () => {
  const events: AskEvent[] = [];
  const parser = parseAskStream((e) => events.push(e));
  parser.feed(success('done, no newline'));
  assert.deepEqual(events, []);
  parser.end();
  assert.ok(events.some((e) => e.kind === 'done'));
});

/** Every object the framer hands back, plus the text it kept, dropping the lines it could not parse. */
function frame(events: AskEvent[]): { objects: unknown[]; text: string } {
  const objects: unknown[] = [];
  const framer = jsonlFramer((o) => {
    if (o !== undefined) {
      objects.push(o);
    }
  });
  for (const e of events) {
    framer.feed(e);
  }
  framer.end();
  return { objects, text: framer.text() };
}

const textDelta = (text: string): AskEvent => ({ kind: 'delta', text });
const assistant = (text: string): AskEvent => ({ kind: 'message', text });
const result = (text: string): AskEvent => ({
  kind: 'done',
  text,
  denials: [],
});

/**
 * The event order `claude 2.1.234` produced for "emit one object, call a tool, emit another": each
 * message's text arrives as deltas and again in full, and neither message ends on a newline.
 */
const TWO_MESSAGES: AskEvent[] = [
  textDelta('{"thread":"T1","outcome":"fixed","reply":"Done."}'),
  assistant('{"thread":"T1","outcome":"fixed","reply":"Done."}'),
  { kind: 'tool', label: 'Edit math.js' },
  assistant(''), // the tool call is a message of its own, carrying no text
  textDelta('{"thread":"T2","outcome":"declined","reply":"Your call."}'),
  assistant('{"thread":"T2","outcome":"declined","reply":"Your call."}'),
  result('{"thread":"T2","outcome":"declined","reply":"Your call."}'),
];

test('jsonlFramer: a message ending mid-line does not run into the next message', () => {
  // Without the boundary the two objects concatenate into one unparseable line and both are lost,
  // which is every answer of a pass that emits one per message.
  assert.deepEqual(frame(TWO_MESSAGES).objects, [
    { thread: 'T1', outcome: 'fixed', reply: 'Done.' },
    { thread: 'T2', outcome: 'declined', reply: 'Your call.' },
  ]);
});

test('jsonlFramer: the final result repeats the last message and is not framed twice', () => {
  assert.equal(frame(TWO_MESSAGES).objects.length, 2);
});

test('jsonlFramer: an answer that only ever arrives in the final result is still framed', () => {
  assert.deepEqual(frame([result('{"n":1}\n{"n":2}')]).objects, [{ n: 1 }, { n: 2 }]);
});

test('jsonlFramer: a message completes what its deltas cut short, from where they stopped', () => {
  const { objects } = frame([textDelta('{"n":1}\n{"n"'), assistant('{"n":1}\n{"n":2}')]);
  assert.deepEqual(objects, [{ n: 1 }, { n: 2 }]);
});

test('jsonlFramer: the text it keeps holds each message once, so the array fallback still parses', () => {
  // What the fallback is handed when the model answers with one JSON array rather than a line per
  // object, split over two messages. Joining on a newline is what keeps it valid JSON.
  const { text } = frame([
    textDelta('[{"n":1},'),
    assistant('[{"n":1},'),
    textDelta('{"n":2}]'),
    assistant('{"n":2}]'),
    result('{"n":2}]'),
  ]);
  assert.deepEqual(JSON.parse(text), [{ n: 1 }, { n: 2 }]);
});

test('isSessionGone distinguishes a lost session from any other failure', () => {
  assert.ok(isSessionGone('No conversation found with session ID: abc'));
  assert.ok(!isSessionGone('claude exited with code 1'));
  assert.ok(!isSessionGone('The `claude` CLI was not found.'));
});

test('rawTail keeps the end of the stream, which is where a failure says why', () => {
  const tail = rawTail();
  // Well past the 16k bound, fed in pieces as stdout arrives.
  for (let i = 0; i < 3_000; i++) {
    tail.append(`{"type":"stream_event","seq":${i}}\n`);
  }
  tail.append('{"type":"result","is_error":true,"errors":["over quota"]}');

  const text = tail.text();
  assert.ok(text.length <= 16_000, `bounded, got ${text.length}`);
  assert.ok(text.endsWith('{"type":"result","is_error":true,"errors":["over quota"]}'));
  assert.ok(!text.includes('"seq":0}'), 'the start is dropped, not the end');
});

test('rawTail reads as (none) when the subprocess wrote nothing', () => {
  assert.equal(rawTail().text(), '(none)');
});

test('toolLabel names the target, or just the tool when there is none', () => {
  assert.equal(toolLabel('Read', { file_path: '/dev/pr-open/src/tour.ts' }), 'Read tour.ts');
  assert.equal(toolLabel('Grep', { pattern: 'useSleeve' }), 'Grep useSleeve');
  assert.equal(toolLabel('Glob', undefined), 'Glob');
});
