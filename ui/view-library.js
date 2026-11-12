/* Views: Test library and execution history.
 * Part of the UI bundle: classic scripts loaded in order from index.html, sharing one global
 * scope (state S, helpers, render).
 */
'use strict';

/* View state owned by this file (defaults only; S itself lives in core.js). */
Object.assign(S, {
  libApp: 'all',            // application filter: 'all' or an application name
  libTag: 'all',            // tag filter
  libSort: 'updated',       // updated | name | lastrun | status | created
  libGroup: false,          // group rows by application
  execStatus: 'all',        // Executions: status filter
  execEnv: 'all',           // Executions: environment key filter
  _envsAsked: false, _runsAsked: false, _testsSeenLoading: false, _testsLoaded: false,
});

/* ── Shared helpers (also used by view-test.js / view-run.js) ──────────────── */

/** The environment record for a test's `target.app` (a key, or `url:<base>`), or null. */
function envFor(app) {
  if (!app) return null;
  const envs = S.envs || [];
  const byKey = envs.find((e) => e.key === app);
  if (byKey) return byKey;
  const base = String(app).replace(/^url:/, '').replace(/\/+$/, '');
  const byUrl = envs.find((e) => String(e.baseUrl || '').replace(/\/+$/, '') === base);
  if (byUrl) return byUrl;
  const d = describeTarget(app);
  return d ? { ...d, application: d.application || 'Other' } : null;
}
/** Application a test belongs to = the application of its recorded environment. */
function appOf(t) {
  const e = envFor(t && t.target && t.target.app);
  return (e && e.application) || 'Other';
}
/** Environment badge followed by its name. `env` is an environment-like object or null. */
function envTag(env, opts) {
  if (!env) return '<span class="subtle">unknown</span>';
  const o = opts || {};
  return `<span class="env-tag">${envBadge(env.kind)}${o.noLabel ? '' : `<span class="env-tag-name truncate">${esc(env.label || env.key || '')}</span>`}</span>`;
}

const REASON_SHORT = {
  no_assertions: 'no assertion', steps_skipped: 'steps skipped', assertion_failed: 'assertion failed',
  element_not_found: 'element not found', element_ambiguous: 'ambiguous element', step_failed: 'step failed',
  app_unreachable: 'app unreachable', browser_error: 'browser error', timeout: 'timed out',
  internal_error: 'internal error', auth_failed: 'sign-in failed', cancelled: 'cancelled',
  interrupted: 'interrupted', assertions_passed: 'assertions held',
};
function reasonShort(reason) { return REASON_SHORT[reason] || (reason ? String(reason).replace(/_/g, ' ') : ''); }

/** Result cell: status pill and, when there is one, the short reason beside it. */
function resultCell(status, reason) {
  const r = reasonShort(reason);
  return `<span class="lib-result">${statusPill(status)}${r && status !== 'passed' ? `<span class="lib-reason truncate">${esc(r)}</span>` : ''}</span>`;
}

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
function sevDot(sev) {
  if (!sev) return '';
  return `<span class="sev-dot sev-${esc(sev)}" title="Bug severity: ${esc(sev)}" role="img" aria-label="Bug severity ${esc(sev)}"></span>`;
}

/** Last <=5 runs of a test, oldest first, from the already-loaded cross-test history. */
function recentStatuses(t) {
  const runs = (S.allRuns || []).filter((r) => r.testId === t.id).slice(0, 5).map((r) => r.status).reverse();
  if (runs.length) return runs;
  return t.lastRun ? [t.lastRun.status] : [];
}
function spark(statuses) {
  if (!statuses.length) return '<span class="subtle">—</span>';
  return `<span class="spark" aria-label="Recent runs: ${esc(statuses.join(', '))}">${
    statuses.map((s) => `<i class="sd sd-${esc(s)}" title="${esc(STATUS_LABEL[s] || s)}"></i>`).join('')}</span>`;
}

/** One-shot background loads. Idempotent: safe to call from inside a render. */
function ensureEnvsOnce() {
  if (S.envs || S._envsAsked) return;
  S._envsAsked = true;
  loadEnvironments().then(() => scheduleRender());
}
function ensureRunsOnce() {
  if (S.allRuns || S._runsAsked) return;
  S._runsAsked = true;
  loadAllRuns().then(() => scheduleRender());
}

