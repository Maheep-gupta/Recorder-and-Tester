/* ══════════════════════════════════════════════════════════════════════════
   Replayr — the STANDALONE PANEL's script.

   One job: mirror the recording, live, in a window narrow enough to sit next
   to the app you are recording. It OWNS nothing. The server holds the draft;
   this page renders snapshots of it and posts commands back.

   The SSE contract is the same one ui/app.js uses — EventSource('/api/events'),
   event names "recording" and "run". The recording payload is Recording#snapshot():

     { status, paused, app, baseUrl, headed, startedAt, stoppedAt,
       captureReady, error, browserLabel, viewport, steps: [ decorated step, … ] }

   A decorated step carries `type`, `text` (server-rendered English), `warnings`,
   `locatorSummary` ({ primary, strategy, score, verified, fallbacks }) and, for
   an identity target, `target.fingerprint` + `target.candidates`. Everything the
   inspector below shows is read from those — nothing on this page is invented,
   and where a thing genuinely is not captured the pane says so rather than
   drawing a convincing blank.

   The row descriptions are built here rather than printing `text`, because
   `text` already inlines the element name and repeating it in a 380px column
   wastes the line that matters. The server's wording is kept as the row tooltip.

   Plain DOM, no framework, no build step, no external requests.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const $ = (id) => document.getElementById(id);

/* ── page state. `stepCount` is only kept to diff against the next snapshot. ── */
const S = {
  snap: { status: 'idle', paused: false, steps: [] },
  stepCount: 0,
  sseUp: false,
  loaded: false,         // true once the first snapshot has arrived
  away: 0,               // steps that landed while the list was scrolled up
  follow: true,          // auto-scroll while you are at the bottom of the list
  busy: null,            // the command in flight, so a double-click cannot fire twice
  tick: null,            // the elapsed-time interval
  cmdError: null,        // why the last command was refused

  mode: 'record',        // record · execute · settings
  sub: 'steps',          // steps · inspector · console · network
  loc: 'locators',       // locators · attributes · screenshot · html
  selId: null,           // the selected step's id
  search: '',
  filter: 'all',         // 'all' or a step type
  logs: { console: [], network: [] },
  logErr: { console: null, network: null },
  run: null,             // the most recent 'run' frame, for the Execute pane
};

/* ══════════════════════════════════════════════════════════════════════════
   THEME — the same choice, the same localStorage key, as the main window.
   Both pages are the same origin, so parking the panel beside the main window
   and flipping the theme in either keeps them in step (on the next paint).
   ══════════════════════════════════════════════════════════════════════════ */
const THEMES = ['system', 'light', 'dark'];

function themeChoice() {
  try { return localStorage.getItem('tf.theme') || 'system'; } catch { return 'system'; }
}

function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') document.documentElement.setAttribute('data-theme', choice);
  else document.documentElement.removeAttribute('data-theme');
  const dark = choice === 'dark'
    || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  $('themeIcon').setAttribute('href', choice === 'system' ? '#i-system' : dark ? '#i-moon' : '#i-sun');
  const next = THEMES[(THEMES.indexOf(choice) + 1) % THEMES.length];
  const word = { system: 'follow the system', light: 'light', dark: 'dark' };
  $('themeBtn').setAttribute('aria-label', `Theme: ${word[choice]}. Switch to ${word[next]}.`);
}

function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(themeChoice()) + 1) % THEMES.length];
  try { localStorage.setItem('tf.theme', next); } catch { /* private window: this session only */ }
  applyTheme(next);
}

/* ══════════════════════════════════════════════════════════════════════════
   SMALL HELPERS
   ══════════════════════════════════════════════════════════════════════════ */
const ICONS = {
  navigate: 'i-nav', click: 'i-click', dblclick: 'i-click', hover: 'i-hover',
  fill: 'i-fill', press: 'i-key', check: 'i-tick', uncheck: 'i-untick',
  select: 'i-select', upload: 'i-upload', openPage: 'i-tab', closePage: 'i-tab',
  wait: 'i-dot', waitForXhr: 'i-dot',
  expectVisible: 'i-eye', expectText: 'i-eye', expectValue: 'i-eye',
  expectChecked: 'i-eye', expectUrl: 'i-eye', expectSnapshot: 'i-eye',
};

/** Clip a value so one long paste cannot own the whole row. */
function clip(v, max = 42) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A URL as you would read it out loud: the path, not the origin. */
function shortUrl(url) {
  const raw = String(url || '').replace('{{baseUrl}}', '');
  try { const u = new URL(raw); return clip(u.pathname + u.search, 40); } catch { /* already relative */ }
  return clip(raw, 40) || '/';
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function icon(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls || 'i');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.appendChild(use);
  return svg;
}

/**
 * Byte-for-byte the same rule as `formatDuration()` in steps.js. It is duplicated rather than
 * shared because that file is Node and this one is a browser script with no build step - so if
 * you change one, change the other, or the same wait step starts reading differently depending
 * on which window you are looking at.
 */
