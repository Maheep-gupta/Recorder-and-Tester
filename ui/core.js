/* Core: state, helpers, API client, router, data loading, live events, render loop.
 * Part of the UI bundle: classic scripts loaded in order from index.html, sharing one global
 * scope (state S, helpers, render). Load first.
 */
'use strict';

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
    username: '', password: '',    // optional login for the typed URL; the password is dropped once sent
  },
  saveForm: { name: '', description: '', folder: '', tags: [], tagDraft: '', runAfter: false, bugExpected: '', bugActual: '', bugSeverity: '' },
  envs: null,                    // GET /api/environments
  envForm: null,                 // environment being added/edited, or null
  envError: null,
  trash: null,                   // GET /api/trash
  recovered: null,               // GET /api/recording/recovered draft, or null
  cancelling: false,

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

function blankSaveForm() {
  return { name: '', description: '', folder: '', tags: [], tagDraft: '', runAfter: false, bugExpected: '', bugActual: '', bugSeverity: '' };
}

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
  const locked = drawerIsOpen() || (S.sheetOpen && isNarrow()) || !!S.overlay || !!S.lightbox || paletteIsOpen();
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
  openPage: 'Open tab', closePage: 'Close tab', expectVisible: 'Expect visible', expectHidden: 'Expect hidden', expectCount: 'Expect count',
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
    case 'expectVisible': case 'expectHidden': case 'expectCount': case 'expectText': case 'expectValue': return 'eye';
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
const STATUS_LABEL = {
  passed: 'Passed', failed: 'Failed', blocked: 'Blocked', error: 'Error', cancelled: 'Cancelled',
  inconclusive: 'Inconclusive', running: 'In Progress', starting: 'In Progress', 'not-run': 'Not run', skipped: 'Skipped',
};
function statusPill(status) {
  const st = status === 'starting' ? 'running' : status;
  if (!STATUS_LABEL[status]) return `<span class="pill st-not-run"><span class="dot"></span>Never run</span>`;
  const legacy = { passed: 'pass', failed: 'fail', blocked: 'block', running: 'run' }[st] || '';
  return `<span class="pill ${legacy} st-${esc(st)}"><span class="dot"></span>${esc(STATUS_LABEL[status])}</span>`;
}
const REASON_TEXT = {
  no_assertions: 'The steps completed, but this test has no assertion, so the fix is not verified. Add an assertion (e.g. Expect text) to verify the expected behaviour.',
  steps_skipped: 'Some steps were skipped, so the result is not conclusive. Check the skipped steps below.',
  assertion_failed: 'An assertion did not hold: the bug still reproduces or the expectation was not met.',
  element_not_found: 'A step could not find its element on the page.',
  element_ambiguous: 'A step matched more than one element and the engine refused to guess which one you meant.',
  step_failed: 'A step failed while running.',
  app_unreachable: 'The application could not be reached. Check that it is running at the chosen address.',
  browser_error: 'The browser or page crashed or closed during the run.',
  timeout: 'The run exceeded its time limit and was stopped.',
  internal_error: 'An internal error stopped the run.',
  auth_failed: 'Signing in to the application failed before the steps could run.',
  cancelled: 'The run was cancelled before it finished.',
  interrupted: 'The service stopped while this run was in progress.',
  assertions_passed: 'Every step ran and the assertions passed: the expected behaviour was verified.',
};
const FINISHED = new Set(['passed', 'failed', 'blocked', 'error', 'cancelled', 'inconclusive']);
const ENV_ICON = { production: 'shield', staging: 'flask', development: 'code', local: 'laptop' };
function envBadge(kind) {
  const k = ['production', 'staging', 'development', 'local'].includes(kind) ? kind : 'production';
  return `<span class="env-badge env-${k}">${icon(ENV_ICON[k], 'i-sm')}${esc(k)}</span>`;
}
/** The environment kind a stored run target (app key or url:<base>) belongs to, or null. */
function envKindFor(app) {
  if (!app) return null;
  const hit = (S.envs || []).find((e) => e.key === app || e.baseUrl === appBaseUrl(app));
  if (hit && hit.kind) return hit.kind;
  const d = describeTarget(app);
  return d && d.kind ? d.kind : null;
}
/* A target is a configured app key ("ui-shell") or `url:<base URL>` for an address typed into the
   Setup form. These mirror src/targets.js closely enough for display; the server stays the
   authority and validates again. */
function normaliseAppUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch { return null; }
}
function isLocalHost(h) {
  h = String(h || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}
/** { key, label, baseUrl, auth, remote, custom, hasSavedLogin, hasTypedLogin } or null. */
function describeTarget(input) {
  const apps = (S.config && S.config.apps) || {};
  const saved = new Set((S.config && S.config.savedLogins) || []);
  let s = String(input || '');
  if (Object.prototype.hasOwnProperty.call(apps, s)) {
    const a = apps[s];
    return { key: s, ...a, custom: false, hasTypedLogin: saved.has(new URL(a.baseUrl).origin) };
  }
  if (s.startsWith('url:')) s = s.slice(4);
  const baseUrl = normaliseAppUrl(s);
  if (!baseUrl) return null;
  const origin = new URL(baseUrl).origin;
  for (const [key, a] of Object.entries(apps)) {
    if (a.baseUrl === baseUrl) return { key, ...a, custom: false, hasTypedLogin: saved.has(origin) };
  }
  const u = new URL(baseUrl);
  return {
    key: 'url:' + baseUrl, label: u.host + (u.pathname === '/' ? '' : u.pathname), baseUrl,
    auth: saved.has(origin), remote: false, custom: true, hasSavedLogin: null, hasTypedLogin: saved.has(origin),
    kind: isLocalHost(u.hostname) ? 'local' : 'production', protected: !isLocalHost(u.hostname),
  };
}
function appLabel(key) {
  const a = describeTarget(key);
  return a ? a.label : (key || 'unknown app');
}
function appBaseUrl(key) {
  const a = describeTarget(key);
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
    throw new Error('Cannot reach the Replayr service — is the Replayr server (npm start) still running?');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.code = data && data.code;
    err.body = data;
    throw err;
  }
  return data;
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
  if (parts[0] === 'environments') return { name: 'environments' };
  if (parts[0] === 'trash') return { name: 'trash' };
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
  closePalette(true);
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
  if (S.route.name === 'home') await Promise.all([loadTests(), loadStats(), loadAllRuns(), loadEnvironments()]);
  if (S.route.name === 'tests') await loadTests();
  if (S.route.name === 'executions') { await loadTests(); await loadAllRuns(); }
  if (S.route.name === 'environments') await loadEnvironments();
  if (S.route.name === 'trash') await loadTrash();
  if (S.route.name === 'record') await loadRecovered();
  if (S.route.name === 'test') { loadEnvironments(); await loadTest(S.route.id); }
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
  S._testsLoaded = true;   // an empty library must leave the skeleton even if no render saw the loading state
  // Defensive: GET /api/tests can include non-test JSON from the tests dir (e.g. environments.json), which has no id.
  if (data) { S.tests = (data.tests || []).filter((t) => t && t.id); refreshFolders(); }
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
  // …but only while the user is following along: once they pick an older step to inspect, a new
  // action must not yank the inspector away from it.
  const prevSteps = previous.steps || [];
  const wasFollowing = S.recSel == null || !prevSteps.length
    || S.recSel === keyOf(prevSteps[prevSteps.length - 1], prevSteps.length - 1);
  if (S.rec.status === 'recording' && steps.length && prevSteps.length !== steps.length && wasFollowing) {
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
  if (previous.status !== S.rec.status || !previous.paused !== !S.rec.paused) paintChrome();
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
    done: !!p.done || FINISHED.has(p.status),
    reason: p.reason || null, summary: p.summary || null, target: p.target || null,
    recordedOn: p.recordedOn || null, crossEnv: !!p.crossEnv, urlRewrites: p.urlRewrites || [],
    dialogs: p.dialogs || [], assertions: p.assertions || null,
  };
}

