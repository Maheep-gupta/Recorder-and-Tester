'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════════════════ */
const S = {
  config: null,                  // GET /api/config
  route: { name: 'home' },
  sseUp: false,

  tests: [],                     // GET /api/tests
  stats: null,                   // GET /api/stats
  allRuns: null,                 // GET /api/runs
  runsError: null,               // why the cross-test history could not be read

  search: '',                    // top bar search, applies to the Test Library
  libTab: 'all',                 // all | favorites | folders
  libView: 'list',               // list | grid
  libFilter: 'all',              // all | passed | failed | never
  libFolder: null,               // folder name the library is narrowed to, or null for every folder
  libSelection: {},              // id -> true (checkbox column)

  rec: { status: 'idle', steps: [] },
  recStage: null,                // null = derive from rec.status; 'save' = the Save Test screen
  recSel: null,                  // selected step key in the recorder/review
  recForm: {                     // Record → Setup form
    name: '', description: '', app: null, browser: 'chromium', viewport: '1280x800',
    useSession: true, captureNetwork: false,
  },
  saveForm: { name: '', description: '', folder: '', tags: [], tagDraft: '', runAfter: false },

  test: null,                    // full test open at #/test/:id
  testTab: 'overview',
  testSel: null,
  testDirty: false,
  testTagDraft: '',              // half-typed tag on the test's Settings tab (the Save screen
                                 // already kept its own draft; this one was thrown away on
                                 // every re-render, so an arriving snapshot ate the word)
  inspEdit: false,               // the "Edit" toggle in the Step Details panel
  runs: {},                      // testId -> run summaries
  testCache: {},                 // testId -> full test
  runTarget: null,               // environment chosen for the NEXT run; null = wherever it was recorded
  testUnavailable: {},           // testId -> true once a fetch for it has been attempted and failed

  live: null,                    // in-flight run
  runCache: {},                  // "testId/runId" -> finished run
  runUnavailable: {},            // "testId/runId" -> true once a fetch for it has failed
  lightbox: null,
  overlay: null,                 // {kind:'palette'|'modal', ...}
  paletteQuery: '',
  paletteIndex: 0,
  settingsTab: 'general',
  folders: [],                   // local folder names (localStorage) merged with folders in use

  /* Responsive + async state ------------------------------------------- */
  narrow: false,                 // viewport is at or below the mobile breakpoint
  sheetOpen: false,              // Step Details shown as a bottom sheet (mobile only)
  recPanelOpen: false,           // "Session" panel toggle in the mobile recorder
  loadingTests: false,
  loadingRuns: false,
  launching: false,              // POST /api/recording/start in flight
  saving: false,                 // POST /api/tests or PUT /api/tests/:id in flight
  pausing: false,                // POST /api/recording/pause|resume in flight
};

/* ══════════════════════════════════════════════════════════════════════════
   VIEWPORT
   Below this width the sidebar is a drawer, the Step Details panel is a bottom
   sheet, and the live recorder switches to its single-column layout. The CSS
   agent keys the matching visual rules off the same 900px breakpoint.
   ══════════════════════════════════════════════════════════════════════════ */
const MOBILE_QUERY = '(max-width: 900px)';
const mobileMQ = window.matchMedia(MOBILE_QUERY);
function isNarrow() { return mobileMQ.matches; }

const $ = (id) => document.getElementById(id);
const page = () => $('page');

/* ══════════════════════════════════════════════════════════════════════════
   SMALL HELPERS
   ══════════════════════════════════════════════════════════════════════════ */
/**
 * The Browser choice, labelled with what this machine can actually launch.
 *
 * Each engine is a separate Playwright download whose version must match the installed package,
 * so on most machines only Chromium is there. Offering Firefox and WebKit as though they were
 * ready means picking one and getting an error at launch; saying "not installed" up front, and
 * refusing to select it, is the honest version. The server derives the list from a path lookup,
 * so it cannot drift from reality.
 */
function browserOptions() {
  const list = (S.config && S.config.browsers && S.config.browsers.length)
    ? S.config.browsers
    : [{ key: 'chromium', label: 'Chrome', installed: true }];
  return list.map((b) => {
    const rec = b.key === 'chromium' ? ' (Recommended)' : '';
    const tail = b.installed ? rec : ' — not installed';
    return `<option value="${esc(b.key)}"${b.installed ? '' : ' disabled'}`
      + `${S.recForm.browser === b.key && b.installed ? ' selected' : ''}>${esc(b.label)}${tail}</option>`;
  }).join('');
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function icon(name, cls) {
  return `<svg class="i ${cls || ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}
function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }

/** Say something politely to a screen reader without showing it on screen. */
let lastAnnouncement = '';
let announceTimer = null;
function announce(message) {
  const node = $('liveRegion');
  if (!node || !message || message === lastAnnouncement) return;
  lastAnnouncement = message;
  node.textContent = message;
  // Screen readers queue the text the moment it lands, so emptying the node a moment later
  // costs nothing and keeps the region from holding stale words.
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { node.textContent = ''; }, 1500);
}

/** The page behind a drawer, sheet, modal or lightbox must not scroll. */
function syncScrollLock() {
  const locked = drawerIsOpen() || (S.sheetOpen && isNarrow()) || !!S.overlay || !!S.lightbox;
  document.documentElement.classList.toggle('scroll-locked', locked);
}

/** Stable key for a step even when the recorder gave it no id. */
function keyOf(step, index) { return step && step.id != null ? String(step.id) : '#' + index; }
function findStep(steps, key) { return (steps || []).find((s, i) => keyOf(s, i) === key) || null; }
function indexOfStep(steps, key) { return (steps || []).findIndex((s, i) => keyOf(s, i) === key); }

function relTime(iso) {
  if (!iso) return { label: '—', title: '' };
  const d = new Date(iso);
  if (isNaN(d)) return { label: '—', title: String(iso) };
  const title = d.toLocaleString();
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 45) return { label: 'just now', title };
  if (secs < 5400) return { label: Math.round(secs / 60) + ' min ago', title };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (d >= today) return { label: Math.round(secs / 3600) + ' hr ago', title };
  if (d >= new Date(today.getTime() - 86400000)) return { label: 'yesterday', title };
  if (secs < 7 * 86400) return { label: Math.round(secs / 86400) + ' days ago', title };
  return { label: d.toLocaleDateString(), title };
}
function timeAgo(iso) {
  const t = relTime(iso);
  return `<span title="${esc(t.title)}">${esc(t.label)}</span>`;
}
function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
}
/** hh:mm:ss for the recorder, mm:ss for shorter runs. */
function elapsedFrom(iso, long) {
  if (!iso) return long ? '00:00:00' : '00:00';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  if (long) return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
  return `${pad(Math.floor(secs / 60))}:${pad(secs % 60)}`;
}
/** "Good morning" / "Good afternoon" / "Good evening" from the real clock. */
function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
function userName() {
  const u = S.config && S.config.user;
  return (u && u.name) || 'Local';
}
function userInitials() {
  const u = S.config && S.config.user;
  if (u && u.initials) return u.initials;
  const name = userName();
  return name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || 'L';
}

/* Step presentation ------------------------------------------------------ */
const ACTION_LABEL = {
  navigate: 'Navigate', click: 'Click', dblclick: 'Double click', hover: 'Hover', fill: 'Fill',
  press: 'Press', check: 'Check', uncheck: 'Uncheck', select: 'Select', upload: 'Upload',
  openPage: 'Open tab', closePage: 'Close tab', expectVisible: 'Expect visible',
  expectText: 'Expect text', expectValue: 'Expect value', expectChecked: 'Expect checked', expectUrl: 'Expect URL',
  wait: 'Wait', waitForXhr: 'Wait for network',
};
function actionLabel(type) { return ACTION_LABEL[type] || type; }

/**
 * Waits point at no element, so everything the rest of the UI reads off a target has to be
 * answered from the step itself instead. Keeping the list here rather than testing the two type
 * names in six places means the next targetless step type only has to be added once.
 */
const TARGETLESS = new Set(['wait', 'waitForXhr']);
function isTargetless(step) { return !!step && TARGETLESS.has(step.type); }

/**
 * MIRROR OF `formatDuration` in src/steps.js — keep the two identical.
 * The engine writes the same duration into `step.text` (which the run views render), so a second
 * rule here would show "900ms" in the editor and "0.9s" in the result for the same step. This is
 * NOT `fmtDuration`: that one measures how long something took and belongs to runs and timers,
 * where a sub-second reading really is more useful in milliseconds.
 */
function stepDuration(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (n < 100) return `${n}ms`;
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}s`;
}

/**
 * The bold action name for one step. Most types are named by their type alone, but a fixed wait
 * is meaningless without its duration — "Wait" and "Wait" on two rows is not a step list, so the
 * length goes in the name where the eye already is. Same wording as the engine's describe().
 */
function stepActionLabel(step) {
  if (!step) return '';
  if (step.type === 'wait') return step.ms != null ? `Wait ${stepDuration(step.ms)}` : 'Wait';
  return actionLabel(step.type);
}

function stepIcon(type) {
  switch (type) {
    case 'navigate': case 'expectUrl': return 'globe';
    case 'wait': return 'clock';
    case 'waitForXhr': return 'refresh';
    case 'click': case 'dblclick': case 'hover': return 'pointer';
    case 'fill': return 'text';
    case 'press': return 'keyboard';
    case 'check': case 'uncheck': case 'expectChecked': return 'check-square';
    case 'select': return 'list';
    case 'upload': return 'upload';
    case 'openPage': case 'closePage': return 'window';
    case 'expectVisible': case 'expectText': case 'expectValue': return 'eye';
    default: return 'circle';
  }
}
function stepIconTint(type) {
  if (type === 'navigate' || type === 'expectUrl') return 'blue';
  if (type && type.indexOf('expect') === 0) return 'green';
  if (type === 'fill' || type === 'select' || type === 'upload' || type === 'press') return 'amber';
  if (type === 'wait' || type === 'waitForXhr') return 'grey';   // plumbing, not an interaction
  return '';           // default violet
}
/** The human target line under the bold action name. */
function stepTarget(step) {
  // A wait touches nothing, so the line that normally names the element says what the replay is
  // actually waiting on — leaving it blank reads as "we failed to work out the target".
  if (step.type === 'wait') {
    return step.recordedIdle ? 'the page sat idle here while you recorded' : 'a fixed pause, no element';
  }
  if (step.type === 'waitForXhr') return 'until the page stops fetching';
  const fp = step.target && step.target.fingerprint;
  if (fp) {
    if (fp.name) return `${fp.role || fp.tag || 'element'} "${fp.name}"`;
    if (fp.text) return `${fp.tag || 'element'} "${fp.text}"`;
    if (fp.attrs && fp.attrs.id) return `#${fp.attrs.id}`;
    return fp.tag || 'element';
  }
  const by = step.target && step.target.by;
  if (by) {
    const shape = typeof by === 'string' ? step.target : by;
    if (shape.name) return `${shape.role || 'element'} "${shape.name}"`;
    if (shape.value) return String(shape.value);
    return 'legacy target';
  }
  return step.url || (step.text || '');
}
/** The mono detail line (value / url / key). */
function stepDetail(s) {
  // The wait's own length is already in its action name; only the ceiling on a network wait is
  // extra information, and only when the recorder set one.
  if (s.type === 'wait') return '';
  if (s.type === 'waitForXhr') return s.timeoutMs != null ? `timeout ${stepDuration(s.timeoutMs)}` : '';
  if (s.url) return s.url;
  if (s.value != null && s.value !== '') return String(s.value);
  if (s.key) return s.key;
  if (Array.isArray(s.values) && s.values.length) return s.values.join(', ');
  if (Array.isArray(s.files) && s.files.length) return s.files.join(', ');
  if (s.type === 'expectText' && s.text) return String(s.text);
  return '';
}
function editableKey(s) {
  if (s.type === 'wait') return 'ms';
  if (s.type === 'navigate' || s.type === 'expectUrl') return 'url';
  if (s.type === 'press') return 'key';
  if (s.type === 'fill' || s.type === 'expectValue') return 'value';
  if (s.type === 'expectText') return 'text';
  return null;
}
function statusPill(status) {
  if (status === 'passed') return `<span class="pill pass"><span class="dot"></span>Passed</span>`;
  if (status === 'failed') return `<span class="pill fail"><span class="dot"></span>Failed</span>`;
  if (status === 'blocked') return `<span class="pill block"><span class="dot"></span>Blocked</span>`;
  if (status === 'running' || status === 'starting') return `<span class="pill run"><span class="dot"></span>In Progress</span>`;
  return `<span class="pill"><span class="dot"></span>Never run</span>`;
}
function appLabel(key) {
  const a = S.config && S.config.apps && S.config.apps[key];
  return a ? a.label : (key || 'unknown app');
}
function appBaseUrl(key) {
  const a = S.config && S.config.apps && S.config.apps[key];
  return a ? a.baseUrl : '';
}
const sepdot = '<span class="sepdot"></span>';

/* ══════════════════════════════════════════════════════════════════════════
   API + TOASTS
   ══════════════════════════════════════════════════════════════════════════ */
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the recorder service — is server.js still running?');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, kind) {
  const node = document.createElement('div');
  node.className = 'toast' + (kind === 'bad' ? ' bad' : kind === 'good' ? ' good' : '');
  node.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  node.innerHTML = `${icon(kind === 'bad' ? 'alert' : kind === 'good' ? 'check-circle' : 'info', 'i-sm')}<span>${esc(message)}</span>`;
  $('toasts').appendChild(node);
  setTimeout(() => node.remove(), kind === 'bad' ? 9000 : 4000);
}

/** Run an async action; any failure becomes a readable toast. Returns undefined on failure. */
async function guard(fn, failMessage) {
  try { return await fn(); }
  catch (e) { toast((failMessage ? failMessage + ': ' : '') + e.message, 'bad'); return undefined; }
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast('Copied to clipboard', 'good');
  } catch { toast('Could not copy to the clipboard', 'bad'); }
}

/* ══════════════════════════════════════════════════════════════════════════
   THEME  (light / dark / system, persisted)
   ══════════════════════════════════════════════════════════════════════════ */
function themeChoice() { return lsGet('tf.theme') || 'system'; }
function effectiveTheme() {
  const choice = themeChoice();
  if (choice === 'light' || choice === 'dark') return choice;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') document.documentElement.setAttribute('data-theme', choice);
  else document.documentElement.removeAttribute('data-theme');
  const dark = effectiveTheme() === 'dark';
  const useEl = $('themeIcon');
  if (useEl) useEl.setAttribute('href', dark ? '#i-sun' : '#i-moon');
}
function setTheme(choice) { lsSet('tf.theme', choice); applyTheme(choice); closeMenu(); }

/* ══════════════════════════════════════════════════════════════════════════
   ROUTER
   ══════════════════════════════════════════════════════════════════════════ */
function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'home') return { name: 'home' };
  if (parts[0] === 'record') return { name: 'record' };
  if (parts[0] === 'tests') return { name: 'tests' };
  if (parts[0] === 'executions') return { name: 'executions' };
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'test' && parts[1]) return { name: 'test', id: parts[1] };
  if (parts[0] === 'run' && parts[1] && parts[2]) return { name: 'run', testId: parts[1], runId: parts[2] };
  return { name: 'home' };
}
function go(hash, replace) {
  if (replace) location.replace(hash); else location.hash = hash;
}

async function onRouteChange() {
  closeMenu();
  closeDrawer();
  S.runTarget = null;               // a target chosen for one test must not leak onto the next
  S.overlay = null;                 // the palette / a modal must never outlive the screen it was
                                    // opened over: without this, opening the palette and then
                                    // navigating (its own actions do exactly that, as does the
                                    // browser Back button) left it floating above the new page
  S.sheetOpen = false;              // a new screen never arrives with the bottom sheet already up
  S.route = parseHash();
  // Opening a DIFFERENT test must start from a blank slate, not from the last one's steps.
  if (S.route.name === 'test' && S.test && S.test.id !== S.route.id) S.test = null;
  paintChrome();
  render();                                   // paint immediately, then fill in
  if (S.route.name === 'home') { await loadTests(); await loadStats(); }
  if (S.route.name === 'tests') await loadTests();
  if (S.route.name === 'executions') { await loadTests(); await loadAllRuns(); }
  if (S.route.name === 'test') await loadTest(S.route.id);
  if (S.route.name === 'run' && S.route.runId !== 'live') await loadRun(S.route.testId, S.route.runId);
  render();
}

/* ══════════════════════════════════════════════════════════════════════════
   DATA LOADERS
   ══════════════════════════════════════════════════════════════════════════ */
async function loadTests() {
  S.loadingTests = true;
  const data = await guard(() => api('GET', '/api/tests'), 'Could not load the tests');
  S.loadingTests = false;
  if (data) { S.tests = data.tests || []; refreshFolders(); }
}

async function loadStats() {
  const data = await guard(() => api('GET', '/api/stats'), 'Could not load the summary counts');
  if (data) S.stats = data;
}

async function loadAllRuns() {
  S.loadingRuns = true;
  S.runsError = null;
  try {
    const data = await api('GET', '/api/runs?limit=50');
    S.allRuns = data.runs || [];
  } catch (e) {
    S.runsError = e.message;
    toast('Could not load the execution history: ' + e.message + ' — press Refresh to try again.', 'bad');
  } finally {
    S.loadingRuns = false;
  }
}

async function loadTest(id) {
  const t = await guard(() => api('GET', '/api/tests/' + id), 'Could not open that test');
  if (!t) {
    // Leaving the PREVIOUS test on screen under the new URL is the worst possible answer: the
    // page then shows one test's steps while the address bar, the Execute button and Delete
    // all point at another. Drop it and say what happened.
    S.test = null;
    S.testUnavailable[id] = 'missing';
    if (S.route.name === 'test' && S.route.id === id) render();
    return;
  }
  delete S.testUnavailable[id];
  S.test = t;
  S.testCache[id] = t;
  S.testDirty = false;
  S.testTagDraft = '';
  S.inspEdit = false;
  S.testSel = (t.steps && t.steps.length) ? keyOf(t.steps[0], 0) : null;
  loadRuns(id);
}

async function loadRuns(id) {
  const data = await guard(() => api('GET', `/api/tests/${id}/runs`), 'Could not load the run history');
  if (!data) return;
  S.runs[id] = data.runs || [];
  if (S.route.name === 'test' && S.route.id === id) render();
}

async function loadRun(testId, runId) {
  const key = testId + '/' + runId;
  if (S.runCache[key]) return;
  const r = await guard(() => api('GET', `/api/tests/${testId}/runs/${runId}`), 'Could not open that result');
  if (r) { S.runCache[key] = normaliseRun(r); delete S.runUnavailable[key]; }
  // A spinner that can never resolve is a lie - the same rule the failed-run screen already
  // follows for a run whose test has been deleted. Remember the miss so the screen can say so.
  else S.runUnavailable[key] = true;
}

/* Called from inside a render, so it must be idempotent in BOTH directions. Remembering only
   successes meant a run whose test has since been deleted re-fired GET /api/tests/:id on every
   single render - and render runs on every SSE tick and every resize, so a 404 became an endless
   request loop. The id is claimed BEFORE the await, which also collapses the duplicate request
   that the paint-then-fill double render was making. */
async function ensureTestCached(testId) {
  if (!testId || S.testCache[testId] || S.testUnavailable[testId]) return;
  S.testUnavailable[testId] = 'loading';
  const t = await guard(() => api('GET', '/api/tests/' + testId), 'Could not load the recorded step');
  if (t) { delete S.testUnavailable[testId]; S.testCache[testId] = t; }
  else S.testUnavailable[testId] = 'missing';
  render();
}

/** Folder names = those in use by tests + those the user created locally. */
function refreshFolders() {
  const used = new Set(S.tests.map((t) => t.folder).filter(Boolean));
  let stored = [];
  try { stored = JSON.parse(lsGet('tf.folders') || '[]'); } catch { stored = []; }
  stored.forEach((f) => used.add(f));
  S.folders = Array.from(used).sort();
}
function addFolder(name) {
  const clean = String(name || '').trim();
  if (!clean) return;
  const next = Array.from(new Set(S.folders.concat([clean]))).sort();
  lsSet('tf.folders', JSON.stringify(next));
  S.folders = next;
}

/* ══════════════════════════════════════════════════════════════════════════
   SSE — recording snapshots + run progress, with our own backoff
   ══════════════════════════════════════════════════════════════════════════ */
let sseSource = null;
let sseBackoff = 500;

function connectEvents() {
  try { if (sseSource) sseSource.close(); } catch { /* ignore */ }
  sseSource = new EventSource('/api/events');

  sseSource.onopen = () => { S.sseUp = true; sseBackoff = 500; paintChrome(); };

  sseSource.addEventListener('recording', (e) => {
    let snap; try { snap = JSON.parse(e.data); } catch { return; }
    onRecordingSnapshot(snap);
  });
  sseSource.addEventListener('run', (e) => {
    let progress; try { progress = JSON.parse(e.data); } catch { return; }
    onRunProgress(progress);
  });
  sseSource.onerror = () => {
    S.sseUp = false;
    paintChrome();
    try { sseSource.close(); } catch { /* ignore */ }
    setTimeout(connectEvents, sseBackoff);
    sseBackoff = Math.min(sseBackoff * 2, 10000);
  };
}

