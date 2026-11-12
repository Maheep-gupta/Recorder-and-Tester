/* View: Test detail and the run-target picker.
 * Part of the UI bundle: classic scripts loaded in order from index.html, sharing one global
 * scope (state S, helpers, render).
 */
'use strict';

/** Where the test was recorded: an environment record (or null when unknown). */
function recordedEnv(t) { return envFor(t && t.target && t.target.app); }

/**
 * Default run target: a LOCAL environment of the same application when one exists (the point of the
 * tool is to verify the fix on localhost), otherwise wherever the test was recorded.
 */
function defaultTargetKey(t) {
  const recorded = (t.target && t.target.app) || (S.config && S.config.defaultApp) || '';
  const rec = recordedEnv(t);
  if (rec && rec.kind !== 'local') {
    const local = (S.envs || []).find((e) => e.kind === 'local' && (e.application || 'Default') === (rec.application || 'Default'));
    if (local) return local.key;
  }
  return recorded;
}
function runTargetFor(t) {
  const chosen = S.runTarget;
  return chosen && runTargetOptions(t).some(([key]) => key === chosen) ? chosen : defaultTargetKey(t);
}
/* Every known environment (server list when loaded, else the config apps), plus the typed URL
   this test was recorded on when it is not one of them. */
function runTargetOptions(t) {
  const options = S.envs && S.envs.length
    ? S.envs.map((e) => [e.key, e])
    : Object.entries((S.config && S.config.apps) || {});
  const recorded = (t.target && t.target.app) || '';
  const def = recorded && describeTarget(recorded);
  if (def && !options.some(([key]) => key === def.key)) options.unshift([def.key, def]);
  return options;
}
function envInfo(key) {
  const found = (S.envs || []).find((e) => e.key === key);
  return found || describeTarget(key) || { key, label: key, baseUrl: '', kind: 'production', protected: true };
}

