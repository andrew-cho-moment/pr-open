const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const err = $('err'); // repo picker + repos-load errors
const tourErr = $('tourErr'); // guided-review progress + errors, stays visible in focus mode
const askSection = $('askSection'); // the ask dock, whose height is the sum of the three below
const askResize = $('askResize'); // the dock's top edge, doubling as its divider
const askList = $('askList'); // the transcript; the dock's grip sizes it, so it is touched per-move
const askInput = $('askInput'); // the compose box; its own grip sizes it, likewise per-move
const askComposeResize = $('askComposeResize'); // the compose box's top edge

function submit(action) {
  const repo = $('repo').value;
  const number = $('num').value.trim();
  if (repo && number) {
    // Any warm still on the timer is for this very reference, since every path that arms it reads
    // these same two fields. The click has the better claim on the single job slot: it opens the
    // reference itself rather than guessing at it.
    clearTimeout(prefetchTimer);
    vscode.postMessage({ type: 'openRepo', action, repo, number });
  }
}

// Warm a PR the user looks likely to click, so the click finds the repo already in the window, its
// commits already fetched, and the GitHub PR extension already holding the PR. Debounced, since this
// fires from typing.
//
// A whole reference is the bar: a repo name on its own is a half-typed thought, and warming it would
// put a folder in the window for a repo the user is still deciding against.
//
// Short enough to fire before Enter does, which is what 700ms here used to spend the warm on: a whole
// reference typed leaves no pause a longer delay could wait for. The prefix numbers this warms on the
// way ("1247" queues #1 first) cost a round trip at most, because the extension side runs one job at
// a time, abandons a running job as soon as a newer reference arrives, and drops a guess still
// waiting for a slot when the user acts on one instead.
const TYPING_DELAY_MS = 50;
let prefetchTimer = null;
function prefetch(repo, number) {
  const n = Number(number);
  if (!repo || !Number.isInteger(n) || n <= 0) { return; }
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(
    () => vscode.postMessage({ type: 'prefetch', repo, number: n }),
    TYPING_DELAY_MS,
  );
}
function prefetchTyped() { prefetch($('repo').value, $('num').value.trim()); }

// Parse a pasted PR link / short ref into { repo, number }. Owner is dropped: the
// repo+number path resolves it from the matched clone's origin. Mirrors prref.ts.
function parsePasted(s) {
  s = s.trim();
  const strip = (r) => r.replace(/\.git$/i, '');
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(s);
  if (m) { return { repo: strip(m[2]), number: m[3] }; }
  m = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(s);
  if (m) { return { repo: strip(m[2]), number: m[3] }; }
  m = /^([^/\s#]+)#(\d+)$/.exec(s);
  if (m) { return { repo: strip(m[1]), number: m[2] }; }
  return null;
}

// Case-insensitive substring match; names starting with the query rank above names containing it.
function filterOptions(query, items) {
  const q = query.trim().toLowerCase();
  if (!q) { return items; }
  const starts = [], contains = [];
  for (const it of items) {
    const i = it.toLowerCase().indexOf(q);
    if (i === 0) { starts.push(it); } else if (i > 0) { contains.push(it); }
  }
  return starts.concat(contains);
}

// Keyboard-first autocomplete over a fixed list of strings, attached to an <input> inside a .combo
// wrapper. Replaces <datalist>, whose popup is drawn by the browser: we can neither read its
// highlight nor bind Tab to accepting it. Tab / Enter commit the highlighted match and keep focus,
// so Tab again moves on to the next field. The popup and the ARIA wiring are built here so the
// markup cannot drift out of sync with them; the rendered list is the only record of what matched.
function createCombo({ input, onChange, onEnterClosed }) {
  const list = document.createElement('ul');
  list.id = input.id + 'Options';
  list.className = 'combo-list';
  list.setAttribute('role', 'listbox');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.after(list);

  let items = [];
  let index = 0; // highlighted option; valid whenever the list is open

  const isOpen = () => !list.hidden;
  const highlighted = () => list.children[index];

  function close() {
    list.hidden = true;
    list.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  // Move the highlight without rebuilding the list; returns the newly highlighted option.
  function highlight(next) {
    list.querySelector('[aria-selected="true"]')?.setAttribute('aria-selected', 'false');
    index = next;
    const li = highlighted();
    li.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', li.id);
    return li;
  }

  function open(from) {
    const matches = filterOptions(from, items);
    if (!matches.length) { close(); return; }
    list.innerHTML = '';
    matches.forEach((m, i) => {
      const li = document.createElement('li');
      li.id = list.id + '-' + i;
      li.dataset.index = String(i);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.textContent = m;
      list.appendChild(li);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlight(0);
  }

  // Filling the field from elsewhere (a pasted URL, the status Fill button, prefill). Dismisses
  // any open popup, so no caller has to reason about whether one is showing.
  function setValue(value) {
    input.value = value;
    close();
  }

  function commit(value) {
    setValue(value);
    onChange?.();
  }

  // onChange covers typing and committing alike; assigning .value fires no 'input' event.
  input.addEventListener('input', () => { open(input.value); onChange?.(); });
  input.addEventListener('blur', close);
  // Clicking the field shows what is available, the way the <datalist> arrow used to. Clicking
  // again is for moving the caret, so an open list stays open.
  input.addEventListener('click', () => { if (!isOpen()) { open(input.value); } });
  // Committing by mouse must not blur the input first, or the blur handler would close the list
  // before the click lands; suppressing mousedown also leaves focus in the input.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li) { commit(li.textContent); }
  });
  // Hovering moves the real highlight, so the row under the cursor is the row Enter commits.
  list.addEventListener('mouseover', (e) => {
    const li = e.target.closest('li');
    if (li) { highlight(Number(li.dataset.index)); }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen()) { open(input.value); return; }
      const n = list.children.length;
      highlight((index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n).scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      if (isOpen()) { e.preventDefault(); commit(highlighted().textContent); return; }
      if (e.key === 'Enter') { onEnterClosed?.(); }
      return; // Tab with the list closed falls through to native focus movement
    }
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      close();
    }
  });

  close(); // hidden until the first keystroke, and stamps aria-expanded
  return { setItems(next) { items = next; close(); }, setValue };
}

const repoCombo = createCombo({
  input: $('repo'),
  onChange: prefetchTyped,
  onEnterClosed: () => submit('page'),
});

// Pasting or typing a link auto-fills the repo + number fields below.
$('url').addEventListener('input', () => {
  const p = parsePasted($('url').value);
  if (p) { repoCombo.setValue(p.repo); $('num').value = p.number; prefetch(p.repo, p.number); }
});
$('num').addEventListener('input', prefetchTyped);

document.querySelectorAll('button[data-action]').forEach((b) => {
  b.addEventListener('click', () => submit(b.dataset.action));
});
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit('page'); });
$('num').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit('page'); });