/**
 * The recorded workflow happens in a SEPARATE Chromium window, and this page goes straight
 * behind it the moment that window opens - so the person recording never sees the step list
 * they are meant to be watching. The panel exists for exactly that, but it only ever opened if
 * you knew the button was there. Now a recording that really starts pops it out for you.
 *
 * Driven off the recorder's OWN status reaching `recording`, never off the Launch click: a
 * launch that fails must not leave an orphan panel over the app. Opened once per recording -
 * the window is named, so a repeat call would only refocus, but refocusing on every SSE tick
 * would steal the window back from the app the user is trying to drive.
 */
let panelAutoOpened = false;
function maybeAutoOpenPanel(previousStatus) {
  if (S.rec.status !== 'recording') {
    // Anything that is not an active recording arms the next one. `stopping` is still this
    // recording, so it must not re-arm and pop a second panel as the draft winds down.
    if (S.rec.status !== 'stopping') panelAutoOpened = false;
    return;
  }
  if (panelAutoOpened || previousStatus === 'recording') return;
  panelAutoOpened = true;
  if (!prefGet('autoPanel', true)) return;   // opted out in Settings; the button still works
  openRecorderPanel();                       // toasts by itself if the pop-up is blocked
}

function onRecordingSnapshot(snap) {
  const previous = S.rec;
  S.rec = snap || { status: 'idle', steps: [] };
  const steps = S.rec.steps || [];

  // Follow the newest step while recording so the panel always shows something live.
  if (S.rec.status === 'recording' && steps.length && (previous.steps || []).length !== steps.length) {
    S.recSel = keyOf(steps[steps.length - 1], steps.length - 1);
  }
  if (previous.status !== S.rec.status) {
    announce(S.rec.status === 'recording' ? 'Recording.'
      : S.rec.status === 'starting' ? 'Starting the browser.'
      : S.rec.status === 'stopped' ? `Recording stopped, ${steps.length} ${steps.length === 1 ? 'step' : 'steps'} captured.`
      : '');
  }
  // Pause is the one state change that costs the user work if they miss it, so it is announced
  // from the SERVER's snapshot — the same source the button reads — rather than when we asked.
  if (!previous.paused !== !S.rec.paused) {
    announce(S.rec.paused
      ? 'Recording paused. Nothing you do in the browser is being captured.'
      : 'Recording resumed. Your actions are being captured again.');
  }
  if (previous.status !== 'stopped' && S.rec.status === 'stopped') {
    S.recStage = null;                                  // land on Review
    if (steps.length) S.recSel = keyOf(steps[0], 0);
    S.saveForm.name = S.saveForm.name || S.recForm.name;
    S.saveForm.description = S.saveForm.description || S.recForm.description;
  }
  if (S.recSel != null && !steps.some((s, i) => keyOf(s, i) === S.recSel)) {
    S.recSel = steps.length ? keyOf(steps[steps.length - 1], steps.length - 1) : null;
  }
  maybeAutoOpenPanel(previous.status);
  // Coalesced: the recorder sends one of these per captured keystroke.
  if (S.route.name === 'record') scheduleRender();
}

function normaliseRun(p) {
  return {
    id: p.id || p.runId || null,
    testId: p.testId,
    testName: p.testName || (S.testCache[p.testId] && S.testCache[p.testId].name) || p.testId,
    status: p.status || 'running',
    startedAt: p.startedAt || null,
    finishedAt: p.finishedAt || null,
    durationMs: p.durationMs != null ? p.durationMs : null,
    stepCount: p.stepCount != null ? p.stepCount : (p.total != null ? p.total : (p.steps || []).length),
    failedStep: p.failedStep != null ? p.failedStep : null,
    error: p.error || null,
    url: p.url || null,
    screenshot: p.screenshot || null,
    notes: p.notes || [],
    consoleErrors: p.consoleErrors || [],
    networkErrors: p.networkErrors || [],
    steps: p.steps || [],
    phase: p.phase || null,
    current: p.current != null ? p.current : null,
    done: !!p.done || p.status === 'passed' || p.status === 'failed' || p.status === 'blocked',
  };
}

function onRunProgress(progress) {
  const run = normaliseRun(progress);
  if (!run.startedAt) run.startedAt = (S.live && S.live.startedAt) || new Date().toISOString();
  S.live = run;

  announce(run.done
    ? `${run.testName || 'The test'} ${run.status === 'passed' ? 'passed' : run.status === 'blocked' ? 'was blocked' : 'failed'}.`
    : phaseLine(run));

  if (run.done) {
    if (run.id) S.runCache[run.testId + '/' + run.id] = run;
    loadTests().then(() => { if (S.route.name === 'tests' || S.route.name === 'home') render(); });
    if (S.route.name === 'run' && S.route.runId === 'live' && run.id) {
      go(`#/run/${run.testId}/${run.id}`, true);
      S.route = parseHash();
    }
  }
  // Coalesced for the same reason: step progress arrives far faster than a screen can be read.
  if (S.route.name === 'run' || S.route.name === 'home') scheduleRender();
}

/* ══════════════════════════════════════════════════════════════════════════
   CHROME  (sidebar, top bar) — painted outside the page render
   ══════════════════════════════════════════════════════════════════════════ */
const NAV_ITEMS = [
  { hash: '#/home', label: 'Home', icon: 'home', match: ['home'] },
  { hash: '#/record', label: 'Record', icon: 'record', match: ['record'] },
  { hash: '#/tests', label: 'Tests', icon: 'tests', match: ['tests', 'test'] },
  { hash: '#/executions', label: 'Executions', icon: 'activity', match: ['executions', 'run'] },
  { hash: '#/settings', label: 'Settings', icon: 'settings', match: ['settings'] },
];

function paintChrome() {
  $('nav').innerHTML = NAV_ITEMS.map((item) => `
    <a href="${item.hash}" ${item.match.includes(S.route.name) ? 'aria-current="page"' : ''} title="${esc(item.label)}">
      ${icon(item.icon)}<span class="hide-collapsed">${esc(item.label)}</span>
    </a>`).join('');

  $('sbCard').innerHTML = `
    <div class="row" style="gap:6px; margin-bottom:5px">
      <span class="dot" style="width:7px;height:7px;border-radius:50%;background:${S.sseUp ? 'var(--success)' : 'var(--warning)'}"></span>
      <span class="meta" style="color:${S.sseUp ? 'var(--success)' : 'var(--warning)'}">${S.sseUp ? 'Connected' : 'Reconnecting…'}</span>
    </div>
    <div class="meta" style="margin-bottom:3px">Tests directory</div>
    <div class="path">${esc((S.config && S.config.testsDir) || 'loading…')}</div>`;

  $('sbUser').innerHTML = `
    <span class="avatar">${esc(userInitials())}</span>
    <span class="hide-collapsed" style="min-width:0">
      <div class="truncate" style="font-size:12.5px; font-weight:500">${esc(userName())}</div>
      <div class="meta">Developer</div>
    </span>`;

  $('topAvatar').textContent = userInitials();
  applyRail(railIsOn());
  const pill = $('connPill');
  pill.className = 'pill' + (S.sseUp ? '' : ' block');
  pill.innerHTML = S.sseUp
    ? `<span class="dot"></span>Local Only`
    : `${icon('refresh', 'i-sm spinner')}Reconnecting`;
  applyTheme(themeChoice());
}

/* ══════════════════════════════════════════════════════════════════════════
   RENDER
   ══════════════════════════════════════════════════════════════════════════ */
function render() {
  const active = document.activeElement;
  const focusId = active && active.id && page().contains(active) ? active.id : null;
  const caret = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;

  let html = '';
  switch (S.route.name) {
    case 'record':     html = viewRecord(); break;
    case 'tests':      html = viewTests(); break;
    case 'test':       html = viewTestDetail(); break;
    case 'executions': html = viewExecutions(); break;
    case 'settings':   html = viewSettings(); break;
    case 'run':        html = viewRun(); break;
    default:           html = viewHome();
  }
  page().innerHTML = html;
  $('overlayHost').innerHTML = (S.lightbox ? viewLightbox() : '') + (S.overlay ? viewOverlay() : '');
  paintChrome();

  if (focusId) {
    const node = $(focusId);
    if (node) {
      node.focus();
      if (caret && typeof node.setSelectionRange === 'function') {
        try { node.setSelectionRange(caret[0], caret[1]); } catch { /* ignore */ }
      }
    }
  }
  if (S.overlay && S.overlay.kind === 'palette') { const q = $('paletteInput'); if (q) q.focus(); }
  syncScrollLock();
  tickTimers();
}

/**
 * PAINT ONCE PER FRAME, not once per event.
 *
 * render() rebuilds the whole page. Measured on this machine that is 0.6 ms at 10 steps,
 * 1.5 ms at 50 and 3.7 ms at 100 - fine for one user action, ruinous for the recorder, which
 * pushes a snapshot per keystroke: typing one field into the recorded app fired ~18 snapshots
 * and so 18 complete teardowns of the DOM, back to back, while the user was mid-word.
 *
 * So the SSE paths ask for a paint instead of taking one. A burst collapses to a single
 * rebuild on the next frame, and the state itself is still updated synchronously - only the
 * pixels wait. The timer beside the frame request matters: for almost all of a recording this
 * page is BEHIND the Chromium window being driven, where requestAnimationFrame is frozen, and
 * a paint that never happens is worse than a slow one.
 */
let renderHandle = null;
function scheduleRender() {
  if (renderHandle) return;
  const fire = () => {
    const h = renderHandle;
    renderHandle = null;
    if (h) { cancelAnimationFrame(h.raf); clearTimeout(h.timer); }
    render();
  };
  renderHandle = { raf: requestAnimationFrame(fire), timer: setTimeout(fire, 250) };
}

function tickTimers() {
  document.querySelectorAll('[data-elapsed]').forEach((n) => {
    n.textContent = elapsedFrom(n.getAttribute('data-elapsed'), n.hasAttribute('data-long'));
  });
}
setInterval(tickTimers, 1000);

/* ══════════════════════════════════════════════════════════════════════════
   VIEW — HOME
   ══════════════════════════════════════════════════════════════════════════ */
function viewHome() {
  if (!S.tests.length && !S.stats && S.loadingTests) return loadingCard('Loading tests…');
  if (!S.tests.length && S.stats && S.stats.total === 0) return viewEmptyState();
  const stats = S.stats || { total: S.tests.length, passed: 0, failed: 0, running: 0 };
  const recent = S.tests.slice().sort((a, b) =>
    new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)).slice(0, 3);

  return `
  <div style="margin-bottom:22px">
    <h1 class="row" style="gap:9px">${esc(greeting())}, ${esc(userName())}
      <span style="color:var(--warning)">${icon('hand', 'i-lg')}</span></h1>
    <div class="sub muted" style="margin-top:4px">Ready to catch bugs before they catch you.</div>
  </div>

  <div class="grid4" style="margin-bottom:18px">
    ${quickAction('record', '', 'Start Recording', 'Open browser and record', 'start-recording')}
    ${quickAction('window', 'blue', 'Open Browser', 'Launch without recording', 'open-browser')}
    ${quickAction('import', 'amber', 'Import Test', 'From file or clipboard', 'import-test')}
    ${quickAction('folder-plus', 'green', 'New Folder', 'Organize your tests', 'new-folder')}
  </div>

  <div class="grid4" style="margin-bottom:22px">
    ${statTile('tests', 'grey', stats.total, 'Total Tests')}
    ${statTile('check-circle', 'green', stats.passed, 'Passed')}
    ${statTile('x-circle', 'red', stats.failed, 'Failed')}
    ${statTile('refresh', 'blue', stats.running || 0, 'In Progress')}
  </div>

  <div class="split">
    <div class="card">
      <div class="card-head">
        <h3>Recent Tests</h3>
        <a href="#/tests" class="meta" style="color:var(--accent)">View all</a>
      </div>
      ${recent.length ? recent.map((t) => `
        <div class="list-row" role="button" tabindex="0" data-act="open-test" data-id="${esc(t.id)}">
          <span class="tile sq ${stepIconTint('')}">${icon('tests', 'i-sm')}</span>
          <span class="grow">
            <div class="nm truncate">${esc(t.name)}</div>
            <div class="ds truncate">${esc(t.description || (t.stepCount + ' steps'))}</div>
          </span>
          ${statusPill(t.lastRun ? t.lastRun.status : 'never')}
          <span class="meta nowrap">${t.lastRun ? timeAgo(t.lastRun.at) : '—'}</span>
          <button class="btn-icon" data-act="row-menu" data-id="${esc(t.id)}" aria-label="More actions">${icon('dots')}</button>
        </div>`).join('') : `<div class="empty-sm">No tests yet.</div>`}
    </div>

    <div class="promo">
      <div class="art">
        <svg width="150" height="92" viewBox="0 0 150 92" fill="none" stroke="currentColor" stroke-width="1.5"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="8" y="10" width="84" height="58" rx="5"/>
          <path d="M8 24h84"/><circle cx="18" cy="17" r="1.6"/><circle cx="25" cy="17" r="1.6"/><circle cx="32" cy="17" r="1.6"/>
          <path d="M22 38h34M22 47h48M22 56h26"/>
          <circle cx="120" cy="52" r="17"/><circle cx="120" cy="52" r="6"/>
          <path d="M94 30c12-6 23-2 28 7" stroke-dasharray="4 5"/><path d="M124 34l3 2.4-2.6 3.2"/>
        </svg>
      </div>
      <div>
        <h3 style="font-size:15px; margin-bottom:6px">Turn your manual steps into reliable tests</h3>
        <p class="meta" style="line-height:1.5">Record once. Design Studio Tester captures every action with a ranked set of
          locators, so a replay still finds the element after your markup changes.</p>
      </div>
      <button class="btn btn-primary btn-block" data-act="start-recording">${icon('record', 'i-sm')}New Recording</button>
    </div>
  </div>`;
}

function quickAction(ic, tint, title, desc, act, disabled, hint) {
  return `
  <button class="qa" data-act="${esc(act)}" ${disabled ? 'disabled' : ''} ${hint ? `title="${esc(hint)}"` : ''}>
    <span class="tile ${tint}">${icon(ic, 'i-sm')}</span>
    <span><span class="t">${esc(title)}</span><div class="d">${esc(desc)}</div></span>
  </button>`;
}
function statTile(ic, tint, n, label) {
  return `
  <div class="stat">
    <span class="tile ${tint}">${icon(ic, 'i-sm')}</span>
    <span><div class="n">${esc(n == null ? '—' : n)}</div><div class="l">${esc(label)}</div></span>
  </div>`;
}

/** Every async screen gets one of these instead of an empty page. */
function loadingCard(label) {
  return `<div class="card empty-sm" role="status">${icon('refresh', 'i-sm spinner')} ${esc(label)}</div>`;
}

