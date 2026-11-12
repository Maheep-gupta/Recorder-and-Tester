/* Actions and boot: step operations, recording/run commands, shell drawer, delegated events.
 * Part of the UI bundle: classic scripts loaded in order from index.html, sharing one global
 * scope (state S, helpers, render). Load last: it boots the app.
 */
'use strict';

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
  const appKey = S.recForm.app == null ? cfg.defaultApp : S.recForm.app;
  if (!describeTarget(appKey)) {
    toast('Enter a full http:// or https:// application URL first', 'bad');
    return;
  }
  const username = String(S.recForm.username || '').trim();
  const password = S.recForm.password || '';
  if (!!username !== !!password) {
    toast('Enter both a username and a password, or leave both blank', 'bad');
    return;
  }
  S.launching = true;
  render();
  announce('Starting the browser.');
  toast('Starting the browser — this takes a few seconds.');
  await guard(() => api('POST', '/api/recording/start',
      { app: appKey, headed: true, browser: S.recForm.browser, viewport: S.recForm.viewport,
        ...(username ? { username, password } : {}) }),
    'Could not start recording. Check the app is running, then try again');
  // The server has saved the login by now (it does so before the session check), so drop the
  // password from page memory and pick up the new "saved login" state.
  if (username) {
    S.recForm.password = '';
    try { S.config = await api('GET', '/api/config'); } catch { /* keep the old config */ }
  }
  S.launching = false;
  render();
}
async function forgetLogin() {
  const appKey = S.recForm.app || (S.config && S.config.defaultApp);
  const done = await guard(() => api('DELETE', '/api/logins', { app: appKey }), 'Could not forget the saved login');
  if (done === undefined) return;
  S.config.savedLogins = done.savedLogins || [];
  try { S.config = await api('GET', '/api/config'); } catch { /* keep what we have */ }
  toast('Saved login forgotten', 'good');
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
  S.saveForm = blankSaveForm();
  await loadTests();
  go('#/tests');
}

function bugFromForm(f) {
  const expected = String(f.bugExpected || '').trim(), actual = String(f.bugActual || '').trim(), severity = f.bugSeverity || '';
  if (!expected && !actual && !severity) return null;
  const bug = { expected, actual };
  if (severity) bug.severity = severity;
  return bug;
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
    ...(bugFromForm(f) ? { bug: bugFromForm(f) } : {}),
  }), 'Could not save the test — the recorded steps are still here, so you can try again');
  S.saving = false;
  if (!saved) { render(); return; }
  toast(`Saved "${saved.name}" — ${(saved.steps || []).length} steps`, 'good');
  const runAfter = f.runAfter;
  S.recStage = null; S.recSel = null;
  S.saveForm = blankSaveForm();
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

async function runTest(id, app, confirmProtected) {
  S.live = normaliseRun({ testId: id, app, status: 'starting', steps: [], startedAt: new Date().toISOString() });
  S.runStepsOpen = false;
  S.cancelling = false;
  S.overlay = null;
  announce('Starting the browser.');
  // The picker defaults to where the test was recorded, so a run from a picker always names its
  // target. Row menus / Run Again send no app and the server resolves the recorded one.
  const body = {};
  if (app) body.app = app;
  if (confirmProtected) body.confirmProtected = true;
  try {
    await api('POST', `/api/tests/${id}/run`, body);
    if (S.live && S.live.testId === id && !(S.route.name === 'run' && S.route.runId === 'live')) go('#/run/' + id + '/live');
  } catch (e) {
    S.live = null;
    if (S.route.name === 'run') go('#/test/' + id);
    if (e.status === 428 && e.code === 'confirm-protected') {
      openProtectedModal(id, app, (e.body && e.body.target) || envInfo(app));
    } else {
      toast('Could not start the run. Check nothing else is running, then try again: ' + e.message, 'bad');
    }
  }
}

function openProtectedModal(id, app, target) {
  const label = (target && (target.label || target.key)) || app || 'this environment';
  const baseUrl = (target && target.baseUrl) || '';
  S.overlay = {
    kind: 'modal', title: 'Run against a protected environment', danger: true, focusCancel: true,
    confirmAct: 'confirm-protected-run', confirmLabel: 'Run against ' + label,
    confirmData: { id, app: app || '' },
    body: `<p>You are about to replay this test against <b>${esc(label)}</b> (<span class="mono">${esc(baseUrl)}</span>),
      a PRODUCTION/protected environment. Recorded steps (clicks, form submits, deletes) will really happen there.</p>`,
  };
  render();
}