$('statusFill').addEventListener('click', () => {
  if (!checkedOutPr) { return; }
  repoCombo.setValue(checkedOutPr.repo);
  $('num').value = checkedOutPr.number;
});
$('statusCopy').addEventListener('click', () => {
  if (!checkedOutPr) { return; }
  vscode.postMessage({ type: 'copyUrl', url: checkedOutPr.url });
  const a = $('statusCopy');
  a.classList.replace('codicon-copy', 'codicon-check');
  setTimeout(() => { a.classList.replace('codicon-check', 'codicon-copy'); }, 1200);
});

// Focus mode: collapse everything above the guided review. Resets to expanded on each load.
let focusMode = false;
function setFocus(on) {
  focusMode = on;
  $('topSection').style.display = on ? 'none' : '';
  // Folding changes what #panelScroll holds, so a carried-over offset points at nothing meaningful.
  $('panelScroll').scrollTop = 0;
  $('focusToggle').className = on ? 'codicon codicon-fold-down' : 'codicon codicon-fold-up';
  $('focusToggle').title = on
    ? 'Show the PR picker and checkout status'
    : 'Hide everything above and focus on the review';
}
$('focusToggle').addEventListener('click', () => setFocus(!focusMode));

let checkedOutPr = null; // { repo, number, dir } for the checked-out PR, drives the Review + Fill buttons.
function setReviewButton() {
  const btn = $('tourStartBtn');
  btn.disabled = !checkedOutPr;
  btn.textContent = checkedOutPr ? 'Review PR #' + checkedOutPr.number : 'Review checked-out PR';
  $('statusFill').setAttribute('aria-disabled', String(!checkedOutPr));
  $('statusCopy').setAttribute('aria-disabled', String(!checkedOutPr));
  renderAddressButton();
}

function linkifyTitle(pr) {
  const title = escapeHtml(pr.title);
  if (pr.linear && pr.linearId) {
    return title.replace(pr.linearId, '<a data-ext="' + escapeHtml(pr.linear) + '">' + pr.linearId + '</a>');
  }
  return title;
}