/** The always-visible SOURCE -> TARGET strip. The target is never hidden. */
function runTargetPicker(t) {
  const apps = runTargetOptions(t);
  const current = runTargetFor(t);
  const info = envInfo(current);
  const recKey = (t.target && t.target.app) || '';
  const rec = recordedEnv(t) || { kind: 'production', label: recKey || 'unknown', baseUrl: appBaseUrl(recKey) };
  const same = rec.key === info.key || recKey === current;
  // group the options by application
  const groups = new Map();
  apps.forEach(([key, a]) => {
    const g = a.application || 'Environments';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([key, a]);
  });
  const opt = ([key, a]) => `<option value="${esc(key)}"${key === current ? ' selected' : ''}>${esc(a.label || key)} · ${esc(a.kind || 'production')}${
    key === recKey ? ' (recorded here)' : ''}</option>`;
  return `
  <section class="env-strip" aria-label="Recorded environment and run target">
    <div class="es-side">
      <div class="es-label">Recorded on</div>
      <div class="es-env">${envTag(rec)}</div>
      <div class="es-url mono truncate" title="${esc(rec.baseUrl || '')}">${esc(rec.baseUrl || '')}</div>
    </div>
    <div class="es-arrow" aria-hidden="true">${icon('arrow-right')}</div>
    <div class="es-side es-target">
      <div class="es-label"><label for="runTarget">Run on</label></div>
      <div class="es-env">${envBadge(info.kind)}
        <select class="field" id="runTarget" data-act="run-target" title="Which environment to replay against">
          ${groups.size > 1
            ? [...groups].map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(opt).join('')}</optgroup>`).join('')
            : apps.map(opt).join('')}
        </select>
      </div>
      <div class="es-url mono truncate" title="${esc(info.baseUrl || '')}">${esc(info.baseUrl || '')}</div>
    </div>
    <div class="es-run">
      <button class="btn btn-primary btn-lg" data-act="run-test" data-id="${esc(t.id)}" data-app="${esc(current)}">
        ${icon('play', 'i-sm')}Run on ${esc(info.label || info.key)}</button>
    </div>
    <div class="es-note ${info.protected ? 'warn' : ''}">${
      info.protected
        ? `${icon('shield', 'i-sm')}<span><b>Protected environment.</b> Recorded clicks and submits will really happen there; you will be asked to confirm.</span>`
        : same
          ? `${icon('info', 'i-sm')}<span>Same environment it was recorded on.</span>`
          : `${icon('info', 'i-sm')}<span>Cross-environment replay: recorded on <b>${esc(rec.label || '')}</b>, running on <b>${esc(info.label || info.key)}</b>.</span>`}</div>
  </section>`;
}
INPUTS['run-target'] = (node, value) => { S.runTarget = value || null; render(); };

function isAssertion(s) { return !!s && String(s.type || '').startsWith('expect'); }

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
    return `<button class="back" data-act="nav" data-href="#/tests">${icon('arrow-left', 'i-sm')}Test Library</button>
      <div class="card card-pad" role="status" aria-label="Loading test">
        <span class="skeleton" style="width:40%;height:22px"></span><span class="skeleton" style="width:70%;height:12px;margin-top:14px"></span>
        <span class="skeleton" style="width:100%;height:90px;margin-top:20px"></span></div>`;
  }
  ensureEnvsOnce();
  const runs = S.runs[t.id] || [];
  const steps = t.steps || [];
  const sev = t.bug && t.bug.severity;
  const last = t.lastRun;
  const asserts = steps.filter(isAssertion).length;

  return `
  ${pageHeader({
    crumbs: [{ label: 'Test Library', hash: '#/tests' }, t.name],
    title: t.name,
    subtitle: t.description || '',
    meta: statusPill(last ? last.status : 'never') + (sev ? `<span class="sev sev-${esc(sev)}">${sevDot(sev)}${esc(sev)} severity</span>` : ''),
    actions: `<button class="btn" data-act="test-tab" data-tab="steps">${icon('pencil', 'i-sm')}Edit</button>
      <button class="btn-icon" data-act="row-menu" data-id="${esc(t.id)}" aria-label="More actions for ${esc(t.name)}">${icon('dots')}</button>`,
  })}
  ${(t.tags || []).length || t.folder ? `<div class="td-meta">${(t.tags || []).map((x) => `<span class="tag">${esc(x)}</span>`).join('')}${
    t.folder ? `<span class="meta">${icon('folder', 'i-sm')} ${esc(t.folder)}</span>` : ''}</div>` : ''}

  ${runTargetPicker(t)}

  <div class="tabs" role="tablist">
    ${[['overview', 'Overview', ''], ['steps', 'Steps', steps.length], ['executions', 'History', runs.length], ['settings', 'Settings', '']]
      .map(([key, label, count]) => `
        <button role="tab" aria-selected="${S.testTab === key}" data-act="test-tab" data-tab="${key}">
          ${esc(label)}${count !== '' ? ` <span class="count">(${esc(count)})</span>` : ''}
        </button>`).join('')}
  </div>

  ${S.testDirty ? `<div class="note warn" style="margin-bottom:14px">${icon('alert', 'i-sm')}
    <span>You have unsaved changes.</span><span class="grow"></span>
    <button class="btn btn-sm btn-primary" data-act="save-test" ${S.saving ? 'disabled' : ''}>
      ${S.saving ? 'Saving test…' : 'Save changes'}</button></div>` : ''}

  ${S.testTab === 'overview' ? testOverview(t, runs, asserts)
    : S.testTab === 'steps' ? (steps.length ? markAssertions(stepPanes(steps, S.testSel, 'test'), steps) : `<div class="card empty-sm">This test has no steps.</div>`)
    : S.testTab === 'executions' ? testExecutions(t, runs)
    : testSettings(t)}`;
}

/** Tint the assertion steps in the shared step list so the checks stand out from the actions. */
function markAssertions(html, steps) {
  let i = -1;
  return html.replace(/<li class="step /g, (m) => {
    i++;
    return isAssertion(steps[i]) ? '<li class="step is-assert ' : m;
  });
}

function testOverview(t, runs, asserts) {
  const created = relTime(t.createdAt), updated = relTime(t.updatedAt);
  const last = runs[0] || (t.lastRun ? { id: t.lastRun.runId, status: t.lastRun.status, reason: t.lastRun.reason, summary: t.lastRun.summary, startedAt: t.lastRun.at, durationMs: t.lastRun.durationMs } : null);
  const bug = t.bug || {};
  const steps = t.steps || [];
  const assertSteps = steps.filter(isAssertion);
  return `
  <div class="split">
    <div class="td-col">
      ${(bug.expected || bug.actual) ? `<div class="card card-pad td-bug">
        <h3>The bug</h3>
        <div class="td-bug-grid">
          <div class="td-exp"><div class="td-k">Expected</div>${esc(bug.expected || 'Not recorded')}</div>
          <div class="td-act"><div class="td-k">Actual (the bug)</div>${esc(bug.actual || 'Not recorded')}</div>
        </div></div>` : ''}

      <div class="card">
        <div class="card-head"><h3>Assertions</h3><span class="meta">${assertSteps.length}</span></div>
        ${assertSteps.length ? `<ul class="td-asserts">${assertSteps.map((s) => `
          <li>${icon('check-circle', 'i-sm')}<span class="grow">${esc(stepActionLabel(s))}${stepDetail(s) ? ` <span class="meta mono">${esc(stepDetail(s))}</span>` : ''}</span></li>`).join('')}</ul>`
        : `<div class="card-pad"><div class="note warn">${icon('alert', 'i-sm')}<span><b>This test has no assertion.</b> Replays will finish as
            <b>Inconclusive</b>: the steps run, but nothing checks that the bug is gone. Add an <i>Expect text</i> / <i>Expect URL</i> step that
            captures the correct behaviour.</span></div>
          <div style="margin-top:10px"><button class="btn btn-sm" data-act="test-tab" data-tab="steps">${icon('pencil', 'i-sm')}Open steps to add one</button></div></div>`}
      </div>

      <div class="card card-pad">
        <dl class="kv kv-wide">
          <dt>Description</dt><dd>${esc(t.description || '—')}</dd>
          <dt>Application</dt><dd>${esc(appOf(t))}</dd>
          <dt>Steps</dt><dd>${steps.length} <span class="meta">(${asserts} assertion${asserts === 1 ? '' : 's'})</span></dd>
          <dt>Created</dt><dd title="${esc(created.title)}">${esc(created.label)}</dd>
          <dt>Last Updated</dt><dd title="${esc(updated.title)}">${esc(updated.label)}</dd>
          <dt>Folder</dt><dd>${t.folder ? esc(t.folder) : '<span class="subtle">none</span>'}</dd>
        </dl>
      </div>
    </div>
    <div class="td-col">
      <div class="card">
        <div class="card-head"><h3>Last Execution</h3></div>
        <div class="card-pad">
          ${last ? `<div class="row" style="gap:10px">
              ${resultCell(last.status, last.reason)}
              <span class="grow"></span>
              ${last.id ? `<button class="btn btn-sm" data-act="open-run" data-test="${esc(t.id)}" data-run="${esc(last.id)}">Open report</button>` : ''}
            </div>
            ${last.summary ? `<div style="margin-top:10px">${esc(last.summary)}</div>` : ''}
            <div class="meta" style="margin-top:8px">${timeAgo(last.startedAt)} &middot; ${esc(fmtDuration(last.durationMs))}</div>`
          : `<div class="meta">This test has never been executed. Choose where to run it above.</div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Quick Actions</h3></div>
        ${[
          ['pencil', 'Edit steps', 'test-tab-steps', ''],
          ['duplicate', 'Duplicate test', 'duplicate-test', ''],
          ['upload', 'Export as JSON', 'export-test', ''],
          ['trash', 'Delete test', 'delete-test', 'danger'],
        ].map(([ic, label, act, danger]) => `
          <div class="list-row" role="button" tabindex="0" data-act="${act}" data-id="${esc(t.id)}">
            <span class="tile sq ${danger ? 'red' : 'grey'}">${icon(ic, 'i-sm')}</span>
            <span class="grow" style="${danger ? 'color:var(--danger)' : ''}">${esc(label)}</span>
            ${icon('chevron-right', 'i-sm subtle')}
          </div>`).join('')}
      </div>
    </div>
  </div>`;
}