/* ══════════════════════════════════════════════════════════════════════════
   VIEW - TEST LIBRARY
   ══════════════════════════════════════════════════════════════════════════ */
function viewTests() {
  ensureEnvsOnce(); ensureRunsOnce();
  if (S.loadingTests) S._testsSeenLoading = true;
  else if (S._testsSeenLoading) S._testsLoaded = true;

  if (!libTests().length) {
    if (S.loadingTests || !S._testsLoaded) return libraryShell('', libSkeleton());
    return viewEmptyState();
  }

  const rows = libraryRows();
  const selectedCount = Object.keys(S.libSelection).filter((k) => S.libSelection[k]).length;
  const body = S.libTab === 'folders' ? foldersPanel() : S.libView === 'grid' ? libraryGrid(rows) : libraryTable(rows);
  return libraryShell(libToolbar(rows, selectedCount), body);
}

function libraryShell(toolbar, body) {
  const favourites = libTests().filter((t) => t.favorite).length;
  return `
  ${pageHeader({
    title: 'Test Library',
    subtitle: 'Bugs recorded on one environment, replayed on another to verify the fix.',
    actions: `<button class="btn" data-act="import-test">${icon('import', 'i-sm')}Import</button>
      <button class="btn btn-primary" data-act="start-recording">${icon('plus', 'i-sm')}New Recording</button>`,
  })}
  ${libTests().length ? `<div class="tabs" role="tablist">
    <button role="tab" aria-selected="${S.libTab === 'all'}" data-act="lib-tab" data-tab="all">All Tests <span class="count">(${libTests().length})</span></button>
    <button role="tab" aria-selected="${S.libTab === 'favorites'}" data-act="lib-tab" data-tab="favorites">Favorites <span class="count">(${favourites})</span></button>
    <button role="tab" aria-selected="${S.libTab === 'folders'}" data-act="lib-tab" data-tab="folders">Folders <span class="count">(${S.folders.length})</span></button>
  </div>` : ''}
  ${toolbar}
  ${body}`;
}

function applications() {
  const set = new Set();
  (S.envs || []).forEach((e) => set.add(e.application || 'Default'));
  libTests().forEach((t) => set.add(appOf(t)));
  return [...set].sort((a, b) => a.localeCompare(b));
}
function allTags() {
  const set = new Set();
  libTests().forEach((t) => (t.tags || []).forEach((x) => set.add(x)));
  return [...set].sort((a, b) => a.localeCompare(b));
}