function renderStatus(m) {
  const el = $('statusText');
  const s = m.item;
  checkedOutPr = s && s.pr ? { repo: s.repo, number: s.pr.number, dir: s.dir, url: s.pr.url } : null;
  setReviewButton();
  if (m.error) { el.textContent = m.error; return; }
  if (!s) { el.textContent = 'No repo open in this window.'; return; }
  const branch = '<b>' + escapeHtml(s.branch) + '</b>';
  let html = 'On ' + branch + '<br />no PR';
  if (s.pr) {
    // No branch here: the PR number and title already say which checkout this is, and the branch
    // is the long element that wrapped the row onto a second line. It stays in the no-PR case
    // below, where it is the only thing identifying where you are.
    html = '<a data-ext="' + escapeHtml(s.pr.url) + '">PR #' + s.pr.number + '</a><br />' + linkifyTitle(s.pr);
    if (s.pr.behind) {
      html +=
        '<div class="behind">Behind the remote head' +
        '<button class="pull" data-dir="' + escapeHtml(s.dir) + '" data-num="' + s.pr.number + '">Pull</button></div>';
    }
  }
  el.innerHTML = html;
  wireExternalLinks(el);
  el.querySelectorAll('button.pull').forEach((b) => {
    b.addEventListener('click', () =>
      vscode.postMessage({ type: 'pullPr', dir: b.dataset.dir, number: Number(b.dataset.num) }),
    );
  });
}

function startTour(repo, number, dir) {
  if (!repo || !number) { err.textContent = 'Pick a repo + number first.'; return; }
  vscode.postMessage({ type: 'tourStart', repo, number: Number(number), dir });
}
$('tourStartBtn').addEventListener('click', () => {
  if (checkedOutPr) { startTour(checkedOutPr.repo, checkedOutPr.number, checkedOutPr.dir); }
});
$('tourNextBtn').addEventListener('click', () => vscode.postMessage({ type: 'tourNext' }));
$('tourPrevBtn').addEventListener('click', () => vscode.postMessage({ type: 'tourPrev' }));
$('tourEndBtn').addEventListener('click', () => vscode.postMessage({ type: 'tourEnd' }));

const STATUS = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', binary: 'binary' };
function showTourActive(on) {
  $('tourIdle').style.display = on ? 'none' : '';
  $('tourActive').style.display = on ? '' : 'none';
  $('tourNav').style.display = on ? '' : 'none'; // pinned above the review, so it sits outside #tourActive
}

/** Everything an ended and a failed review both unwind. Neither keeps a heading or PR context. */
function showTourIdle() {
  showTourActive(false);
  tourStreaming = false;
  tourIncomplete = '';
  renderTourContext('');
  $('tourHeading').textContent = '';
}

// Steps stream in one at a time. The webview owns the running total and current step so it can
// update the "Step x/y" header and the Next button as more steps arrive.
let tourTotal = 0;
let tourStreaming = false;
let tourStepIdx = 0;
let currentStatus = '';
let tourIncomplete = '';

function refreshHeader() {
  if (tourTotal === 0) {
    $('tourStep').textContent = tourStreaming ? 'Analyzing…' : 'No reviewable source changes';
    $('tourPrevBtn').disabled = true;
    $('tourNextBtn').disabled = true;
    return;
  }
  const badge = '[' + (STATUS[currentStatus] || currentStatus || '...') + ']';
  $('tourStep').innerHTML =
    '<span class="badge">' + badge + '</span> Step ' + (tourStepIdx + 1) + '/' + tourTotal + (tourStreaming ? '…' : '');
  $('tourPrevBtn').disabled = tourStepIdx <= 0;
  $('tourNextBtn').disabled = tourStepIdx >= tourTotal - 1;
}

function appendTourStep(index, title, status) {
  const ul = $('tourSteps');
  const li = document.createElement('li');
  li.dataset.index = String(index);
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = (index + 1) + '. [' + (status === 'binary' ? 'bin' : status) + ']';
  li.appendChild(badge);
  li.appendChild(document.createTextNode(title));
  li.addEventListener('click', () => vscode.postMessage({ type: 'tourGoto', index }));
  ul.appendChild(li);
  tourTotal = ul.children.length;
  refreshHeader();
}

// A short business-context summary (from the PR description / Linear), shown above the steps and
// toggled by the "Context" button in the tour header. Empty text hides both the box and the button.
let contextText = '';
let contextOpen = true;
function renderTourContext(text) {
  contextText = text || '';
  $('tourContextBody').textContent = contextText;
  contextOpen = true; // fresh context defaults to shown
  updateContext();
}
function updateContext() {
  const has = !!contextText;
  const toggle = $('tourContextToggle');
  toggle.style.display = has ? '' : 'none';
  toggle.classList.toggle('active', has && contextOpen);
  toggle.setAttribute('aria-expanded', String(has && contextOpen));
  $('tourContext').style.display = has && contextOpen ? '' : 'none';
}
$('tourContextToggle').addEventListener('click', () => { contextOpen = !contextOpen; updateContext(); });