function onRunProgress(progress) {
  const run = normaliseRun(progress);
  if (!run.startedAt) run.startedAt = (S.live && S.live.startedAt) || new Date().toISOString();
  const liveChanged = !S.live || S.live.done !== run.done || S.live.testId !== run.testId;
  S.live = run;
  if (liveChanged) paintChrome();

  announce(run.done
    ? `${run.testName || 'The test'}: ${STATUS_LABEL[run.status] || run.status}.`
    : phaseLine(run));

  if (run.done) {
    if (run.id) S.runCache[run.testId + '/' + run.id] = run;
    const refresh = [loadTests()];
    if (S.route.name === 'home') refresh.push(loadStats(), loadAllRuns());
    Promise.all(refresh).then(() => { if (S.route.name === 'tests' || S.route.name === 'home') render(); });
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
const NAV_GROUPS = [
  { label: 'Workspace', items: [
    { hash: '#/home', label: 'Overview', icon: 'home', match: ['home'], keys: ['g', 'o'] },
    { hash: '#/tests', label: 'Test Library', icon: 'tests', match: ['tests', 'test'], keys: ['g', 't'], count: 'tests' },
    { hash: '#/record', label: 'Record Bug', icon: 'record', match: ['record'], keys: ['g', 'r'] },
    { hash: '#/executions', label: 'Execution History', icon: 'history', match: ['executions', 'run'], keys: ['g', 'h'] },
  ] },
  { label: 'Configuration', items: [
    { hash: '#/environments', label: 'Applications & Environments', short: 'Apps & Environments', icon: 'layers', match: ['environments'], keys: ['g', 'e'] },
  ] },
  { label: 'Management', items: [
    { hash: '#/trash', label: 'Trash', icon: 'trash', match: ['trash'] },
    { hash: '#/settings', label: 'Settings', icon: 'settings', match: ['settings'] },
  ] },
];
/* Flat list, kept for anything that wants the nav as data (the command palette does). */
const NAV_ITEMS = NAV_GROUPS.reduce((all, g) => all.concat(g.items.map((i) => Object.assign({ group: g.label }, i))), []);

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl';

/** Is a recording underway, and is a replay in flight? Both feed the sidebar's live rows. */
function recordingActive() { return S.rec && (S.rec.status === 'recording' || S.rec.status === 'starting'); }
function runActive() { return !!(S.live && !S.live.done); }

function navLiveRows() {
  const rows = [];
  if (recordingActive()) {
    const n = (S.rec.steps || []).length;
    const label = S.rec.status === 'starting' ? 'Starting browser' : S.rec.paused ? 'Recording paused' : 'Recording';
    rows.push(`<a class="nav-live nav-live-rec${S.rec.paused ? ' paused' : ''}" href="#/record" title="${esc(label)} - open the recorder"
        ${S.route.name === 'record' ? 'aria-current="page"' : ''}>
      <span class="live-dot" aria-hidden="true"></span>
      <span class="nav-text hide-collapsed"><b>${esc(label)}</b><span class="nav-live-sub">${n} ${n === 1 ? 'step' : 'steps'}</span></span>
    </a>`);
  }
  if (runActive()) {
    const name = S.live.testName || S.live.testId || 'test';
    rows.push(`<a class="nav-live nav-live-run" href="#/run/${esc(S.live.testId)}/live" title="Replay in progress: ${esc(name)}">
      <span class="live-dot" aria-hidden="true"></span>
      <span class="nav-text hide-collapsed"><b>Replay running</b><span class="nav-live-sub truncate">${esc(name)}</span></span>
    </a>`);
  }
  return rows.length ? `<div class="nav-group nav-live-group">${rows.join('')}</div>` : '';
}

function navLink(item) {
  const current = item.match.includes(S.route.name);
  const count = item.count === 'tests' && S.tests.length ? `<span class="nav-count hide-collapsed" aria-label="${S.tests.length} tests">${S.tests.length}</span>` : '';
  const keys = item.keys ? `<span class="nav-keys hide-collapsed" aria-hidden="true"><kbd>${item.keys[0]}</kbd><kbd>${item.keys[1]}</kbd></span>` : '';
  const tip = item.label + (item.keys ? `  (${item.keys.join(' then ')})` : '');
  return `<a href="${item.hash}" ${current ? 'aria-current="page"' : ''} title="${esc(tip)}"${item.keys ? ` aria-keyshortcuts="${item.keys.join(' ')}"` : ''}>
      ${icon(item.icon)}<span class="nav-text hide-collapsed">${esc(item.short || item.label)}</span>${count}${keys}
    </a>`;
}

/** Topbar bits index.html does not carry: the command palette trigger and a real theme toggle. */
function ensureTopbar() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  if (!$('paletteBtn')) {
    const b = document.createElement('button');
    b.id = 'paletteBtn';
    b.type = 'button';
    b.className = 'btn btn-sm pal-trigger';
    b.setAttribute('data-act', 'open-palette');
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-keyshortcuts', 'Control+K Meta+K');
    b.setAttribute('title', `Command palette (${MOD_KEY}+K)`);
    b.innerHTML = `${icon('command', 'i-sm')}<span class="pal-label">Commands</span><kbd>${MOD_KEY} K</kbd>`;
    bar.insertBefore(b, $('connPill') || $('themeBtn'));
  }
  const tb = $('themeBtn');
  if (tb && tb.getAttribute('data-act') !== 'toggle-theme') {
    tb.setAttribute('data-act', 'toggle-theme');
    tb.removeAttribute('aria-haspopup');
  }
  if (tb) {
    const dark = effectiveTheme() === 'dark';
    tb.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    tb.setAttribute('title', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  const gs = $('globalSearch');
  if (gs && !gs.dataset.shellInit) {
    gs.dataset.shellInit = '1';
    gs.setAttribute('placeholder', 'Search tests…');
    gs.setAttribute('aria-keyshortcuts', '/');
    gs.addEventListener('keydown', (e) => { if (e.key === 'Enter' && S.route.name !== 'tests') { e.preventDefault(); go('#/tests'); } });
  }
  const toasts = $('toasts');
  if (toasts && !toasts.getAttribute('aria-live')) {
    toasts.setAttribute('aria-live', 'polite');
    toasts.setAttribute('role', 'region');
    toasts.setAttribute('aria-label', 'Notifications');
  }
}

function paintChrome() {
  ensureTopbar();
  const nav = $('nav');
  const focused = document.activeElement && nav.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
  nav.innerHTML = navLiveRows() + NAV_GROUPS.map((g, i) => `
    <div class="nav-group">
      <div class="nav-label hide-collapsed" id="navg-${i}">${esc(g.label)}</div>
      <div class="nav-rule" aria-hidden="true"></div>
      <div role="group" aria-labelledby="navg-${i}">${g.items.map(navLink).join('')}</div>
    </div>`).join('');
  if (focused) { const again = nav.querySelector(`a[href="${CSS.escape(focused)}"]`); if (again) again.focus(); }

  $('sbCard').innerHTML = `
    <div class="sb-status" role="status">
      <span class="sb-dot ${S.sseUp ? 'up' : 'down'}" aria-hidden="true"></span>
      <span>${S.sseUp ? 'Live updates connected' : 'Reconnecting to the service…'}</span>
    </div>
    <div class="meta" style="margin:6px 0 2px">Tests directory</div>
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
  // The rail has no room for words, so a dropped connection gets a dot on the logo instead.
  const glyph = document.querySelector('.wordmark .glyph');
  if (glyph) glyph.classList.toggle('offline', !S.sseUp);
}

/**
 * The one page header every view should use.
 *   pageHeader({ title, crumbs, subtitle, actions, meta })
 *   title    plain text (escaped here)
 *   crumbs   optional [{ label, hash? } | 'text'] shown above the title; the last one is the current page
 *   subtitle optional plain text under the title (escaped)
 *   actions  optional HTML for the right-hand context actions (buttons); you escape it
 *   meta     optional HTML shown inline after the title (a status pill, an env badge); you escape it
 */
function pageHeader(o) {
  o = o || {};
  const crumbs = (o.crumbs || []).map((c, i, all) => {
    const item = typeof c === 'string' ? { label: c } : c;
    const last = i === all.length - 1;
    const inner = item.hash && !last ? `<a href="${esc(item.hash)}">${esc(item.label)}</a>` : `<span${last ? ' aria-current="page"' : ''}>${esc(item.label)}</span>`;
    return inner + (last ? '' : icon('chevron-right', 'i-sm crumb-sep'));
  }).join('');
  return `
  <header class="ph">
    <div class="ph-main">
      ${crumbs ? `<nav class="ph-crumbs" aria-label="Breadcrumb">${crumbs}</nav>` : ''}
      <div class="ph-titlerow"><h1 class="ph-title">${esc(o.title || '')}</h1>${o.meta ? `<span class="ph-meta">${o.meta}</span>` : ''}</div>
      ${o.subtitle ? `<p class="ph-sub">${esc(o.subtitle)}</p>` : ''}
    </div>
    ${o.actions ? `<div class="ph-actions">${o.actions}</div>` : ''}
  </header>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   RENDER
   ══════════════════════════════════════════════════════════════════════════ */
let lastOverlayHtml = '';
function render() {
  const active = document.activeElement;
  const focusId = active && active.id && page().contains(active) ? active.id : null;
  const ovId = active && active.id && $('overlayHost').contains(active) ? active.id : null;
  let focusSel = null;
  if (!focusId && active && active.getAttribute && page().contains(active)) {
    const da = active.getAttribute('data-act');
    const did = active.getAttribute('data-id');
    const dk = active.getAttribute('data-key');
    if (da && did) focusSel = `[data-act="${CSS.escape(da)}"][data-id="${CSS.escape(did)}"]`;
    else if (dk) focusSel = `[data-key="${CSS.escape(dk)}"]`;
  }
  const caret = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;

  let html = '';
  switch (S.route.name) {
    case 'record':     html = viewRecord(); break;
    case 'tests':      html = viewTests(); break;
    case 'test':       html = viewTestDetail(); break;
    case 'executions': html = viewExecutions(); break;
    case 'settings':   html = viewSettings(); break;
    case 'environments': html = viewEnvironments(); break;
    case 'trash':      html = viewTrash(); break;
    case 'run':        html = viewRun(); break;
    default:           html = viewHome();
  }
  overlayBeforePaint();
  page().innerHTML = html;
  const ovHtml = (S.lightbox ? viewLightbox() : '') + (S.overlay ? viewOverlay() : '');
  // Rebuild the overlay only when it really changed: re-creating an unchanged modal on every
  // render replayed its enter animation, dropped focus, and threw away what was typed into it.
  if (ovHtml !== lastOverlayHtml) { $('overlayHost').innerHTML = ovHtml; lastOverlayHtml = ovHtml; }
  overlayAfterPaint();
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
  if (ovId) { const n = $(ovId); if (n) n.focus(); }
  if (focusSel) { const n = page().querySelector(focusSel); if (n) n.focus(); }
  if (S.overlay && S.overlay.focusCancel) { S.overlay.focusCancel = false; const c = $('modalCancel'); if (c) c.focus(); }
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

/* ── Action registry: view files register their own data-act handlers here ──
 * ACTIONS[act](trigger, event) for clicks; INPUTS[act](node, value, event) for input events.
 * A registered handler wins over the legacy switch in actions.js. */
const ACTIONS = Object.create(null);
const INPUTS = Object.create(null);

function prefGet(key, dflt) {
  const v = lsGet('tf.pref.' + key);
  return v == null ? !!dflt : v === '1';
}
function prefSet(key, on) { lsSet('tf.pref.' + key, on ? '1' : '0'); }

/* ══════════════════════════════════════════════════════════════════════════
   VIEW — RECORD  (Setup → Record → Review → Save)
   ══════════════════════════════════════════════════════════════════════════ */

/** Which of the four stages we are on, derived from the live recorder status. */