async function cancelRun() {
  if (S.cancelling) return;
  S.cancelling = true;
  render();
  try { await api('POST', '/api/run/cancel'); toast('Cancelling the run…'); }
  catch (e) { S.cancelling = false; toast('Could not cancel: ' + e.message, 'bad'); render(); }
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
  let failed = 0;
  for (const id of ids) {
    try { await api('DELETE', '/api/tests/' + id); delete S.libSelection[id]; }
    catch { failed++; }
  }
  const done = ids.length - failed;
  if (failed) toast(`Deleted ${done} of ${ids.length}; ${failed} failed`, 'bad');
  else toast(`Deleted ${ids.length} ${ids.length === 1 ? 'test' : 'tests'}`, 'good');
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

  if (ACTIONS[act]) { ACTIONS[act](trigger, event); return; }
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
    case 'forget-login': forgetLogin(); break;
    case 'stop-rec': stopRecording(); break;
    case 'open-panel': openRecorderPanel(); break;
    case 'pause-rec': pauseRecording(); break;
    case 'resume-rec': resumeRecording(); break;
    case 'discard-draft': discardDraft(); break;
    case 'goto-save': S.recStage = 'save'; if (!S.saveForm.name) S.saveForm.name = S.recForm.name; render(); break;
    case 'goto-review': S.recStage = null; render(); break;
    case 'save-draft': saveDraft(); break;
    case 'pick-env': S.recForm.app = trigger.getAttribute('data-url'); render(); break;
    case 'recovered-save': saveRecovered(); break;
    case 'recovered-discard': discardRecovered(); break;
    case 'remove-tag':
      S.saveForm.tags = S.saveForm.tags.filter((x) => x !== trigger.getAttribute('data-tag'));
      render(); break;

    /* tests */
    case 'run-test': closeMenu(); runTest(id, trigger.getAttribute('data-app') || undefined); break;
    case 'save-test': saveTest(); break;
    case 'cancel-run': cancelRun(); break;
    case 'confirm-protected-run': { const o = S.overlay; if (o && o.confirmData) runTest(o.confirmData.id, o.confirmData.app || undefined, true); break; }
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
    default: break;
  }
});

/* Scrim closes the mobile drawer; so does following any nav link. */
$('scrim').addEventListener('click', () => closeDrawer());
$('nav').addEventListener('click', (e) => { if (e.target.closest('a')) closeDrawer(); });

/* Crossing the mobile breakpoint changes the layout, so re-render at the boundary. */
try { mobileMQ.addEventListener('change', onViewportChange); }
catch { window.addEventListener('resize', onViewportChange); }

/* The Setup form's URL and login hints depend on what was typed; refresh them once the field is
   committed (blur, Enter, or a pick from the suggestion list), not per keystroke. */