function renderTourState(m) {
  showTourActive(true);
  tourStepIdx = m.step;
  currentStatus = m.status;
  $('tourTitle').textContent = m.title;
  $('tourExpl').textContent = m.explanation;
  const locs = $('tourLocs');
  locs.innerHTML = '';
  for (const l of m.locations) {
    const a = document.createElement('a');
    setFileLoc(a, l);
    a.title = l.file; // full repo-relative path on hover
    a.addEventListener('click', () =>
      vscode.postMessage({ type: 'tourOpenLocation', file: l.file, startLine: l.startLine, endLine: l.endLine }));
    locs.appendChild(a);
  }
  refreshHeader();
  document.querySelectorAll('#tourSteps li').forEach((li) => {
    li.classList.toggle('active', Number(li.dataset.index) === m.step);
  });
  tourErr.textContent = tourIncomplete;
}

// --- Ask Claude ----------------------------------------------------------------------------------
// A transcript of the questions asked during this review, from either surface. What is typed here is
// one continuous conversation about the checked-out PR: the whole diff goes in with the first
// question, and every later one continues from it. Entries are held by the extension; this keeps only
// what it needs to render. Collapse state persists via setState so reopening the panel does not
// reopen a section the reviewer closed.
let askEntries = [];
const askSaved = vscode.getState() || {};
let askOpen = askSaved.askOpen === true;
// Transcript height in px, dragged via #askResize; the dock follows its content, so this is what a
// reviewer reaching for the dock's edge is really choosing (see #askSection in panel.css). Null until
// first dragged, when the transcript sizes to its entries.
let askListHeight = askSaved.askListHeight || null;
// Compose box height in px, dragged via #askComposeResize. Null until first dragged: the box then sits
// at the two rows its `rows` attribute asks for.
let askInputHeight = askSaved.askInputHeight || null;
// The anchor the compose box will submit with, narrowing the question to those lines. Null means the
// question is about the PR as a whole, which is what an unaimed box asks. `pending` freezes while the
// reviewer is typing, so clicking around the editor mid-question cannot silently re-aim it; `live`
// tracks the editor.
let askPending = null;
let askLive = null;
let askExpanded = new Set();

function askBusy() {
  return askEntries.some((e) => e.state === 'streaming');
}

function saveAskState() {
  vscode.setState({ askOpen, askListHeight, askInputHeight });
}

function setAskOpen(on, tell) {
  askOpen = on;
  askSection.classList.toggle('open', on);
  askResize.tabIndex = on ? 0 : -1; // no tab stop on a divider with no height to give
  $('askChevron').className = 'codicon codicon-chevron-' + (on ? 'down' : 'right');
  $('askToggle').setAttribute('aria-expanded', String(on));
  commitAskSizes(); // opening changed the dock's height, so both shares of it changed too
  if (tell !== false) { vscode.postMessage({ type: 'askToggle', open: on }); }
}

// The dock's height is the sum of its transcript, its compose box and its chrome, so resizing it means
// resizing one of those. Each of the two below owns one, enforces its floor, and leaves its ceiling to
// the stylesheet, which is what keeps holding after the window shrinks under a stored height.
const ASK_KEY_STEP = 24;
// A floor on the dragged preference, not on the rendered transcript: #askList keeps `min-height: 0` so
// it can still be squeezed to nothing when the dock is against its ceiling and the box needs the room.
const ASK_LIST_MIN_H = 48;
function applyListHeight(px) {
  askListHeight = px === null ? null : Math.max(px, ASK_LIST_MIN_H);
  askList.style.height = askListHeight ? askListHeight + 'px' : '';
  // A sized transcript drops the modesty cap the stylesheet puts on an untouched one.
  askList.classList.toggle('sized', askListHeight !== null);
}
// The floor comes back out of the stylesheet, which needs the same number anyway to stop a long
// transcript from squeezing the box below two lines. The transcript's floor above is a plain constant
// because only its drag has one.
const ASK_INPUT_MIN_H = parseFloat(getComputedStyle(askInput).minHeight);
function applyComposeHeight(px) {
  askInputHeight = px === null ? null : Math.max(px, ASK_INPUT_MIN_H);
  askInput.style.height = askInputHeight ? askInputHeight + 'px' : '';
}