function libToolbar(rows, selectedCount) {
  if (S.libTab === 'folders') return '';
  const apps = applications(), tags = allTags();
  const filtered = S.libFilter !== 'all' || S.libApp !== 'all' || S.libTag !== 'all' || S.search || S.libFolder;
  return `
  <div class="lib-toolbar" role="search">
    <label class="lib-search">${icon('search', 'i-sm')}
      <input id="libSearch" class="field" type="search" placeholder="Search name, description, tags…" value="${esc(S.search)}"
             data-act="lib-search" aria-label="Search tests" autocomplete="off"></label>
    <select class="field" data-act="lib-status" aria-label="Filter by last result">
      ${[['all', 'Any result'], ['passed', 'Passed'], ['failed', 'Failed'], ['blocked', 'Blocked'], ['inconclusive', 'Inconclusive'],
        ['error', 'Error'], ['cancelled', 'Cancelled'], ['never', 'Never run']]
        .map(([v, l]) => `<option value="${v}"${S.libFilter === v ? ' selected' : ''}>${l}</option>`).join('')}
    </select>
    <select class="field" data-act="lib-app" aria-label="Filter by application">
      <option value="all">All applications</option>
      ${apps.map((a) => `<option value="${esc(a)}"${S.libApp === a ? ' selected' : ''}>${esc(a)}</option>`).join('')}
    </select>
    ${tags.length ? `<select class="field" data-act="lib-tag" aria-label="Filter by tag">
      <option value="all">All tags</option>
      ${tags.map((a) => `<option value="${esc(a)}"${S.libTag === a ? ' selected' : ''}>${esc(a)}</option>`).join('')}
    </select>` : ''}
    <select class="field" data-act="lib-sort" aria-label="Sort by">
      ${[['updated', 'Sort: Recently updated'], ['name', 'Sort: Name'], ['lastrun', 'Sort: Last run'], ['status', 'Sort: Status (worst first)'], ['created', 'Sort: Created']]
        .map(([v, l]) => `<option value="${v}"${S.libSort === v ? ' selected' : ''}>${l}</option>`).join('')}
    </select>
    <span class="grow"></span>
    <button class="btn btn-sm ${S.libGroup ? 'btn-secondary' : 'btn-ghost'}" data-act="lib-group" aria-pressed="${!!S.libGroup}">${icon('layers', 'i-sm')}Group by application</button>
    <div class="seg" role="group" aria-label="View">
      <button data-act="lib-view" data-view="list" aria-pressed="${S.libView === 'list'}" title="Table view" aria-label="Table view">${icon('rows', 'i-sm')}</button>
      <button data-act="lib-view" data-view="grid" aria-pressed="${S.libView === 'grid'}" title="Grid view" aria-label="Grid view">${icon('grid', 'i-sm')}</button>
    </div>
  </div>
  ${S.libFolder ? `<div class="note info lib-note">${icon('folder', 'i-sm')}<span>Showing the <b>${esc(S.libFolder)}</b> folder</span>
      <span class="grow"></span><button class="btn btn-sm btn-ghost" data-act="clear-folder">Show all folders</button></div>` : ''}
  <div class="lib-count meta" aria-live="polite">${rows.length} of ${libTests().length} ${libTests().length === 1 ? 'test' : 'tests'}${
    filtered ? ` <button class="btn btn-sm btn-ghost" data-act="lib-reset">Reset filters</button>` : ''}</div>
  ${selectedCount ? `<div class="lib-bulk" role="status">
      <b>${selectedCount} selected</b><span class="grow"></span>
      <button class="btn btn-sm btn-ghost" data-act="lib-clear-sel">Clear</button>
      <button class="btn btn-sm btn-danger-outline" data-act="delete-selected">${icon('trash', 'i-sm')}Delete ${selectedCount}</button>
    </div>` : ''}`;
}

const STATUS_ORDER = { failed: 0, error: 1, blocked: 2, inconclusive: 3, cancelled: 4, passed: 5, never: 6 };

/** The rows that survive the tab, every filter and the search; in the chosen sort order. */
function libraryRows() {
  const q = S.search.trim().toLowerCase();
  const rows = libTests().filter((t) => {
    if (S.libTab === 'favorites' && !t.favorite) return false;
    // A folder is a field on the test, so it is filtered as one (not typed into the search box).
    if (S.libFolder && t.folder !== S.libFolder) return false;
    if (q && !((t.name || '') + ' ' + (t.description || '') + ' ' + (t.tags || []).join(' ')).toLowerCase().includes(q)) return false;
    const status = t.lastRun ? t.lastRun.status : 'never';
    if (S.libFilter !== 'all' && S.libFilter !== status) return false;
    if (S.libApp !== 'all' && appOf(t) !== S.libApp) return false;
    if (S.libTag !== 'all' && !(t.tags || []).includes(S.libTag)) return false;
    return true;
  });
  const ts = (v) => (v ? new Date(v).getTime() || 0 : 0);
  const cmp = {
    name: (a, b) => (a.name || '').localeCompare(b.name || ''),
    lastrun: (a, b) => ts(b.lastRun && b.lastRun.at) - ts(a.lastRun && a.lastRun.at),
    status: (a, b) => (STATUS_ORDER[a.lastRun ? a.lastRun.status : 'never'] ?? 9) - (STATUS_ORDER[b.lastRun ? b.lastRun.status : 'never'] ?? 9)
      || (a.name || '').localeCompare(b.name || ''),
    created: (a, b) => ts(b.createdAt) - ts(a.createdAt),
    updated: (a, b) => ts(b.updatedAt) - ts(a.updatedAt),
  }[S.libSort] || (() => 0);
  return rows.sort(cmp);
}