function testExecutions(t, runs) {
  if (!runs.length) {
    return `<div class="card empty lib-empty"><div class="art">${icon('history', 'i-lg')}</div><h2>Not executed yet</h2>
      <p>Pick an environment above and run the test. Each run is kept here with its verdict.</p></div>`;
  }
  setTimeout(() => enrichRuns(runs.map((r) => ({ ...r, testId: t.id }))), 0);
  return `
  <div class="card tbl-wrap lib-card">
    <table class="tbl lib-tbl exec-tbl" aria-label="Runs of this test">
      <thead><tr><th class="ex-c-res">Result</th><th class="ex-c-env">Ran on</th><th class="ex-c-steps">Steps</th><th class="ex-c-dur">Duration</th>
        <th class="ex-c-at">Started</th><th class="cell-actions" aria-label="Open"></th></tr></thead>
      <tbody>
        ${runs.map((r0) => {
          const r = richRun({ ...r0, testId: t.id });
          const env = r.target ? (envFor(r.target.key) || r.target) : null;
          return `
          <tr data-act="open-run" data-test="${esc(t.id)}" data-run="${esc(r.id)}" tabindex="0">
            <td class="ex-c-res">${resultCell(r.status, r.reason)}</td>
            <td class="ex-c-env">${env ? envTag(env) : '<span class="subtle">—</span>'}</td>
            <td class="ex-c-steps meta tnum">${esc(r.stepsPassed != null ? r.stepsPassed : '?')}/${esc(r.stepCount != null ? r.stepCount : '?')}</td>
            <td class="ex-c-dur meta tnum">${esc(fmtDuration(r.durationMs))}</td>
            <td class="ex-c-at meta">${timeAgo(r.startedAt)}</td>
            <td class="cell-actions">${icon('chevron-right', 'i-sm subtle')}</td>
          </tr>`;
        }).join('')}
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