// Each grip announces its element as a share of what contains it, the unit the stylesheet's ceilings
// are already in, so no pixel constant has to be mirrored here. Read after the browser has clamped.
function syncAskValue() {
  const share = askSection.getBoundingClientRect().height / document.body.clientHeight;
  askResize.setAttribute('aria-valuenow', String(Math.round(share * 100)));
}
function syncComposeValue() {
  const dock = askSection.getBoundingClientRect().height;
  const share = dock ? askInput.getBoundingClientRect().height / dock : 0;
  askComposeResize.setAttribute('aria-valuenow', String(Math.round(share * 100)));
}
// Either resize moves the dock, which is one share's denominator and the other's numerator, so both are
// announced together once the gesture settles - never mid-drag, where the reads would force a layout.
function commitAskSizes() {
  // Keep only the height the stylesheet allowed. A drag that carried on past max-height would otherwise
  // bank the overshoot: reversing it would do nothing until the surplus was paid off, and a later, taller
  // panel would restore a box the reviewer never saw. A zero reading means the box is not laid out at
  // all, which is a collapsed dock and tells us nothing about its height. The transcript is deliberately
  // not clamped this way - it renders short whenever the dock is against its ceiling, and storing that
  // would quietly shrink a preference the reviewer still holds.
  const shown = askInput.getBoundingClientRect().height;
  if (askInputHeight !== null && shown) { applyComposeHeight(shown); }
  syncAskValue();
  syncComposeValue();
  saveAskState();
}

// Wire a grip to the element it sizes. Both grips are the same gesture at two scales: a drag is a delta
// from where the pointer went down, with the height measured once there so no move reads layout, and
// the arrow keys step from the rendered height, which is what the reviewer can see after a stored one
// has been clamped. The delta is why neither pivots on its element's own edge - a grip sits a line
// above what it sizes, and pivoting there would jump that gap on the first move.
function wireGrip(grip, el, apply) {
  let startY = 0;
  let startH = 0;
  // Only a move resizes anything, so a stray click on a grip leaves both heights alone.
  const move = (e) => apply(startH + (startY - e.clientY));
  const end = () => {
    grip.removeEventListener('pointermove', move);
    commitAskSizes();
  };
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // no text selection while dragging
    startY = e.clientY;
    startH = el.getBoundingClientRect().height;
    grip.setPointerCapture(e.pointerId); // capture is released implicitly on pointerup
    grip.addEventListener('pointermove', move);
  });
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowUp' ? ASK_KEY_STEP : e.key === 'ArrowDown' ? -ASK_KEY_STEP : 0;
    if (!step) { return; }
    e.preventDefault();
    apply(el.getBoundingClientRect().height + step);
    commitAskSizes();
  });
}
wireGrip(askResize, askList, applyListHeight);
wireGrip(askComposeResize, askInput, applyComposeHeight);

function renderAskHead() {
  $('askCount').textContent = askEntries.length ? String(askEntries.length) : '';
  $('askClear').style.display = askEntries.length && !askBusy() ? '' : 'none';
  $('askStopBtn').style.display = askBusy() ? '' : 'none';
  $('askBtn').disabled = askBusy() || !askInput.value.trim();
}

function renderAskAnchor() {
  const el = $('askAnchor');
  const anchor = askPending || askLive;
  el.innerHTML = '';
  el.classList.toggle('empty', !anchor);
  if (!anchor) {
    el.textContent = 'whole PR · select lines to narrow it';
    renderAskHead();
    return;
  }
  const label = document.createElement('span');
  setFileLoc(label, anchor);
  label.title = anchor.file + (anchor.side === 'base' ? ' (base side)' : '');
  el.appendChild(label);
  // Only offer the reset while a frozen anchor differs from where the cursor actually is.
  if (askPending && askLive && !sameAnchor(askLive, askPending)) {
    const reset = document.createElement('a');
    reset.textContent = 'use current selection';
    reset.addEventListener('click', () => { askPending = null; renderAskAnchor(); });
    el.appendChild(reset);
  }
  renderAskHead();
}

// Whether two anchors name the same lines, so a reset that would change nothing is not offered.
// Mirrors sameAnchor in src/askanchor.ts. The path is what tells `src/order/book.ts:10-20` from
// `test/order/book.ts:10-20`, which the label they both show cannot.
function sameAnchor(a, b) {
  return a.file === b.file && a.side === b.side && a.startLine === b.startLine && a.endLine === b.endLine;
}

function renderAskList() {
  askList.innerHTML = '';
  for (const entry of askEntries) { askList.appendChild(renderAskEntry(entry)); }
  renderAskHead();
}