function viewEmptyState() {
  return `
  <div class="card empty">
    <div class="art">
      <svg width="168" height="112" viewBox="0 0 168 112" fill="none" stroke="currentColor" stroke-width="1.5"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="12" y="14" width="96" height="66" rx="6"/><path d="M12 30h96"/>
        <circle cx="24" cy="22" r="2"/><circle cx="32" cy="22" r="2"/><circle cx="40" cy="22" r="2"/>
        <path d="M28 44h40M28 54h56M28 64h30"/>
        <circle cx="132" cy="60" r="20"/><circle cx="132" cy="60" r="7"/>
        <path d="M108 34c14-6 26-2 32 8" stroke-dasharray="4 5"/><path d="M138 40l3.5 2.6-3 3.6"/>
      </svg>
    </div>
    <h2>No tests yet</h2>
    <p>Record your first test to get started.</p>
    <button class="btn btn-primary btn-lg" data-act="start-recording">${icon('record')}Start Recording</button>
  </div>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   VIEW — TEST LIBRARY
   ══════════════════════════════════════════════════════════════════════════ */
function viewTests() {
  if (!S.tests.length) return S.loadingTests ? loadingCard('Loading tests…') : viewEmptyState();

  const favourites = S.tests.filter((t) => t.favorite);
  const rows = libraryRows();
  const selectedCount = Object.keys(S.libSelection).filter((k) => S.libSelection[k]).length;

  return `
  <div class="page-head">
    <div>
      <h1>Test Library</h1>
      <div class="sub">All your recorded test cases in one place.</div>
    </div>
    <div class="row wrap">
      <button class="btn" data-act="filter-menu">${icon('filter', 'i-sm')}Filter${S.libFilter !== 'all' ? ': ' + esc(S.libFilter) : ''}</button>
      <div class="seg" role="group" aria-label="View">
        <button data-act="lib-view" data-view="list" aria-pressed="${S.libView === 'list'}" title="List view" aria-label="List view">${icon('rows', 'i-sm')}</button>
        <button data-act="lib-view" data-view="grid" aria-pressed="${S.libView === 'grid'}" title="Grid view" aria-label="Grid view">${icon('grid', 'i-sm')}</button>
      </div>
      <button class="btn btn-primary" data-act="start-recording">${icon('plus', 'i-sm')}New Recording</button>
    </div>
  </div>

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected="${S.libTab === 'all'}" data-act="lib-tab" data-tab="all">All Tests <span class="count">(${S.tests.length})</span></button>
    <button role="tab" aria-selected="${S.libTab === 'favorites'}" data-act="lib-tab" data-tab="favorites">Favorites <span class="count">(${favourites.length})</span></button>
    <button role="tab" aria-selected="${S.libTab === 'folders'}" data-act="lib-tab" data-tab="folders">Folders <span class="count">(${S.folders.length})</span></button>
  </div>

  ${S.libFolder ? `<div class="note info" style="margin-bottom:12px">
      ${icon('folder', 'i-sm')}<span>Showing the <b>${esc(S.libFolder)}</b> folder</span>
      <span class="grow"></span>
      <button class="btn btn-sm btn-ghost" data-act="clear-folder">Show all folders</button>
    </div>` : ''}

  ${selectedCount ? `<div class="note info" style="margin-bottom:12px">
      ${icon('info', 'i-sm')}<span>${selectedCount} selected</span>
      <span class="grow"></span>
      <button class="btn btn-sm btn-danger-outline" data-act="delete-selected">${icon('trash', 'i-sm')}Delete selected</button>
    </div>` : ''}

  ${S.libTab === 'folders' ? foldersPanel() : S.libView === 'grid' ? libraryGrid(rows) : libraryTable(rows)}`;
}

/** The rows that survive the tab, the filter and the top-bar search. */
function libraryRows() {
  const q = S.search.trim().toLowerCase();
  return S.tests.filter((t) => {
    if (S.libTab === 'favorites' && !t.favorite) return false;
    // Picking a folder used to type its NAME into the free-text search box, which matches on
    // name/description/tags and so found the folder's tests only by coincidence - usually
    // nothing at all. A folder is a field on the test, so it is filtered as one.
    if (S.libFolder && t.folder !== S.libFolder) return false;
    if (q && !((t.name || '') + ' ' + (t.description || '') + ' ' + (t.tags || []).join(' ')).toLowerCase().includes(q)) return false;
    const status = t.lastRun ? t.lastRun.status : 'never';
    if (S.libFilter === 'passed' && status !== 'passed') return false;
    if (S.libFilter === 'failed' && status !== 'failed' && status !== 'blocked') return false;
    if (S.libFilter === 'never' && t.lastRun) return false;
    return true;
  });
}

function libraryTable(rows) {
  if (!rows.length) return emptyFilterPanel();
  const allChecked = rows.every((t) => S.libSelection[t.id]);
  return `
  <div class="card tbl-wrap">
    <table class="tbl tbl-card" aria-label="Recorded tests">
      <thead><tr>
        <th style="width:34px"><input type="checkbox" data-act="select-all" ${allChecked ? 'checked' : ''} aria-label="Select all tests"></th>
        <th>Name</th><th class="col-secondary" style="width:80px">Steps</th><th class="col-secondary" style="width:130px">Last Run</th>
        <th style="width:130px">Status</th><th class="cell-actions" aria-label="Actions"></th>
      </tr></thead>
      <tbody>
        ${rows.map((t) => `
          <tr data-act="open-test" data-id="${esc(t.id)}" tabindex="0">
            <td class="cell-select" data-label="" style="width:34px">
              <input type="checkbox" data-act="select-row" data-id="${esc(t.id)}" ${S.libSelection[t.id] ? 'checked' : ''}
                     aria-label="Select ${esc(t.name)}">
            </td>
            <td class="cell-title">
              <span class="cellname">
                <span class="tile sq ${t.favorite ? 'amber' : ''}">${icon(t.favorite ? 'star' : 'tests', 'i-sm')}</span>
                <span style="min-width:0">
                  <div class="truncate" style="font-weight:600">${esc(t.name)}</div>
                  ${t.description ? `<div class="meta truncate">${esc(t.description)}</div>` : ''}
                  ${(t.tags && t.tags.length) ? `<div class="row wrap" style="gap:4px;margin-top:4px">${
                    t.tags.slice(0, 3).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}</div>` : ''}
                </span>
              </span>
            </td>
            <td data-label="Steps" class="col-secondary tnum">${esc(t.stepCount)}</td>
            <td data-label="Last Run" class="col-secondary meta">${t.lastRun ? timeAgo(t.lastRun.at) : 'Never'}</td>
            <td data-label="Status">${statusPill(t.lastRun ? t.lastRun.status : 'never')}</td>
            <td class="cell-actions" data-label="" style="text-align:right">
              <button class="btn-icon" data-act="row-menu" data-id="${esc(t.id)}" aria-label="Actions for ${esc(t.name)}">${icon('dots')}</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

function libraryGrid(rows) {
  if (!rows.length) return emptyFilterPanel();
  return `<div class="grid4" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr))">
    ${rows.map((t) => `
      <div class="card card-pad" role="button" tabindex="0" data-act="open-test" data-id="${esc(t.id)}" style="cursor:pointer">
        <div class="row" style="margin-bottom:10px">
          <span class="tile sq ${t.favorite ? 'amber' : ''}">${icon(t.favorite ? 'star' : 'tests', 'i-sm')}</span>
          <span class="grow"></span>
          ${statusPill(t.lastRun ? t.lastRun.status : 'never')}
        </div>
        <div class="truncate" style="font-weight:600">${esc(t.name)}</div>
        <div class="meta truncate" style="margin-top:2px">${esc(t.description || '')}</div>
        <div class="row meta" style="margin-top:12px; gap:6px">
          <span>${esc(t.stepCount)} steps</span>${sepdot}
          <span>${t.lastRun ? relTime(t.lastRun.at).label : 'never run'}</span>
        </div>
      </div>`).join('')}
  </div>`;
}

function emptyFilterPanel() {
  return `<div class="card empty-sm" style="padding:44px 16px">
    No tests match this view.
    ${S.search ? `<button class="btn btn-sm btn-ghost" data-act="clear-search">Clear search</button>` : ''}
    ${S.libFolder ? `<button class="btn btn-sm btn-ghost" data-act="clear-folder">Show all folders</button>` : ''}
    ${S.libFilter !== 'all' ? `<button class="btn btn-sm btn-ghost" data-act="set-filter" data-filter="all">Clear filter</button>` : ''}
  </div>`;
}

function foldersPanel() {
  if (!S.folders.length) {
    return `<div class="card empty-sm" style="padding:44px 16px">
      No folders yet.
      <div style="margin-top:12px"><button class="btn btn-sm" data-act="new-folder">${icon('folder-plus', 'i-sm')}New folder</button></div>
    </div>`;
  }
  return `<div class="card">
    ${S.folders.map((f) => {
      const inFolder = S.tests.filter((t) => t.folder === f);
      return `<div class="list-row" role="button" tabindex="0" data-act="folder-filter" data-folder="${esc(f)}"
              aria-current="${S.libFolder === f ? 'true' : 'false'}">
        <span class="tile sq grey">${icon('folder', 'i-sm')}</span>
        <span class="grow"><div class="nm">${esc(f)}</div>
          <div class="meta">${inFolder.length} ${inFolder.length === 1 ? 'test' : 'tests'}</div></span>
        ${icon('chevron-right', 'i-sm subtle')}
      </div>`;
    }).join('')}
  </div>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   VIEW — EXECUTIONS
   ══════════════════════════════════════════════════════════════════════════ */
function viewExecutions() {
  const runs = S.allRuns;
  return `
  <div class="page-head">
    <div>
      <h1>Executions</h1>
      <div class="sub">Every replay across all tests, newest first.</div>
    </div>
    <button class="btn" data-act="reload-runs" ${S.loadingRuns ? 'disabled' : ''}>
      ${icon('refresh', S.loadingRuns ? 'i-sm spinner' : 'i-sm')}${S.loadingRuns ? 'Refreshing…' : 'Refresh'}
    </button>
  </div>
  ${S.runsError ? `<div class="note bad" role="alert" style="margin-bottom:12px">${icon('alert', 'i-sm')}
    <span><b>The execution history could not be read.</b> ${esc(S.runsError)} — check the recorder service is
    still running, then press Refresh.</span></div>` : ''}
  ${S.loadingRuns && !runs ? loadingCard('Loading executions…')
    : !runs ? `<div class="card empty-sm">No execution history yet.</div>`
    : !runs.length ? viewNoExecutions() : `
    <div class="card tbl-wrap">
      <table class="tbl tbl-card" aria-label="Execution history, newest first">
        <thead><tr>
          <th>Test Name</th><th style="width:130px">Status</th><th class="col-secondary" style="width:110px">Duration</th>
          <th style="width:160px">Executed At</th><th class="cell-actions">Actions</th>
        </tr></thead>
        <tbody>
          ${runs.map((r) => `
            <tr data-act="open-run" data-test="${esc(r.testId)}" data-run="${esc(r.id)}" tabindex="0">
              <td class="cell-title">
                <span class="cellname">
                  <span class="tile sq ${r.status === 'passed' ? 'green' : r.status === 'failed' ? 'red' : 'grey'}">
                    ${icon(r.status === 'passed' ? 'check' : r.status === 'failed' ? 'x' : 'clock', 'i-sm')}
                  </span>
                  <span style="min-width:0">
                    <div class="truncate" style="font-weight:600">${esc(r.testName || r.testId)}</div>
                    ${r.status === 'failed' && r.failedStep ? `<div class="meta">failed at step ${esc(r.failedStep)}</div>` : ''}
                  </span>
                </span>
              </td>
              <td data-label="Status">${statusPill(r.status)}</td>
              <td data-label="Duration" class="col-secondary tnum meta">${esc(fmtDuration(r.durationMs))}</td>
              <td data-label="Executed At" class="meta">${timeAgo(r.startedAt)}</td>
              <td class="cell-actions" data-label="" style="text-align:right">
                <button class="btn-icon" data-act="run-menu" data-test="${esc(r.testId)}" data-run="${esc(r.id)}"
                        aria-label="Actions for the ${esc(r.testName || r.testId)} run">${icon('dots')}</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`}`;
}

/* ══════════════════════════════════════════════════════════════════════════
   VIEW — SETTINGS
   ══════════════════════════════════════════════════════════════════════════ */
const SETTINGS_TABS = [
  ['general', 'General'], ['browser', 'Browser'], ['recording', 'Recording'],
  ['execution', 'Execution'], ['storage', 'Storage'],
];

/* Settings used to force a 180px sub-nav column with an inline grid-template, which beat every
   media query and made this the worst horizontal-overflow offender on a phone. Now the narrow
   layout is a deliberate horizontally scrollable tab strip (the same `.tabs` component used on the
   Test Library) and the wide layout is a real side nav. */
/* Executions with nothing in them used to be a single grey sentence in an empty card, which
   told the reader nothing about what to do next. Every other empty surface in this app uses
   the .empty component - illustration, heading, one line of guidance, one action - so this
   one does too. The action depends on whether there is anything to execute yet. */
function viewNoExecutions() {
  const hasTests = (S.tests || []).length > 0;
  return `
  <div class="card empty">
    <div class="art">
      <svg width="168" height="112" viewBox="0 0 168 112" fill="none" stroke="currentColor" stroke-width="1.5"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="14" y="18" width="140" height="76" rx="8"/><path d="M14 38h140"/>
        <circle cx="26" cy="28" r="2"/><circle cx="34" cy="28" r="2"/><circle cx="42" cy="28" r="2"/>
        <path d="M30 66h22l8-14 10 28 9-20 7 12h28" stroke-dasharray="0"/>
      </svg>
    </div>
    <h2>No executions yet</h2>
    <p>${hasTests
      ? 'Run a test and every replay will be listed here, newest first, with the step that failed and why.'
      : 'Record a test first. Once you replay it, every run shows up here with its result and timings.'}</p>
    ${hasTests
      ? `<button class="btn btn-primary btn-lg" data-act="nav" data-href="#/tests">${icon('tests')}Go to Test Library</button>`
      : `<button class="btn btn-primary btn-lg" data-act="start-recording">${icon('record')}Start Recording</button>`}
  </div>`;
}

function viewSettings() {
  const cfg = S.config || {};
  const head = `
  <div class="page-head">
    <div><h1>Settings</h1><div class="sub">How this local recorder behaves. Values come from the recorder service.</div></div>
  </div>`;

  if (isNarrow()) {
    return head + `
    <div class="tabs" role="tablist" aria-label="Settings sections">
      ${SETTINGS_TABS.map(([key, label]) => `
        <button role="tab" id="settab-${key}" aria-selected="${S.settingsTab === key}"
                aria-controls="setpanel" data-act="settings-tab" data-tab="${key}">${esc(label)}</button>`).join('')}
    </div>
    <div class="card card-pad" id="setpanel" role="tabpanel"
         aria-labelledby="settab-${esc(S.settingsTab)}" tabindex="0">${settingsPanel(cfg)}</div>`;
  }

  return head + `
  <div class="split-sidenav">
    <nav class="card sidenav" aria-label="Settings sections">
      ${SETTINGS_TABS.map(([key, label]) => `
        <button class="btn btn-ghost btn-block nav-sub" data-act="settings-tab" data-tab="${key}"
                aria-current="${S.settingsTab === key ? 'page' : 'false'}">${esc(label)}</button>`).join('')}
    </nav>
    <div class="card card-pad">${settingsPanel(cfg)}</div>
  </div>`;
}

function settingsPanel(cfg) {
  if (S.settingsTab === 'general') {
    const apps = Object.entries(cfg.apps || {});
    return `
    <h3 style="margin-bottom:14px">General</h3>
    <div class="field-row">
      <label class="label" for="setAppUrl">Application URL</label>
      <select class="field" id="setAppUrl" data-act="set-default-app">
        ${apps.map(([key, a]) => `<option value="${esc(key)}"${key === (S.recForm.app || cfg.defaultApp) ? ' selected' : ''}>${esc(a.label)} — ${esc(a.baseUrl)}</option>`).join('')}
      </select>
      <div class="meta">Configured in <span class="mono">src/config.js</span>; this picks the default for new recordings.</div>
    </div>
    <div class="field-row">
      <label class="label" for="setBrowser">Default Browser</label>
      <select class="field" id="setBrowser" data-act="set-browser">
        ${browserOptions()}
      </select>
    </div>
    <div class="field-row">
      <span class="label">Theme</span>
      <div class="seg" role="group" aria-label="Theme">
        ${[['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'System', 'monitor']].map(([v, l, ic]) => `
          <button data-act="set-theme" data-theme="${v}" aria-pressed="${themeChoice() === v}">${icon(ic, 'i-sm')}${l}</button>`).join('')}
      </div>
    </div>
    <div class="opt-row">
      <label class="check"><input type="checkbox" data-act="pref" data-pref="autoPanel" ${prefGet('autoPanel', true) ? 'checked' : ''}>
        <span><b>Pop the recorder panel out when recording starts</b><div class="meta">The recording happens in a
          separate Chromium window, so this page ends up behind it. The panel is a wide, short bar that sits above
          the app you are driving. Turn this off to open it yourself with the Recorder Panel button.</div></span></label>
    </div>
    <div class="opt-row">
      <label class="check"><input type="checkbox" data-act="pref" data-pref="autoOpen" ${prefGet('autoOpen') ? 'checked' : ''}>
        <span><b>Auto-open browser after recording</b><div class="meta">Re-open the app when a recording is saved.</div></span></label>
    </div>
    <div class="opt-row">
      <label class="check"><input type="checkbox" data-act="pref" data-pref="verboseLogs" ${prefGet('verboseLogs') ? 'checked' : ''}>
        <span><b>Show detailed logs</b><div class="meta">Print each locator attempt in the run detail.</div></span></label>
    </div>`;
  }
  if (S.settingsTab === 'browser') {
    return `<h3 style="margin-bottom:14px">Browser</h3>
      <dl class="kv kv-wide">
        <dt>Recording</dt><dd>Always headed — you drive it yourself.</dd>
        <dt>Replay</dt><dd>${cfg.headedRun ? 'Headed' : 'Headless'} <span class="meta">(set in src/config.js)</span></dd>
        <dt>Viewport</dt><dd>${esc(S.recForm.viewport.replace('x', ' × '))}</dd>
        <dt>Saved logins</dt><dd>${(() => {
          // One session file per environment, so this has to be a list. A single "Present" was
          // only ever telling you about localhost.
          const authed = Object.entries(cfg.apps || {}).filter(([, a]) => a.auth);
          if (!authed.length) return 'No environment here needs a login.';
          return authed.map(([, a]) => `${esc(a.label)}: ${a.hasSavedLogin ? 'saved' : 'none yet'}`).join('<br>');
        })()}</dd>
      </dl>`;
  }
  if (S.settingsTab === 'recording') {
    return `<h3 style="margin-bottom:14px">Recording</h3>
      <dl class="kv kv-wide">
        <dt>Test id attribute</dt><dd class="mono">${esc(cfg.testIdAttribute || 'data-testid')}</dd>
        <dt>Network capture</dt><dd>Not captured in this version.</dd>
        <dt>Locator strategies</dt><dd>testid → role → label → text → css → xpath → positional</dd>
      </dl>`;
  }
  if (S.settingsTab === 'execution') {
    return `<h3 style="margin-bottom:14px">Execution</h3>
      <dl class="kv kv-wide">
        <dt>Step timeout</dt><dd>${cfg.stepTimeoutMs ? Math.round(cfg.stepTimeoutMs / 1000) + ' s per step' : 'default'}</dd>
        <dt>Stopping a run</dt><dd>Not supported — a run finishes on its own.</dd>
        <dt>Screenshots</dt><dd>One capture at the failing step.</dd>
      </dl>`;
  }
  return `<h3 style="margin-bottom:14px">Storage</h3>
    <dl class="kv kv-wide">
      <dt>Tests directory</dt><dd class="mono" style="word-break:break-all">${esc(cfg.testsDir || '—')}</dd>
      <dt>Format</dt><dd>One JSON file per test, run history beside it.</dd>
      <dt>Folders</dt><dd>${S.folders.length ? S.folders.map((f) => `<span class="tag">${esc(f)}</span>`).join(' ') : 'none'}</dd>
    </dl>`;
}

/** A preference, with a default for the ones that ship ON. Unset !== off. */
function prefGet(key, dflt) {
  const v = lsGet('tf.pref.' + key);
  return v == null ? !!dflt : v === '1';
}
function prefSet(key, on) { lsSet('tf.pref.' + key, on ? '1' : '0'); }

/* ══════════════════════════════════════════════════════════════════════════
   VIEW — RECORD  (Setup → Record → Review → Save)
   ══════════════════════════════════════════════════════════════════════════ */

/** Which of the four stages we are on, derived from the live recorder status. */
function recStage() {
  if (S.recStage === 'save') return 'save';
  switch (S.rec.status) {
    case 'recording': case 'stopping': case 'starting': return 'record';
    case 'stopped': return 'review';
    default: return 'setup';
  }
}

function stepper(active) {
  const stages = [['setup', 'Setup'], ['record', 'Record'], ['review', 'Review'], ['save', 'Save']];
  const activeIndex = stages.findIndex(([k]) => k === active);
  return `<div class="stepper">${stages.map(([key, label], i) => `
    <div class="sp ${i === activeIndex ? 'on' : i < activeIndex ? 'done' : ''}">
      <span class="bub">${i < activeIndex ? icon('check', 'i-sm') : i + 1}</span>
      <span class="lb">${esc(label)}</span>
    </div>
    ${i < stages.length - 1 ? '<span class="bar"></span>' : ''}`).join('')}</div>`;
}

function viewRecord() {
  const stage = recStage();
  if (stage === 'setup')  return viewRecordSetup();
  if (stage === 'record') return viewRecordLive();
  if (stage === 'review') return viewReview();
  return viewSaveTest();
}

/* ── Screen 3 — Setup ──────────────────────────────────────────────────── */
function viewRecordSetup() {
  const cfg = S.config || {};
  const apps = Object.entries(cfg.apps || {});
  const appKey = S.recForm.app || cfg.defaultApp || (apps[0] && apps[0][0]);
  // Saved logins are per environment now, so this screen must describe the SELECTED one rather
  // than a single global flag that only ever spoke for localhost.
  const appDef = (cfg.apps && cfg.apps[appKey]) || { label: appKey || 'the app', auth: false, remote: false };
  const appSaved = !!appDef.hasSavedLogin;
  const failed = S.rec.status === 'error';

  return `
  <div class="page-head"><div>
    <h1>Record a New Test</h1>
    <div class="sub">Configure your recording session and launch the browser.</div>
  </div></div>
  ${stepper('setup')}

  ${failed ? `<div class="card card-pad" style="margin-bottom:16px; border-color:var(--danger)">
    <div class="row" style="color:var(--danger); margin-bottom:8px">${icon('x-circle', 'i-lg')}<b>Could not start the last recording</b></div>
    <pre class="err">${esc(S.rec.error || 'Unknown error')}</pre>
  </div>` : ''}

  <div class="split">
    <div class="card">
      <div class="card-head"><h3>Test Details</h3></div>
      <div class="card-pad">
        <div class="field-row">
          <label class="label" for="recName">Test Name</label>
          <input class="field" id="recName" data-act="rec-form" data-key="name" value="${esc(S.recForm.name)}"
                 placeholder="Customer save loses the tax code">
        </div>
        <div class="field-row">
          <label class="label" for="recDesc">Description <span class="subtle">(optional)</span></label>
          <input class="field" id="recDesc" data-act="rec-form" data-key="description" value="${esc(S.recForm.description)}"
                 placeholder="What is broken, and what should happen instead">
        </div>
        <div class="field-row">
          <label class="label" for="recApp">Application URL</label>
          <select class="field" id="recApp" data-act="rec-form" data-key="app">
            ${apps.map(([key, a]) => `<option value="${esc(key)}"${key === appKey ? ' selected' : ''}>${esc(a.label)} — ${esc(a.baseUrl)}</option>`).join('')}
          </select>
        </div>

        ${appDef.remote ? `<div class="note warn" style="margin:-6px 0 16px">${icon('alert', 'i-sm')}<span>
          <b>${esc(appDef.label)} is a shared remote environment.</b> Everything you do while recording
          happens for real against it, using whatever account credentials.local.env holds. Prefer a
          read-only path, and avoid anything destructive.</span></div>` : ''}

        <h4 class="sec-title" style="margin:20px 0 10px">Browser Options</h4>
        <div class="field-row">
          <label class="label" for="recBrowser">Browser</label>
          <select class="field" id="recBrowser" data-act="rec-form" data-key="browser">
            ${browserOptions()}
          </select>
        </div>
        <div class="field-row">
          <label class="label" for="recViewport">Viewport</label>
          <select class="field" id="recViewport" data-act="rec-form" data-key="viewport">
            ${['1280x800', '1440x900', '1920x1080', '1024x768'].map((v) =>
              `<option value="${v}"${S.recForm.viewport === v ? ' selected' : ''}>${v.replace('x', ' × ')}</option>`).join('')}
          </select>
        </div>

        <div class="opt-row">
          <span class="grow">
            <span class="row" style="gap:6px"><b style="font-size:13px">Use existing authenticated session</b>
              <span class="subtle" title="Restores the saved storage state so you start logged in">${icon('info', 'i-sm')}</span></span>
            <div class="meta">${appSaved ? `A saved login for ${esc(appDef.label)} is available.`
              : `No saved login for ${esc(appDef.label)} yet — it will sign in with credentials.local.env.`}</div>
          </span>
          <label class="switch"><input type="checkbox" data-act="rec-form" data-key="useSession"
            ${S.recForm.useSession ? 'checked' : ''} ${appDef.auth ? '' : 'disabled'} aria-label="Use existing authenticated session"><span></span></label>
        </div>
        <div class="opt-row" title="Not captured in this version">
          <span class="grow">
            <b style="font-size:13px">Capture network requests <span class="subtle" style="font-weight:400">(optional)</span></b>
            <div class="meta">Not captured in this version.</div>
          </span>
          <label class="switch" title="Not captured in this version">
            <input type="checkbox" disabled aria-label="Capture network requests — not available"><span></span></label>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Before you start</h3></div>
      <div class="card-pad">
        ${[
          ['Make sure your application is running', appBaseUrl(appKey) || 'the configured base URL'],
          ['Login if required', appSaved ? 'A saved session will be restored for you.' : 'It will sign in with credentials.local.env.'],
          ['Perform the complete workflow', 'From the first click to the broken result.'],
          ["We'll capture your actions automatically", 'Each action is stored with ranked locators.'],
        ].map(([t, d]) => `
          <div class="row" style="align-items:flex-start; gap:10px; margin-bottom:14px">
            <span class="st-ok" style="margin-top:1px">${icon('check-circle')}</span>
            <span><div style="font-size:13px; font-weight:500">${esc(t)}</div><div class="meta">${esc(d)}</div></span>
          </div>`).join('')}
        <button class="btn btn-primary btn-lg btn-block" data-act="launch-recording" style="margin-top:6px"
                ${S.launching ? 'disabled' : ''}>
          ${S.launching ? icon('refresh', 'spinner') : icon('record')}${S.launching
            ? 'Starting the browser…' : 'Launch Browser &amp; Start Recording'}
        </button>
        <div class="meta" style="text-align:center; margin-top:8px">Recording always runs headed so you can drive it.</div>
      </div>
    </div>
  </div>`;
}

/**
 * The identity engine has to attach to the recorded page before it can fingerprint an element.
 * When it did not, every locator captured in this session is a weak one — say so, loudly, while
 * there is still time to start over rather than after the replay fails.
 */
function captureWarning(rec) {
  const relevant = ['recording', 'stopping', 'stopped'].includes(rec.status) || !!rec.paused;
  if (!relevant || rec.captureReady !== false) return '';
  return `<div class="note warn" role="alert" style="margin-bottom:14px">${icon('alert', 'i-sm')}
    <span><b>Identity capture is not attached.</b> Every locator recorded in this session is a weak one,
    so a replay is likely to miss the element after your markup changes. Stop this recording, restart the
    recorder service, and record the workflow again.</span></div>`;
}

/**
 * A paused recorder looks exactly like a running one from inside the Chromium window — the
 * browser still responds, nothing says "off". Someone who does not notice will drive the whole
 * reproduction, capture none of it, and blame us. So the banner is an alert, it is the first
 * thing on the page, and it carries the way out of the state it is warning about.
 */
function pausedBanner(rec) {
  if (!rec.paused || rec.status !== 'recording') return '';
  return `
  <div class="note warn paused-banner" role="alert" style="margin-bottom:14px">
    ${icon('pause', 'i-sm')}
    <span class="grow"><b>Recording is paused — nothing is being captured.</b>
      Anything you do in the browser window right now is lost. Resume before you carry on with
      the workflow you are trying to reproduce.</span>
    <button class="btn btn-sm btn-primary" data-act="resume-rec" ${S.pausing ? 'disabled' : ''}>
      ${icon('play', 'i-sm')}${S.pausing ? 'Resuming…' : 'Resume'}
    </button>
  </div>`;
}

/* ── Screen 4 — Live ───────────────────────────────────────────────────── */
function viewRecordLive() {
  const rec = S.rec;
  const steps = rec.steps || [];
  const starting = rec.status === 'starting';
  const paused = !!rec.paused;
  // The button says what the NEXT press does, and it is the recorder's own `paused` flag that
  // decides which — never a local guess made when the request went out.
  // `long` is off in the narrow layout: two full-width buttons share 320px there, and a nowrap
  // "Pause Recording" beside "Stop Recording" does not fit on that line.
  const pauseBtn = (extra, long) => `
    <button class="btn ${extra || ''}" data-act="${paused ? 'resume-rec' : 'pause-rec'}"
            ${starting || S.pausing ? 'disabled' : ''}>
      ${icon(paused ? 'play' : 'pause', 'i-sm')}${S.pausing
        ? (paused ? 'Resuming…' : 'Pausing…')
        : (paused ? 'Resume' : 'Pause') + (long ? ' Recording' : '')}
    </button>`;
  const baseUrl = rec.baseUrl || appBaseUrl(rec.app);
  const lastStep = steps.length ? steps[steps.length - 1] : null;
  const currentUrl = (lastStep && (lastStep.url || lastStep.at)) || baseUrl;
  const stateWord = starting ? 'Starting…' : paused ? 'Paused' : 'Recording…';
  const stateGlyph = starting ? icon('refresh', 'i-lg spinner')
    : paused ? icon('pause', 'i-lg') : '<span class="livedot"></span>';

  const stepsCard = `
    <div class="card">
      <div class="card-head"><h3>Live Steps <span class="count muted">(${steps.length})</span></h3>
        ${steps.length ? `<span class="meta">${paused ? 'paused — not growing' : 'newest last'}</span>` : ''}</div>
      ${steps.length ? renderStepList(steps, S.recSel, 'rec', { showTime: true, reorder: false }) : `
        <div class="empty-sm" style="padding:40px 16px">
          ${starting ? 'Starting the browser…'
            : paused ? 'No steps yet — and none will be captured until you resume.'
            : 'No steps yet — click something in the recorded window.'}
        </div>`}
    </div>`;

  const sessionCard = `
    <div class="card" id="recSession">
      <div class="card-head"><h3>Live Browser Session</h3><span class="pill ${starting ? '' : paused ? 'block' : 'run'}"><span class="dot"></span>${starting ? 'Opening' : paused ? 'Paused — not capturing' : 'Attached'}</span></div>
      <div class="card-pad">
        <div class="browserframe">
          <div class="browserbar">
            <span class="dots"><i></i><i></i><i></i></span>
            <span class="url truncate" title="${esc(currentUrl)}">${esc(currentUrl || 'about:blank')}</span>
          </div>
          <div class="browserbody">
            <span class="tile blue" style="width:44px;height:44px">${icon('window', 'i-lg')}</span>
            <div>
              <div style="font-weight:600; font-size:13.5px">The recorded browser is a separate window</div>
              <div class="meta" style="margin-top:4px; max-width:320px">
                We cannot stream its viewport into this page, so this panel mirrors the session state instead.
                Switch to the Chromium window to carry on.
              </div>
            </div>
          </div>
        </div>
        <dl class="kv kv-mid" style="margin-top:14px">
          <dt>Application</dt><dd>${esc(appLabel(rec.app))}</dd>
          <dt>Base URL</dt><dd class="mono" style="word-break:break-all">${esc(baseUrl || '—')}</dd>
          <dt>Current URL</dt><dd class="mono" style="word-break:break-all">${esc(currentUrl || '—')}</dd>
          <dt>Last action</dt><dd>${lastStep ? esc(stepActionLabel(lastStep) + ' — ' + stepTarget(lastStep)) : '<span class="subtle">none yet</span>'}</dd>
          <dt>Captured</dt><dd>${steps.length} ${steps.length === 1 ? 'step' : 'steps'}</dd>
        </dl>
      </div>
    </div>`;

  /* ── Narrow: status bar, the newest step, the list, Pause/Stop pinned. ── */
  if (isNarrow()) {
    return `
    <div class="card card-pad row wrap recbar${paused ? ' is-paused' : ''}" role="status">
      ${stateGlyph}
      <b>${esc(starting ? 'Starting' : paused ? 'Paused — not capturing' : 'Recording')}</b>
      <span class="mono tnum recbar-time" data-elapsed="${esc(rec.startedAt || '')}" data-long>00:00:00</span>
      <span class="grow"></span>
      <span class="pill">${steps.length} ${steps.length === 1 ? 'step' : 'steps'}</span>
      <button class="btn btn-sm" data-act="toggle-rec-session" aria-expanded="${S.recPanelOpen}" aria-controls="recSession">
        ${icon('window', 'i-sm')}${S.recPanelOpen ? 'Hide session' : 'Session'}
      </button>
    </div>

    ${pausedBanner(rec)}
    ${captureWarning(rec)}

    <div class="card rec-current" style="margin-bottom:14px">
      <div class="card-head"><h3>${lastStep ? 'Most recent step' : 'Nothing captured yet'}</h3>
        ${lastStep ? `<span class="meta tnum">${steps.length}</span>` : ''}</div>
      ${lastStep ? `
        <div class="list-row">
          <span class="tile sq ${stepIconTint(lastStep.type)}">${icon(stepIcon(lastStep.type), 'i-sm')}</span>
          <span class="grow">
            <div class="nm truncate">${esc(stepActionLabel(lastStep))}</div>
            <div class="ds truncate" title="${esc(stepTarget(lastStep))}">${esc(stepTarget(lastStep))}</div>
            ${stepDetail(lastStep) ? `<div class="meta truncate">${esc(stepDetail(lastStep))}</div>` : ''}
          </span>
        </div>` : `
        <div class="empty-sm">${starting
          ? 'Starting the browser… Chromium is opening and the app is loading.'
          : paused ? 'Paused — switch back and resume before you carry on.'
          : 'Switch to the recorded window and click something.'}</div>`}
    </div>

    ${S.recPanelOpen ? sessionCard : ''}

    <div style="margin-top:14px">${stepsCard}</div>

    <div class="rec-actions row">
      ${pauseBtn('btn-lg grow' + (paused ? ' btn-primary' : ''))}
      <button class="btn btn-lg btn-danger grow" data-act="stop-rec" ${starting ? 'disabled' : ''}>
        ${icon('stop', 'i-sm')}Stop Recording
      </button>
    </div>`;
  }

  /* ── Wide: the two-pane layout, unchanged. ── */
  return `
  <div class="page-head">
    <div>
      <h1 class="row" style="gap:10px">
        ${stateGlyph}
        ${esc(stateWord)}
        <span class="mono tnum recbar-time" data-elapsed="${esc(rec.startedAt || '')}" data-long>00:00:00</span>
      </h1>
      <div class="sub">${starting
        ? 'Starting the browser — Chromium is opening and the app is loading. This takes a few seconds.'
        : paused ? 'Capture is off. The browser still works, but nothing you do there is being recorded.'
        : "Perform your workflow in the browser. We're capturing your actions."}</div>
    </div>
    <div class="row">
      <!-- The recording happens in a SEPARATE Chromium window that you are busy driving, so this
           page is behind it and you cannot see what is being captured without alt-tabbing away
           from the very thing you are recording. The panel is a narrow window meant to sit
           beside the app. Named window, so pressing this twice refocuses it rather than
           opening a second one. -->
      <button class="btn u-desktop-only" data-act="open-panel"
              aria-label="Open the recorder panel in a separate window">
        ${icon('sidebar', 'i-sm')}Recorder Panel
      </button>
      ${pauseBtn(paused ? 'btn-primary' : '', true)}
      <button class="btn btn-danger" data-act="stop-rec" ${starting ? 'disabled' : ''}>${icon('stop', 'i-sm')}Stop Recording</button>
    </div>
  </div>
  ${stepper('record')}
  ${pausedBanner(rec)}
  ${captureWarning(rec)}

  <div class="split">
    ${stepsCard}
    ${sessionCard}
  </div>`;
}

/* ── Screen 5 — Review & Edit Steps ────────────────────────────────────── */
function viewReview() {
  const steps = S.rec.steps || [];
  const durationMs = (S.rec.startedAt && S.rec.stoppedAt)
    ? new Date(S.rec.stoppedAt) - new Date(S.rec.startedAt) : null;

  return `
  <div class="page-head">
    <div>
      <h1>Review &amp; Edit Steps</h1>
      <div class="sub">Check what was captured, fix any value, then save.</div>
    </div>
    <div class="row wrap">
      <span class="pill">${steps.length} steps</span>
      ${durationMs != null ? `<span class="pill">${esc(fmtDuration(durationMs))}</span>` : ''}
      <button class="btn" data-act="discard-draft">Discard</button>
      <button class="btn btn-primary" data-act="goto-save" ${steps.length ? '' : 'disabled'}>
        Continue${icon('arrow-right', 'i-sm')}
      </button>
    </div>
  </div>
  ${stepper('review')}
  ${captureWarning(S.rec)}
  ${steps.length ? stepPanes(steps, S.recSel, 'rec') : `<div class="card empty-sm" style="padding:44px 16px">
      Nothing was captured. <button class="btn btn-sm" data-act="discard-draft">Start over</button></div>`}`;
}

/**
 * The step list beside the Step Details panel, shared by Review and Test detail.
 * On a wide screen the details are a side panel. Below the mobile breakpoint the same markup
 * becomes a bottom sheet (`.sheet` / `.sheet-open`) that only appears once a step is picked.
 */
function stepPanes(steps, selectedKey, scope) {
  const selected = findStep(steps, selectedKey);
  const index = indexOfStep(steps, selectedKey);
  const asSheet = isNarrow() && S.sheetOpen && !!selected;
  return `
  <div class="split">
    <div class="card">
      <div class="card-head"><h3>Steps</h3>
        <span class="row" style="gap:var(--sp-2)">
          <span class="meta">${steps.length}</span>
          ${insertWaitButton(steps, index)}
        </span>
      </div>
      ${renderStepList(steps, selectedKey, scope)}
    </div>
    <div class="card sheet${asSheet ? ' sheet-open' : ''}" id="stepSheet"
         role="${asSheet ? 'dialog' : 'group'}"${asSheet ? ' aria-modal="true"' : ''} aria-label="Step details">
      <span class="u-mobile-only"><button class="btn-icon sheet-close" id="sheetClose" data-act="close-sheet"
              title="Close step details" aria-label="Close step details">${icon('x', 'i-sm')}</button></span>
      ${stepDetailsPanel(selected, index, scope)}
    </div>
  </div>`;
}

/**
 * Where an inserted wait lands, in one phrase. A wait exists to delay whatever comes next, so it
 * goes BEFORE the step the user is pointing at — the selected one, which is also the step the
 * details panel is showing. With nothing selected there is no "next", so it appends.
 * The phrase is used verbatim in the button's accessible name, the menu heading and the
 * announcement, so the promise made before the click is the sentence read out after it.
 */
function insertWaitWhere(steps, index) {
  return index >= 0 && index < steps.length ? `before step ${index + 1}` : 'at the end of the test';
}

/** The control that offers the two kinds of wait. Disabled-free: appending is always valid. */
function insertWaitButton(steps, index) {
  const where = insertWaitWhere(steps, index);
  return `<button class="btn btn-sm" data-act="insert-wait-menu" data-index="${index}"
            aria-haspopup="menu" aria-label="Insert a wait ${esc(where)}" title="Insert a wait ${esc(where)}">
            ${icon('clock', 'i-sm')}Insert wait</button>`;
}

/**
 * Move a step one place up or down. Buttons, not drag: the list is read on a phone as often as on
 * a laptop, and a drag handle is unusable with a screen reader or a thumb. Disabled at the ends
 * rather than hidden, so the control does not shift position as the row travels.
 * The id is keyed on the STEP, not its index, so `render()` hands focus back to the same button
 * after the move and a second press keeps moving the same step.
 */
function moveButtons(scope, key, index, total) {
  const first = index === 0;
  const last = index === total - 1;
  const btn = (dir, up) => `
    <button class="btn-icon s-move" id="mv-${esc(scope)}-${esc(key)}-${dir}"
            data-act="move-step" data-scope="${esc(scope)}" data-key="${esc(key)}" data-delta="${up ? -1 : 1}"
            ${(up ? first : last) ? 'disabled' : ''}
            aria-label="Move step ${index + 1} ${up ? 'up' : 'down'}"
            title="Move ${up ? 'up' : 'down'}">${icon('chevron-down', 'i-sm' + (up ? ' flip-y' : ''))}</button>`;
  return btn('up', true) + btn('down', false);
}

/** The numbered step rows. `runSteps` decorates them during a replay. */
function renderStepList(steps, selectedKey, scope, opts) {
  const options = opts || {};
  // Reorder is for a list that is finished being written: Review and the saved test's Steps tab.
  // While the recorder is still running, S.rec.steps is replaced wholesale by the next snapshot,
  // so a move made there would silently undo itself on the very next click in the browser.
  const canReorder = options.reorder !== false && scope !== 'run';
  if (!steps || !steps.length) return `<div class="empty-sm">No steps.</div>`;
  const byIndex = {};
  (options.runSteps || []).forEach((rs) => { byIndex[rs.index] = rs; });

  return `<ol class="steps" role="listbox" aria-label="Steps">` + steps.map((s, i) => {
    const key = keyOf(s, i);
    const rs = byIndex[i + 1];
    const status = rs ? rs.status : null;
    const shaky = !!(s.warnings && s.warnings.length) || (s.locatorSummary && s.locatorSummary.verified === false);
    const detail = stepDetail(s);
    return `
      <li class="step ${status ? 'st-' + esc(status) : ''}" role="option" tabindex="0"
          aria-selected="${key === selectedKey}" data-act="select-step" data-scope="${esc(scope)}" data-key="${esc(key)}">
        <span class="s-num">${status ? runGlyph(status) : String(i + 1).padStart(2, '0')}</span>
        <span class="tile sq ${stepIconTint(s.type)}" style="width:24px;height:24px">${icon(stepIcon(s.type), 'i-sm')}</span>
        <span style="min-width:0">
          <span class="s-act">${esc(stepActionLabel(s))}</span>${s.recordedIdle
            ? `<span class="tag s-badge" title="The recorder captured this pause because the page went quiet here — you did not add it">recorded pause</span>` : ''}
          <div class="s-tgt truncate" title="${esc(stepTarget(s))}">${esc(stepTarget(s))}</div>
          ${detail ? `<div class="s-sub truncate" title="${esc(detail)}">${esc(detail)}</div>` : ''}
          ${rs && rs.note ? `<div class="s-sub" style="color:var(--warning)">${esc(rs.note)}</div>` : ''}
        </span>
        <span class="s-right">
          ${rs && rs.ms != null ? `<span class="s-ms">${esc(fmtDuration(rs.ms))}</span>` : ''}
          ${options.showTime && s.at ? '' : ''}
          ${shaky ? `<span class="s-warn" title="${esc((s.warnings || []).join(' · ') || 'The locator was not verified at record time')}">${icon('alert', 'i-sm')}</span>` : ''}
          ${canReorder ? moveButtons(scope, key, i, steps.length) : ''}
          ${scope !== 'run' ? `<button class="btn-icon s-del danger" data-act="delete-step" data-scope="${esc(scope)}" data-key="${esc(key)}"
             aria-label="Delete step ${i + 1}" title="Delete this step">${icon('x', 'i-sm')}</button>` : ''}
        </span>
      </li>`;
  }).join('') + '</ol>';
}

function runGlyph(status) {
  if (status === 'passed')  return `<svg class="i i-sm st-ok" role="img" aria-label="passed"><use href="#i-check"/></svg>`;
  if (status === 'failed')  return `<svg class="i i-sm st-bad" role="img" aria-label="failed"><use href="#i-x"/></svg>`;
  if (status === 'running') return `<svg class="i i-sm spinner" style="color:var(--accent)" role="img" aria-label="running"><use href="#i-refresh"/></svg>`;
  if (status === 'skipped') return `<svg class="i i-sm subtle" role="img" aria-label="skipped"><use href="#i-minus"/></svg>`;
  return `<svg class="i i-sm subtle" role="img" aria-label="pending"><use href="#i-circle"/></svg>`;
}

/* ── Step Details panel ────────────────────────────────────────────────── */
function stepDetailsPanel(step, index, scope) {
  if (!step) {
    return `<div class="empty-sm" style="padding:44px 16px">
      ${icon('target', 'i-lg subtle')}<div style="margin-top:8px">Select a step to see how it will be found.</div></div>`;
  }
  const target = step.target || null;
  const fp = target && target.fingerprint ? target.fingerprint : null;
  const summary = step.locatorSummary || {};
  const candidates = (target && target.candidates) || [];
  const primaryStrategy = (target && target.primary && target.primary.strategy) || summary.strategy;
  const primaryIndex = Math.max(0, candidates.findIndex((c) => c.strategy === primaryStrategy));
  const primary = candidates[primaryIndex] || null;
  const fallbacks = candidates.filter((c, i) => i !== primaryIndex);
  const confidence = summary.score != null ? summary.score : (primary && primary.score);
  const key = editableKey(step);
  const editable = S.inspEdit;
  const targetless = isTargetless(step);

  const head = `
    <div class="card-head">
      <h3>Step Details <span class="muted" style="font-weight:400">· ${index + 1}</span></h3>
      <div class="row">
        <button class="btn btn-sm ${editable ? 'btn-primary' : ''}" data-act="toggle-insp-edit">
          ${icon('pencil', 'i-sm')}${editable ? 'Done' : 'Edit'}
        </button>
        <button class="btn-icon danger" data-act="delete-step" data-scope="${esc(scope)}" data-key="${esc(keyOf(step, index))}"
                aria-label="Delete this step" title="Delete this step">${icon('trash', 'i-sm')}</button>
      </div>
    </div>`;

  // A wait resolves no element, so every section below this point would be an empty box with a
  // heading — "Target Element" with nothing in it reads as a step whose target we LOST. Show
  // what the step actually is instead: how long it waits, and whether that is editable.
  if (targetless) return head + waitSection(step, index, scope, key, editable);

  return head + `
    <div class="insp-sec">
      <div class="field-row">
        <label class="label" for="inspAction">Action</label>
        <select class="field" id="inspAction" disabled title="The action type is fixed at record time — re-record to change it">
          <option>${esc(stepActionLabel(step))}</option>
        </select>
      </div>
      <div class="field-row">
        <label class="label" for="inspTarget">Target Element</label>
        <input class="field" id="inspTarget" value="${esc(stepTarget(step))}" readonly
               title="Editing the target is not supported — re-record the step to change what it points at">
      </div>
      ${key ? `
        <div class="field-row" style="margin-bottom:0">
          <label class="label" for="inspValue">${esc(key === 'url' ? 'URL' : key === 'key' ? 'Key' : key === 'text' ? 'Expected text' : 'Value')}</label>
          <input class="field" id="inspValue" value="${esc(step[key] == null ? '' : step[key])}" ${editable ? '' : 'readonly'}
                 data-act="edit-step-value" data-scope="${esc(scope)}" data-key="${esc(keyOf(step, index))}" data-field="${esc(key)}">
          <div class="meta">${editable ? 'Saved with the test; the description is recomputed on save.' : 'Press Edit to change this value.'}</div>
        </div>` : ''}
    </div>

    <div class="insp-sec">
      <h4>Locator (Primary)</h4>
      ${summary.primary ? `
        <div class="code-line">
          <code>${esc(summary.primary)}</code>
          <button class="btn-icon" data-act="copy" data-copy="${esc(summary.primary)}" aria-label="Copy locator" title="Copy">${icon('copy', 'i-sm')}</button>
        </div>` : `<div class="note info">${icon('info', 'i-sm')}<span>No locator summary was recorded for this step.</span></div>`}
      ${confidence != null ? `<div style="margin-top:10px">
        <span class="pill ${confidence >= 70 ? 'pass' : confidence >= 40 ? 'block' : 'fail'}">
          ${icon('shield', 'i-sm')}Confidence ${esc(confidence)}%</span>
        ${summary.verified === false ? `<span class="pill block" style="margin-left:6px">not verified at record time</span>` : ''}
      </div>` : ''}
    </div>

    ${fallbacks.length ? `
    <div class="insp-sec">
      <h4>Fallback Locators (${fallbacks.length})</h4>
      ${fallbacks.map((c, i) => {
        const rejected = !!c.rejected;
        const ambiguous = !rejected && ((c.matches != null && c.matches !== 1) || c.verified === false || c.correct === false);
        return `
        <div class="fallback ${rejected ? 'bad' : ambiguous ? 'warnb' : ''}">
          <span class="rk">${i + 1}</span>
          <span style="min-width:0; flex:1">
            <code><b>${esc(c.strategy)}:</b> ${esc(candidateExpression(c))}</code>
            <div class="why">${esc(c.why || '')}${c.score != null ? ` · score ${esc(c.score)}` : ''}</div>
            ${rejected ? `<div class="why st-bad">${icon('x-circle', 'i-sm')} ${esc(c.rejected)}</div>`
              : ambiguous ? `<div class="why st-warn">${icon('alert', 'i-sm')} ${c.matches != null && c.matches !== 1 ? esc(c.matches) + ' matches' : 'not verified'}</div>`
              : `<div class="why st-ok">${icon('check-circle', 'i-sm')} verified · 1 match</div>`}
          </span>
        </div>`;
      }).join('')}
    </div>` : ''}

    ${fp ? elementSection(fp) : target ? legacyTargetSection(target) : ''}
    ${fp && fp.context ? contextSection(fp) : ''}
    ${fp ? distrustSection(fp) : ''}
    ${(step.warnings && step.warnings.length) ? `
      <div class="insp-sec"><h4>Warnings</h4>
        ${step.warnings.map((w) => `<div class="note warn">${icon('alert', 'i-sm')}<span>${esc(w)}</span></div>`).join('')}
      </div>` : ''}`;
}

/**
 * The whole details panel for a step that waits rather than acts. `wait` is the only one whose
 * number is ours to change — a network wait ends when the page goes quiet, and its timeout is a
 * safety net the recorder chose, not a duration to tune here.
 */
function waitSection(step, index, scope, key, editable) {
  const isFixed = step.type === 'wait';
  return `
    <div class="insp-sec">
      <div class="field-row">
        <label class="label" for="inspAction">Action</label>
        <select class="field" id="inspAction" disabled title="The action type is fixed at record time — re-record to change it">
          <option>${esc(actionLabel(step.type))}</option>
        </select>
      </div>
      ${isFixed ? `
        <div class="field-row" style="margin-bottom:0">
          <label class="label" for="inspValue">Wait for (milliseconds)</label>
          <input class="field" id="inspValue" type="number" min="0" step="50" inputmode="numeric"
                 value="${esc(step.ms == null ? '' : step.ms)}" ${editable ? '' : 'readonly'}
                 data-act="edit-step-value" data-scope="${esc(scope)}" data-key="${esc(keyOf(step, index))}" data-field="ms">
          <div class="meta">${editable
            ? `The replay pauses for ${esc(stepDuration(step.ms || 0))} here. Saved with the test.`
            : `The replay pauses for ${esc(stepDuration(step.ms || 0))} here. Press Edit to change it.`}</div>
        </div>` : `
        <div class="field-row" style="margin-bottom:0">
          <label class="label" for="inspValue">Gives up after</label>
          <input class="field" id="inspValue" value="${esc(step.timeoutMs != null ? stepDuration(step.timeoutMs) : 'the replay default')}" readonly
                 title="The timeout is a safety net, not a duration to tune — re-record to change it">
          <div class="meta">Waits until the page stops fetching, then carries on.</div>
        </div>`}
    </div>

    ${step.recordedIdle ? `
    <div class="insp-sec">
      <h4>Where this came from</h4>
      <div class="note info">${icon('clock', 'i-sm')}<span><b>The recorder added this pause.</b>
        The page went quiet for this long while you were recording, so the replay is given the same
        room. A wait you added by hand carries no such badge — that is the one to reach for first
        if you are trimming the test.</span></div>
    </div>` : ''}

    <div class="insp-sec">
      <h4>Why there is no locator</h4>
      <div class="note info">${icon('info', 'i-sm')}<span>${isFixed
        ? 'A fixed wait touches no element, so there is nothing to find and nothing that can go stale.'
        : 'This step waits on network activity, not on an element, so it has no locator to rank.'}</span></div>
    </div>`;
}

/** A readable one-liner for a candidate's params. */
function candidateExpression(c) {
  const p = c.params || {};
  if (p.role) return `role: ${p.role}${p.name ? `, name: ${JSON.stringify(p.name)}` : ''}${p.exact ? ', exact' : ''}`;
  if (p.value != null) return String(p.value);
  const keys = Object.keys(p);
  if (!keys.length) return c.strategy;
  return keys.map((k) => `${k}: ${p[k]}`).join(', ');
}

function elementSection(fp) {
  const attrs = fp.attrs || {};
  const attrKeys = Object.keys(attrs);
  const state = fp.state || {};
  return `
  <div class="insp-sec">
    <h4>Element</h4>
    <dl class="kv">
      <dt>Tag</dt><dd>${fp.tag ? `<span class="tag">${esc(fp.tag)}</span>` : '—'}</dd>
      <dt>Role</dt><dd>${fp.role ? `<span class="tag">${esc(fp.role)}</span>` : '<span class="subtle">none</span>'}</dd>
      <dt>Name</dt><dd>${fp.name ? esc(fp.name) : '<span class="subtle">no accessible name</span>'}</dd>
      <dt>Name from</dt><dd>${fp.nameSource ? esc(fp.nameSource) : '<span class="subtle">—</span>'}</dd>
      <dt>Own text</dt><dd>${fp.text ? esc(fp.text) : '<span class="subtle">—</span>'}</dd>
    </dl>
    ${attrKeys.length ? `<div class="row wrap" style="gap:5px; margin-top:10px">
      ${attrKeys.map((k) => `<span class="tag">${esc(k)}="${esc(attrs[k])}"</span>`).join('')}</div>` : ''}
    ${(fp.labels && fp.labels.length) ? `<div class="meta" style="margin-top:8px">Labelled by: ${esc(fp.labels.join(', '))}</div>` : ''}
    ${fp.siblings ? `<div class="meta" style="margin-top:8px">On the page at record time:
      ${esc(fp.siblings.sameRoleAndName)} with this role+name · ${esc(fp.siblings.sameText)} with this text ·
      ${esc(fp.siblings.sameTag)} of this tag</div>` : ''}
    ${(state.visible === false || state.enabled === false) ? `<div class="note warn" style="margin-top:10px">
      ${icon('alert', 'i-sm')}<span>Recorded while ${state.visible === false ? 'not visible' : ''}${
        state.visible === false && state.enabled === false ? ' and ' : ''}${state.enabled === false ? 'disabled' : ''}.</span></div>` : ''}
  </div>`;
}

function legacyTargetSection(target) {
  const by = target.by;
  if (!by) return '';
  const shape = typeof by === 'string' ? Object.assign({ by }, target) : by;
  const entries = Object.entries(shape).filter(([k, v]) => k !== 'candidates' && v != null && v !== '');
  return `
  <div class="insp-sec">
    <h4>Element</h4>
    <div class="note info" style="margin-bottom:10px">${icon('info', 'i-sm')}
      <span>Legacy target, no fingerprint recorded. Re-record this test to get the full analysis.</span></div>
    <dl class="kv">${entries.map(([k, v]) =>
      `<dt>${esc(k)}</dt><dd class="mono" style="word-break:break-all">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl>
  </div>`;
}

function contextSection(fp) {
  const ctx = fp.context || {};
  const ancestors = ctx.ancestors || [];
  if (!ancestors.length && !ctx.heading && !ctx.landmark && !ctx.list) return '';
  const crumbs = ancestors.slice().sort((a, b) => (b.depth || 0) - (a.depth || 0))
    .map((a) => a.name || a.testid || a.id || a.tag)
    .concat([fp.name || fp.tag || 'element']);
  return `
  <div class="insp-sec">
    <h4>Context</h4>
    <div class="crumb">${crumbs.map((c, i) =>
      `${i ? icon('chevron-right', 'i-sm') : ''}${i === crumbs.length - 1 ? `<b>${esc(c)}</b>` : esc(c)}`).join('')}</div>
    ${(ctx.heading || ctx.landmark || ctx.list) ? `<dl class="kv" style="margin-top:10px">
      ${ctx.heading ? `<dt>Heading</dt><dd>${esc(ctx.heading)}</dd>` : ''}
      ${ctx.landmark ? `<dt>Landmark</dt><dd>${esc(ctx.landmark)}</dd>` : ''}
      ${ctx.list ? `<dt>List</dt><dd>${esc(typeof ctx.list === 'object' ? JSON.stringify(ctx.list) : ctx.list)}</dd>` : ''}
    </dl>` : ''}
  </div>`;
}

function distrustSection(fp) {
  const volatile = fp.volatile || {};
  const keys = Object.keys(volatile);
  if (!keys.length && !fp.blindSpot) return '';
  return `
  <div class="insp-sec">
    <h4>Signals we distrust</h4>
    ${fp.blindSpot ? `<div class="note warn" style="margin-bottom:${keys.length ? '10px' : '0'}">
      ${icon('alert', 'i-sm')}<span><b>Blind spot.</b> ${esc(fp.blindSpot)}</span></div>` : ''}
    ${keys.length ? `<dl class="kv kv-narrow">
      ${keys.map((k) => `<dt>${esc(k)}</dt><dd class="muted">${esc(volatile[k])}</dd>`).join('')}</dl>` : ''}
  </div>`;
}

/* ── Screen 6 — Save Test ──────────────────────────────────────────────── */
function viewSaveTest() {
  const steps = S.rec.steps || [];
  const cfg = S.config || {};
  const durationMs = (S.rec.startedAt && S.rec.stoppedAt) ? new Date(S.rec.stoppedAt) - new Date(S.rec.startedAt) : null;
  const f = S.saveForm;

  return `
  <div class="page-head">
    <div><h1>Save Test</h1><div class="sub">Give your test a name and organize it.</div></div>
    <button class="back" data-act="goto-review" style="margin:0">${icon('arrow-left', 'i-sm')}Back to steps</button>
  </div>
  ${stepper('save')}

  <div class="split">
    <div class="card card-pad">
      <div class="field-row">
        <label class="label" for="saveName">Test Name</label>
        <input class="field" id="saveName" data-act="save-form" data-key="name" value="${esc(f.name)}"
               placeholder="Customer save loses the tax code">
      </div>
      <div class="field-row">
        <label class="label" for="saveDesc">Description <span class="subtle">(optional)</span></label>
        <textarea class="field" id="saveDesc" rows="3" data-act="save-form" data-key="description"
                  placeholder="What is broken, and what should happen instead">${esc(f.description)}</textarea>
      </div>
      <div class="field-row">
        <label class="label" for="saveFolder">Folder <span class="subtle">(optional)</span></label>
        <select class="field" id="saveFolder" data-act="save-form" data-key="folder">
          <option value="">No folder</option>
          ${S.folders.map((x) => `<option value="${esc(x)}"${f.folder === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}
        </select>
      </div>
      <div class="field-row">
        <span class="label">Tags</span>
        <div class="row wrap" style="gap:6px">
          ${f.tags.map((tag) => `<span class="chip">${esc(tag)}
            <button data-act="remove-tag" data-tag="${esc(tag)}" aria-label="Remove tag ${esc(tag)}">${icon('x', 'i-sm')}</button></span>`).join('')}
          <input class="field" id="tagDraft" style="width:150px" placeholder="Add a tag…" value="${esc(f.tagDraft)}"
                 data-act="tag-draft" aria-label="Add a tag">
        </div>
        <div class="meta">Press Enter to add.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Test Summary</h3></div>
      <div class="card-pad">
        <div class="row" style="gap:12px; margin-bottom:12px">
          <span class="tile sq">${icon('list', 'i-sm')}</span>
          <span><div style="font-weight:600">${steps.length}</div><div class="meta">steps captured</div></span>
        </div>
        <div class="row" style="gap:12px; margin-bottom:14px">
          <span class="tile sq blue">${icon('clock', 'i-sm')}</span>
          <span><div style="font-weight:600">${esc(durationMs != null ? fmtDuration(durationMs) : '—')}</div><div class="meta">recording length</div></span>
        </div>
        <dl class="kv kv-narrow">
          <dt>Browser</dt><dd>${esc(S.recForm.browser === 'chromium' ? 'Chrome' : S.recForm.browser)} · ${esc(S.recForm.viewport.replace('x', ' × '))}</dd>
          <dt>Base URL</dt><dd class="mono" style="word-break:break-all">${esc(S.rec.baseUrl || appBaseUrl(S.rec.app) || '—')}</dd>
          <dt>Saved to</dt><dd class="mono" style="word-break:break-all">${esc(cfg.testsDir || '—')}</dd>
        </dl>
        <label class="check" style="margin-top:14px">
          <input type="checkbox" data-act="save-form" data-key="runAfter" ${f.runAfter ? 'checked' : ''}>
          <span>Run test after saving</span>
        </label>
      </div>
    </div>
  </div>

  <div class="row" style="justify-content:flex-end; gap:8px; margin-top:18px">
    <button class="btn" data-act="goto-review">Cancel</button>
    <button class="btn btn-primary" data-act="save-draft" ${steps.length && !S.saving ? '' : 'disabled'}>
      ${S.saving ? icon('refresh', 'i-sm spinner') : icon('check', 'i-sm')}${S.saving ? 'Saving test…' : 'Save Test'}
    </button>
  </div>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   VIEW — TEST DETAILS  (Overview / Steps / Executions / Settings)
   ══════════════════════════════════════════════════════════════════════════ */
/* Where the NEXT run happens. Defaults to the environment the test was recorded against, which
   is what every existing caller already did. The reason it exists: you can record a workflow on
   a shared QA box and then replay the same steps against the code running on this machine,
   because steps store {{baseUrl}} rather than an absolute host. */
function runTargetFor(t) {
  const recorded = (t.target && t.target.app) || (S.config && S.config.defaultApp) || '';
  const chosen = S.runTarget;
  const apps = (S.config && S.config.apps) || {};
  return chosen && apps[chosen] ? chosen : recorded;
}
function runTargetPicker(t) {
  const apps = Object.entries((S.config && S.config.apps) || {});
  if (apps.length < 2) return '';
  const current = runTargetFor(t);
  const recorded = (t.target && t.target.app) || '';
  return `
    <label class="sr-only" for="runTarget">Environment to run against</label>
    <select class="field" id="runTarget" data-act="run-target" style="width:auto;max-width:230px"
            title="Which environment to replay against">
      ${apps.map(([key, a]) => `<option value="${esc(key)}"${key === current ? ' selected' : ''}>Run on ${esc(a.label)}${
        key === recorded ? ' (recorded here)' : ''}</option>`).join('')}
    </select>`;
}

function viewTestDetail() {
  const t = S.test;
  if (!t) {
    if (S.testUnavailable[S.route.id] === 'missing') {
      return `<button class="back" data-act="nav" data-href="#/tests">${icon('arrow-left', 'i-sm')}Test Library</button>
        <div class="card empty">
          <h2>That test is not there any more</h2>
          <p>The recorder has no test called <span class="mono">${esc(S.route.id)}</span>. It was probably
            deleted, or renamed on disk.</p>
          <button class="btn btn-primary btn-lg" data-act="nav" data-href="#/tests">${icon('tests')}Back to the library</button>
        </div>`;
    }
    return `<div class="card empty-sm" role="status">${icon('refresh', 'i-sm spinner')} Loading test…</div>`;
  }
  const runs = S.runs[t.id] || [];
  const steps = t.steps || [];

  return `
  <button class="back" data-act="nav" data-href="#/tests">${icon('arrow-left', 'i-sm')}Test Library</button>
  <div class="page-head">
    <div style="min-width:0">
      <h1 class="${isNarrow() ? '' : 'truncate'}">${esc(t.name)}</h1>
      <div class="sub">${esc(t.description || 'No description.')}</div>
    </div>
    <div class="row">
      ${runTargetPicker(t)}
      <button class="btn ${S.testDirty ? '' : 'btn-primary'}" data-act="run-test" data-id="${esc(t.id)}"
              data-app="${esc(runTargetFor(t))}">${icon('play', 'i-sm')}Execute</button>
      <button class="btn" data-act="test-tab" data-tab="steps">${icon('pencil', 'i-sm')}Edit</button>
      <button class="btn-icon" data-act="row-menu" data-id="${esc(t.id)}" aria-label="More actions for ${esc(t.name)}">${icon('dots')}</button>
    </div>
  </div>

  <div class="tabs" role="tablist">
    ${[['overview', 'Overview', ''], ['steps', 'Steps', steps.length], ['executions', 'Executions', runs.length], ['settings', 'Settings', '']]
      .map(([key, label, count]) => `
        <button role="tab" aria-selected="${S.testTab === key}" data-act="test-tab" data-tab="${key}">
          ${esc(label)}${count !== '' ? ` <span class="count">(${esc(count)})</span>` : ''}
        </button>`).join('')}
  </div>

  ${S.testDirty ? `<div class="note warn" style="margin-bottom:14px">${icon('alert', 'i-sm')}
    <span>You have unsaved changes.</span><span class="grow"></span>
    <button class="btn btn-sm btn-primary" data-act="save-test" ${S.saving ? 'disabled' : ''}>
      ${S.saving ? 'Saving test…' : 'Save changes'}</button></div>` : ''}

  ${S.testTab === 'overview' ? testOverview(t, runs)
    : S.testTab === 'steps' ? (steps.length ? stepPanes(steps, S.testSel, 'test') : `<div class="card empty-sm">This test has no steps.</div>`)
    : S.testTab === 'executions' ? testExecutions(t, runs)
    : testSettings(t)}`;
}

function testOverview(t, runs) {
  const created = relTime(t.createdAt), updated = relTime(t.updatedAt);
  const last = runs[0] || (t.lastRun ? { id: t.lastRun.runId, status: t.lastRun.status, startedAt: t.lastRun.at, durationMs: t.lastRun.durationMs } : null);
  return `
  <div class="split">
    <div class="card card-pad">
      <dl class="kv kv-wide">
        <dt>Description</dt><dd>${esc(t.description || '—')}</dd>
        <dt>Total Steps</dt><dd>${(t.steps || []).length}</dd>
        <dt>Created</dt><dd title="${esc(created.title)}">${esc(created.label)}</dd>
        <dt>Last Updated</dt><dd title="${esc(updated.title)}">${esc(updated.label)}</dd>
        <dt>Tags</dt><dd>${(t.tags && t.tags.length)
          ? t.tags.map((x) => `<span class="chip" style="margin:0 4px 4px 0">${esc(x)}</span>`).join('')
          : '<span class="subtle">none</span>'}</dd>
        <dt>Base URL</dt><dd class="mono" style="word-break:break-all">${esc(appBaseUrl(t.target && t.target.app) || '—')}</dd>
        <dt>Folder</dt><dd>${t.folder ? esc(t.folder) : '<span class="subtle">none</span>'}</dd>
      </dl>
    </div>
    <div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h3>Last Execution</h3></div>
        <div class="card-pad">
          ${last ? `<div class="row" style="gap:10px">
              ${statusPill(last.status)}
              <span class="meta">${timeAgo(last.startedAt)}</span>
              <span class="grow"></span>
              ${last.id ? `<button class="btn btn-sm" data-act="open-run" data-test="${esc(t.id)}" data-run="${esc(last.id)}">View</button>` : ''}
            </div>
            <div class="meta" style="margin-top:8px">Duration ${esc(fmtDuration(last.durationMs))}</div>`
          : `<div class="meta">This test has never been executed.</div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Quick Actions</h3></div>
        ${[
          ['play', 'Execute Test', 'run-test', ''],
          ['pencil', 'Edit Test', 'test-tab-steps', ''],
          ['duplicate', 'Duplicate Test', 'duplicate-test', ''],
          ['trash', 'Delete Test', 'delete-test', 'danger'],
        ].map(([ic, label, act, danger]) => `
          <div class="list-row" role="button" tabindex="0" data-act="${act}" data-id="${esc(t.id)}" data-tab="steps">
            <span class="tile sq ${danger ? 'red' : 'grey'}">${icon(ic, 'i-sm')}</span>
            <span class="grow" style="${danger ? 'color:var(--danger)' : ''}">${esc(label)}</span>
            ${icon('chevron-right', 'i-sm subtle')}
          </div>`).join('')}
      </div>
    </div>
  </div>`;
}

function testExecutions(t, runs) {
  if (!runs.length) return `<div class="card empty-sm" style="padding:44px 16px">This test has not been executed yet.</div>`;
  return `
  <div class="card tbl-wrap">
    <table class="tbl tbl-card" aria-label="Runs of this test">
      <thead><tr><th style="width:130px">Status</th><th style="width:120px">Steps</th><th class="col-secondary" style="width:110px">Duration</th>
        <th>Executed At</th><th class="cell-actions" aria-label="Open"></th></tr></thead>
      <tbody>
        ${runs.map((r) => `
          <tr data-act="open-run" data-test="${esc(t.id)}" data-run="${esc(r.id)}" tabindex="0">
            <td data-label="Status">${statusPill(r.status)}</td>
            <td data-label="Steps" class="meta tnum">${esc(r.stepsPassed != null ? r.stepsPassed : '?')}/${esc(r.stepCount != null ? r.stepCount : '?')}</td>
            <td data-label="Duration" class="col-secondary meta tnum">${esc(fmtDuration(r.durationMs))}</td>
            <td data-label="Executed At" class="meta">${timeAgo(r.startedAt)}</td>
            <td class="cell-actions" data-label="" style="text-align:right">${icon('chevron-right', 'i-sm subtle')}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

function testSettings(t) {
  return `
  <div class="card card-pad" style="max-width:600px">
    <div class="field-row">
      <label class="label" for="tName">Test Name</label>
      <input class="field" id="tName" value="${esc(t.name)}" data-act="test-field" data-key="name">
    </div>
    <div class="field-row">
      <label class="label" for="tDesc">Description</label>
      <textarea class="field" id="tDesc" rows="3" data-act="test-field" data-key="description">${esc(t.description || '')}</textarea>
    </div>
    <div class="field-row">
      <label class="label" for="tFolder">Folder</label>
      <select class="field" id="tFolder" data-act="test-field" data-key="folder">
        <option value="">No folder</option>
        ${S.folders.map((x) => `<option value="${esc(x)}"${t.folder === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}
      </select>
    </div>
    <div class="field-row">
      <span class="label">Tags</span>
      <div class="row wrap" style="gap:6px">
        ${(t.tags || []).map((tag) => `<span class="chip">${esc(tag)}
          <button data-act="remove-test-tag" data-tag="${esc(tag)}" aria-label="Remove ${esc(tag)}">${icon('x', 'i-sm')}</button></span>`).join('')}
        <input class="field" id="tTagDraft" style="width:150px" placeholder="Add a tag…" value="${esc(S.testTagDraft)}"
               data-act="test-tag-draft" aria-label="Add a tag">
      </div>
    </div>
    <label class="check" style="margin:6px 0 16px">
      <input type="checkbox" data-act="test-field" data-key="favorite" ${t.favorite ? 'checked' : ''}>
      <span>Show in Favorites</span>
    </label>
    <div class="row" style="justify-content:flex-end; gap:8px">
      <button class="btn btn-danger-outline" data-act="delete-test" data-id="${esc(t.id)}">${icon('trash', 'i-sm')}Delete test</button>
      <button class="btn ${S.testDirty ? 'btn-primary' : ''}" data-act="save-test" ${S.testDirty && !S.saving ? '' : 'disabled'}>
        ${S.saving ? 'Saving test…' : 'Save changes'}
      </button>
    </div>
  </div>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   VIEW — RUN  (progress / passed / blocked / failed)
   ══════════════════════════════════════════════════════════════════════════ */
function viewRun() {
  const { testId, runId } = S.route;
  const run = runId === 'live'
    ? S.live
    : (S.runCache[testId + '/' + runId] || (S.live && S.live.id === runId ? S.live : null));
  if (!run) {
    if (runId !== 'live' && S.runUnavailable[testId + '/' + runId]) {
      return `<button class="back" data-act="nav" data-href="#/test/${esc(testId)}">${icon('arrow-left', 'i-sm')}Test</button>
        <div class="card empty">
          <h2>That result is not there any more</h2>
          <p>The recorder has no run <span class="mono">${esc(runId)}</span> for this test. It was most likely
            deleted with the test, or the run history was cleared.</p>
          <button class="btn btn-primary btn-lg" data-act="nav" data-href="#/executions">${icon('activity')}All executions</button>
        </div>`;
    }
    return `<div class="card empty-sm" role="status">${icon('refresh', 'i-sm spinner')} Loading result…</div>`;
  }

  const back = `<button class="back" data-act="nav" data-href="#/test/${esc(run.testId)}">${icon('arrow-left', 'i-sm')}${esc(run.testName || 'Test')}</button>`;
  if (!run.done) return back + viewRunProgress(run);
  if (run.status === 'passed') return back + viewRunPassed(run);
  if (run.status === 'blocked') return back + viewRunBlocked(run);
  return back + viewRunFailed(run);
}

function phaseLine(run) {
  if (run.phase === 'preflight') return 'Checking the app is up and signing in…';
  if (run.status === 'starting') return 'Starting the browser…';
  const total = run.stepCount || (run.steps || []).length || 0;
  const current = run.current != null ? run.current : (run.steps || []).filter((s) => s.status !== 'pending').length;
  return total ? `Executing step ${current} of ${total}…` : 'Executing…';
}

/* ── Screen 8 — Execution running ──────────────────────────────────────── */
function viewRunProgress(run) {
  const steps = run.steps || [];
  const total = run.stepCount || steps.length || 0;
  const finished = steps.filter((s) => s.status === 'passed' || s.status === 'failed').length;
  const pct = total ? Math.min(100, Math.round((finished / total) * 100)) : 8;

  return `
  <div class="page-head">
    <div><h1>Executing Test</h1><div class="sub">${esc(run.testName || run.testId)}</div></div>
    <button class="btn btn-danger-outline" disabled title="Stopping a run is not supported by the recorder service">
      ${icon('stop', 'i-sm')}Stop Execution
    </button>
  </div>

  <div class="card card-pad" style="margin-bottom:16px">
    <div class="progress" style="margin-bottom:10px" role="progressbar" aria-label="Execution progress"
         aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(pct)}"
         aria-valuetext="${esc(phaseLine(run))}"><i style="width:${pct}%"></i></div>
    <div class="spread">
      <span class="meta">${esc(phaseLine(run))}</span>
      <span class="meta">Elapsed <b class="mono tnum" data-elapsed="${esc(run.startedAt || '')}">00:00</b></span>
    </div>
  </div>

  <div class="note info" style="margin-bottom:16px">${icon('info', 'i-sm')}
    <span>The run continues in the background — you can navigate away and come back to it.</span></div>

  <div class="card">
    <div class="card-head"><h3>Steps</h3><span class="meta">${finished}/${total}</span></div>
    ${renderRunSteps(run)}
  </div>`;
}

/**
 * Run steps carry their own text — the engine's describe(), so "Wait 1.2s" already reads right.
 * The fallback is the bare action name on purpose: `ms` on a RUN step is how long the step TOOK,
 * not how long a wait was configured for, so stepActionLabel() would quote the wrong number.
 */
function renderRunSteps(run) {
  const steps = run.steps || [];
  if (!steps.length) return `<div class="empty-sm">Waiting for the first step…</div>`;
  return `<ol class="steps">` + steps.map((s) => `
    <li class="step plain st-${esc(s.status || 'pending')}">
      <span class="s-num">${runGlyph(s.status)}</span>
      <span class="tile sq ${stepIconTint(s.type)}" style="width:24px;height:24px">${icon(stepIcon(s.type), 'i-sm')}</span>
      <span style="min-width:0">
        <span class="s-act">${esc(s.index)}. ${esc(s.text || actionLabel(s.type))}</span>
        ${s.url ? `<div class="s-sub truncate" title="${esc(s.url)}">${esc(s.url)}</div>` : ''}
        ${s.note ? `<div class="s-sub" style="color:var(--warning)">${esc(s.note)}</div>` : ''}
        ${s.resolution && s.resolution.strategy ? `<div class="s-sub">via ${esc(s.resolution.strategy)}${
          s.resolution.confidence != null ? ` · confidence ${esc(s.resolution.confidence)}%` : ''}</div>` : ''}
      </span>
      <span class="s-right">
        ${s.status === 'running' ? `<span style="color:var(--accent)">Running…</span>`
          : s.status === 'pending' ? `<span class="subtle">Pending</span>`
          : s.ms != null ? `<span class="s-ms">${esc(fmtDuration(s.ms))}</span>` : ''}
        ${s.status === 'passed' ? `<span class="dot" style="width:6px;height:6px;border-radius:50%;background:var(--success);display:inline-block"></span>` : ''}
      </span>
    </li>`).join('') + '</ol>';
}

/* ── Screen 9a — Passed ────────────────────────────────────────────────── */
function viewRunPassed(run) {
  const total = run.stepCount || (run.steps || []).length;
  return `
  <div class="res pass" style="margin-bottom:16px">
    <span class="mark">${icon('check', 'i-lg')}</span>
    <div class="grow">
      <h2>Test Passed</h2>
      <div class="muted" style="font-size:13px; margin-top:2px">All ${esc(total)} steps completed successfully.</div>
      ${(run.notes || []).map((n) => `<div class="meta" style="margin-top:4px">${esc(n)}</div>`).join('')}
    </div>
    <div class="row" style="gap:22px; align-items:flex-start">
      <span class="figure"><div class="meta">Duration</div><div class="n">${esc(fmtDuration(run.durationMs))}</div></span>
      <span class="figure"><div class="meta">Finished</div><div class="n">${relTime(run.finishedAt || run.startedAt).label}</div></span>
    </div>
  </div>
  <div class="row wrap" style="margin-bottom:16px">
    <button class="btn" data-act="toggle-steps" aria-expanded="${!!S.runStepsOpen}">${icon('list', 'i-sm')}View Details</button>
    <button class="btn btn-primary" data-act="run-test" data-id="${esc(run.testId)}">${icon('play', 'i-sm')}Run Again</button>
  </div>
  <div class="card">
    <details class="disc" ${S.runStepsOpen ? 'open' : ''} style="border-top:0">
      <summary>${icon('chevron-right', 'i-sm chev')}Steps <span class="meta">(${(run.steps || []).length} with timings)</span></summary>
      <div class="disc-body" style="padding:0 4px 4px">${renderRunSteps(run)}</div>
    </details>
  </div>
  ${evidenceBlocks(run)}`;
}

/* ── Blocked ───────────────────────────────────────────────────────────── */
function viewRunBlocked(run) {
  return `
  <div class="res block" style="margin-bottom:16px">
    <span class="mark">${icon('alert', 'i-lg')}</span>
    <div class="grow">
      <h2>Blocked</h2>
      <div class="muted" style="font-size:13px; margin-top:2px">This is not a test failure — the run could not start properly.</div>
    </div>
    <span class="figure"><div class="meta">Attempted</div><div class="n">${relTime(run.startedAt).label}</div></span>
  </div>
  <div class="card card-pad" style="margin-bottom:16px">
    <h3 style="margin-bottom:8px">Why it was blocked</h3>
    ${run.error ? `<pre class="err" style="background:var(--warning-bg); color:var(--warning)">${esc(run.error)}</pre>` : ''}
    ${(run.notes || []).map((n) => `<div class="note warn" style="margin-top:8px">${icon('info', 'i-sm')}<span>${esc(n)}</span></div>`).join('')}
    <div class="note info" style="margin-top:10px">${icon('info', 'i-sm')}
      <span>Usual causes: the app is not running on its port, or the saved login has expired.
      Start the app, refresh the login, then run again.</span></div>
  </div>
  <div class="row">
    <button class="btn btn-primary" data-act="run-test" data-id="${esc(run.testId)}">${icon('refresh', 'i-sm')}Run Again</button>
    <button class="btn" data-act="nav" data-href="#/test/${esc(run.testId)}">Open test</button>
  </div>
  ${(run.steps || []).length ? `<div class="card" style="margin-top:16px">
    <div class="card-head"><h3>Steps</h3></div>${renderRunSteps(run)}</div>` : ''}
  ${evidenceBlocks(run)}`;
}

/* ── Screen 9b — Failed ────────────────────────────────────────────────── */
function viewRunFailed(run) {
  const total = run.stepCount || (run.steps || []).length;
  const failedIndex = run.failedStep;
  const failedStep = (run.steps || []).find((s) => s.index === failedIndex)
    || (run.steps || []).find((s) => s.status === 'failed');

  const savedTest = S.testCache[run.testId];
  if (!savedTest) ensureTestCached(run.testId);
  const recorded = savedTest && failedStep
    ? (savedTest.steps || []).find((s) => s.id === failedStep.id) || (savedTest.steps || [])[failedIndex - 1]
    : null;

  // Only trust what the run actually recorded. execution.js sets result.screenshot ONLY when
  // page.screenshot() succeeded, so it is null whenever no image was written. Guessing
  // `step-N.png` here fabricated a filename for a file that often does not exist: the request
  // 404'd, the console filled with errors, and "View Screenshot" stayed enabled over a broken
  // image. If the run says there is no screenshot, there is no screenshot.
  const shot = run.screenshot || null;
  const shotUrl = shot
    ? `/api/tests/${encodeURIComponent(run.testId)}/runs/${encodeURIComponent(run.id)}/file/${encodeURIComponent(shot)}`
    : null;
  const shortError = run.error ? String(run.error).split('\n')[0].slice(0, 120) : 'Element not found.';

  return `
  <div class="res fail" style="margin-bottom:16px">
    <span class="mark">${icon('x', 'i-lg')}</span>
    <div class="grow">
      <h2>Test Failed</h2>
      <div class="muted" style="font-size:13px; margin-top:2px">
        Failed at step ${esc(failedIndex || '?')} of ${esc(total)}: ${esc(shortError)}
      </div>
      ${failedStep ? `<div class="meta" style="margin-top:3px">${esc(failedStep.text || actionLabel(failedStep.type))}</div>` : ''}
    </div>
    <div class="row" style="gap:22px; align-items:flex-start">
      <span class="figure"><div class="meta">Duration</div><div class="n">${esc(fmtDuration(run.durationMs))}</div></span>
      <span class="figure"><div class="meta">Finished</div><div class="n">${relTime(run.finishedAt || run.startedAt).label}</div></span>
    </div>
  </div>

  <div class="row wrap" style="margin-bottom:16px">
    <button class="btn" data-act="scroll-to" data-target="errorBlock">${icon('alert', 'i-sm')}View Error</button>
    <button class="btn" ${shotUrl ? `data-act="expand-shot" data-src="${esc(shotUrl)}"` : 'disabled title="No screenshot was captured for this run"'}>
      ${icon('image', 'i-sm')}View Screenshot
    </button>
    <button class="btn" data-act="nav" data-href="#/test/${esc(run.testId)}">${icon('pencil', 'i-sm')}Edit Test</button>
    <button class="btn btn-primary" data-act="run-test" data-id="${esc(run.testId)}">${icon('play', 'i-sm')}Run Again</button>
  </div>

  ${(run.notes || []).map((n) => `<div class="note warn" style="margin-bottom:16px">${icon('info', 'i-sm')}<span>${esc(n)}</span></div>`).join('')}

  <div class="card card-pad" id="errorBlock" style="margin-bottom:16px">
    <h3 style="margin-bottom:8px">Error</h3>
    <pre class="err">${esc(run.error || 'The step did not complete.')}</pre>
  </div>

  ${failedStep && failedStep.resolution ? attemptsBlock(failedStep.resolution) : ''}
  ${recorded ? recordedBlock(recorded)
    : savedTest ? ''
    /* A spinner that can never resolve is a lie. If the fetch has already come back empty -
       the test this run came from has been deleted since - say so instead of "Loading" forever. */
    : S.testUnavailable[run.testId] === 'missing'
      ? `<div class="card empty-sm" style="margin-bottom:16px">What was recorded is not available: the test
         this run came from is no longer in the library.</div>`
      : `<div class="card empty-sm" style="margin-bottom:16px">Loading what was recorded…</div>`}

  <div class="card card-pad" style="margin-bottom:16px">
    <h3 style="margin-bottom:10px">Where it stopped</h3>
    <dl class="kv kv-mid">
      <dt>URL</dt><dd class="mono" style="word-break:break-all">${esc((failedStep && failedStep.url) || run.url || '—')}</dd>
      <dt>Run id</dt><dd class="mono">${esc(run.id || '—')}</dd>
      <dt>Finished</dt><dd>${run.finishedAt ? esc(new Date(run.finishedAt).toLocaleString()) : '—'}</dd>
    </dl>
    ${shotUrl ? `<div style="margin-top:12px">
      <div class="meta" style="margin-bottom:6px">Screenshot at the failing step — click to expand</div>
      <img class="shot" src="${esc(shotUrl)}" alt="Screenshot at step ${esc(failedIndex || '')}"
           data-act="expand-shot" data-src="${esc(shotUrl)}"
           onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'empty-sm',textContent:'No screenshot was captured for this run.'}))">
    </div>` : ''}
  </div>

  <div class="card" style="margin-bottom:16px">
    <div class="card-head"><h3>Steps</h3><span class="meta">${(run.steps || []).length}</span></div>
    ${renderRunSteps(run)}
  </div>
  ${evidenceBlocks(run)}`;
}

function attemptsBlock(resolution) {
  const attempts = resolution.attempts || [];
  const sim = resolution.similarity;
  return `
  <div class="card" style="margin-bottom:16px">
    <div class="card-head">
      <h3>What the locator engine tried</h3>
      ${resolution.confidence != null ? `<span class="meta">confidence ${esc(resolution.confidence)}%</span>` : ''}
    </div>
    ${attempts.length ? `<div class="tbl-wrap">
      <table class="tbl tbl-card" aria-label="Locator strategies tried at the failing step">
        <thead><tr><th style="width:26px" aria-label="Accepted"></th><th style="width:110px">Strategy</th><th>Locator</th>
          <th class="col-tertiary" style="width:80px">Matches</th><th style="width:200px">Outcome</th></tr></thead>
        <tbody>
          ${attempts.map((a) => `
            <tr class="${a.accepted ? 'accepted' : ''}" style="cursor:default">
              <td data-label="Result">${a.accepted
                ? `<span class="st-ok"><svg class="i i-sm" role="img" aria-label="accepted"><use href="#i-check"/></svg></span>`
                : `<span class="st-bad"><svg class="i i-sm" role="img" aria-label="rejected"><use href="#i-x"/></svg></span>`}</td>
              <td data-label="Strategy"><span class="tag">${esc(a.strategy)}</span></td>
              <td data-label="Locator" class="mono">${esc(a.locator || '')}</td>
              <td data-label="Matches" class="col-tertiary tnum">${a.matches != null ? esc(a.matches) : '—'}</td>
              <td data-label="Outcome">${a.accepted
                ? `<span class="st-ok">used${a.similarity != null ? ` · similarity ${esc(a.similarity)}` : ''}</span>`
                : `<span class="st-bad">${esc(a.rejected || 'rejected')}</span>`}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : `<div class="empty-sm">No locator attempts were recorded for this step.</div>`}
    ${sim ? `<div class="card-pad" style="border-top:1px solid var(--border)">
      <div class="meta" style="margin-bottom:6px">Similarity to the recorded element: <b class="tnum">${esc(sim.score)}</b></div>
      <div class="row wrap" style="gap:5px">
        ${(sim.matched || []).map((m) => `<span class="pill pass">${esc(m)}</span>`).join('')}
        ${(sim.differed || []).map((m) => `<span class="pill fail">${esc(m)}</span>`).join('')}
      </div></div>` : ''}
  </div>`;
}

function recordedBlock(step) {
  const fp = step.target && step.target.fingerprint;
  if (!fp) {
    return `<div class="card card-pad" style="margin-bottom:16px">
      <h3 style="margin-bottom:8px">What was recorded</h3>
      <div class="note info">${icon('info', 'i-sm')}<span>Legacy target, no fingerprint recorded. Re-record this test to get the comparison.</span></div>
    </div>`;
  }
  const attrs = fp.attrs || {};
  const idAttr = (S.config && S.config.testIdAttribute) || 'data-testid';
  const testId = attrs[idAttr] || attrs['data-testid'] || attrs['data-test-id'] || null;
  return `
  <div class="card card-pad" style="margin-bottom:16px">
    <h3 style="margin-bottom:10px">What was recorded</h3>
    <dl class="kv kv-mid">
      <dt>Role</dt><dd>${fp.role ? `<span class="tag">${esc(fp.role)}</span>` : '<span class="subtle">none</span>'}</dd>
      <dt>Name</dt><dd>${fp.name ? esc(fp.name) : '<span class="subtle">none</span>'}</dd>
      <dt>Text</dt><dd>${fp.text ? esc(fp.text) : '<span class="subtle">none</span>'}</dd>
      <dt>Test id</dt><dd>${testId ? `<span class="mono">${esc(testId)}</span>` : '<span class="subtle">none</span>'}</dd>
      <dt>Tag</dt><dd><span class="tag">${esc(fp.tag || '?')}</span></dd>
      ${fp.context && fp.context.heading ? `<dt>Under</dt><dd>${esc(fp.context.heading)}</dd>` : ''}
    </dl>
    ${step.locatorSummary && step.locatorSummary.primary ? `<div class="code-line" style="margin-top:12px">
      <code>${esc(step.locatorSummary.primary)}</code>
      <button class="btn-icon" data-act="copy" data-copy="${esc(step.locatorSummary.primary)}" aria-label="Copy locator">${icon('copy', 'i-sm')}</button>
    </div>` : ''}
  </div>`;
}

function evidenceBlocks(run) {
  const consoleErrors = run.consoleErrors || [];
  const networkErrors = run.networkErrors || [];
  if (!consoleErrors.length && !networkErrors.length) return '';
  return `
  <div class="card">
    ${consoleErrors.length ? `<details class="disc" style="border-top:0">
      <summary>${icon('chevron-right', 'i-sm chev')}Console errors <span class="pill fail">${consoleErrors.length}</span></summary>
      <div class="disc-body">${consoleErrors.map((c) => `<div class="code-line" style="margin-bottom:6px"><code>${
        c.step != null ? `<span class="subtle">[step ${esc(c.step)}]</span> ` : ''}${esc(c.text)}</code></div>`).join('')}</div>
    </details>` : ''}
    ${networkErrors.length ? `<details class="disc">
      <summary>${icon('chevron-right', 'i-sm chev')}Failed requests <span class="pill fail">${networkErrors.length}</span></summary>
      <div class="disc-body">${networkErrors.map((n) => `<div class="code-line" style="margin-bottom:6px"><code>${
        n.step != null ? `<span class="subtle">[step ${esc(n.step)}]</span> ` : ''}<b>${esc(n.status || n.error || 'error')}</b> ${esc(n.url)}</code></div>`).join('')}</div>
    </details>` : ''}
  </div>`;
}

function viewLightbox() {
  return `<div class="lightbox" data-act="close-lightbox" role="dialog" aria-label="Screenshot">
    <img src="${esc(S.lightbox)}" alt="Screenshot, expanded"></div>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   OVERLAYS — command palette + small modals + menus
   ══════════════════════════════════════════════════════════════════════════ */
function paletteActions() {
  const actions = [
    { id: 'start-recording', label: 'Start recording', icon: 'record', hint: 'N' },
    { id: 'open-browser', label: 'Open browser', icon: 'window' },
    { id: 'create-test', label: 'Create new test', icon: 'plus' },
    { id: 'import-test', label: 'Import test', icon: 'import' },
    { id: 'goto-tests', label: 'Go to test library', icon: 'tests' },
    { id: 'goto-executions', label: 'View executions', icon: 'activity' },
    { id: 'goto-settings', label: 'Settings', icon: 'settings' },
  ];
  const q = S.paletteQuery.trim().toLowerCase();
  const matched = actions.filter((a) => !q || a.label.toLowerCase().includes(q));
  const tests = q
    ? S.tests.filter((t) => (t.name || '').toLowerCase().includes(q)).slice(0, 6)
        .map((t) => ({ id: 'open:' + t.id, label: t.name, icon: 'tests', group: 'Tests' }))
    : [];
  return matched.map((a) => Object.assign({ group: 'Actions' }, a)).concat(tests);
}

function viewOverlay() {
  if (S.overlay.kind === 'palette') {
    const items = paletteActions();
    if (S.paletteIndex >= items.length) S.paletteIndex = Math.max(0, items.length - 1);
    let lastGroup = null;
    return `
    <div class="overlay" data-act="close-overlay">
      <div class="palette" role="dialog" aria-label="Command palette" data-stop>
        <div class="pinput">
          ${icon('search', 'i-lg subtle')}
          <input id="paletteInput" placeholder="Search tests, actions, settings…" value="${esc(S.paletteQuery)}"
                 data-act="palette-query" autocomplete="off" aria-label="Command palette search">
          <kbd>Esc</kbd>
        </div>
        <div class="plist">
          ${items.length ? items.map((item, i) => {
            const head = item.group !== lastGroup ? `<div class="pgroup">${esc(item.group)}</div>` : '';
            lastGroup = item.group;
            return head + `<button class="pitem" aria-selected="${i === S.paletteIndex}" data-act="palette-run" data-cmd="${esc(item.id)}">
              ${icon(item.icon, 'i-sm')}<span class="grow">${esc(item.label)}</span>
              ${item.hint ? `<kbd>${esc(item.hint)}</kbd>` : ''}</button>`;
          }).join('') : `<div class="empty-sm">Nothing matches “${esc(S.paletteQuery)}”.</div>`}
        </div>
      </div>
    </div>`;
  }

  // Small modals: import a test, create a folder.
  const o = S.overlay;
  return `
  <div class="overlay" data-act="close-overlay">
    <div class="modal" role="dialog" aria-label="${esc(o.title)}" data-stop>
      <div class="card-head"><h3>${esc(o.title)}</h3>
        <button class="btn-icon" data-act="close-overlay" aria-label="Close">${icon('x', 'i-sm')}</button></div>
      <div class="mbody">${o.body}</div>
      <div class="mfoot">
        <button class="btn" data-act="close-overlay">Cancel</button>
        <button class="btn btn-primary" data-act="${esc(o.confirmAct)}">${esc(o.confirmLabel)}</button>
      </div>
    </div>
  </div>`;
}

function openImportModal() {
  S.overlay = {
    kind: 'modal', title: 'Import Test', confirmAct: 'do-import', confirmLabel: 'Import',
    body: `
      <div class="field-row">
        <label class="label" for="importFile">From a file</label>
        <input class="field" id="importFile" type="file" accept="application/json,.json" style="padding:5px 8px; height:auto">
      </div>
      <div class="field-row" style="margin-bottom:0">
        <label class="label" for="importText">…or paste the test JSON</label>
        <textarea class="field" id="importText" rows="7" placeholder='{"name":"…","steps":[…]}'></textarea>
      </div>`,
  };
  render();
}

function openFolderModal() {
  S.overlay = {
    kind: 'modal', title: 'New Folder', confirmAct: 'do-folder', confirmLabel: 'Create',
    body: `<div class="field-row" style="margin-bottom:0">
      <label class="label" for="folderName">Folder name</label>
      <input class="field" id="folderName" placeholder="Checkout regressions" autocomplete="off">
      <div class="meta">Folders live on this machine and become available when you save or edit a test.</div>
    </div>`,
  };
  render();
}

let menuNode = null;
function closeMenu() { if (menuNode) { menuNode.remove(); menuNode = null; } }

function openMenuAt(anchor, html) {
  closeMenu();
  const rect = anchor.getBoundingClientRect();
  menuNode = document.createElement('div');
  menuNode.className = 'menu';
  menuNode.setAttribute('role', 'menu');
  menuNode.innerHTML = html;
  document.body.appendChild(menuNode);
  const w = menuNode.offsetWidth, h = menuNode.offsetHeight;
  menuNode.style.top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - h - 8)) + 'px';
  menuNode.style.left = Math.max(8, Math.min(rect.right - w, window.innerWidth - w - 8)) + 'px';
  const first = menuNode.querySelector('button:not(:disabled)');
  if (first) first.focus();
}

function openTestMenu(anchor, testId) {
  const t = S.tests.find((x) => x.id === testId) || S.test;
  const lastRunId = t && t.lastRun && t.lastRun.runId;
  openMenuAt(anchor, `
    <button role="menuitem" data-act="run-test" data-id="${esc(testId)}">${icon('play', 'i-sm')}Execute</button>
    <button role="menuitem" data-act="open-test" data-id="${esc(testId)}">${icon('pencil', 'i-sm')}Open &amp; edit</button>
    <button role="menuitem" data-act="duplicate-test" data-id="${esc(testId)}">${icon('duplicate', 'i-sm')}Duplicate</button>
    <button role="menuitem" data-act="toggle-favorite" data-id="${esc(testId)}">${icon('star', 'i-sm')}${t && t.favorite ? 'Remove from favorites' : 'Add to favorites'}</button>
    <button role="menuitem" data-act="export-test" data-id="${esc(testId)}">${icon('upload', 'i-sm')}Export as JSON</button>
    <button role="menuitem" data-act="view-last" data-id="${esc(testId)}" ${lastRunId ? '' : 'disabled'}>${icon('history', 'i-sm')}View last result</button>
    <div class="msep"></div>
    <button role="menuitem" class="danger" data-act="delete-test" data-id="${esc(testId)}">${icon('trash', 'i-sm')}Delete test</button>`);
}

function openThemeMenu(anchor) {
  const choice = themeChoice();
  openMenuAt(anchor, `
    <div class="mhead">Theme</div>
    ${[['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'System', 'monitor']].map(([v, l, ic]) => `
      <button role="menuitemradio" aria-checked="${choice === v}" data-act="set-theme" data-theme="${v}">
        ${icon(ic, 'i-sm')}<span class="grow">${l}</span>${choice === v ? icon('check', 'i-sm') : ''}
      </button>`).join('')}`);
}

function openFilterMenu(anchor) {
  openMenuAt(anchor, `
    <div class="mhead">Last run</div>
    ${[['all', 'All'], ['passed', 'Passed'], ['failed', 'Failed or blocked'], ['never', 'Never run']].map(([v, l]) => `
      <button role="menuitemradio" aria-checked="${S.libFilter === v}" data-act="set-filter" data-filter="${v}">
        <span class="grow">${l}</span>${S.libFilter === v ? icon('check', 'i-sm') : ''}</button>`).join('')}`);
}

/** The two kinds of wait, named by what they are FOR rather than by their step type. */
function openInsertWaitMenu(anchor) {
  const scope = reorderScope();
  if (!scope) return;
  const steps = stepsForScope(scope);
  const index = Number(anchor.getAttribute('data-index'));
  const item = (kind, ic, label, hint) => `
    <button role="menuitem" data-act="insert-wait" data-scope="${esc(scope)}" data-kind="${kind}" data-index="${index}">
      ${icon(ic, 'i-sm')}<span class="grow" style="text-align:left">${esc(label)}
        <div class="meta">${esc(hint)}</div></span></button>`;
  openMenuAt(anchor, `
    <div class="mhead">Insert ${esc(insertWaitWhere(steps, index))}</div>
    ${item('waitForXhr', 'refresh', 'Wait for network', 'Until the page stops fetching')}
    ${item('wait', 'clock', `Fixed pause (${stepDuration(DEFAULT_WAIT_MS)})`, 'You can change the milliseconds next')}`);
}

/* ══════════════════════════════════════════════════════════════════════════
   ACTIONS
   ══════════════════════════════════════════════════════════════════════════ */
/**
 * While the recorder holds these statuses the DRAFT BELONGS TO THE SERVER: every captured
 * action pushes a whole new snapshot over SSE and `S.rec.steps` is replaced wholesale. Any
 * local edit to that array is undone by the very next click in the recorded window - which is
 * exactly how a deleted step came back. Reorder and Insert wait already refuse to run here;
 * delete now goes through the recorder instead of pretending.
 */
const LIVE_REC_STATUS = new Set(['starting', 'recording', 'stopping']);
function recordingIsLive() { return LIVE_REC_STATUS.has(S.rec.status); }

/**
 * The recorder answers a step delete with the draft as it now stands. Accept the shapes it
 * might use rather than guessing at one; anything unrecognised means we simply wait for the
 * next SSE frame instead of inventing a list.
 */
function unwrapSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.steps)) return payload;
  if (payload.recording && Array.isArray(payload.recording.steps)) return payload.recording;
  if (payload.snapshot && Array.isArray(payload.snapshot.steps)) return payload.snapshot;
  return null;
}

let deletingLiveStep = false;

/**
 * Drop one step out of a recording that is still running. The recorder owns the draft, so the
 * server is asked and the server's answer is applied whole - hand-patching the local array
 * would put us back where we started, one snapshot away from the step reappearing.
 */
async function deleteLiveStep(step) {
  if (deletingLiveStep) return;
  const stepId = step && step.id;
  if (stepId == null) {
    toast('The recorder has not given that step an id yet, so it cannot be dropped mid-recording. '
      + 'Stop the recording and delete it on the review screen.', 'bad');
    return;
  }
  deletingLiveStep = true;
  const reply = await guard(() => api('DELETE', '/api/recording/step/' + encodeURIComponent(stepId)),
    'Could not delete that step');
  deletingLiveStep = false;
  // guard() has already said why (404 = the recorder no longer has that step, 409 = nothing is
  // recording). Leaving the row on screen is the honest outcome: the draft did not change.
  if (reply === undefined) { render(); return; }
  const snap = unwrapSnapshot(reply);
  if (snap) onRecordingSnapshot(snap);        // the server's truth, applied whole
  else render();                              // unrecognised body - the next SSE frame corrects us
  announce('Step deleted.');
}

function stepsForScope(scope) {
  if (scope === 'rec') return S.rec.steps || [];
  if (scope === 'test') return (S.test && S.test.steps) || [];
  return [];
}
function selectStep(scope, key) {
  if (scope === 'rec') S.recSel = key; else S.testSel = key;
  if (isNarrow()) S.sheetOpen = true;      // the details panel is a bottom sheet down here
  render();
}
function deleteStep(scope, key) {
  const steps = stepsForScope(scope);
  const i = indexOfStep(steps, key);
  if (i < 0) return;
  // Same reason the reorder buttons are absent while recording: the next snapshot replaces
  // this array. Ask the recorder instead of splicing something that will come straight back.
  if (scope === 'rec' && recordingIsLive()) { deleteLiveStep(steps[i]); return; }
  steps.splice(i, 1);
  const nextKey = steps.length ? keyOf(steps[Math.min(i, steps.length - 1)], Math.min(i, steps.length - 1)) : null;
  if (scope === 'rec') S.recSel = nextKey;
  else { S.testSel = nextKey; S.testDirty = true; }
  render();
}
/** Which step list the current screen is editing, or null when none is. */
function reorderScope() {
  if (S.route.name === 'record') return 'rec';
  if (S.route.name === 'test' && S.testTab === 'steps') return 'test';
  return null;
}

/**
 * Reorder one step in place. The draft lives only in S.rec until it is saved, so moving a step
 * there is the whole job; a saved test has to go back through PUT /api/tests/:id, which the
 * existing dirty flag and its "Save changes" banner already drive.
 */
function moveStep(scope, key, delta) {
  // Same reason the buttons are absent on the live screen: the next snapshot would undo it.
  if (scope === 'rec' && recordingIsLive()) return;
  const steps = stepsForScope(scope);
  const from = indexOfStep(steps, key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= steps.length) return;

  const [moved] = steps.splice(from, 1);
  steps.splice(to, 0, moved);
  if (scope === 'rec') S.recSel = key;
  else { S.testSel = key; S.testDirty = true; }

  // Say where it landed, not just that it moved: the row numbers renumber underneath and a
  // screen-reader user has no way to see that happen.
  announce(`${stepActionLabel(moved)} moved ${delta < 0 ? 'up' : 'down'} to position ${to + 1} of ${steps.length}.`);
  render();

  // render() hands focus back by id, but the button disables itself at the end of the list —
  // when that happens keep the user in the pair rather than dropping them on the body.
  const same = $(`mv-${scope}-${key}-${delta < 0 ? 'up' : 'down'}`);
  if (same && !same.disabled) { same.focus(); return; }
  const other = $(`mv-${scope}-${key}-${delta < 0 ? 'down' : 'up'}`);
  if (other) other.focus();
}

/* Ids for steps the user added here. The server renumbers everything to s1..sN when the test is
   saved, so these only have to be unique inside this page for the lifetime of the draft. */
let insertedStepSeq = 0;
function newStepId() { return `new-${++insertedStepSeq}`; }

const DEFAULT_WAIT_MS = 1000;   // a round starting point; the details panel is where it is tuned

/**
 * Add a wait the user asked for. There is no endpoint for this and there does not need to be:
 * the draft is a client-side array until Save, and a saved test goes back whole through the
 * existing PUT. A live recording is the one case with nowhere to put it — see moveStep.
 */
function insertWait(scope, kind, index) {
  if (scope === 'rec' && recordingIsLive()) return;
  const steps = stepsForScope(scope);
  const at = index >= 0 && index < steps.length ? index : steps.length;
  const step = kind === 'waitForXhr'
    ? { id: newStepId(), type: 'waitForXhr' }
    : { id: newStepId(), type: 'wait', ms: DEFAULT_WAIT_MS };
  steps.splice(at, 0, step);

  // Select it: the millisecond field lives in the details panel, and a pause the user cannot
  // immediately retune is a pause they will delete and re-add.
  const key = keyOf(step, at);
  if (scope === 'rec') S.recSel = key; else { S.testSel = key; S.testDirty = true; }
  if (isNarrow()) S.sheetOpen = true;
  // A pause you just created is a pause you are about to set the length of, so the panel opens
  // already in edit mode rather than making the user find "Edit" first.
  if (step.type === 'wait') S.inspEdit = true;
  announce(`${stepActionLabel(step)} inserted at position ${at + 1} of ${steps.length}.`);
  render();

  const field = $('inspValue');
  if (field && !field.readOnly) field.focus();
}

function moveSelection(delta) {
  const scope = reorderScope();
  if (!scope) return false;
  const steps = stepsForScope(scope);
  if (!steps.length) return false;
  const current = scope === 'rec' ? S.recSel : S.testSel;
  const i = indexOfStep(steps, current);
  const next = Math.max(0, Math.min(steps.length - 1, (i < 0 ? 0 : i + delta)));
  selectStep(scope, keyOf(steps[next], next));
  const node = document.querySelector('.step[aria-selected="true"]');
  if (node) { node.focus(); node.scrollIntoView({ block: 'nearest' }); }
  return true;
}

async function launchRecording() {
  if (S.launching) return;
  const cfg = S.config || {};
  const appKey = S.recForm.app || cfg.defaultApp;
  S.launching = true;
  render();
  announce('Starting the browser.');
  toast('Starting the browser — this takes a few seconds.');
  await guard(() => api('POST', '/api/recording/start',
      { app: appKey, headed: true, browser: S.recForm.browser, viewport: S.recForm.viewport }),
    'Could not start recording. Check the app is running, then try again');
  S.launching = false;
  render();
}
async function stopRecording() {
  announce('Stopping the recording.');
  await guard(() => api('POST', '/api/recording/stop'), 'Could not stop the recording');
}
/**
 * Pause and resume never flip the button themselves. The recorder is the only thing that knows
 * whether capture is actually off, and it says so on the SSE `recording` snapshot; guessing here
 * would show "Paused" over a recorder that is still capturing, which is the exact lie this
 * screen must not tell. All the in-flight flag does is stop a second click landing meanwhile.
 */
async function setRecordingPaused(paused) {
  if (S.pausing) return;
  S.pausing = true;
  render();
  const ok = await guard(() => api('POST', paused ? '/api/recording/pause' : '/api/recording/resume'),
    paused ? 'Could not pause the recording' : 'Could not resume the recording');
  S.pausing = false;
  // On success the snapshot re-renders us; on failure nothing moved, so re-render to give the
  // button back with the state the recorder still reports.
  if (ok === undefined) render(); else if (S.route.name === 'record') render();
}
function pauseRecording() { return setRecordingPaused(true); }
function resumeRecording() { return setRecordingPaused(false); }
async function discardDraft() {
  if (!confirm('Discard this recording? The captured steps will be lost.')) return;
  const ok = await guard(() => api('POST', '/api/recording/discard'), 'Could not discard the recording');
  if (ok === undefined) return;
  S.recStage = null; S.recSel = null;
  S.saveForm = { name: '', description: '', folder: '', tags: [], tagDraft: '', runAfter: false };
  await loadTests();
  go('#/tests');
}

async function saveDraft() {
  if (S.saving) return;
  const f = S.saveForm;
  const name = f.name.trim();
  if (!name) { toast('Give the test a name first', 'bad'); const n = $('saveName'); if (n) n.focus(); return; }
  S.saving = true;
  render();
  announce('Saving test.');
  const saved = await guard(() => api('POST', '/api/tests', {
    name, description: f.description.trim(), app: S.rec.app, steps: S.rec.steps,
    tags: f.tags, folder: f.folder || null, favorite: false,
  }), 'Could not save the test — the recorded steps are still here, so you can try again');
  S.saving = false;
  if (!saved) { render(); return; }
  toast(`Saved "${saved.name}" — ${(saved.steps || []).length} steps`, 'good');
  const runAfter = f.runAfter;
  S.recStage = null; S.recSel = null;
  S.saveForm = { name: '', description: '', folder: '', tags: [], tagDraft: '', runAfter: false };
  S.recForm.name = ''; S.recForm.description = '';
  await loadTests();
  if (runAfter) runTest(saved.id); else go('#/test/' + saved.id);
}

async function saveTest() {
  if (!S.test || S.saving) return;
  const t = S.test;
  S.saving = true;
  render();
  const saved = await guard(() => api('PUT', '/api/tests/' + t.id, {
    name: t.name, description: t.description, steps: t.steps,
    tags: t.tags || [], folder: t.folder || null, favorite: !!t.favorite,
  }), 'Could not save the test — your edits are still on screen, so you can try again');
  S.saving = false;
  if (!saved) { render(); return; }
  S.test = saved; S.testCache[saved.id] = saved; S.testDirty = false;
  toast('Changes saved', 'good');
  await loadTests();
  render();
}

async function deleteTest(id) {
  const t = S.tests.find((x) => x.id === id) || S.test;
  const name = (t && t.name) || id;
  if (!confirm(`Delete "${name}" and its run history?\n\nThis cannot be undone.`)) return;
  const ok = await guard(() => api('DELETE', '/api/tests/' + id), 'Could not delete the test');
  if (ok === undefined) return;
  toast(`Deleted "${name}"`, 'good');
  delete S.testCache[id];
  delete S.libSelection[id];
  await loadTests();
  if (S.route.name === 'test') go('#/tests'); else render();
}

async function duplicateTest(id) {
  const copy = await guard(() => api('POST', `/api/tests/${id}/duplicate`), 'Could not duplicate the test');
  if (!copy) return;
  toast(`Duplicated as "${copy.name || 'copy'}"`, 'good');
  await loadTests();
  if (copy.id) go('#/test/' + copy.id); else render();
}

/**
 * Write one test out as the JSON the Import modal already knows how to read - the modal said
 * "from an export" while nothing in the app could produce one. No endpoint is needed: GET
 * /api/tests/:id is the whole file, so this is a download of what the server already serves.
 */
async function exportTest(id) {
  const t = await guard(() => api('GET', '/api/tests/' + id), 'Could not export the test');
  if (!t) return;
  const slug = String(t.id || t.name || 'test').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'test';
  const filename = slug + '.json';
  let url;
  try {
    url = URL.createObjectURL(new Blob([JSON.stringify(t, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) {
    toast('Could not write the export: ' + e.message, 'bad');
    return;
  } finally {
    // Revoked late rather than immediately: some browsers have not started reading the blob
    // by the time click() returns, and a revoked URL there is a silently empty download.
    if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 20000);
  }
  toast('Exported "' + (t.name || t.id) + '" as ' + filename, 'good');
}

async function toggleFavorite(id) {
  const t = S.tests.find((x) => x.id === id);
  if (!t) return;
  const saved = await guard(() => api('PUT', '/api/tests/' + id, { favorite: !t.favorite }),
    'Could not change the favorite');
  if (!saved) return;
  await loadTests();
  render();
}

/**
 * Open the compact recorder panel beside the app you are recording.
 *
 * A named window, so a second press refocuses the panel already open instead of scattering
 * copies. If the browser blocks the popup we say so rather than leaving the user pressing a
 * button that appears to do nothing — a silent no-op is the worst outcome here.
 */
function openRecorderPanel() {
  // A TALL, NARROW panel parked down the right-hand edge, so it sits BESIDE the window you are
  // driving rather than over it. It carries the step list, the element inspector and the
  // locator read-out, so it needs height; the old 150px-high strip opened the same page with
  // everything in it clipped out of sight, which read as "the panel is broken".
  const avail = window.screen.availWidth || 1280;
  const availH = window.screen.availHeight || 900;
  const w = Math.min(460, Math.max(360, Math.round(avail * 0.3)));
  const h = Math.max(560, availH - 60);
  const left = Math.max(0, avail - w - 16);
  const win = window.open('/recorder', 'tf-recorder',
    `popup=yes,width=${w},height=${h},left=${left},top=0`);
  if (!win) { toast('Your browser blocked the panel window. Allow pop-ups for this page, then try again.', 'bad'); return; }
  win.focus();
  announce('Recorder panel opened in a separate window.');
}

async function runTest(id, app) {
  S.live = normaliseRun({ testId: id, app, status: 'starting', steps: [], startedAt: new Date().toISOString() });
  S.runStepsOpen = false;
  go('#/run/' + id + '/live');
  announce('Starting the browser.');
  // No `app` means "wherever it was recorded" - the server resolves that, so an unchanged
  // caller (a row menu, Run Again) keeps behaving exactly as it did.
  const started = await guard(() => api('POST', `/api/tests/${id}/run`, app ? { app } : {}),
    'Could not start the run. Check nothing else is running, then try again');
  if (started === undefined) { S.live = null; go('#/test/' + id); }
}

async function openBrowserOnly() {
  const appKey = S.recForm.app || (S.config && S.config.defaultApp);
  toast('Starting the browser…');
  const ok = await guard(() => api('POST', '/api/browser/open', { app: appKey }),
    'Could not open the browser. Check the app is running on its port');
  if (ok === undefined) return;
  toast('Browser opening at ' + (appBaseUrl(appKey) || 'the app URL'), 'good');
}

async function doImport() {
  const fileInput = $('importFile');
  const textInput = $('importText');
  let raw = (textInput && textInput.value.trim()) || '';
  if (!raw && fileInput && fileInput.files && fileInput.files[0]) {
    raw = await fileInput.files[0].text().catch(() => '');
  }
  if (!raw) { toast('Choose a file or paste the test JSON first', 'bad'); return; }
  let body;
  try { body = JSON.parse(raw); } catch (e) { toast('That is not valid JSON: ' + e.message, 'bad'); return; }
  const imported = await guard(() => api('POST', '/api/tests/import', body),
    'Could not import the test — check the JSON has a name and a steps array');
  if (!imported) return;
  S.overlay = null;
  toast(`Imported "${imported.name || 'test'}"`, 'good');
  await loadTests();
  if (imported.id) go('#/test/' + imported.id); else render();
}

function doFolder() {
  const input = $('folderName');
  const name = input ? input.value.trim() : '';
  if (!name) { toast('Give the folder a name', 'bad'); return; }
  addFolder(name);
  S.overlay = null;
  toast(`Folder "${name}" created`, 'good');
  render();
}

async function deleteSelected() {
  const ids = Object.keys(S.libSelection).filter((k) => S.libSelection[k]);
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} ${ids.length === 1 ? 'test' : 'tests'} and their run history?`)) return;
  for (const id of ids) {
    await guard(() => api('DELETE', '/api/tests/' + id), 'Could not delete a test');
    delete S.libSelection[id];
  }
  toast(`Deleted ${ids.length} ${ids.length === 1 ? 'test' : 'tests'}`, 'good');
  await loadTests();
  render();
}

function runPaletteCommand(cmd) {
  S.overlay = null;
  // Every branch has to repaint. `go()` only repaints through hashchange, which does NOT fire
  // when the hash is already the one being set - so "Go to test library" pressed while already
  // on the library cleared S.overlay and then never re-rendered, leaving the palette floating
  // over the page with no way out but Esc. Painting here is idempotent: a real route change
  // fires hashchange and renders again.
  if (cmd.indexOf('open:') === 0) { go('#/test/' + cmd.slice(5)); render(); return; }
  switch (cmd) {
    case 'start-recording': case 'create-test': go('#/record'); break;
    case 'open-browser': openBrowserOnly(); break;
    case 'import-test': openImportModal(); return;   // renders itself, with the modal up
    case 'goto-tests': go('#/tests'); break;
    case 'goto-executions': go('#/executions'); break;
    case 'goto-settings': go('#/settings'); break;
    default: break;
  }
  render();
}

/* ── The shell: mobile drawer, laptop rail ─────────────────────────────
   Open drawer   = .shell.nav-open   Icon-only sidebar = .shell.rail
   The matching data-* attributes on <html> are kept so the older stylesheet
   rules keep working while the CSS is being reworked. ── */
function shellEl() { return document.querySelector('.shell'); }
function drawerIsOpen() { const el = shellEl(); return !!(el && el.classList.contains('nav-open')); }

let drawerReturnFocus = null;

function openDrawer() {
  const el = shellEl();
  if (!el || drawerIsOpen()) return;
  drawerReturnFocus = document.activeElement;
  el.classList.add('nav-open');
  document.documentElement.setAttribute('data-drawer', 'open');

  const sidebar = $('sidebar');
  if (sidebar) {
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    sidebar.setAttribute('aria-label', 'Navigation');
  }
  const burger = $('burger');
  if (burger) burger.setAttribute('aria-expanded', 'true');
  const scrim = $('scrim');
  if (scrim) scrim.removeAttribute('aria-hidden');
  syncScrollLock();

  // Move focus in, but leave the rest of the page reachable — no keyboard trap.
  const first = $('drawerClose') || (sidebar && sidebar.querySelector('a, button'));
  if (first && typeof first.focus === 'function') first.focus();
}

function closeDrawer(restoreFocus) {
  const wasOpen = drawerIsOpen();
  const el = shellEl();
  if (el) el.classList.remove('nav-open');
  document.documentElement.removeAttribute('data-drawer');

  const sidebar = $('sidebar');
  if (sidebar) {
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
    sidebar.removeAttribute('aria-label');
  }
  const burger = $('burger');
  if (burger) burger.setAttribute('aria-expanded', 'false');
  const scrim = $('scrim');
  if (scrim) scrim.setAttribute('aria-hidden', 'true');
  syncScrollLock();

  if (wasOpen && restoreFocus !== false) {
    const back = (drawerReturnFocus && document.contains(drawerReturnFocus)) ? drawerReturnFocus : $('burger');
    if (back && typeof back.focus === 'function') back.focus();
  }
  drawerReturnFocus = null;
}

function railIsOn() { const el = shellEl(); return !!(el && el.classList.contains('rail')); }

function applyRail(on) {
  const el = shellEl();
  if (el) el.classList.toggle('rail', !!on);
  if (on) document.documentElement.setAttribute('data-sidebar', 'collapsed');
  else document.documentElement.removeAttribute('data-sidebar');
  const btn = $('railBtn');
  if (btn) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? 'Expand sidebar' : 'Collapse sidebar');
    btn.setAttribute('title', on ? 'Expand sidebar' : 'Collapse sidebar');
  }
}
function toggleSidebar() {
  const next = !railIsOn();
  applyRail(next);
  lsSet('tf.sidebar', next ? 'collapsed' : 'expanded');
}

/* ── The Step Details bottom sheet (mobile only) ── */
function closeSheet() {
  if (!S.sheetOpen) return;
  S.sheetOpen = false;
  syncScrollLock();
  render();
  const selected = document.querySelector('.step[aria-selected="true"]');
  if (selected && typeof selected.focus === 'function') selected.focus();
}

/** Re-lay-out when the viewport crosses the mobile breakpoint. */
function onViewportChange() {
  const narrow = isNarrow();
  if (narrow === S.narrow) return;
  S.narrow = narrow;
  if (!narrow) { closeDrawer(false); S.sheetOpen = false; }
  closeMenu();
  syncScrollLock();
  render();
}

/* ══════════════════════════════════════════════════════════════════════════
   EVENTS — one delegated click handler driven by data-act
   ══════════════════════════════════════════════════════════════════════════ */
document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-act]');
  if (menuNode && !menuNode.contains(event.target)) closeMenu();
  if (!trigger) return;

  const act = trigger.getAttribute('data-act');
  const id = trigger.getAttribute('data-id');
  const scope = trigger.getAttribute('data-scope');
  const key = trigger.getAttribute('data-key');
  const rowActs = ['open-test', 'open-run', 'folder-filter'];
  if (!rowActs.includes(act)) event.stopPropagation();

  switch (act) {
    /* navigation */
    case 'nav': event.preventDefault(); go(trigger.getAttribute('data-href')); break;
    case 'open-test': go('#/test/' + id); break;
    case 'open-run': go(`#/run/${trigger.getAttribute('data-test')}/${trigger.getAttribute('data-run')}`); break;
    case 'run-menu': openMenuAt(trigger, `
        <button role="menuitem" data-act="open-run" data-test="${esc(trigger.getAttribute('data-test'))}" data-run="${esc(trigger.getAttribute('data-run'))}">${icon('eye', 'i-sm')}Open result</button>
        <button role="menuitem" data-act="run-test" data-id="${esc(trigger.getAttribute('data-test'))}">${icon('play', 'i-sm')}Run again</button>
        <button role="menuitem" data-act="open-test" data-id="${esc(trigger.getAttribute('data-test'))}">${icon('tests', 'i-sm')}Open test</button>`); break;
    case 'open-drawer': openDrawer(); break;
    case 'close-drawer': closeDrawer(); break;
    case 'collapse-sidebar': toggleSidebar(); break;

    /* recording */
    case 'start-recording': S.recStage = null; go('#/record'); break;
    case 'launch-recording': launchRecording(); break;
    case 'stop-rec': stopRecording(); break;
    case 'open-panel': openRecorderPanel(); break;
    case 'pause-rec': pauseRecording(); break;
    case 'resume-rec': resumeRecording(); break;
    case 'discard-draft': discardDraft(); break;
    case 'goto-save': S.recStage = 'save'; if (!S.saveForm.name) S.saveForm.name = S.recForm.name; render(); break;
    case 'goto-review': S.recStage = null; render(); break;
    case 'save-draft': saveDraft(); break;
    case 'remove-tag':
      S.saveForm.tags = S.saveForm.tags.filter((x) => x !== trigger.getAttribute('data-tag'));
      render(); break;

    /* tests */
    case 'run-test': closeMenu(); runTest(id, trigger.getAttribute('data-app') || undefined); break;
    case 'save-test': saveTest(); break;
    case 'delete-test': closeMenu(); deleteTest(id); break;
    case 'duplicate-test': closeMenu(); duplicateTest(id); break;
    case 'export-test': closeMenu(); exportTest(id); break;
    case 'toggle-favorite': closeMenu(); toggleFavorite(id); break;
    case 'delete-selected': deleteSelected(); break;
    case 'row-menu': openTestMenu(trigger, id); break;
    case 'view-last': {
      closeMenu();
      const t = S.tests.find((x) => x.id === id);
      if (t && t.lastRun && t.lastRun.runId) go(`#/run/${id}/${t.lastRun.runId}`);
      else toast('This test has no runs yet', 'bad');
      break;
    }
    case 'remove-test-tag':
      if (S.test) { S.test.tags = (S.test.tags || []).filter((x) => x !== trigger.getAttribute('data-tag')); S.testDirty = true; render(); }
      break;

    /* library chrome */
    case 'lib-tab':
      S.libTab = trigger.getAttribute('data-tab');
      S.libFolder = null;          // "All Tests" has to mean all tests
      render(); break;
    case 'lib-view': S.libView = trigger.getAttribute('data-view'); render(); break;
    case 'filter-menu': openFilterMenu(trigger); break;
    case 'set-filter': S.libFilter = trigger.getAttribute('data-filter'); closeMenu(); render(); break;
    case 'clear-search': S.search = ''; { const g = $('globalSearch'); if (g) g.value = ''; } render(); break;
    case 'folder-filter': S.libTab = 'all'; S.libFolder = trigger.getAttribute('data-folder'); render(); break;
    case 'clear-folder': S.libFolder = null; render(); break;
    case 'select-all': {
      const rows = libraryRows();
      const allChecked = rows.every((t) => S.libSelection[t.id]);
      rows.forEach((t) => { S.libSelection[t.id] = !allChecked; });
      render(); break;
    }
    case 'select-row': S.libSelection[id] = !S.libSelection[id]; render(); break;

    /* test detail */
    case 'test-tab': S.testTab = trigger.getAttribute('data-tab'); render(); break;
    case 'test-tab-steps': S.testTab = 'steps'; render(); break;

    /* steps */
    case 'select-step': selectStep(scope, key); break;
    case 'delete-step': deleteStep(scope, key); break;
    case 'move-step': moveStep(scope, key, Number(trigger.getAttribute('data-delta')) || 0); break;
    case 'insert-wait-menu': openInsertWaitMenu(trigger); break;
    case 'insert-wait':
      closeMenu();
      insertWait(trigger.getAttribute('data-scope'), trigger.getAttribute('data-kind'),
        Number(trigger.getAttribute('data-index')));
      break;
    case 'close-sheet': closeSheet(); break;
    case 'toggle-insp-edit': S.inspEdit = !S.inspEdit; render(); break;
    case 'toggle-rec-session': S.recPanelOpen = !S.recPanelOpen; render(); break;

    /* misc */
    case 'copy': copyText(trigger.getAttribute('data-copy')); break;
    case 'expand-shot': S.lightbox = trigger.getAttribute('data-src'); render(); break;
    case 'close-lightbox': S.lightbox = null; render(); break;
    case 'toggle-steps': S.runStepsOpen = !S.runStepsOpen; render(); break;
    case 'scroll-to': { const n = $(trigger.getAttribute('data-target')); if (n) n.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
    case 'theme-menu': openThemeMenu(trigger); break;
    case 'set-theme': setTheme(trigger.getAttribute('data-theme')); render(); break;
    case 'open-browser': openBrowserOnly(); break;
    case 'import-test': openImportModal(); break;
    case 'new-folder': openFolderModal(); break;
    case 'do-import': doImport(); break;
    case 'do-folder': doFolder(); break;
    case 'close-overlay':
      // Only the BACKDROP is click-to-dismiss. The guard used to reject any click that landed
      // inside [data-stop] - which is the modal itself - so the modal's own Cancel and X buttons,
      // which carry this very action, were dead. Test the TRIGGER instead: a click that reached
      // here through the backdrop but landed inside the dialog is a click INSIDE the dialog and
      // must not close it; a real close button always closes.
      if (trigger.classList.contains('overlay') && event.target.closest('[data-stop]')) break;
      S.overlay = null; render(); break;
    case 'palette-run': runPaletteCommand(trigger.getAttribute('data-cmd')); break;
    case 'reload-runs': S.allRuns = null; render(); loadAllRuns().then(render); break;
    case 'settings-tab': S.settingsTab = trigger.getAttribute('data-tab'); render(); break;
    default: break;
  }
});

/* Scrim closes the mobile drawer; so does following any nav link. */
$('scrim').addEventListener('click', () => closeDrawer());
$('nav').addEventListener('click', (e) => { if (e.target.closest('a')) closeDrawer(); });

/* Crossing the mobile breakpoint changes the layout, so re-render at the boundary. */
try { mobileMQ.addEventListener('change', onViewportChange); }
catch { window.addEventListener('resize', onViewportChange); }

/* Inputs and selects */
document.addEventListener('input', (event) => {
  const node = event.target.closest('[data-act]');
  if (event.target.id === 'globalSearch') {
    S.search = event.target.value;
    if (S.route.name === 'tests') render();
    else if (S.search) go('#/tests');
    return;
  }
  if (!node) return;
  const act = node.getAttribute('data-act');
  const field = node.getAttribute('data-key');
  const value = node.type === 'checkbox' ? node.checked : node.value;

  switch (act) {
    case 'rec-form': S.recForm[field] = value; if (field === 'app') render(); break;
    // Belongs on the input listener, not the click one: a <select> never fires click when the
    // value changes, so the Execute button kept its original target and the choice did nothing.
    case 'run-target': S.runTarget = value || null; render(); break;
    case 'save-form': S.saveForm[field] = value; break;
    case 'tag-draft': S.saveForm.tagDraft = value; break;
    case 'test-tag-draft': S.testTagDraft = value; break;
    case 'test-field':
      if (!S.test) break;
      S.test[field] = field === 'folder' && value === '' ? null : value;
      if (!S.testDirty) { S.testDirty = true; render(); }
      break;
    case 'edit-step-value': {
      const steps = stepsForScope(node.getAttribute('data-scope'));
      const step = findStep(steps, node.getAttribute('data-key'));
      if (!step) break;
      const which = node.getAttribute('data-field');
      // A wait's duration is a number everywhere else in the pipeline; an <input type=number>
      // still hands back a string, and "1200" would replay as NaN milliseconds.
      const isMs = which === 'ms';
      step[which] = isMs ? Math.max(0, Math.round(Number(value) || 0)) : value;
      // Clearing the cached description must not clear the FIELD being edited. On an expectText
      // step the editable field IS `text`, so this line wiped every keystroke the user had just
      // typed - the row went blank and the edit was never saved.
      if (which !== 'text') step.text = null;        // the server recomputes the description on save
      const dirtied = node.getAttribute('data-scope') === 'test' && !S.testDirty;
      if (dirtied) S.testDirty = true;
      // The duration is part of the step's NAME ("Wait 1.2s"), so the row has to follow the field
      // as it is typed. render() puts focus and the caret back, so this costs nothing visible.
      if (dirtied || isMs) render();
      break;
    }
    case 'palette-query': S.paletteQuery = value; S.paletteIndex = 0; render(); break;
    case 'set-default-app': S.recForm.app = value; break;
    case 'set-browser': S.recForm.browser = value; break;
    case 'pref': prefSet(node.getAttribute('data-pref'), node.checked); break;
    default: break;
  }
});

/* Enter inside the tag inputs adds a tag. */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if (event.target.id === 'tagDraft') {
    event.preventDefault();
    const v = event.target.value.trim();
    if (v && !S.saveForm.tags.includes(v)) S.saveForm.tags.push(v);
    S.saveForm.tagDraft = '';
    event.target.value = '';
    render();
  } else if (event.target.id === 'tTagDraft' && S.test) {
    event.preventDefault();
    const v = event.target.value.trim();
    if (v) { S.test.tags = Array.from(new Set((S.test.tags || []).concat([v]))); S.testDirty = true; }
    S.testTagDraft = '';
    event.target.value = '';
    render();
  }
});

/* Global keyboard */
document.addEventListener('keydown', (event) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);

  if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    S.overlay = S.overlay && S.overlay.kind === 'palette' ? null : { kind: 'palette' };
    S.paletteQuery = ''; S.paletteIndex = 0;
    render();
    return;
  }

  if (S.overlay && S.overlay.kind === 'palette') {
    const items = paletteActions();
    if (event.key === 'ArrowDown') { event.preventDefault(); S.paletteIndex = Math.min(items.length - 1, S.paletteIndex + 1); render(); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); S.paletteIndex = Math.max(0, S.paletteIndex - 1); render(); return; }
    if (event.key === 'Enter') { event.preventDefault(); const item = items[S.paletteIndex]; if (item) runPaletteCommand(item.id); return; }
  }

  if (event.key === 'Escape') {
    if (S.lightbox) { S.lightbox = null; render(); return; }
    if (S.overlay) { S.overlay = null; render(); return; }
    if (menuNode) { closeMenu(); return; }
    if (drawerIsOpen()) { closeDrawer(); return; }
    if (S.sheetOpen && isNarrow()) { closeSheet(); return; }
    if (inField) { document.activeElement.blur(); return; }
    if (S.route.name === 'record' && S.recSel != null) { S.recSel = null; render(); return; }
    if (S.route.name === 'test' && S.testSel != null) { S.testSel = null; render(); return; }
    return;
  }

  if ((event.key === 'Enter' || event.key === ' ') && !inField) {
    const active = document.activeElement;
    // A real <button> already activates itself on Enter/Space. Claiming the key here would fire
    // the ROW it sits in instead — the step row's delete and reorder controls are inside the
    // <li>, so Enter on "Move step 3 up" used to select step 3 and move nothing.
    if (active && active.closest('button, a[href]')) return;
    const row = active && active.closest('[role="button"], .step, tr[data-act]');
    if (row && row.getAttribute('data-act')) { event.preventDefault(); row.click(); return; }
  }

  if (inField) return;

  // Alt+Arrow reorders the SELECTED step; a bare arrow still just moves the selection. The
  // buttons remain the contract — this is the shortcut for someone already driving by keyboard.
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.altKey) {
    const scope = reorderScope();
    const current = scope === 'rec' ? S.recSel : scope === 'test' ? S.testSel : null;
    if (scope && current != null) {
      event.preventDefault();
      moveStep(scope, current, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
  }

  if (event.key === '/') { const g = $('globalSearch'); if (g) { event.preventDefault(); g.focus(); g.select(); } return; }
  if (event.key === 'n' && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); S.recStage = null; go('#/record'); return; }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (moveSelection(event.key === 'ArrowDown' ? 1 : -1)) event.preventDefault();
  }
});

window.addEventListener('hashchange', onRouteChange);
window.addEventListener('resize', closeMenu);

/* ══════════════════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════════════════ */
(function initChrome() {
  applyTheme(themeChoice());
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (themeChoice() === 'system') applyTheme('system');
    });
  } catch { /* older browsers */ }
  applyRail(lsGet('tf.sidebar') === 'collapsed');
  S.narrow = isNarrow();
})();

(async function boot() {
  try {
    S.config = await api('GET', '/api/config');
    S.recForm.app = S.config.defaultApp;
  } catch (e) {
    toast('Cannot reach the recorder service: ' + e.message, 'bad');
  }
  refreshFolders();
  await loadTests();
  await loadStats();
  await onRouteChange();
  connectEvents();
})();