function libSkeleton() {
  const row = `<tr class="lib-skel"><td></td><td><span class="skeleton" style="width:55%;height:13px"></span><span class="skeleton" style="width:80%;height:10px;margin-top:8px"></span></td>
    <td><span class="skeleton" style="width:70%;height:12px"></span></td><td><span class="skeleton" style="width:60%;height:12px"></span></td>
    <td><span class="skeleton" style="width:80px;height:20px"></span></td><td><span class="skeleton" style="width:60%;height:12px"></span></td>
    <td></td><td></td></tr>`;
  return `<div class="card tbl-wrap lib-card" role="status" aria-label="Loading tests"><table class="tbl lib-tbl">
    <tbody>${row.repeat(7)}</tbody></table></div>`;
}

/** Which optional columns fit. Omitted in markup (not display:none) so a group row's colspan stays exact. */
function libCols() {
  const w = window.innerWidth;
  return { src: w > 1180, spark: w > 1180, app: w > 900, steps: w > 900 };
}
function libRow(t, c) {
  const last = t.lastRun;
  const rec = envFor(t.target && t.target.app);
  const ran = last && last.app ? envFor(last.app) : null;
  const sev = (t.bug && t.bug.severity) || (S.testCache[t.id] && S.testCache[t.id].bug && S.testCache[t.id].bug.severity) || '';
  const cross = ran && rec && ran.key !== rec.key;
  return `
  <tr data-act="open-test" data-id="${esc(t.id)}" data-ctx="${esc(t.id)}" tabindex="0" class="${S.libSelection[t.id] ? 'is-selected' : ''}">
    <td class="cell-select"><input type="checkbox" data-act="select-row" data-id="${esc(t.id)}" ${S.libSelection[t.id] ? 'checked' : ''} aria-label="Select ${esc(t.name)}"></td>
    <td class="lib-c-name">
      <div class="lib-name">${sevDot(sev)}${t.favorite ? `<span class="lib-fav" title="Favorite">${icon('star', 'i-sm')}</span>` : ''}<span class="truncate lib-title">${esc(t.name)}</span></div>
      ${t.description ? `<div class="meta truncate lib-desc">${esc(t.description)}</div>` : ''}
      ${(t.tags && t.tags.length) ? `<div class="lib-tags">${t.tags.slice(0, 3).map((x) => `<span class="tag">${esc(x)}</span>`).join('')}${
        t.tags.length > 3 ? `<span class="meta">+${t.tags.length - 3}</span>` : ''}</div>` : ''}
    </td>
    ${c.app ? `<td class="lib-c-app"><span class="truncate">${esc(appOf(t))}</span></td>` : ''}
    ${c.src ? `<td class="lib-c-src">${envTag(rec)}</td>` : ''}
    <td class="lib-c-res">${last ? resultCell(last.status, last.reason) : statusPill('never')}</td>
    <td class="lib-c-run">${last ? `<div>${timeAgo(last.at)}</div>
      <div class="meta lib-ranon">${ran ? `${cross ? '<span class="lib-arrow" title="Replayed on a different environment than it was recorded on">&rarr;</span>' : ''}${envTag(ran)}` : ''}</div>` : '<span class="subtle">Never</span>'}</td>
    ${c.spark ? `<td class="lib-c-spark">${spark(recentStatuses(t))}</td>` : ''}
    ${c.steps ? `<td class="lib-c-steps tnum">${esc(t.stepCount)}</td>` : ''}
    <td class="cell-actions lib-actions">
      <span class="lib-hover">
        <button class="btn-icon" data-act="run-test" data-id="${esc(t.id)}" aria-label="Execute ${esc(t.name)}" data-tip="Execute">${icon('play', 'i-sm')}</button>
        <button class="btn-icon" data-act="row-menu" data-id="${esc(t.id)}" aria-label="Actions for ${esc(t.name)}">${icon('dots')}</button>
      </span>
    </td>
  </tr>`;
}