function renderAskEntry(entry) {
  const li = document.createElement('li');
  li.dataset.id = entry.id;

  const q = document.createElement('div');
  q.className = 'q';
  const chev = document.createElement('span');
  chev.className = 'codicon codicon-chevron-' + (askExpanded.has(entry.id) ? 'down' : 'right');
  q.appendChild(chev);
  const text = document.createElement('span');
  text.textContent = entry.question; // the reviewer's own words: never parsed
  q.appendChild(text);
  q.addEventListener('click', () => {
    if (askExpanded.has(entry.id)) { askExpanded.delete(entry.id); } else { askExpanded.add(entry.id); }
    renderAskList();
  });
  li.appendChild(q);

  const meta = document.createElement('div');
  meta.className = 'ask-meta';
  // A whole-PR question has no lines to jump to, so it says its scope instead of offering a link.
  if (entry.anchor) {
    const jump = document.createElement('a');
    setFileLoc(jump, entry.anchor);
    jump.title = entry.anchor.file;
    jump.addEventListener('click', () => vscode.postMessage({ type: 'askJump', id: entry.id }));
    meta.appendChild(jump);
  } else {
    meta.appendChild(document.createTextNode('whole PR'));
  }
  if (entry.state === 'streaming') { meta.appendChild(document.createTextNode('…')); }
  li.appendChild(meta);

  if (askExpanded.has(entry.id)) {
    if (entry.state === 'error') {
      const e = document.createElement('div');
      e.className = 'err';
      e.textContent = entry.error || 'That question failed.';
      li.appendChild(e);
    }
    const body = document.createElement('div');
    body.className = 'ask-answer';
    body.innerHTML = entry.html || ''; // extension-rendered, escaped HTML only
    wireExternalLinks(body);
    li.appendChild(body);
  }
  return li;
}

// Answers may cite URLs; the renderer emits them as data-ext, the panel's existing convention.
function wireExternalLinks(root) {
  root.querySelectorAll('a[data-ext]').forEach((a) => {
    a.addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: a.dataset.ext }));
  });
}

// A streaming answer re-renders often, so only its own body is rewritten: completed answers keep
// their selection and scroll position. Writes are coalesced to one per frame.
let askPaint = null;
function applyAnswer(id, html) {
  const entry = askEntries.find((e) => e.id === id);
  if (!entry) { return; }
  entry.html = html;
  if (!askExpanded.has(id)) { return; }
  if (askPaint) { askPaint.set(id, html); return; }
  askPaint = new Map([[id, html]]);
  requestAnimationFrame(() => {
    const pending = askPaint;
    askPaint = null;
    for (const [entryId, markup] of pending) {
      const li = askList.querySelector('li[data-id="' + entryId + '"]');
      const body = li && li.querySelector('.ask-answer');
      if (!body) { continue; }
      const atBottom = askList.scrollHeight - askList.scrollTop - askList.clientHeight < 24;
      body.innerHTML = markup;
      wireExternalLinks(body);
      if (atBottom) { askList.scrollTop = askList.scrollHeight; }
    }
  });
}

function askSubmit() {
  const anchor = askPending || askLive;
  const question = askInput.value.trim();
  if (!question || askBusy()) { return; }
  // An unaimed box asks about the whole PR.
  vscode.postMessage({ type: 'askSubmit', question, anchor: anchor || undefined });
  askInput.value = '';
  askPending = null;
  renderAskAnchor();
}

$('askToggle').addEventListener('click', () => setAskOpen(!askOpen));
$('askClear').addEventListener('click', () => vscode.postMessage({ type: 'askClear' }));
$('askBtn').addEventListener('click', askSubmit);
$('askStopBtn').addEventListener('click', () => {
  const streaming = askEntries.find((e) => e.state === 'streaming');
  if (streaming) { vscode.postMessage({ type: 'askCancel', id: streaming.id }); }
});
askInput.addEventListener('input', () => {
  // Typing freezes the anchor the reviewer aimed at; clearing the box releases it.
  askPending = askInput.value.trim() ? askPending || askLive : null;
  renderAskAnchor();
});
askInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); askSubmit(); }
});

function upsertAskEntry(entry) {
  const at = askEntries.findIndex((e) => e.id === entry.id);
  if (at >= 0) { askEntries[at] = entry; } else { askEntries.push(entry); }
  // A question asked from here is one the reviewer is waiting on; one asked in the diff should not
  // yank the panel open, it just bumps the count.
  if (entry.origin === 'panel') {
    askExpanded.add(entry.id);
    if (!askOpen) { setAskOpen(true); }
  }
  renderAskList();
}

// --- Address PR comments -------------------------------------------------------------------------
// One run over every unresolved review thread on the checked-out PR: claude fixes what it can, then
// pr-open commits and pushes that, replies on each thread, and resolves the ones it addressed. The
// extension owns the run and pushes its whole state on every change, so this only ever renders what
// it was last handed — there is no partial update to keep in step.
let addressState = { running: false, message: '', items: [] };

// Only `declined` needs saying differently: the other outcomes already read as what they are.
const DECLINED_BADGE = 'needs you';
// What has happened to a thread on GitHub, which is the part a reviewer's reply depends on.
const ADDRESS_NOTE = {
  pending: 'waiting',
  drafted: 'not posted yet',
  resolved: 'replied · resolved',
  replied: 'replied · still open',
  failed: 'not posted',
};

