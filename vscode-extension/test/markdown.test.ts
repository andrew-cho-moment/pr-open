import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../src/markdown';

test('model output can never inject markup', () => {
  const html = renderMarkdown('Watch out: <script>alert(1)</script> & "quotes" and \'apostrophes\'.');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp;') && html.includes('&quot;') && html.includes('&#39;'));
});

test('a fence cannot break out of its own code block', () => {
  const html = renderMarkdown('```\n</code></pre><img onerror=x>\n```');
  assert.equal(html, '<pre><code>&lt;/code&gt;&lt;/pre&gt;&lt;img onerror=x&gt;</code></pre>');
});

test('an unterminated fence still renders balanced tags', () => {
  // The streaming case: a code block that has not finished arriving.
  const html = renderMarkdown('Here:\n```ts\nconst a = 1;');
  assert.ok(html.includes('<pre><code>const a = 1;</code></pre>'));
  assert.equal(count(html, '<pre>'), count(html, '</pre>'));
  assert.equal(count(html, '<code>'), count(html, '</code>'));
});

test('an unterminated inline span stays literal until its closer arrives', () => {
  assert.ok(renderMarkdown('partial `code').includes('partial `code'));
  assert.ok(renderMarkdown('partial **bold').includes('partial **bold'));
  assert.ok(renderMarkdown('done `code`').includes('<code>code</code>'));
});

test('emphasis inside a code span stays literal', () => {
  const html = renderMarkdown('call `a **b** c` now');
  assert.ok(html.includes('<code>a **b** c</code>'));
  assert.ok(!html.includes('<strong>'));
});

test('snake_case identifiers are not italicized', () => {
  assert.ok(!renderMarkdown('the base_ref_oid field').includes('<em>'));
  assert.ok(renderMarkdown('_emphasis_ here').includes('<em>emphasis</em>'));
});

test('only http(s) links become anchors', () => {
  assert.equal(renderMarkdown('[x](javascript:alert(1))').includes('<a'), false);
  assert.ok(renderMarkdown('[x](https://example.com/a?b=1)').includes('<a data-ext="https://example.com/a?b=1">x</a>'));
});

test('lists, headings, rules and paragraphs render', () => {
  assert.ok(renderMarkdown('- one\n- two').includes('<ul><li>one</li><li>two</li></ul>'));
  assert.ok(renderMarkdown('1. one\n2. two').includes('<ol><li>one</li><li>two</li></ol>'));
  assert.ok(renderMarkdown('## Heading').includes('<div class="md-h">Heading</div>'));
  assert.ok(renderMarkdown('---').includes('<hr class="md-hr" />'));

  const paras = renderMarkdown('first\n\nsecond');
  assert.equal(count(paras, '<p>'), 2);
  // A single newline inside a paragraph is a soft break, not a new paragraph.
  assert.ok(renderMarkdown('one\ntwo').includes('one<br />two'));
});

test('a list interrupted by prose closes before the paragraph', () => {
  const html = renderMarkdown('- one\n\nafter');
  assert.ok(html.indexOf('</ul>') < html.indexOf('<p>after</p>'));
});

test('empty input renders nothing', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('\n\n'), '');
});

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