function fmtWait(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (n < 100) return `${n}ms`;
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}s`;
}

/**
 * The action, WITHOUT the target — the target gets its own line, so saying it
 * twice would cost the row its second line for nothing.
 */
function shortDesc(step) {
  switch (step.type) {
    case 'navigate': return `Go to ${shortUrl(step.url)}`;
    case 'click': return 'Click';
    case 'dblclick': return 'Double-click';
    case 'hover': return 'Hover';
    // Mirrors describe() in steps.js: a credential is never rendered, here or anywhere else.
    case 'fill': return step.secret ? 'Type a hidden value' : `Type "${clip(step.value, 34)}"`;
    case 'press': return `Press ${step.key}`;
    case 'check': return 'Tick';
    case 'uncheck': return 'Untick';
    case 'select': return step.secret ? 'Select a hidden value' : `Select "${clip((step.values || []).join(', '), 34)}"`;
    case 'upload': return `Upload ${(step.files || []).length || 'a'} file(s)`;
    case 'openPage': return 'A new tab opens';
    case 'closePage': return 'Close the tab';
    // Worded to match `describe()` in steps.js exactly. Three surfaces render these steps -
    // this panel, the main step list, and the run result - and a wait that reads "Wait 2300 ms"
    // in one and "Wait 2.3s" in another looks like two different steps to the person reading it.
    case 'wait': return `Wait ${fmtWait(step.ms)}`;
    case 'waitForXhr': return 'Wait for network';
    case 'expectVisible': return 'Expect visible';
    // No value here on purpose: decorate() overwrites a step's own `text` with
    // its English rendering, so the expected string is not in the snapshot.
    case 'expectText': return 'Expect the text';
    case 'expectValue': return `Expect value "${clip(step.value, 30)}"`;
    case 'expectChecked': return step.checked === false ? 'Expect unticked' : 'Expect ticked';
    case 'expectUrl': return `Expect the URL ${shortUrl(step.url)}`;
    case 'expectSnapshot': return 'Expect the recorded snapshot';
    default: return step.type;
  }
}

/** The action, in the words the details pane uses — the full name, no target. */
const ACTION_NAME = {
  navigate: 'Navigate', click: 'Click', dblclick: 'Double-click', hover: 'Hover',
  fill: 'Fill', press: 'Press key', check: 'Check', uncheck: 'Uncheck',
  select: 'Select', upload: 'Upload', openPage: 'New tab', closePage: 'Close tab',
  wait: 'Wait', waitForXhr: 'Wait for network',
  expectVisible: 'Expect visible', expectText: 'Expect text', expectValue: 'Expect value',
  expectChecked: 'Expect checked', expectUrl: 'Expect URL', expectSnapshot: 'Expect snapshot',
};

/**
 * What the step is pointing at: the accessible name where the element has one,
 * with its role as a tag. Falls back to the winning locator so a nameless
 * element still says something honest rather than nothing.
 */
function targetLine(step) {
  const t = step.target;
  if (t && t.fingerprint) {                       // identity target — the normal case
    const fp = t.fingerprint;
    const name = fp.name || fp.text || '';
    if (name) return { role: fp.role || fp.tag || '', name: clip(name, 60) };
  }
  if (t && !t.fingerprint) {                      // legacy `{ by, role, name/text }` target
    const name = t.name && typeof t.name === 'object' ? t.name.regex : (t.name || t.text || t.value || '');
    if (name) return { role: t.role || t.by || '', name: clip(String(name), 60) };
  }
  const sum = step.locatorSummary;
  if (sum && sum.primary) return { role: '', locator: clip(sum.primary, 60) };
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
   STATUS
   ══════════════════════════════════════════════════════════════════════════ */

/** The word at the top. `paused` is a flag on a recording, but here it IS the state. */
function statusKey(snap) {
  if (!S.loaded) return 'connecting';
  if (snap.status === 'recording' && snap.paused) return 'paused';
  return snap.status || 'idle';
}

const STATUS_TEXT = {
  connecting: 'Connecting…',
  idle: 'No recording in progress',
  starting: 'Opening the browser…',
  recording: 'Recording',
  paused: 'Paused',
  stopping: 'Stopping…',
  stopped: 'Recording stopped',
  error: 'Recording failed',
};

function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** A step's offset from the start of the recording — the column on the right of each row. */
function stepOffset(step) {
  const started = S.snap.startedAt ? Date.parse(S.snap.startedAt) : null;
  const at = step && step.at ? Date.parse(step.at) : null;
  if (!started || !at || !Number.isFinite(at - started)) return '';
  return fmtElapsed(Math.max(0, at - started));
}

/** Runs on every snapshot AND once a second, so the clock moves between snapshots. */
function paintElapsed() {
  const { startedAt, stoppedAt } = S.snap;
  if (!startedAt) { $('elapsed').textContent = '—'; return; }
  const end = stoppedAt ? Date.parse(stoppedAt) : Date.now();
  $('elapsed').textContent = fmtElapsed(end - Date.parse(startedAt));
}

function setBadge(id, value) {
  const b = $(id);
  if (!Number.isFinite(value)) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = String(value);
}

function paintHeader() {
  const snap = S.snap;
  const key = statusKey(snap);
  document.documentElement.setAttribute('data-rec', key);
  document.title = key === 'recording' ? `● Recording — ${(snap.steps || []).length} steps`
    : key === 'paused' ? '⏸ PAUSED — Recorder'
    : 'Replayr — Recorder';

  $('statusText').textContent = STATUS_TEXT[key] || key;
  const n = (snap.steps || []).length;
  $('count').textContent = `${n} ${n === 1 ? 'step' : 'steps'}`;
  $('tabStepCount').textContent = String(n);
  paintElapsed();
  paintTarget(snap, key);

  // Whether the identity engine attached decides how good the locators will be,
  // so it is stated up front rather than discovered when a replay fails.
  const cap = $('capture');
  const live = ['starting', 'recording', 'stopping', 'stopped'].includes(snap.status);
  // While paused nothing is captured at all, so claiming "identity capture on" would
  // contradict the PAUSED bar sitting directly beneath it on the same screen.
  cap.textContent = key === 'paused' ? 'capture paused'
    : !live ? 'identity capture idle'
    : snap.captureReady ? 'identity capture on' : 'identity capture OFF';
  cap.className = 'sbar-item ' + (key === 'paused' ? 'no' : !live ? '' : snap.captureReady ? 'ok' : 'no');

  // What is ACTUALLY running. The Setup form's Browser and Viewport choices are honoured at
  // launch, but a maximised window sizes itself, so recording.js measures both off the live
  // session afterwards — a value shown here is one the session really has.
  const vp = snap.viewport;
  const bits = [];
  if (vp && vp.width) bits.push(vp.width + ' × ' + vp.height);
  if (snap.browserLabel) bits.push('(' + snap.browserLabel + ')');
  $('sessionText').textContent = bits.length ? bits.join(' ') : '—';
  $('session').hidden = !bits.length;

  const app = $('appLine');
  if ((snap.app || snap.baseUrl) && !snap.target) {
    app.hidden = false;
    app.textContent = `${snap.app || 'app'} · ${snap.baseUrl || ''}`;
  } else {
    app.hidden = true;
  }

  $('pausedBar').hidden = key !== 'paused';
  // Live controls while there is something to control; Review & save / Discard once it has
  // stopped. Never both, so the bar keeps its width.
  const done = key === 'stopped';
  $('ctlLive').hidden = done || key === 'idle' || key === 'connecting';
  $('ctlDone').hidden = !done;
  $('btnDiscard').disabled = !!S.busy;
  $('btnReview').disabled = !!S.busy || !(snap.steps || []).length;
  $('btnReview').title = (snap.steps || []).length ? '' : 'Nothing was captured, so there is nothing to review.';
  if (!done) $('discardBar').hidden = true;
  // One bar, two sources: the recording's own error, or a command the server refused. The
  // command's reason wins — it is the newer news, and it is answering something you just did.
  const problem = S.cmdError || snap.error;
  $('errBar').hidden = !problem;
  if (problem) $('errText').textContent = problem;

  const active = ['starting', 'recording', 'stopping'].includes(snap.status);
  // On a single-row bar the two states swap places rather than sitting side by side with one
  // permanently dead. Only ever one of them is in the layout, so the bar keeps its width.
  const paused = !!snap.paused;
  $('btnPause').hidden = paused;
  $('btnResume').hidden = !paused;
  $('btnPause').disabled = !!S.busy || snap.status !== 'recording' || paused;
  $('btnResume').disabled = !!S.busy || snap.status !== 'recording' || !paused;
  $('btnStop').disabled = !!S.busy || !active;

  // Counts the server sends alongside the snapshot, so the tabs say whether there is anything
  // to look at before you switch to them. Absent on a build without the capture — then the
  // badge stays hidden rather than showing a confident zero.
  setBadge('tabConsoleCount', snap.consoleCount);
  setBadge('tabNetworkCount', snap.networkCount);
}

const KIND_WORD = { production: 'Production', staging: 'Staging', development: 'Development', local: 'Local' };

/** Environment strip, production warning and current page. Every field is optional. */
function paintTarget(snap, key) {
  const live = !['idle', 'connecting'].includes(key);
  const t = snap.target && typeof snap.target === 'object' ? snap.target : null;
  const kind = t && KIND_WORD[t.kind] ? t.kind : null;

  const strip = $('targetStrip');
  strip.hidden = !(live && t);
  if (t) {
    $('targetLabel').textContent = t.label || t.key || t.baseUrl || 'Environment';
    $('targetLabel').title = t.baseUrl || '';
    const badge = $('targetKind');
    badge.hidden = !kind;
    badge.className = 'env-badge' + (kind ? ' env-' + kind : '');
    badge.textContent = kind ? KIND_WORD[kind] : '';
  }

  const warn = $('prodWarn');
  const isProd = !!t && kind === 'production';
  warn.hidden = !(live && t && (t.protected || isProd));
  $('prodWarnText').textContent = isProd
    ? 'Recording on PRODUCTION — avoid destructive actions; secrets are redacted'
    : 'Recording on a protected environment — avoid destructive actions; secrets are redacted';

  const pg = snap.page && typeof snap.page === 'object' ? snap.page : null;
  const url = pg && pg.url ? String(pg.url) : '';
  const title = pg && pg.title ? String(pg.title) : '';
  $('pageStrip').hidden = !(live && (url || title));
  $('pageTitle').textContent = title;
  $('pageTitle').title = title;
  $('pageTitle').hidden = !title;
  $('pageUrl').textContent = url;
  $('pageUrl').title = url;

  $('idleCard').hidden = key !== 'idle';
}

function paintLink() {
  const pill = $('linkPill');
  pill.dataset.state = S.sseUp ? 'up' : 'down';
  $('linkPillText').textContent = S.sseUp ? 'Connected' : 'Reconnecting';
}

/* ══════════════════════════════════════════════════════════════════════════
   WINDOW SHAPE
   Collapsed is the point of this thing: a thin strip parked over the app you are driving.
   Expanded adds the step list and the inspector when you want to read back what was captured.
   ══════════════════════════════════════════════════════════════════════════ */
const BAR_H = 250;           // title bar + status + session line + the window's own chrome
const OPEN_H = 780;
const PANEL_KEY = 'tf.recorderPanel';
const COMPACT_KEY = 'tf.recorderCompact';   // '1' when compact

function setPanel(mode, resize) {
  document.documentElement.setAttribute('data-panel', mode);
  try {
    localStorage.setItem(PANEL_KEY, mode);
    localStorage.setItem(COMPACT_KEY, mode === 'collapsed' ? '1' : '0');
  } catch { /* private window: not worth failing over */ }
  $('btnCollapse').setAttribute('aria-expanded', String(mode === 'expanded'));
  // resizeTo only works on a window a script opened, and some browsers refuse outright. The
  // CSS already gives the collapsed shape, so a refusal costs nothing but the resize.
  if (resize) {
    try { window.resizeTo(window.outerWidth, mode === 'collapsed' ? BAR_H : OPEN_H); } catch { /* ignore */ }
  }
  if (mode === 'expanded') scrollToLatest();
  announce(mode === 'collapsed' ? 'Compact mode on.' : 'Compact mode off; captured steps are shown.');
}

function initPanel() {
  let saved = null;
  try {
    const c = localStorage.getItem(COMPACT_KEY);
    saved = c === '1' ? 'collapsed' : c === '0' ? 'expanded' : localStorage.getItem(PANEL_KEY);
  } catch { /* ignore */ }
  // EXPANDED by default. Collapsed-by-default meant the panel opened showing a title bar, a
  // status row and nothing else — the steps, the inspector and the locators were all there,
  // hidden behind a preference nobody had set. Collapse is a thing you choose, not a thing you
  // arrive at; the choice is still remembered once you make it.
  const mode = saved === 'collapsed' ? 'collapsed' : 'expanded';
  document.documentElement.setAttribute('data-panel', mode);
  $('btnCollapse').setAttribute('aria-expanded', String(mode === 'expanded'));
  $('btnCollapse').addEventListener('click', () => setPanel('collapsed', true));
  $('btnExpand').addEventListener('click', () => setPanel('expanded', true));
  $('btnClose').addEventListener('click', () => closeSelf());
}

/**
 * Close this window.
 *
 * A window the opener created can close itself; one someone reached by typing the URL into a
 * normal tab cannot, and `window.close()` there fails silently. So the failure is checked for
 * and said out loud rather than leaving a control that appears to do nothing.
 *
 * `quiet` is for the automatic close after a recording stops: not being able to close is worth
 * a line in a panel the user is looking at, but not an error bar on a panel they have finished
 * with and can shut themselves.
 */
function closeSelf(quiet) {
  window.close();
  setTimeout(() => {
    if (window.closed) return;
    if (quiet) return;
    $('errText').textContent = 'This tab was not opened by Replayr, so it cannot close itself. Close it yourself.';
    $('errBar').hidden = false;
  }, 250);
}

/* ══════════════════════════════════════════════════════════════════════════
   MODE + TAB SWITCHING
   ══════════════════════════════════════════════════════════════════════════ */
function setMode(mode) {
  S.mode = mode;
  for (const b of document.querySelectorAll('.mode')) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  }
  $('paneRecord').hidden = mode !== 'record';
  $('paneExecute').hidden = mode !== 'execute';
  $('paneSettings').hidden = mode !== 'settings';
  if (mode === 'execute') paintRun();
  if (mode === 'settings') paintSettings();
  paintHint();
}

function setSub(sub) {
  S.sub = sub;
  for (const b of document.querySelectorAll('.sub')) {
    const on = b.dataset.sub === sub;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const p of document.querySelectorAll('.subpane')) p.hidden = p.dataset.pane !== sub;
  if (sub === 'inspector') paintInspector();
  if (sub === 'console') loadLog('console');
  if (sub === 'network') loadLog('network');
  paintHint();
}

function setLoc(loc) {
  S.loc = loc;
  for (const b of document.querySelectorAll('.loc')) {
    const on = b.dataset.loc === loc;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  }
  paintLocBody();
}

function paintHint() {
  const h = $('hintText');
  if (S.mode === 'execute') h.textContent = 'Mirrors a run started from the main window.';
  else if (S.mode === 'settings') h.textContent = 'These preferences belong to this panel.';
  else if (S.sub === 'console') h.textContent = 'Console output from the page being recorded.';
  else if (S.sub === 'network') h.textContent = 'Data calls the page made while recording.';
  else if (S.sub === 'inspector') h.textContent = 'The element behind the selected step.';
  else h.textContent = 'Click a step to inspect how it will be found.';
}

/* ══════════════════════════════════════════════════════════════════════════
   STEP LIST
   ══════════════════════════════════════════════════════════════════════════ */
function visibleSteps() {
  const all = S.snap.steps || [];
  const q = S.search.trim().toLowerCase();
  return all
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => S.filter === 'all' || s.type === S.filter)
    .filter(({ s }) => {
      if (!q) return true;
      const t = targetLine(s);
      return [s.type, shortDesc(s), s.text, t && t.name, t && t.locator]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
}

function stepRow(step, i, isNew) {
  const li = el('li', 'step' + (isNew ? ' is-new' : ''));
  // The flash is a one-shot. Drop the class when it ends so "which rows are new" stays true.
  if (isNew) li.addEventListener('animationend', () => li.classList.remove('is-new'), { once: true });
  li.setAttribute('data-type', step.type);
  if (step.id) li.dataset.id = step.id;
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  if (step.text) li.title = step.text;             // the server's full wording, on hover
  if (step.id && step.id === S.selId) li.classList.add('is-sel');

  li.appendChild(el('span', 'idx', String(i + 1)));
  li.appendChild(icon(ICONS[step.type] || 'i-dot'));

  const body = el('span', 'step-body');
  const desc = el('span', 'step-desc', shortDesc(step));
  body.appendChild(desc);

  // A pause the recorder measured for you, rather than a step you asked for. Worth marking on
  // the surface you actually watch while recording: seeing one appear is how you notice the
  // tool has decided your thinking time is part of the test, and can go and delete it.
  if (step.type === 'wait' && step.recordedIdle) {
    desc.after(el('span', 'role', 'recorded pause'));
  }

  const t = targetLine(step);
  if (t) {
    const line = el('span', 'step-name');
    if (t.role) line.appendChild(el('span', 'role', t.role));
    const name = el('span');
    if (t.locator) { name.className = 'mono'; name.textContent = t.locator; }
    else name.textContent = t.name;
    line.appendChild(name);
    body.appendChild(line);
  }
  li.appendChild(body);

  if (step.secret) {
    const lock = el('span', 'step-lock');
    lock.setAttribute('role', 'img');
    lock.setAttribute('aria-label', 'Secret: the value is hidden and not recorded');
    lock.title = 'Secret: the value is hidden and not recorded';
    lock.appendChild(icon('i-lock', 'i i-sm'));
    li.appendChild(lock);
  }

  const off = stepOffset(step);
  if (off) li.appendChild(el('span', 'step-time tnum', off));

  // The outcome dot. A warning is the only thing that can be wrong about a step at capture
  // time, so it is the only thing that changes the mark — nothing here pretends to know
  // whether the step will replay.
  const warned = (step.warnings || []).length > 0;
  const mark = el('span', 'step-mark ' + (warned ? 'warn' : 'ok'));
  if (warned) {
    mark.setAttribute('role', 'img');
    mark.title = step.warnings.join('. ');
    mark.appendChild(icon('i-alert', 'i i-sm'));
  } else {
    mark.appendChild(icon('i-check-c', 'i i-sm'));
  }
  li.appendChild(mark);
  return li;
}

const EMPTY_TEXT = {
  idle: ['No recording in progress.', 'Start one from the Replayr window, then park this panel beside the app.'],
  starting: ['Waiting for the browser…', 'The recorder window is opening. Steps appear here the moment you act.'],
  recording: ['Nothing captured yet.', 'Every click, keystroke and navigation in the recorder window lands here.'],
  paused: ['Nothing captured yet.', 'The recorder is paused — resume before you do the thing you want recorded.'],
  stopping: ['Finishing up…', ''],
  stopped: ['Recording stopped with no steps.', 'Nothing was captured, so there is nothing to save.'],
  error: ['The recording could not start.', ''],
};

/**
 * Append-only while the list is simply growing: a snapshot's step list only ever grows during
 * a recording, so the rows already on screen are left alone. That keeps the animation honest
 * (only the genuinely new row flashes) and costs nothing on a long recording. A search, a
 * filter, a selection change, a delete or a discard all redraw from scratch.
 */
function paintSteps() {
  const filtered = visibleSteps();
  const list = $('list');
  const plain = !S.search.trim() && S.filter === 'all';
  const grew = plain && filtered.length > S.stepCount && list.children.length === S.stepCount;

  if (grew) {
    // Opening the panel mid-recording hydrates the whole list in one go. Those rows are not new
    // to the recording, only new to this window, so nothing flashes when the list was empty —
    // only steps that land while you are already watching.
    const hadRows = list.children.length > 0;
    for (let k = S.stepCount; k < filtered.length; k++) {
      list.appendChild(stepRow(filtered[k].s, filtered[k].i, hadRows));
    }
    if (hadRows && !S.follow) { S.away += filtered.length - S.stepCount; paintJump(); }
  } else {
    list.textContent = '';
    for (const { s, i } of filtered) list.appendChild(stepRow(s, i, false));
  }
  S.stepCount = plain ? filtered.length : -1;   // -1: the next snapshot must redraw, not append

  const empty = $('empty');
  const total = (S.snap.steps || []).length;
  if (filtered.length) empty.hidden = true;
  else if (total) {
    empty.hidden = false;
    empty.textContent = 'No step matches this search.';
    empty.appendChild(el('span', 'hint', `Clear the box, or change the filter, to see all ${total}.`));
  } else {
    const [line, hint] = EMPTY_TEXT[statusKey(S.snap)] || EMPTY_TEXT.idle;
    empty.hidden = false;
    empty.textContent = line;
    if (hint) empty.appendChild(el('span', 'hint', hint));
  }
  if (S.follow && plain) scrollToLatest();
}

function scrollToLatest() {
  const wrap = $('listWrap');
  if (!wrap) return;
  wrap.scrollTop = wrap.scrollHeight;
  S.follow = true;
  S.away = 0;
  paintJump();
}

/** The "New steps" pill: only when steps landed while you were reading further up. */
function paintJump() {
  const j = $('jump');
  j.hidden = S.away <= 0;
  if (S.away > 0) {
    j.lastChild.textContent = S.away === 1 ? '1 new step' : S.away + ' new steps';
    j.setAttribute('aria-label', 'Jump to the latest step (' + S.away + ' new)');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   SELECTION + STEP DETAILS
   ══════════════════════════════════════════════════════════════════════════ */
function selectedStep() {
  if (!S.selId) return null;
  return (S.snap.steps || []).find((s) => s.id === S.selId) || null;
}

function selectStep(id) {
  S.selId = id;
  for (const li of document.querySelectorAll('.step')) li.classList.toggle('is-sel', li.dataset.id === id);
  paintDetails();
  if (S.sub === 'inspector') paintInspector();
}

function indexOfSel() {
  const all = S.snap.steps || [];
  const at = all.findIndex((s) => s.id === S.selId);
  return at < 0 ? all.length - 1 : at;
}

/**
 * The candidates behind a step. Returns [] when there is nothing to show — the caller says so
 * rather than drawing an empty table.
 */
function candidatesOf(step) {
  const t = step && step.target;
  if (t && Array.isArray(t.candidates) && t.candidates.length) return t.candidates;
  return [];
}

/**
 * How confident the engine is that it will find this element again — read from the candidate
 * it actually verified, never guessed. Three levels, because "98%" and "we could not check"
 * must not look the same.
 */
function confidenceOf(step) {
  const sum = step && step.locatorSummary;
  const cands = candidatesOf(step);
  const verified = cands.filter((c) => c.verified).length;
  const usable = cands.filter((c) => !c.rejected).length;

  if (!sum && !cands.length) return null;
  if (sum && sum.strategy === 'legacy') {
    return { level: 'medium',
      title: 'Identified by a single recorded selector',
      sub: 'This step predates the identity engine — re-record it to get fallbacks.' };
  }
  const score = sum && Number.isFinite(sum.score) ? sum.score : (cands[0] && cands[0].score);
  if (!verified) {
    return { level: 'low',
      title: 'Element not verified at capture',
      sub: usable
        ? `${usable} locator${usable === 1 ? '' : 's'} recorded, none confirmed against the live page.`
        : 'No usable locator was recorded — this step is unlikely to replay.' };
  }
  const pct = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const level = pct >= 80 ? 'high' : pct >= 50 ? 'medium' : 'low';
  const word = level === 'high' ? 'high' : level === 'medium' ? 'moderate' : 'low';
  // Count fallbacks the way the engine counts them. summarise() in identity/index.js defines one
  // as "a usable candidate that is not the winner" — and this line, sitting beside the main
  // window quoting a different number for the very same step, is how you lose trust in both.
  const fallbacks = sum && Number.isFinite(sum.fallbacks) ? sum.fallbacks : Math.max(0, usable - 1);
  return {
    level,
    title: `Element identified with ${word} confidence`,
    sub: `Confidence score ${pct}% · ${verified} of ${cands.length} locators verified, ${fallbacks} fallback${fallbacks === 1 ? '' : 's'}`,
  };
}

function paintDetails() {
  const step = selectedStep();
  const box = $('details');
  if (!step) { box.hidden = true; return; }
  box.hidden = false;

  const all = S.snap.steps || [];
  const at = all.findIndex((s) => s.id === step.id);
  $('detTitle').textContent = `Step ${at + 1} details`;
  $('detPrev').disabled = at <= 0;
  $('detNext').disabled = at < 0 || at >= all.length - 1;
  $('detDelete').disabled = !!S.busy;

  $('detAction').textContent = ACTION_NAME[step.type] || step.type;

  const t = targetLine(step);
  const fp = step.target && step.target.fingerprint;
  const line = t
    ? (t.name ? `${t.name}${fp && fp.tag ? ` (${fp.tag})` : ''}` : t.locator)
    : 'No element — this step does not target one';
  $('detTarget').textContent = line;
  $('detTarget').title = line;
  $('detInspect').disabled = !fp;

  const conf = confidenceOf(step);
  const cbox = $('detConf');
  if (conf) {
    cbox.hidden = false;
    cbox.dataset.level = conf.level;
    $('detConfTitle').textContent = conf.title;
    $('detConfSub').textContent = conf.sub;
  } else {
    cbox.hidden = true;
  }

  $('tabLocCount').textContent = String(locatorRows(step).length);
  paintLocBody();
}

/**
 * Every way this step can find its element, best first. Built from the engine's candidates
 * where they exist, and otherwise from the fingerprint's own selector set — so a step always
 * shows what it will actually try, not a prettier version of it.
 */
const KIND_NAME = {
  testid: 'Test ID', role: 'Role', label: 'Label', text: 'Text', placeholder: 'Placeholder',
  altText: 'Alt text', title: 'Title', attr: 'Attribute', css: 'CSS', id: 'ID', name: 'Name',
  domIndex: 'DOM index', relativeXPath: 'XPath (relative)', absoluteXPath: 'XPath (absolute)',
  semanticXPath: 'XPath (semantic)', legacy: 'Recorded selector',
};

function locatorRows(step) {
  const rows = [];
  for (const c of candidatesOf(step)) {
    rows.push({
      kind: KIND_NAME[c.strategy] || c.strategy,
      value: c.locator || c.selector || c.value || '(not renderable)',
      score: Number.isFinite(c.score) ? c.score : null,
      dead: !!c.rejected,
      note: c.rejected ? String(c.rejected)
        : c.verified ? null
        : Number.isFinite(c.matches) && c.matches !== 1 ? `matched ${c.matches} elements` : null,
    });
  }
  if (rows.length) return rows;

  // No candidates: fall back to the raw selector set the fingerprint carries, clearly unscored.
  const fp = step.target && step.target.fingerprint;
  const sel = fp && fp.selectors;
  if (sel) {
    const order = [['semanticCss', 'CSS (semantic)'], ['contextualCss', 'CSS (contextual)'],
      ['positionalCss', 'CSS (positional)'], ['semanticXPath', 'XPath (semantic)'],
      ['absoluteXPath', 'XPath (absolute)']];
    for (const [k, label] of order) {
      if (sel[k]) rows.push({ kind: label, value: sel[k], score: null, dead: false, note: 'not scored — recorded only' });
    }
    if (Number.isFinite(fp.domIndex)) {
      rows.push({ kind: 'DOM index', value: String(fp.domIndex), score: null, dead: false, note: 'not scored — recorded only' });
    }
  }
  const sum = step.locatorSummary;
  if (!rows.length && sum && sum.primary) {
    rows.push({ kind: 'Recorded selector', value: sum.primary, score: null, dead: false, note: null });
  }
  return rows;
}

function locatorRowNode(r) {
  const row = el('div', 'lrow');
  row.appendChild(el('span', 'lkind', r.kind));
  const v = el('span', 'lval' + (r.dead ? ' is-dead' : ''), r.value);
  if (r.note) v.appendChild(el('span', 'lnote', r.note));
  row.appendChild(v);
  const right = el('span', 'row');
  if (Number.isFinite(r.score)) right.appendChild(el('span', 'lscore', String(Math.round(r.score))));
  right.appendChild(copyBtn(r.value, `Copy the ${r.kind} locator`));
  row.appendChild(right);
  return row;
}

function paintLocBody() {
  const body = $('locBody');
  body.textContent = '';
  const step = selectedStep();
  if (!step) return;

  if (S.loc === 'locators') {
    const rows = locatorRows(step);
    if (!rows.length) {
      body.appendChild(noneBox('No locator was recorded for this step.',
        'Without one it cannot be replayed — re-record it.'));
      return;
    }
    for (const r of rows) body.appendChild(locatorRowNode(r));
    return;
  }

  if (S.loc === 'attributes') {
    const fp = step.target && step.target.fingerprint;
    if (!fp) {
      body.appendChild(noneBox('This step has no captured element.',
        'Only steps that touch an element carry attributes.'));
      return;
    }
    const dl = el('dl');
    const put = (k, v) => {
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
      const row = el('div', 'kv');
      row.appendChild(el('dt', null, k));
      row.appendChild(el('dd', null, Array.isArray(v) ? v.join(', ') : String(v)));
      dl.appendChild(row);
    };
    put('tag', fp.tag);
    put('role', fp.role);
    put('name', fp.secret ? '(hidden — looked like a credential)' : fp.name);
    put('name from', fp.nameSource);
    put('text', fp.secret ? '(hidden)' : fp.text);
    put('labels', fp.labels);
    for (const [k, v] of Object.entries(fp.attrs || {})) put(k, v);
    for (const [k, v] of Object.entries(fp.volatile || {})) put(`${k} (volatile)`, v);
    if (Number.isFinite(fp.domIndex)) put('dom index', fp.domIndex);
    if (fp.state) { put('visible', String(!!fp.state.visible)); put('enabled', String(!!fp.state.enabled)); }
    put('page', fp.documentUrl);
    if (!dl.children.length) { body.appendChild(noneBox('No attributes were captured.', '')); return; }
    body.appendChild(dl);
    return;
  }

  if (S.loc === 'screenshot') {
    if (!(step.target && step.target.shot)) {
      // Say WHICH of the three reasons it was. "No screenshot" on its own sends you looking for
      // a broken feature when the honest answer is usually "this step has no element" or "that
      // was a password field and photographing it would persist the credential".
      const fp = step.target && step.target.fingerprint;
      const why = !fp
        ? `${ACTION_NAME[step.type] || step.type} steps act on the page, not on a single element.`
        : fp.secret
          ? 'This field held a credential, so it is deliberately not photographed.'
          : 'The element may have been off-screen, or the picture came out too large to keep.';
      body.appendChild(noneBox('No screenshot for this step.', why));
      return;
    }
    const img = el('img');
    img.src = `/api/recording/step/${encodeURIComponent(step.id)}/shot`;
    img.alt = 'The element as it looked when the step was recorded';
    img.style.maxWidth = '100%';
    img.style.borderRadius = '6px';
    img.addEventListener('error', () => {
      body.textContent = '';
      body.appendChild(noneBox('The screenshot could not be loaded.', 'It may have been dropped when the recording ended.'));
    });
    body.appendChild(img);
    return;
  }

  // HTML — reconstructed from the captured attributes, and labelled as such. The recorder does
  // not store the element's outerHTML, so presenting one would be presenting a guess as source.
  const fp = step.target && step.target.fingerprint;
  if (!fp || !fp.tag) { body.appendChild(noneBox('This step has no captured element.', '')); return; }
  const attrs = Object.entries(fp.attrs || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('');
  const inner = fp.secret ? '' : (fp.text ? clip(fp.text, 80) : '');
  const html = `<${fp.tag}${attrs}>${inner}</${fp.tag}>`;
  const note = el('p', 'none', 'Rebuilt from the captured attributes — not the page’s own source.');
  note.style.textAlign = 'left';
  note.style.padding = '0 0 8px';
  body.appendChild(note);
  body.appendChild(el('pre', 'code', html));
  const wrap = el('div', 'row');
  wrap.style.marginTop = '8px';
  wrap.appendChild(copyBtn(html, 'Copy the reconstructed HTML'));
  body.appendChild(wrap);
}

function noneBox(line, hint) {
  const p = el('p', 'none', line);
  if (hint) p.appendChild(el('span', 'hint', hint));
  return p;
}

function copyBtn(value, label) {
  const b = el('button', 'ico ico-sm');
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.appendChild(icon('i-copy'));
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    let ok = false;
    try { await navigator.clipboard.writeText(value); ok = true; } catch { ok = false; }
    // The clipboard API needs a secure context and a permission; this page is served over
    // plain http on 127.0.0.1, which most browsers do treat as secure — but not all, so a
    // refusal has to say so rather than leaving a button that looks like it worked.
    b.title = ok ? 'Copied' : 'Could not copy — select the text and copy it yourself';
    announce(ok ? 'Copied.' : 'Could not copy to the clipboard.');
    setTimeout(() => { b.title = label; }, 1500);
  });
  return b;
}

/* ══════════════════════════════════════════════════════════════════════════
   ELEMENT INSPECTOR — the selected step's element, at length
   ══════════════════════════════════════════════════════════════════════════ */
function paintInspector() {
  const body = $('inspectBody');
  body.textContent = '';
  const step = selectedStep();
  if (!step) {
    body.appendChild(noneBox('No step selected.', 'Pick a step in the Steps tab to inspect its element.'));
    return;
  }
  const fp = step.target && step.target.fingerprint;
  if (!fp) {
    body.appendChild(noneBox('This step does not target an element.',
      `${ACTION_NAME[step.type] || step.type} steps act on the page, not on a single element.`));
    return;
  }

  body.appendChild(el('p', 'flabel', 'Element'));
  body.appendChild(el('p', 'fbox', `${fp.role || fp.tag}${fp.name ? ` · ${fp.secret ? '(hidden)' : fp.name}` : ''}`));

  const conf = confidenceOf(step);
  if (conf) {
    const c = el('div', 'conf');
    c.dataset.level = conf.level;
    c.appendChild(icon('i-check-c', 'i i-sm'));
    const txt = el('span', 'conf-txt');
    txt.appendChild(el('strong', null, conf.title));
    txt.appendChild(el('span', null, conf.sub));
    c.appendChild(txt);
    body.appendChild(c);
  }

  // Where it sits. This is the part that explains a failure: the same button inside a
  // different dialog is a different button, and the ancestor chain is what says so.
  const ctx = fp.context || {};
  const dl = el('dl');
  const put = (k, v) => {
    if (v == null || v === '') return;
    const row = el('div', 'kv');
    row.appendChild(el('dt', null, k));
    row.appendChild(el('dd', null, String(v)));
    dl.appendChild(row);
  };
  put('heading', ctx.heading);
  put('landmark', ctx.landmark);
  if (ctx.list && ctx.list.total) put('list position', `${ctx.list.index + 1} of ${ctx.list.total}`);
  if (Array.isArray(ctx.ancestors) && ctx.ancestors.length) {
    put('inside', ctx.ancestors.map((a) => a.name || a.role || a.tag).filter(Boolean).slice(0, 4).join(' › '));
  }
  if (fp.siblings && fp.siblings.sameRoleAndName != null) put('similar on page', fp.siblings.sameRoleAndName);
  if (fp.volatileName) put('name looks volatile', fp.volatileName);
  if (fp.volatileText) put('text looks volatile', fp.volatileText);
  if (fp.blindSpot) put('blind spot', fp.blindSpot);
  if (fp.secret) put('credential', 'value withheld on purpose');
  if (dl.children.length) {
    body.appendChild(el('p', 'flabel', 'Context'));
    body.appendChild(dl);
  }

  body.appendChild(el('p', 'flabel', 'Locators'));
  const rows = locatorRows(step);
  if (!rows.length) body.appendChild(noneBox('No locator was recorded.', ''));
  for (const r of rows) body.appendChild(locatorRowNode(r));
}

/* ══════════════════════════════════════════════════════════════════════════
   CONSOLE + NETWORK
   Served from their own endpoints rather than the snapshot, because the snapshot goes over
   SSE on every single step and 500 log lines riding along with each one is not a trade worth
   making. A build without those endpoints answers 404 and the pane says exactly that.
   ══════════════════════════════════════════════════════════════════════════ */
async function loadLog(which) {
  const body = $(which === 'console' ? 'consoleBody' : 'networkBody');
  body.textContent = '';
  body.appendChild(noneBox('Loading…', ''));
  try {
    const res = await fetch(`/api/recording/${which}?limit=300`);
    if (res.status === 404) throw new Error('not-built');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    S.logs[which] = Array.isArray(data.items) ? data.items : [];
    S.logErr[which] = null;
  } catch (e) {
    S.logs[which] = [];
    S.logErr[which] = String((e && e.message) || e) === 'not-built' ? 'not-built' : String((e && e.message) || e);
  }
  paintLog(which);
}

function paintLog(which) {
  const body = $(which === 'console' ? 'consoleBody' : 'networkBody');
  const q = (which === 'console' ? $('conSearch') : $('netSearch')).value.trim().toLowerCase();
  body.textContent = '';

  if (S.logErr[which] === 'not-built') {
    body.appendChild(noneBox(
      which === 'console' ? 'Console capture is not available in this build.' : 'Network capture is not available in this build.',
      'The server has no endpoint for it yet, so nothing is being recorded to show.'));
    return;
  }
  if (S.logErr[which]) {
    body.appendChild(noneBox('Could not load it.', S.logErr[which]));
    return;
  }

  const items = S.logs[which].filter((it) => !q || JSON.stringify(it).toLowerCase().includes(q));
  if (!items.length) {
    body.appendChild(noneBox(
      S.logs[which].length ? 'Nothing matches that filter.' : 'Nothing captured yet.',
      S.logs[which].length ? '' : 'Drive the app in the recorder window and it will appear here.'));
    return;
  }

  for (const it of items) {
    const row = el('div', 'logrow');
    if (which === 'console') {
      row.dataset.lvl = it.type || 'log';
      row.appendChild(el('span', 'lvl', it.type || 'log'));
      row.appendChild(el('span', `msg${it.redacted ? ' is-redacted' : ''}`, it.text || ''));
    } else {
      const st = el('span', `lvl netst ${it.ok ? 'ok' : 'bad'}`);
      st.textContent = it.status == null ? (it.failed ? 'ERR' : '—') : String(it.status);
      row.appendChild(st);
      row.appendChild(el('span', 'msg', `${it.method || 'GET'} ${it.url || ''}`));
    }
    const when = el('span', 'when');
    when.textContent = Number.isFinite(it.durationMs) ? `${it.durationMs}ms`
      : it.at ? new Date(it.at).toLocaleTimeString() : '';
    row.appendChild(when);
    body.appendChild(row);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   EXECUTE — mirror a run started from the main window
   ══════════════════════════════════════════════════════════════════════════ */
function paintRun() {
  const body = $('runBody');
  body.textContent = '';
  const r = S.run;
  if (!r) {
    body.appendChild(noneBox('No run in progress.',
      'Start one from the main window and it will be mirrored here, step by step.'));
    return;
  }
  const list = Array.isArray(r.steps) ? r.steps : [];
  const done = Number.isFinite(r.completed) ? r.completed : list.filter((s) => s.status && s.status !== 'running').length;
  const total = Number.isFinite(r.total) ? r.total : list.length;
  body.appendChild(el('p', 'flabel', 'Run'));
  body.appendChild(el('p', 'fbox', `${r.status || 'running'}${total ? ` · step ${Math.min(done + 1, total)} of ${total}` : ''}`));

  if (r.error) {
    const c = el('div', 'conf');
    c.dataset.level = 'low';
    c.appendChild(icon('i-alert', 'i i-sm'));
    const txt = el('span', 'conf-txt');
    txt.appendChild(el('strong', null, 'The run failed'));
    txt.appendChild(el('span', null, String(r.error)));
    c.appendChild(txt);
    body.appendChild(c);
  }

  if (!list.length) return;
  body.appendChild(el('p', 'flabel', 'Steps'));
  list.forEach((s, i) => {
    const row = el('div', 'lrow');
    row.appendChild(el('span', 'lkind', String(i + 1)));
    const v = el('span', 'lval');
    v.style.fontFamily = 'var(--font-sans)';
    v.textContent = s.text || s.type || '';
    if (s.error) v.appendChild(el('span', 'lnote', String(s.error)));
    row.appendChild(v);
    row.appendChild(el('span', 'lscore', s.status || ''));
    body.appendChild(row);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   SETTINGS
   ══════════════════════════════════════════════════════════════════════════ */
const PREF_KEY = 'tf.recorderPrefs';
function prefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { return {}; }
}
function setPref(k, v) {
  const p = prefs();
  p[k] = v;
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* private window */ }
}

function paintSettings() {
  const body = $('setBody');
  body.textContent = '';
  const p = prefs();

  const row = (label, hint, control) => {
    const wrap = el('div', 'lrow');
    wrap.style.gridTemplateColumns = '1fr auto';
    const l = el('span', 'lval');
    l.style.fontFamily = 'var(--font-sans)';
    l.textContent = label;
    if (hint) l.appendChild(el('span', 'lnote', hint));
    wrap.append(l, control);
    body.appendChild(wrap);
  };

  const themeSel = el('select', 'fbox');
  themeSel.style.minWidth = '120px';
  themeSel.setAttribute('aria-label', 'Theme');
  for (const t of THEMES) {
    const o = el('option', null, t === 'system' ? 'Follow system' : t[0].toUpperCase() + t.slice(1));
    o.value = t;
    if (themeChoice() === t) o.selected = true;
    themeSel.appendChild(o);
  }
  themeSel.addEventListener('input', () => {
    try { localStorage.setItem('tf.theme', themeSel.value); } catch { /* ignore */ }
    applyTheme(themeSel.value);
  });
  row('Theme', 'Shared with the main window.', themeSel);

  const follow = el('input');
  follow.type = 'checkbox';
  follow.setAttribute('aria-label', 'Follow the newest step');
  follow.checked = p.followLatest !== false;
  follow.addEventListener('input', () => { setPref('followLatest', follow.checked); S.follow = follow.checked; });
  row('Follow the newest step', 'Scroll the list as steps arrive.', follow);

  const esc = el('input');
  esc.type = 'checkbox';
  esc.setAttribute('aria-label', 'Escape stops the recording');
  esc.checked = p.escStops !== false;
  esc.addEventListener('input', () => { setPref('escStops', esc.checked); paintHintKeys(); });
  row('Escape stops the recording', 'Turn off if you keep hitting it by accident.', esc);

  const closeStop = el('input');
  closeStop.type = 'checkbox';
  closeStop.setAttribute('aria-label', 'Close this panel when the recording stops');
  closeStop.checked = p.closeOnStop === true;
  closeStop.addEventListener('input', () => setPref('closeOnStop', closeStop.checked));
  row('Close this panel when recording stops', 'Otherwise Review & save and Discard stay here.', closeStop);

  body.appendChild(el('p', 'flabel', 'This session'));
  const dl = el('dl');
  const put = (k, v) => {
    const r = el('div', 'kv');
    r.appendChild(el('dt', null, k));
    r.appendChild(el('dd', null, v == null || v === '' ? '—' : String(v)));
    dl.appendChild(r);
  };
  put('status', statusKey(S.snap));
  put('app', S.snap.app);
  put('base url', S.snap.baseUrl);
  put('browser', S.snap.browserLabel);
  put('viewport', S.snap.viewport ? `${S.snap.viewport.width} × ${S.snap.viewport.height}` : null);
  put('identity capture', S.snap.captureReady ? 'on' : 'off');
  put('live link', S.sseUp ? 'connected' : 'reconnecting');
  body.appendChild(dl);
}

function paintHintKeys() {
  const on = prefs().escStops !== false;
  const bar = $('hintbar');
  bar.querySelector('kbd').hidden = !on;
  bar.querySelector('.hint-k').hidden = !on;
}

/* ══════════════════════════════════════════════════════════════════════════
   MENUS — one element, positioned to whichever trigger opened it
   ══════════════════════════════════════════════════════════════════════════ */
let menuOwner = null;

function closeMenu() {
  const m = $('menu');
  m.hidden = true;
  m.textContent = '';
  if (menuOwner) { menuOwner.setAttribute('aria-expanded', 'false'); menuOwner = null; }
}

function openMenu(trigger, items) {
  closeMenu();
  const m = $('menu');
  for (const it of items) {
    if (it.sep) { m.appendChild(el('div', 'sepline')); continue; }
    if (it.head) { m.appendChild(el('div', 'mhead', it.head)); continue; }
    const b = el('button', null, it.label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (it.disabled) { b.disabled = true; if (it.why) b.title = it.why; }
    else b.addEventListener('click', () => { closeMenu(); it.run(); });
    m.appendChild(b);
  }
  m.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  menuOwner = trigger;

  // Keep it on screen at 320px: prefer left-aligned under the trigger, flip up or left when
  // there is no room. The panel is small enough that this happens often.
  const r = trigger.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8));
  let top = r.bottom + 4;
  if (top + m.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - m.offsetHeight - 4);
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
  const first = m.querySelector('button:not(:disabled)');
  if (first) first.focus();
}

/* ══════════════════════════════════════════════════════════════════════════
   COMMANDS
   ══════════════════════════════════════════════════════════════════════════ */
async function command(what, path) {
  if (S.busy) return;
  S.busy = what;
  S.cmdError = null;
  paintHeader();                                   // disable everything while it is in flight
  try {
    const res = await fetch(path, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
    // The reply IS a snapshot, and the SSE frame is on its way too. Painting the
    // reply makes the button feel instant; the frame that follows agrees with it.
    S.busy = null;
    onSnapshot(body);
  } catch (e) {
    const msg = String((e && e.message) || e);
    S.busy = null;
    S.cmdError = `${what} failed: ${msg}`;
    announce(`${what} failed. ${msg}`);
    paintHeader();
  }
}

/**
 * A request that changes the draft and replies with the whole updated snapshot. Applying the
 * reply wholesale is deliberate: the server owns the draft, so its version of the step list is
 * the only one worth trusting, and a locally-patched list is exactly how a deleted step comes
 * back on the next frame.
 */
async function mutate(what, path, method, payload) {
  if (S.busy) return false;
  S.busy = what;
  S.cmdError = null;
  paintHeader();
  try {
    const res = await fetch(path, {
      method,
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
    S.busy = null;
    S.stepCount = -1;                              // the list changed shape; redraw, do not append
    onSnapshot(body);
    announce(`${what} done.`);
    return true;
  } catch (e) {
    const msg = String((e && e.message) || e);
    S.busy = null;
    S.cmdError = `${what} failed: ${msg}`;
    announce(`${what} failed. ${msg}`);
    paintHeader();
    return false;
  }
}

async function deleteStep(id) {
  if (!id) {
    S.cmdError = 'This step has no id, so the server cannot be told which one to drop. Delete it in Review & Edit after you stop.';
    paintHeader();
    return;
  }
  const before = S.snap.steps || [];
  const at = before.findIndex((s) => s.id === id);
  const ok = await mutate('Delete step', `/api/recording/step/${encodeURIComponent(id)}`, 'DELETE');
  if (ok) {
    // Land on the neighbour rather than closing the pane — deleting three strays in a row is
    // the normal case, and re-selecting each time is the annoying part.
    const after = S.snap.steps || [];
    const next = after[Math.min(Math.max(0, at), after.length - 1)];
    S.selId = next ? next.id : null;
    paintSteps();
    paintDetails();
  }
}

async function addStep(payload, label) {
  const ok = await mutate(label, '/api/recording/step', 'POST', payload);
  if (ok) { paintSteps(); paintDetails(); }
}

/* ══════════════════════════════════════════════════════════════════════════
   SNAPSHOTS
   ══════════════════════════════════════════════════════════════════════════ */
function onSnapshot(snap) {
  const before = S.snap;
  const beforeKey = statusKey(before);
  S.loaded = true;
  S.snap = snap || { status: 'idle', paused: false, steps: [] };
  const key = statusKey(S.snap);
  const n = (S.snap.steps || []).length;
  // A refusal is only true of the state it was refused in ("nothing is being recorded"). The
  // moment the state moves it is stale, so it goes rather than sitting there contradicting the header.
  if (key !== beforeKey) S.cmdError = null;

  // A selection that no longer exists — the step was deleted, or the draft was discarded —
  // must not leave the details pane describing something that is gone.
  if (S.selId && !(S.snap.steps || []).some((s) => s.id === S.selId)) S.selId = null;

  paintHeader();
  paintSteps();
  paintDetails();
  if (S.sub === 'inspector') paintInspector();
  if (S.mode === 'settings') paintSettings();
  startClock();

  if (key !== beforeKey) {
    announce(key === 'paused' ? 'Recording paused. Nothing is being captured.'
      : key === 'recording' && beforeKey === 'paused' ? 'Recording resumed.'
      : key === 'recording' ? 'Recording.'
      : key === 'starting' ? 'Opening the browser.'
      : key === 'stopped' ? `Recording stopped. ${n} ${n === 1 ? 'step' : 'steps'} captured.`
      : key === 'error' ? `Recording failed. ${S.snap.error || ''}`
      : STATUS_TEXT[key] || key);
  } else if (n > (before.steps || []).length) {
    const last = S.snap.steps[n - 1];
    const t = targetLine(last);
    announce(`Step ${n}. ${shortDesc(last)}${t && t.name ? ` ${t.name}` : ''}.`);
  }

  maybeCloseAfterStop(beforeKey, key);
}

/**
 * The recording ended — so does this window.
 *
 * The panel exists to watch a recording happen. Once the recording is over there is nothing
 * live left in it, and what you do next (review the steps, name them, save) happens in the main
 * window. Leaving it open means a dead panel covering a third of the screen that the user has
 * to dismiss by hand every single time.
 *
 * Tied to the state reaching `stopped` rather than to this window's own Stop button, so it also
 * covers Stop pressed on the in-page bar, Escape, and the main window's Stop — all of them are
 * the user saying "I'm done", and all of them leave the same dead panel behind.
 *
 * Deliberately NOT on `error`: a recording that fell over is the one case where the panel is
 * still worth reading. It stays open with the reason on it.
 */
const WAS_LIVE = ['starting', 'recording', 'paused', 'stopping'];
function maybeCloseAfterStop(beforeKey, key) {
  if (key !== 'stopped' || !WAS_LIVE.includes(beforeKey)) return;
  // Opt-in: the stopped state carries Review & save and Discard, so closing by default would
  // take them away before they can be used.
  if (prefs().closeOnStop !== true) return;
  // A beat, so the header visibly reaches "Stopped · N steps" before the window goes. Closing
  // on the same frame as the click reads as a crash rather than as the panel finishing.
  setTimeout(() => closeSelf(true), 600);
}

/** One interval, only while the clock is actually moving. */
function startClock() {
  const running = !!S.snap.startedAt && !S.snap.stoppedAt;
  if (running && !S.tick) S.tick = setInterval(paintElapsed, 1000);
  if (!running && S.tick) { clearInterval(S.tick); S.tick = null; }
}

/* ── the polite live region. Only says what changed. ── */
let lastSaid = '';
function announce(msg) {
  if (!msg || msg === lastSaid) return;
  lastSaid = msg;
  $('live').textContent = msg;
}

/* ══════════════════════════════════════════════════════════════════════════
   SSE — the same contract ui/app.js uses, with our own backoff.
   ══════════════════════════════════════════════════════════════════════════ */
let sse = null;
let backoff = 500;

function connect() {
  try { if (sse) sse.close(); } catch { /* ignore */ }
  sse = new EventSource('/api/events');

  sse.onopen = () => {
    S.sseUp = true;
    backoff = 500;
    $('linkBar').hidden = true;
    paintLink();
  };

  sse.addEventListener('recording', (e) => {
    let snap;
    try { snap = JSON.parse(e.data); } catch { return; }
    onSnapshot(snap);
  });

  // The server also pushes 'run' frames. They used to be dropped here; the Execute tab is
  // what they are for.
  sse.addEventListener('run', (e) => {
    try { S.run = JSON.parse(e.data); } catch { return; }
    if (S.mode === 'execute') paintRun();
  });

  sse.onerror = () => {
    S.sseUp = false;
    paintLink();
    // The header keeps its last known state; the banner is what says it is stale.
    $('linkText').textContent = `Lost the connection to the recorder — retrying in ${Math.round(backoff / 1000) || 1}s…`;
    $('linkBar').hidden = false;
    try { sse.close(); } catch { /* ignore */ }
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 10000);
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   WIRING
   ══════════════════════════════════════════════════════════════════════════ */
$('btnPause').addEventListener('click', () => command('Pause', '/api/recording/pause'));
$('btnResume').addEventListener('click', () => command('Resume', '/api/recording/resume'));
$('btnStop').addEventListener('click', () => command('Stop', '/api/recording/stop'));
$('themeBtn').addEventListener('click', cycleTheme);
$('btnReview').addEventListener('click', () => {
  window.open('/#/record/review', 'tf-main');
  announce('Opened Review and save in the main window.');
});
function askDiscard(show) {
  const n = (S.snap.steps || []).length;
  $('discardText').textContent = 'Discard this recording (' + n + (n === 1 ? ' step' : ' steps') + ')? This cannot be undone.';
  $('discardBar').hidden = !show;
  if (show) $('btnDiscardNo').focus(); else $('btnDiscard').focus();
}
$('btnDiscard').addEventListener('click', () => askDiscard(true));
$('btnDiscardNo').addEventListener('click', () => askDiscard(false));
$('btnDiscardYes').addEventListener('click', async () => {
  $('discardBar').hidden = true;
  await command('Discard', '/api/recording/discard');
});
$('jump').addEventListener('click', () => { scrollToLatest(); $('list').lastElementChild?.scrollIntoView({ block: 'nearest' }); });

for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => setMode(b.dataset.mode));
for (const b of document.querySelectorAll('.sub')) b.addEventListener('click', () => setSub(b.dataset.sub));
for (const b of document.querySelectorAll('.loc')) b.addEventListener('click', () => setLoc(b.dataset.loc));

// One listener for the whole list, so a thousand steps do not mean a thousand listeners.
$('list').addEventListener('click', (e) => {
  const li = e.target.closest('.step');
  if (li && li.dataset.id) selectStep(li.dataset.id);
});
$('list').addEventListener('keydown', (e) => {
  const li = e.target.closest('.step');
  if (!li) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (li.dataset.id) selectStep(li.dataset.id);
  }
});

$('stepSearch').addEventListener('input', () => { S.search = $('stepSearch').value; S.stepCount = -1; paintSteps(); });
$('conSearch').addEventListener('input', () => paintLog('console'));
$('netSearch').addEventListener('input', () => paintLog('network'));
$('conRefresh').addEventListener('click', () => loadLog('console'));
$('netRefresh').addEventListener('click', () => loadLog('network'));

$('btnFilter').addEventListener('click', () => {
  const types = [...new Set((S.snap.steps || []).map((s) => s.type))].sort();
  openMenu($('btnFilter'), [
    { head: 'Show' },
    { label: `All steps${S.filter === 'all' ? ' ✓' : ''}`, run: () => { S.filter = 'all'; S.stepCount = -1; paintSteps(); } },
    ...(types.length ? [{ sep: true }] : []),
    ...types.map((t) => ({
      label: `${ACTION_NAME[t] || t}${S.filter === t ? ' ✓' : ''}`,
      run: () => { S.filter = t; S.stepCount = -1; paintSteps(); },
    })),
  ]);
});

$('btnMore').addEventListener('click', () => {
  const live = ['recording', 'stopping', 'stopped'].includes(S.snap.status);
  openMenu($('btnMore'), [
    { label: 'Open the main window', run: () => window.open('/', 'tf-main') },
    { label: 'Refresh from the server', run: () => fetch('/api/recording').then((r) => r.json()).then(onSnapshot).catch(() => {}) },
    { sep: true },
    { label: 'Discard this recording',
      disabled: !live,
      why: 'There is no draft to discard.',
      // The server refuses to discard a recording that is still running (409) — a draft has to
      // be stopped before it can be thrown away. That is a reasonable rule for an API and a
      // silly one to make a person obey: "discard" plainly means "stop it and bin it", so do
      // both. Stop first, and only bin it if the stop actually worked.
      run: async () => {
        if (['recording', 'starting', 'stopping'].includes(S.snap.status)) {
          await command('Stop', '/api/recording/stop');
          if (S.cmdError) return;
        }
        await command('Discard', '/api/recording/discard');
      } },
  ]);
});

$('detPrev').addEventListener('click', () => {
  const all = S.snap.steps || [];
  const at = all.findIndex((s) => s.id === S.selId);
  if (at > 0) selectStep(all[at - 1].id);
});
$('detNext').addEventListener('click', () => {
  const all = S.snap.steps || [];
  const at = all.findIndex((s) => s.id === S.selId);
  if (at >= 0 && at < all.length - 1) selectStep(all[at + 1].id);
});
$('detDelete').addEventListener('click', () => deleteStep(S.selId));
$('detInspect').addEventListener('click', () => setSub('inspector'));

$('detEdit').addEventListener('click', () => {
  // Editing a step's fields belongs to the main window's Review & Edit — it is the surface that
  // already does it, and a worse copy of it in a 380px column helps nobody. Open it there
  // rather than pretending this panel can.
  window.open('/#/record/review', 'tf-main');
  announce('Opened Review and Edit in the main window.');
});

$('detAssert').addEventListener('click', () => {
  const step = selectedStep();
  const hasTarget = !!(step && step.target);
  const at = indexOfSel() + 1;
  openMenu($('detAssert'), [
    { head: 'Assert about this element' },
    { label: 'It is visible',
      disabled: !hasTarget,
      why: 'This step has no element to assert about.',
      run: () => addStep({ type: 'expectVisible', stepId: S.selId, at }, 'Add assertion') },
    { label: 'It is ticked',
      disabled: !hasTarget,
      why: 'This step has no element to assert about.',
      run: () => addStep({ type: 'expectChecked', checked: true, stepId: S.selId, at }, 'Add assertion') },
    { sep: true },
    { label: 'The URL is the app’s base URL',
      run: () => addStep({ type: 'expectUrl', url: '{{baseUrl}}', at }, 'Add assertion') },
  ]);
});

$('detMore').addEventListener('click', () => {
  const step = selectedStep();
  openMenu($('detMore'), [
    { label: 'Copy the step as JSON',
      disabled: !step,
      run: async () => {
        try { await navigator.clipboard.writeText(JSON.stringify(step, null, 2)); announce('Copied.'); }
        catch { announce('Could not copy to the clipboard.'); }
      } },
    { label: 'Show it in the Element Inspector',
      disabled: !(step && step.target && step.target.fingerprint),
      run: () => setSub('inspector') },
    { sep: true },
    { label: 'Delete this step', disabled: !step, run: () => deleteStep(S.selId) },
  ]);
});

$('btnAddStep').addEventListener('click', () => {
  const live = ['recording', 'stopping', 'stopped'].includes(S.snap.status);
  const at = indexOfSel() + 1;
  const why = 'There is no draft to add to.';
  openMenu($('btnAddStep'), [
    { head: S.selId ? 'Insert after the selected step' : 'Add to the end' },
    { label: 'Wait 1 second', disabled: !live, why, run: () => addStep({ type: 'wait', ms: 1000, at }, 'Add step') },
    { label: 'Wait 3 seconds', disabled: !live, why, run: () => addStep({ type: 'wait', ms: 3000, at }, 'Add step') },
    { label: 'Wait for the network', disabled: !live, why, run: () => addStep({ type: 'waitForXhr', at }, 'Add step') },
  ]);
});

// Follow the newest step only while you are already at the bottom. Scroll up to
// read something back and the list holds still until you ask to come back.
$('listWrap').addEventListener('scroll', (e) => {
  const target = e.currentTarget;
  const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
  S.follow = atBottom;
  if (atBottom) S.away = 0;
  paintJump();
});

// Close the menu the way every menu closes.
document.addEventListener('click', (e) => {
  if (menuOwner && !e.target.closest('.menu') && !e.target.closest('[aria-haspopup="menu"]')) closeMenu();
}, true);
window.addEventListener('resize', closeMenu);
window.addEventListener('blur', closeMenu);

// Space and Escape are what a hand reaches for when the recorder window is not
// focused. Only when the focus is not already on a control, so they never
// double-fire on a focused button.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (menuOwner) { closeMenu(); return; }
    if (!$('discardBar').hidden) { askDiscard(false); return; }
    // Advertised on the hint bar, so it has to work — but it is the one key that ends a
    // recording, so it is a preference and it only acts while one is actually running.
    if (prefs().escStops !== false && ['recording', 'starting'].includes(S.snap.status)) {
      e.preventDefault();
      command('Stop', '/api/recording/stop');
    }
    return;
  }
  if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    if (S.snap.status === 'recording') {
      command(S.snap.paused ? 'Resume' : 'Pause', S.snap.paused ? '/api/recording/resume' : '/api/recording/pause');
    }
  }
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeChoice() === 'system') applyTheme('system');
});
// The main window and this one share localStorage; keep the theme in step.
window.addEventListener('storage', (e) => { if (e.key === 'tf.theme') applyTheme(themeChoice()); });

applyTheme(themeChoice());
S.follow = prefs().followLatest !== false;
paintHeader();
paintLink();
paintHintKeys();
paintHint();
initPanel();
connect();

// A first paint that does not wait for the stream: if SSE is slow or blocked,
// the panel still shows the truth within one request instead of "Connecting…".
fetch('/api/recording').then((r) => r.json()).then((snap) => { if (!S.sseUp) onSnapshot(snap); }).catch(() => {});