function renderAddressButton() {
  const btn = $('addressBtn');
  btn.disabled = !checkedOutPr || addressState.running;
  btn.textContent = addressState.running ? 'Addressing…' : 'Address PR comments';
}

function renderAddress(state) {
  addressState = state;
  const shown = state.running || state.items.length > 0 || !!state.message || !!state.error;
  $('addressBox').style.display = shown ? '' : 'none';
  $('addressStatus').textContent = state.message;
  $('addressErr').textContent = state.error || '';
  $('addressCancel').style.display = state.running ? '' : 'none';
  const ul = $('addressList');
  ul.innerHTML = '';
  for (const item of state.items) { ul.appendChild(renderAddressItem(item)); }
  renderAddressButton();
}

function addressBadge(item) {
  if (item.outcome) { return item.outcome === 'declined' ? DECLINED_BADGE : item.outcome; }
  return item.state === 'failed' ? 'failed' : 'pending';
}

function renderAddressItem(item) {
  const li = document.createElement('li');
  const head = document.createElement('div');
  head.className = 'address-head';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = '[' + addressBadge(item) + ']';
  head.appendChild(badge);
  const where = document.createElement('a');
  setLoc(where, item.file.split('/').pop(), ':' + item.lines);
  where.title = item.file + (item.outdated ? ' · outdated: these lines have moved since the comment' : '');
  where.addEventListener('click', () => vscode.postMessage({ type: 'addressOpen', label: item.label }));
  head.appendChild(where);
  const note = document.createElement('span');
  note.className = 'address-note';
  note.textContent = ADDRESS_NOTE[item.state];
  head.appendChild(note);
  li.appendChild(head);
  if (item.replyHtml) {
    const body = document.createElement('div');
    body.className = 'ask-answer'; // the reply is markdown, under the same rules as an answer
    body.innerHTML = item.replyHtml; // extension-rendered, escaped HTML only
    wireExternalLinks(body);
    li.appendChild(body);
  }
  if (item.error) {
    const err = document.createElement('div');
    err.className = 'err';
    err.textContent = item.error;
    li.appendChild(err);
  }
  return li;
}

$('addressBtn').addEventListener('click', () => {
  if (!checkedOutPr || addressState.running) { return; }
  if (!askOpen) { setAskOpen(true); } // the run reports inside the dock, so open it first
  vscode.postMessage({ type: 'addressStart' });
});
$('addressCancel').addEventListener('click', () => vscode.postMessage({ type: 'addressCancel' }));

// --- Adversarial review -------------------------------------------------------------------------
// Findings land on GitHub as a draft review, so the panel carries a status line and a link rather
// than a second copy of the list: the reviewer adjudicates where the Submit button is.
function renderAdversarial(state) {
  const running = state.phase === 'hunting' || state.phase === 'filing';
  $('advBtn').disabled = running;
  $('advBtn').textContent = running ? 'Reviewing…' : 'Adversarial review';
  const stop = $('advStopBtn');
  stop.style.display = running || state.message || state.error ? '' : 'none';
  stop.textContent = running ? 'Stop' : 'Dismiss';
  $('advErr').textContent = state.error || '';
  const status = $('advStatus');
  status.textContent = '';
  if (!state.message) { return; }
  status.appendChild(document.createTextNode(state.message + ' '));
  if (state.url) {
    const a = document.createElement('a');
    a.dataset.ext = state.url;
    a.textContent = 'View pending review on GitHub';
    status.appendChild(a);
    wireExternalLinks(status);
  }
}