function libraryTable(rows) {
  if (!rows.length) return emptyFilterPanel();
  const allChecked = rows.every((t) => S.libSelection[t.id]);
  const c = libCols();
  const ncols = 5 + (c.app ? 1 : 0) + (c.src ? 1 : 0) + (c.spark ? 1 : 0) + (c.steps ? 1 : 0);
  let body = '';
  if (S.libGroup) {
    const groups = new Map();
    rows.forEach((t) => { const a = appOf(t); if (!groups.has(a)) groups.set(a, []); groups.get(a).push(t); });
    for (const [app, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const bad = list.filter((t) => t.lastRun && (t.lastRun.status === 'failed' || t.lastRun.status === 'error')).length;
      body += `<tr class="lib-group"><th colspan="${ncols}" scope="colgroup">${icon('layers', 'i-sm')}${esc(app)}
        <span class="meta">${list.length} ${list.length === 1 ? 'test' : 'tests'}${bad ? ` &middot; <span class="lib-bad">${bad} failing</span>` : ''}</span></th></tr>`;
      body += list.map((t) => libRow(t, c)).join('');
    }
  } else body = rows.map((t) => libRow(t, c)).join('');
  return `
  <div class="card tbl-wrap lib-card">
    <table class="tbl lib-tbl" aria-label="Recorded tests">
      <thead><tr>
        <th class="cell-select"><input type="checkbox" data-act="select-all" ${allChecked ? 'checked' : ''} aria-label="Select all listed tests"></th>
        <th>Test</th>${c.app ? '<th class="lib-c-app">Application</th>' : ''}${c.src ? '<th class="lib-c-src">Recorded on</th>' : ''}
        <th class="lib-c-res">Last result</th><th class="lib-c-run">Last run</th>${c.spark ? '<th class="lib-c-spark">History</th>' : ''}
        ${c.steps ? '<th class="lib-c-steps">Steps</th>' : ''}<th class="cell-actions" aria-label="Actions"></th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function libraryGrid(rows) {
  if (!rows.length) return emptyFilterPanel();
  return `<div class="lib-grid">
    ${rows.map((t) => {
      const rec = envFor(t.target && t.target.app);
      return `
      <div class="card lib-tile" role="button" tabindex="0" data-act="open-test" data-id="${esc(t.id)}" data-ctx="${esc(t.id)}">
        <div class="row"><span class="truncate lib-title">${t.favorite ? icon('star', 'i-sm') : ''}${esc(t.name)}</span><span class="grow"></span>
          <button class="btn-icon" data-act="row-menu" data-id="${esc(t.id)}" aria-label="Actions for ${esc(t.name)}">${icon('dots')}</button></div>
        <div class="meta lib-desc2">${esc(t.description || 'No description')}</div>
        <div class="row wrap" style="gap:6px">${t.lastRun ? resultCell(t.lastRun.status, t.lastRun.reason) : statusPill('never')}</div>
        <div class="row meta" style="gap:8px">${envTag(rec)}${sepdot}<span>${esc(t.stepCount)} steps</span>${sepdot}<span>${t.lastRun ? relTime(t.lastRun.at).label : 'never run'}</span></div>
      </div>`;
    }).join('')}
  </div>`;
}

function emptyFilterPanel() {
  const hasFilter = S.libFilter !== 'all' || S.libApp !== 'all' || S.libTag !== 'all' || S.search || S.libFolder;
  return `<div class="card empty lib-empty">
    <div class="art">${icon('search', 'i-lg')}</div>
    <h2>${S.libTab === 'favorites' && !hasFilter ? 'No favorites yet' : 'No tests match this view'}</h2>
    <p>${S.libTab === 'favorites' && !hasFilter ? 'Star a test from its actions menu and it will show up here.' : 'Nothing matches the current search and filters.'}</p>
    ${hasFilter ? `<button class="btn" data-act="lib-reset">Reset filters</button>` : ''}
  </div>`;
}

function foldersPanel() {
  if (!S.folders.length) {
    return `<div class="card empty lib-empty"><div class="art">${icon('folder', 'i-lg')}</div><h2>No folders yet</h2>
      <p>Folders group related tests, for example by feature.</p>
      <button class="btn" data-act="new-folder">${icon('folder-plus', 'i-sm')}New folder</button></div>`;
  }
  return `<div class="card">
    ${S.folders.map((f) => {
      const inFolder = libTests().filter((t) => t.folder === f);
      return `<div class="list-row" role="button" tabindex="0" data-act="folder-filter" data-folder="${esc(f)}"
              aria-current="${S.libFolder === f ? 'true' : 'false'}">
        <span class="tile sq grey">${icon('folder', 'i-sm')}</span>
        <span class="grow"><div class="nm">${esc(f)}</div>
          <div class="meta">${inFolder.length} ${inFolder.length === 1 ? 'test' : 'tests'}</div></span>
        ${icon('chevron-right', 'i-sm subtle')}
      </div>`;
    }).join('')}
  </div>
  <div style="margin-top:12px"><button class="btn btn-sm" data-act="new-folder">${icon('folder-plus', 'i-sm')}New folder</button></div>`;
}

/* ── Library handlers ───────────────────────────────────────────────────── */
INPUTS['lib-search'] = (node, value) => {
  S.search = value;
  const g = $('globalSearch'); if (g && g.value !== value) g.value = value;
  render();
};
INPUTS['lib-status'] = (n, v) => { S.libFilter = v; render(); };
INPUTS['lib-app'] = (n, v) => { S.libApp = v; render(); };
INPUTS['lib-tag'] = (n, v) => { S.libTag = v; render(); };
INPUTS['lib-sort'] = (n, v) => { S.libSort = v; render(); };
ACTIONS['lib-group'] = () => { S.libGroup = !S.libGroup; render(); };
ACTIONS['lib-clear-sel'] = () => { S.libSelection = {}; render(); };
ACTIONS['lib-reset'] = () => {
  S.libFilter = 'all'; S.libApp = 'all'; S.libTag = 'all'; S.search = ''; S.libFolder = null;
  const g = $('globalSearch'); if (g) g.value = '';
  render();
};
/* Right-click on a row opens the same menu as the row's "..." button, at the pointer. */
document.addEventListener('contextmenu', (event) => {
  const row = event.target.closest && event.target.closest('[data-ctx]');
  if (!row || S.route.name !== 'tests') return;
  event.preventDefault();
  const x = event.clientX, y = event.clientY;
  openTestMenu(row, row.getAttribute('data-ctx'));
  if (typeof menuNode !== 'undefined' && menuNode) {
    menuNode.style.left = Math.max(8, Math.min(x, window.innerWidth - menuNode.offsetWidth - 8)) + 'px';
    menuNode.style.top = Math.max(8, Math.min(y, window.innerHeight - menuNode.offsetHeight - 8)) + 'px';
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   VIEW - EXECUTIONS
   ══════════════════════════════════════════════════════════════════════════ */
/** What the run list does not carry (reason, target, cross-env) is read lazily, 4 at a time, quietly. */
const enriching = { active: 0, queue: [], seen: new Set() };
function enrichRuns(runs) {
  for (const r of runs.slice(0, 50)) {
    const key = r.testId + '/' + r.id;
    if (S.runCache[key] || enriching.seen.has(key)) continue;
    enriching.seen.add(key);
    enriching.queue.push(r);
  }
  pumpEnrich();
}
function pumpEnrich() {
  while (enriching.active < 4 && enriching.queue.length) {
    const r = enriching.queue.shift();
    enriching.active++;
    api('GET', `/api/tests/${encodeURIComponent(r.testId)}/runs/${encodeURIComponent(r.id)}`)
      .then((full) => { S.runCache[r.testId + '/' + r.id] = normaliseRun(full); })
      .catch(() => {})
      .finally(() => { enriching.active--; if (S.route.name === 'executions' || S.route.name === 'test') scheduleRender(); pumpEnrich(); });
  }
}
/** Merge a run-list row with whatever richer data is already cached or stamped on its test. */
function richRun(r) {
  const full = S.runCache[r.testId + '/' + r.id];
  if (full) return { ...r, reason: full.reason, target: full.target, recordedOn: full.recordedOn, crossEnv: full.crossEnv, summary: full.summary };
  const t = libTests().find((x) => x.id === r.testId);
  const stamp = t && t.lastRun && t.lastRun.runId === r.id ? t.lastRun : null;
  return stamp ? { ...r, reason: stamp.reason, summary: stamp.summary, target: stamp.app ? envFor(stamp.app) : null } : r;
}

function execFiltered(runs) {
  return runs.map(richRun).filter((r) => {
    if (S.execStatus !== 'all' && r.status !== S.execStatus) return false;
    if (S.execEnv !== 'all' && !(r.target && r.target.key === S.execEnv)) return false;
    return true;
  });
}

function viewExecutions() {
  ensureEnvsOnce();
  const runs = S.allRuns;
  if (runs && runs.length) setTimeout(() => enrichRuns(runs), 0);
  const list = runs ? execFiltered(runs) : [];
  const filtered = S.execStatus !== 'all' || S.execEnv !== 'all';
  const envOpts = (S.envs || []);
  return `
  ${pageHeader({
    title: 'Executions',
    subtitle: 'Every replay across all tests, newest first. Recorded on one environment, run on another.',
    actions: `<button class="btn" data-act="reload-runs" ${S.loadingRuns ? 'disabled' : ''}>
      ${icon('refresh', S.loadingRuns ? 'i-sm spinner' : 'i-sm')}${S.loadingRuns ? 'Refreshing…' : 'Refresh'}</button>`,
  })}
  ${S.runsError ? `<div class="note bad" role="alert" style="margin-bottom:12px">${icon('alert', 'i-sm')}
    <span><b>The execution history could not be read.</b> ${esc(S.runsError)}. Check the Replayr service is
    still running, then press Refresh.</span></div>` : ''}
  ${runs && runs.length ? `<div class="lib-toolbar">
    <select class="field" data-act="exec-status" aria-label="Filter by result">
      ${[['all', 'Any result'], ['passed', 'Passed'], ['failed', 'Failed'], ['blocked', 'Blocked'], ['inconclusive', 'Inconclusive'], ['error', 'Error'], ['cancelled', 'Cancelled']]
        .map(([v, l]) => `<option value="${v}"${S.execStatus === v ? ' selected' : ''}>${l}</option>`).join('')}
    </select>
    <select class="field" data-act="exec-env" aria-label="Filter by environment it ran on">
      <option value="all">Any environment</option>
      ${envOpts.map((e) => `<option value="${esc(e.key)}"${S.execEnv === e.key ? ' selected' : ''}>${esc(e.label || e.key)} (${esc(e.kind)})</option>`).join('')}
    </select>
    <span class="grow"></span>
    <span class="meta" aria-live="polite">${list.length} of ${runs.length} runs${
      filtered ? ` <button class="btn btn-sm btn-ghost" data-act="exec-reset">Reset filters</button>` : ''}</span>
  </div>` : ''}
  ${S.loadingRuns && !runs ? execSkeleton()
    : !runs ? `<div class="card empty-sm">No execution history yet.</div>`
    : !runs.length ? viewNoExecutions()
    : !list.length ? `<div class="card empty lib-empty"><div class="art">${icon('search', 'i-lg')}</div><h2>No runs match</h2>
        <p>No execution matches the selected result and environment.</p><button class="btn" data-act="exec-reset">Reset filters</button></div>`
    : `<div class="card tbl-wrap lib-card">
      <table class="tbl lib-tbl exec-tbl" aria-label="Execution history, newest first">
        <thead><tr>
          <th class="ex-c-res">Result</th><th>Test</th><th class="ex-c-env">Environment</th>
          <th class="ex-c-steps">Steps</th><th class="ex-c-dur">Duration</th><th class="ex-c-at">Started</th><th class="cell-actions" aria-label="Actions"></th>
        </tr></thead>
        <tbody>${list.map(execRow).join('')}</tbody>
      </table></div>`}`;
}

function execSkeleton() {
  const row = `<tr class="lib-skel"><td><span class="skeleton" style="width:80px;height:20px"></span></td><td><span class="skeleton" style="width:60%;height:13px"></span></td>
    <td><span class="skeleton" style="width:70%;height:12px"></span></td><td></td><td></td><td></td><td></td></tr>`;
  return `<div class="card tbl-wrap lib-card" role="status" aria-label="Loading executions"><table class="tbl lib-tbl"><tbody>${row.repeat(6)}</tbody></table></div>`;
}

function execRow(r) {
  const tg = r.target;
  const rec = r.recordedOn;
  const cross = r.crossEnv && rec && tg;
  const env = tg ? (envFor(tg.key) || tg) : null;
  return `
  <tr data-act="open-run" data-test="${esc(r.testId)}" data-run="${esc(r.id)}" tabindex="0">
    <td class="ex-c-res">${resultCell(r.status, r.reason)}</td>
    <td class="lib-c-name">
      <div class="truncate lib-title">${esc(r.testName || r.testId)}</div>
      ${r.status === 'failed' && r.failedStep ? `<div class="meta">failed at step ${esc(r.failedStep)}</div>` : ''}
    </td>
    <td class="ex-c-env">${env ? (cross
        ? `<span class="xenv" title="Recorded on ${esc(rec.label || rec.key)}, replayed on ${esc(tg.label || tg.key)}"><span class="xrow xrec">${envTag(recEnv(rec))}</span><span class="xrow"><span class="lib-arrow">&rarr;</span>${envTag(env)}</span></span>`
        : envTag(env)) : '<span class="subtle">—</span>'}</td>
    <td class="ex-c-steps meta tnum">${r.stepsPassed != null ? esc(r.stepsPassed) : '?'}/${r.stepCount != null ? esc(r.stepCount) : '?'}</td>
    <td class="ex-c-dur meta tnum">${esc(fmtDuration(r.durationMs))}</td>
    <td class="ex-c-at meta">${timeAgo(r.startedAt)}</td>
    <td class="cell-actions">
      <button class="btn-icon" data-act="run-menu" data-test="${esc(r.testId)}" data-run="${esc(r.id)}"
              aria-label="Actions for the ${esc(r.testName || r.testId)} run">${icon('dots')}</button>
    </td>
  </tr>`;
}
function recEnv(rec) { return envFor(rec.key) || rec; }

INPUTS['exec-status'] = (n, v) => { S.execStatus = v; render(); };
INPUTS['exec-env'] = (n, v) => { S.execEnv = v; render(); };
ACTIONS['exec-reset'] = () => { S.execStatus = 'all'; S.execEnv = 'all'; render(); };

function viewNoExecutions() {
  const hasTests = (libTests() || []).length > 0;
  return `
  <div class="card empty">
    <div class="art">
      <svg width="168" height="112" viewBox="0 0 168 112" fill="none" stroke="currentColor" stroke-width="1.5"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="14" y="18" width="140" height="76" rx="8"/><path d="M14 38h140"/>
        <circle cx="26" cy="28" r="2"/><circle cx="34" cy="28" r="2"/><circle cx="42" cy="28" r="2"/>
        <path d="M30 66h22l8-14 10 28 9-20 7 12h28"/>
      </svg>
    </div>
    <h2>No executions yet</h2>
    <p>${hasTests
      ? 'Run a test and every replay will be listed here with its verdict, the environment it ran on, and why.'
      : 'Record a bug first. Once you replay it on localhost, every run shows up here with its verdict.'}</p>
    ${hasTests
      ? `<button class="btn btn-primary btn-lg" data-act="nav" data-href="#/tests">${icon('tests')}Go to Test Library</button>`
      : `<button class="btn btn-primary btn-lg" data-act="start-recording">${icon('record')}Start Recording</button>`}
  </div>`;
}

/** Test rows that are real tests (storage can list a stray non-test JSON file as an empty row). */
function libTests() { return S.tests.filter((t) => t && t.id); }

/* Optional columns are decided in JS (libCols), so repaint when the viewport crosses a threshold. */
['(max-width:1180px)', '(max-width:900px)'].forEach((q) => window.matchMedia(q).addEventListener('change', () => {
  if (S.route.name === 'tests') scheduleRender();
}));