document.addEventListener('change', (event) => {
  if (['recApp', 'recUser', 'recPass', 'setAppUrl'].includes(event.target.id)) render();
});

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
  if (INPUTS[act]) { INPUTS[act](node, value, event); return; }

  switch (act) {
    // The URL and login boxes do NOT re-render per keystroke: that would rebuild the input and
    // close the suggestion list mid-typing. The hints below them refresh on `change` instead.
    case 'rec-form': S.recForm[field] = value; break;
    // Belongs on the input listener, not the click one: a <select> never fires click when the
    // value changes, so the Execute button kept its original target and the choice did nothing.
    case 'run-target': S.runTarget = value || null; render(); break;
    case 'save-form': S.saveForm[field] = value; break;
    case 'recovered-name': if (S.recovered) S.recovered.saveName = value; break;
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

/* ══════════════════════════════════════════════════════════════════════════
   ACCESSIBILITY — dialog focus trap + focus return, tablist keys
   The page is rebuilt by render(), so a node reference does not survive; openers are remembered
   as a selector and found again afterwards.
   ══════════════════════════════════════════════════════════════════════════ */
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function describeEl(el) {
  if (!el || el === document.body || !el.getAttribute) return null;
  if (el.id) return '#' + CSS.escape(el.id);
  const act = el.getAttribute('data-act');
  if (!act) return null;
  let sel = `[data-act="${CSS.escape(act)}"]`;
  for (const a of ['data-id', 'data-app', 'data-tab', 'data-theme', 'data-filter', 'data-view', 'data-key', 'data-test', 'data-run']) {
    const v = el.getAttribute(a);
    if (v != null) { sel += `[${a}="${CSS.escape(v)}"]`; break; }
  }
  return sel;
}

/** The innermost open dialog: a modal/palette in the overlay host, or the environment side panel. */
function activeDialog() {
  const host = $('overlayHost');
  const inHost = host && host.querySelectorAll('[role="dialog"]');
  if (inHost && inHost.length) return inHost[inHost.length - 1];
  return document.querySelector('.env-panel[role="dialog"]');
}
function dialogOpen() { return !!activeDialog(); }

let lastOpenerSel = null;
let dialogWasOpen = false;
let dialogOpener = null;
document.addEventListener('click', (e) => { const t = e.target.closest && e.target.closest('button, a[href], [data-act]'); if (t && !t.closest('[role="dialog"]')) lastOpenerSel = describeEl(t); }, true);
document.addEventListener('keydown', (e) => { if (!dialogOpen()) lastOpenerSel = describeEl(document.activeElement) || lastOpenerSel; }, true);

function syncDialogFocus() {
  const dlg = activeDialog();
  if (dlg && !dialogWasOpen) {
    dialogOpener = lastOpenerSel;
    if (!dlg.contains(document.activeElement)) {
      const first = dlg.querySelector(FOCUSABLE);
      (first || dlg).focus();
    }
  } else if (!dlg && dialogWasOpen) {
    const a = document.activeElement;
    if (!a || a === document.body || !document.contains(a)) {
      let n = null;
      try { n = dialogOpener && document.querySelector(dialogOpener); } catch { /* bad selector */ }
      if (n && n.focus) n.focus();
    }
    dialogOpener = null;
  }
  dialogWasOpen = !!dlg;
}

/* Roving tabindex: only the selected tab is in the Tab order; arrows move between tabs. */
function syncTablists() {
  document.querySelectorAll('[role="tablist"]').forEach((list) => {
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    if (!tabs.length) return;
    const sel = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
    tabs.forEach((t) => t.setAttribute('tabindex', t === sel ? '0' : '-1'));
  });
}

(function watchDom() {
  let queued = false;
  const run = () => { queued = false; syncDialogFocus(); syncTablists(); };
  const obs = new MutationObserver(() => { if (!queued) { queued = true; Promise.resolve().then(run); } });
  ['page', 'overlayHost'].forEach((id) => { const n = $(id); if (n) obs.observe(n, { childList: true, subtree: true }); });
  run();
})();

document.addEventListener('keydown', (event) => {
  // Focus trap: Tab cycles inside the open dialog instead of escaping to the page behind it.
  if (event.key === 'Tab') {
    // Modals and the palette are trapped by overlays.js; this covers the remaining dialogs (env panel).
    if (S.overlay || S.lightbox) return;
    const dlg = activeDialog();
    if (!dlg) return;
    const items = Array.from(dlg.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) { event.preventDefault(); dlg.focus(); return; }
    const first = items[0], last = items[items.length - 1], cur = document.activeElement;
    if (!dlg.contains(cur)) { event.preventDefault(); first.focus(); }
    else if (event.shiftKey && (cur === first || cur === dlg)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && cur === last) { event.preventDefault(); first.focus(); }
    return;
  }
  // Tablist: Left/Right/Home/End move between [role=tab] siblings and select them.
  const tab = event.target.closest && event.target.closest('[role="tab"]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const list = tab.closest('[role="tablist"]');
  if (!list) return;
  const tabs = Array.from(list.querySelectorAll('[role="tab"]')).filter((t) => !t.disabled);
  const i = tabs.indexOf(tab);
  let next = i;
  if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else next = tabs.length - 1;
  event.preventDefault();
  event.stopPropagation();
  const target = tabs[next];
  // The page is rebuilt on selection, so find the tab again by its position, not by a data-act
  // selector (an "Edit" button elsewhere can carry the same data-act/data-tab).
  const lists = Array.from(document.querySelectorAll('[role="tablist"]'));
  const li = lists.indexOf(list), ti = Array.from(list.querySelectorAll('[role="tab"]')).indexOf(target);
  target.click();
  const again = document.querySelectorAll('[role="tablist"]')[li];
  const n = again && again.querySelectorAll('[role="tab"]')[ti];
  (n || target).focus();
});

/* Global keyboard */
document.addEventListener('keydown', (event) => {
  const ae = document.activeElement;
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(ae && ae.tagName) || !!(ae && ae.isContentEditable);

  if (event.key === 'Escape') {
    if (S.lightbox) { S.lightbox = null; render(); return; }
    if (S.overlay) { S.overlay = null; render(); return; }
    if (S.envForm) { S.envForm = null; S.envError = null; render(); return; }
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

  // Shortcuts below must never fire while typing, behind a dialog/palette, or with a modifier held.
  if (inField || dialogOpen() || S.overlay || S.envForm) return;

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

  // Bare-key shortcuts (/, n, g-chords, ?) and Ctrl+K live in overlays.js (onShellKeydown) only.
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
    S.recForm.app = appBaseUrl(S.config.defaultApp) || S.config.defaultApp;
  } catch (e) {
    toast('Cannot reach the Replayr service: ' + e.message, 'bad');
  }
  refreshFolders();
  await loadTests();
  await loadStats();
  await onRouteChange();
  connectEvents();
})();