$('advBtn').addEventListener('click', () => {
  const number = $('num').value.trim();
  if (!number || $('advBtn').disabled) { return; }
  vscode.postMessage({ type: 'adversarialStart', number });
});
$('advStopBtn').addEventListener('click', () => vscode.postMessage({ type: 'adversarialCancel' }));

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'prefill') {
    repoCombo.setValue(m.repo);
    $('num').value = String(m.number);
    return;
  }
  if (m.type === 'tourStarted') {
    tourErr.textContent = '';
    tourIncomplete = '';
    $('tourHeading').textContent = m.repo + ' [PR #' + m.number + ']';
    tourTotal = 0; tourStreaming = true; tourStepIdx = 0; currentStatus = '';
    showTourActive(true);
    $('tourSteps').innerHTML = '';
    $('tourTitle').textContent = ''; $('tourExpl').textContent = ''; $('tourLocs').innerHTML = '';
    renderTourContext('');
    $('tourStep').textContent = 'Analyzing…';
    // Deliberately does not touch the transcript: a restore re-posts tourStarted, and only
    // `askCleared` (which the extension owns) may drop questions it still holds.
    return;
  }
  if (m.type === 'askSnapshot') {
    askEntries = m.entries;
    askExpanded = new Set([...askExpanded].filter((id) => askEntries.some((e) => e.id === id)));
    askLive = m.anchor || null;
    renderAskList();
    renderAskAnchor();
    return;
  }
  if (m.type === 'askEntry') { upsertAskEntry(m.entry); return; }
  if (m.type === 'askAnswer') {
    const entry = askEntries.find((x) => x.id === m.id);
    if (entry) { entry.state = m.state; }
    applyAnswer(m.id, m.html);
    if (m.state === 'done') { renderAskList(); }
    return;
  }
  if (m.type === 'askFailed') {
    const entry = askEntries.find((x) => x.id === m.id);
    if (entry) { entry.state = 'error'; entry.error = m.message; }
    renderAskList();
    return;
  }
  if (m.type === 'askAnchor') {
    askLive = m.anchor || null;
    renderAskAnchor();
    return;
  }
  if (m.type === 'addressState') { renderAddress(m.state); return; }
  if (m.type === 'askCleared') {
    askEntries = []; askExpanded = new Set(); askPending = null;
    askInput.value = '';
    renderAskList();
    renderAskAnchor();
    return;
  }
  if (m.type === 'tourContext') { renderTourContext(m.text); return; }
  if (m.type === 'tourStep') { appendTourStep(m.index, m.title, m.status); return; }
  if (m.type === 'tourState') { renderTourState(m); return; }
  if (m.type === 'tourStreamDone') {
    tourStreaming = false;
    tourErr.textContent = tourIncomplete;
    refreshHeader();
    return;
  }
  if (m.type === 'tourProgress') { tourErr.textContent = m.message; return; }
  if (m.type === 'tourError') {
    if (m.partial) {
      tourStreaming = false;
      tourIncomplete = 'Incomplete review: ' + m.message;
      tourErr.textContent = tourIncomplete;
      refreshHeader();
    } else {
      showTourIdle();
      tourErr.textContent = m.message;
    }
    return;
  }
  if (m.type === 'tourEnded') { showTourIdle(); tourTotal = 0; $('tourSteps').innerHTML = ''; tourErr.textContent = ''; return; }
  if (m.type === 'adversarialState') { renderAdversarial(m.state); return; }
  if (m.type === 'checkoutStatus') { renderStatus(m); return; }
  if (m.type === 'repos') {
    err.textContent = m.error || '';
    repoCombo.setItems(m.repos);
  }
});

// --- Location labels ----------------------------------------------------------------------------
// Every location a reviewer clicks reads `basename:lines`, and the panel is a sidebar: a generated
// name would run past its right edge and take the line range with it, leaving
// `20260901193000_settle_cash_a` with nothing to click towards. The label is built as two boxes
// instead, and panel.css shrinks the stem a thousand times faster than the tail, so the width falls
// where `20260901193000_settle_cash_acc….sql:1-41` reads: the name gives way first and the range is
// the last thing to go, which on a sidebar at its narrowest is all that is left. The full
// repo-relative path stays one hover away, and the whole name stays in the DOM for a copy or a screen
// reader, the elision being paint rather than text. The engine does the fitting, so nothing here
// measures anything and a label laid out inside a closed dock or a dragged sidebar comes out right
// with no code run at all.
function setLoc(el, name, rest) {
  const dot = name.lastIndexOf('.'); // a leading dot is the name itself, not an extension
  const cut = dot > 0 ? dot : name.length;
  const stem = document.createElement('span');
  stem.className = 'loc-stem';
  stem.textContent = name.slice(0, cut);
  const tail = document.createElement('span');
  tail.className = 'loc-tail';
  tail.textContent = name.slice(cut) + rest;
  el.classList.add('loc');
  el.replaceChildren(stem, tail);
}

// A location naming a file and a line range: a review location, an ask anchor. An Address row goes
// through setLoc directly, its range arriving from the extension already written out.
function setFileLoc(el, ref) {
  const lines = ref.endLine > ref.startLine ? ref.startLine + '-' + ref.endLine : String(ref.startLine);
  setLoc(el, ref.file.split('/').pop(), ':' + lines + (ref.side === 'base' ? ' · base' : ''));
}

// Mirrors src/markdown.ts's escaper, single quote included: every attribute built here is
// double-quoted today, so `'` escapes nothing yet — it is here so the next single-quoted attribute
// cannot quietly be the one that needed it.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Both stored heights are facts about the transcript and the box rather than about the dock being
// open, so they land once here; setAskOpen only re-announces the shares they add up to.
applyListHeight(askListHeight);
applyComposeHeight(askInputHeight);
// Restore the Ask section's collapse state before `ready`, so the extension's mirror agrees with
// what is on screen and streaming updates are not suppressed against an open section.
setAskOpen(askOpen);
renderAskAnchor();

vscode.postMessage({ type: 'ready' });
