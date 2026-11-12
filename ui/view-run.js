/* Views: Execution report (live progress + finished verdict with a step-by-step debugger).
 * Part of the UI bundle: classic scripts loaded in order from index.html, sharing one global
 * scope (state S, helpers, render).
 */
'use strict';

Object.assign(S, { repKey: null, repSel: null, repEv: null });

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
    return `<div class="card card-pad" role="status" aria-label="Loading result">
      <span class="skeleton" style="width:30%;height:20px"></span><span class="skeleton" style="width:60%;height:12px;margin-top:14px"></span>
      <span class="skeleton" style="width:100%;height:160px;margin-top:20px"></span></div>`;
  }

  if (!run.done) return viewRunProgress(run);
  return pageHeader({
    crumbs: [{ label: 'Test Library', hash: '#/tests' }, { label: run.testName || 'Test', hash: '#/test/' + run.testId }, 'Execution report'],
    title: run.testName || 'Execution report',
    subtitle: run.startedAt ? 'Run ' + new Date(run.startedAt).toLocaleString() : '',
  }) + viewReport(run);
}

/* ══════════════════════════════════════════════════════════════════════════
   FINISHED RUN - verdict first, then the step-by-step debugger
   ══════════════════════════════════════════════════════════════════════════ */
const VERDICT = {
  passed:       { cls: 'pass',  ic: 'check',       word: 'PASS',         fixed: 'Yes', fixedText: 'The expected behaviour was verified.' },
  failed:       { cls: 'fail',  ic: 'x',           word: 'FAIL',         fixed: 'No',  fixedText: 'The bug still reproduces, or a step could not complete.' },
  blocked:      { cls: 'block', ic: 'alert',       word: 'BLOCKED',      fixed: 'Unknown', fixedText: 'The run could not start, so nothing was verified.' },
  error:        { cls: 'error', ic: 'alert',       word: 'ERROR',        fixed: 'Unknown', fixedText: 'The run stopped on an error before it finished.' },
  inconclusive: { cls: 'inc',   ic: 'info',        word: 'INCONCLUSIVE', fixed: 'Unknown', fixedText: 'The steps ran, but nothing proves the bug is gone.' },
  cancelled:    { cls: 'canc',  ic: 'stop',        word: 'CANCELLED',    fixed: 'Unknown', fixedText: 'The run was stopped before it finished.' },
};

function viewReport(run) {
  const v = VERDICT[run.status] || VERDICT.error;
  const tg = run.target, rec = run.recordedOn;
  const a = run.assertions;
  const reasonText = run.reason && REASON_TEXT[run.reason];
  const steps = run.steps || [];
  const targetEnv = tg ? (envFor(tg.key) || tg) : null;
  const recEnvObj = rec ? (envFor(rec.key) || rec) : null;
  const failedOrNo = run.status === 'failed' || run.status === 'error' || run.status === 'inconclusive';

  return `
  <section class="rep-verdict v-${v.cls}" aria-label="Verdict">
    <span class="rep-mark">${icon(v.ic, 'i-lg')}</span>
    <div class="rep-main">
      <div class="rep-q">Is the bug fixed? <b class="rep-a">${esc(v.fixed)}</b></div>
      <div class="rep-title"><h2>${esc(v.word)}</h2>${run.reason ? `<span class="meta mono">${esc(run.reason)}</span>` : ''}</div>
      <div class="rep-summary">${esc(run.summary || v.fixedText)}</div>
      ${reasonText && reasonText !== run.summary ? `<div class="meta rep-reason">${esc(reasonText)}</div>` : ''}
    </div>
    <div class="rep-actions">
      <button class="btn btn-primary" data-act="run-test" data-id="${esc(run.testId)}" ${tg ? `data-app="${esc(tg.key || '')}"` : ''}>${icon('play', 'i-sm')}Run again${tg ? ` on ${esc(tg.label || tg.key)}` : ''}</button>
      <button class="btn" data-act="nav" data-href="#/test/${esc(run.testId)}">${icon('pencil', 'i-sm')}Open test</button>
    </div>
  </section>

  <div class="rep-meta">
    <div class="rm"><span class="rm-k">Ran on</span><span class="rm-v">${targetEnv ? envTag(targetEnv) : '<span class="subtle">unknown</span>'}
      ${tg && tg.baseUrl ? `<span class="mono meta truncate" title="${esc(tg.baseUrl)}">${esc(tg.baseUrl)}</span>` : ''}</span></div>
    <div class="rm"><span class="rm-k">Recorded on</span><span class="rm-v">${recEnvObj ? envTag(recEnvObj) : '<span class="subtle">unknown</span>'}
      ${run.crossEnv ? `<span class="pill st-inconclusive xenv-pill" title="Recorded on one environment, replayed on another">cross-environment</span>` : ''}</span></div>
    <div class="rm"><span class="rm-k">Duration</span><span class="rm-v tnum">${esc(fmtDuration(run.durationMs))}</span></div>
    <div class="rm"><span class="rm-k">Started</span><span class="rm-v">${run.startedAt ? timeAgo(run.startedAt) : '—'}</span></div>
    <div class="rm"><span class="rm-k">Finished</span><span class="rm-v">${run.finishedAt ? timeAgo(run.finishedAt) : '—'}</span></div>
    ${a ? `<div class="rm"><span class="rm-k">Assertions</span><span class="rm-v tnum">${esc(a.passed || 0)} passed &middot; ${esc(a.failed || 0)} failed &middot; ${esc(a.total || 0)} total</span></div>` : ''}
  </div>

  ${(run.notes || []).map((n) => `<div class="note warn" style="margin-bottom:12px">${icon('info', 'i-sm')}<span>${esc(n)}</span></div>`).join('')}
  ${run.status === 'inconclusive' && run.reason === 'no_assertions' ? `<div class="note info" style="margin-bottom:12px">${icon('info', 'i-sm')}
    <span>Add an assertion step (Expect text / Expect URL) to the test, then run it again to get a real PASS or FAIL.</span>
    <span class="grow"></span><button class="btn btn-sm" data-act="nav" data-href="#/test/${esc(run.testId)}">Open test</button></div>` : ''}

  ${steps.length ? debugger_(run) : (run.error ? `<div class="card card-pad" style="margin-bottom:16px"><h3 style="margin-bottom:8px">Error</h3><pre class="err">${esc(run.error)}</pre></div>`
    : `<div class="card empty-sm">No steps were recorded for this run.</div>`)}
  ${evidenceTabs(run)}`;
}

/** The step that opens first: the failed one; else the run's failedStep; else the first step. */
function defaultStep(run) {
  const steps = run.steps || [];
  const failed = steps.find((s) => s.status === 'failed');
  if (failed) return failed.index;
  if (run.failedStep) return run.failedStep;
  return steps.length ? steps[0].index : null;
}
function selectedStepIndex(run) {
  const key = run.testId + '/' + run.id;
  if (S.repKey !== key) { S.repKey = key; S.repSel = null; S.repEv = null; }
  return S.repSel != null ? S.repSel : defaultStep(run);
}
ACTIONS['rep-step'] = (trigger) => { S.repSel = Number(trigger.getAttribute('data-index')); render(); };
ACTIONS['rep-ev'] = (trigger) => { S.repEv = trigger.getAttribute('data-tab'); render(); };

function stepGlyph(status) {
  if (status === 'passed')  return `<span class="sg sg-passed">${icon('check', 'i-sm')}</span>`;
  if (status === 'failed')  return `<span class="sg sg-failed">${icon('x', 'i-sm')}</span>`;
  if (status === 'skipped') return `<span class="sg sg-skipped">${icon('minus', 'i-sm')}</span>`;
  if (status === 'running') return `<span class="sg sg-running">${icon('refresh', 'i-sm spinner')}</span>`;
  return `<span class="sg sg-notrun">${icon('circle', 'i-sm')}</span>`;
}

function debugger_(run) {
  const steps = run.steps || [];
  const sel = selectedStepIndex(run);
  const step = steps.find((s) => s.index === sel) || steps[0];
  const nFail = steps.filter((s) => s.status === 'failed').length;
  const nNot = steps.filter((s) => s.status === 'not-run' || s.status === 'pending').length;
  return `
  <div class="rep-dbg">
    <div class="card rep-steps">
      <div class="card-head"><h3>Steps</h3><span class="meta">${steps.length}${nFail ? ` &middot; <span class="lib-bad">${nFail} failed</span>` : ''}${nNot ? ` &middot; ${nNot} not run` : ''}</span></div>
      <ol class="rep-list" role="listbox" aria-label="Steps of this run">
        ${steps.map((s) => {
          const assert = String(s.type || '').startsWith('expect');
          return `<li><button class="rep-step st-${esc(s.status || 'pending')}${assert ? ' is-assert' : ''}" role="option" aria-selected="${s.index === step.index}"
              data-act="rep-step" data-index="${esc(s.index)}">
            ${stepGlyph(s.status)}
            <span class="rs-n mono">${esc(s.index)}</span>
            <span class="rs-t">${esc(s.text || actionLabel(s.type))}${assert ? ' <span class="tag rs-assert">assertion</span>' : ''}</span>
            <span class="rs-ms tnum">${s.status === 'not-run' || s.status === 'pending' ? '' : esc(fmtDuration(s.ms))}</span>
          </button></li>`;
        }).join('')}
      </ol>
    </div>
    ${stepDetail_(run, step)}
  </div>`;
}

function stepDetail_(run, s) {
  const isFailPoint = s.status === 'failed' || s.index === run.failedStep;
  const err = s.error || (s.index === run.failedStep ? run.error : null);
  const shot = isFailPoint && run.screenshot ? run.screenshot : null;
  const shotUrl = shot ? `/api/tests/${encodeURIComponent(run.testId)}/runs/${encodeURIComponent(run.id)}/file/${encodeURIComponent(shot)}` : null;
  const res = s.resolution;
  const assert = String(s.type || '').startsWith('expect');
  const attempts = (res && res.attempts) || [];
  return `
  <div class="card rep-detail" aria-label="Step ${esc(s.index)} details">
    <div class="card-head">
      <h3><span class="tile sq ${stepIconTint(s.type)}" style="display:inline-grid;vertical-align:middle;margin-right:8px">${icon(stepIcon(s.type), 'i-sm')}</span>Step ${esc(s.index)}${assert ? ' &middot; assertion' : ''}</h3>
      ${statusPill(s.status === 'pending' ? 'not-run' : s.status)}
    </div>
    <div class="rd-body">
      <div class="rd-text">${esc(s.text || actionLabel(s.type))}</div>
      ${err ? `<div class="rd-sec"><div class="rd-k">${assert ? 'Assertion failed' : 'Error'}</div><pre class="err">${esc(err)}</pre></div>` : ''}
      ${s.note ? `<div class="note warn">${icon('info', 'i-sm')}<span>${esc(s.note)}</span></div>` : ''}
      ${s.status === 'not-run' || s.status === 'pending' ? `<div class="meta">This step did not run${run.failedStep ? ` because step ${esc(run.failedStep)} stopped the run` : ' because the run ended first'}.</div>` : ''}
      <dl class="kv kv-mid">
        ${s.url ? `<dt>Page URL</dt><dd class="mono" style="word-break:break-all">${esc(s.url)}</dd>` : (isFailPoint && run.url ? `<dt>Page URL</dt><dd class="mono" style="word-break:break-all">${esc(run.url)}</dd>` : '')}
        ${s.status !== 'not-run' && s.status !== 'pending' ? `<dt>Took</dt><dd class="tnum">${esc(fmtDuration(s.ms))}</dd>` : ''}
        ${res && res.strategy ? `<dt>Found via</dt><dd><span class="tag">${esc(res.strategy)}</span>${res.confidence != null ? ` <span class="meta">confidence ${esc(res.confidence)}%</span>` : ''}</dd>` : ''}
      </dl>
      ${shotUrl ? `<div class="rd-sec"><div class="rd-k">Screenshot at the failing step <span class="meta">(click to enlarge)</span></div>
        <img class="shot" src="${esc(shotUrl)}" alt="Screenshot at step ${esc(s.index)}" data-act="expand-shot" data-src="${esc(shotUrl)}"
             onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'empty-sm',textContent:'No screenshot was captured for this run.'}))"></div>` : ''}
      ${res && (attempts.length || res.recorded || res.suggestion) ? locatorDiagnostics(res, isFailPoint) : ''}
    </div>
  </div>`;
}

/** Locator diagnostics: what the engine tried. Closed by default unless this is the failure point. */
function locatorDiagnostics(res, open) {
  const attempts = res.attempts || [];
  const rec = res.recorded;
  return `
  <details class="disc rd-disc" ${open ? 'open' : ''}>
    <summary>${icon('chevron-right', 'i-sm chev')}Locator diagnostics <span class="meta">(${attempts.length} ${attempts.length === 1 ? 'attempt' : 'attempts'})</span></summary>
    <div class="disc-body">
      ${res.suggestion ? `<div class="note info" style="margin-bottom:10px">${icon('info', 'i-sm')}<span>${esc(res.suggestion)}</span></div>` : ''}
      ${attempts.length ? `<div class="tbl-wrap"><table class="tbl diag-tbl" aria-label="Locator strategies tried">
        <thead><tr><th style="width:26px" aria-label="Accepted"></th><th style="width:96px">Strategy</th><th>Locator</th><th style="width:66px">Matches</th><th style="width:180px">Verdict</th></tr></thead>
        <tbody>${attempts.map((a) => `
          <tr class="${a.accepted ? 'accepted' : ''}" style="cursor:default">
            <td>${a.accepted ? `<span class="st-ok">${icon('check', 'i-sm')}</span>` : `<span class="st-bad">${icon('x', 'i-sm')}</span>`}</td>
            <td><span class="tag">${esc(a.strategy)}</span></td>
            <td class="mono">${esc(a.locator || '')}</td>
            <td class="tnum">${a.matches != null ? esc(a.matches) : '—'}</td>
            <td>${a.accepted ? `<span class="st-ok">used${a.similarity != null ? ` · similarity ${esc(typeof a.similarity === 'object' ? a.similarity.score : a.similarity)}` : ''}</span>`
              : `<span class="st-bad">${esc(a.rejected || 'rejected')}</span>`}</td>
          </tr>`).join('')}</tbody></table></div>` : `<div class="meta">No locator attempts were recorded for this step.</div>`}
      ${res.similarity ? `<div class="meta" style="margin-top:10px">Similarity to the recorded element: <b class="tnum">${esc(res.similarity.score)}</b></div>
        <div class="row wrap" style="gap:5px;margin-top:6px">
          ${(res.similarity.matched || []).map((m) => `<span class="pill st-passed">${esc(m)}</span>`).join('')}
          ${(res.similarity.differed || []).map((m) => `<span class="pill st-failed">${esc(m)}</span>`).join('')}</div>` : ''}
      ${rec ? `<div class="rd-k" style="margin-top:12px">Recorded element</div>
        <dl class="kv kv-mid">
          ${rec.role ? `<dt>Role</dt><dd><span class="tag">${esc(rec.role)}</span></dd>` : ''}
          ${rec.name ? `<dt>Name</dt><dd>${esc(rec.name)}</dd>` : ''}
          ${rec.text ? `<dt>Text</dt><dd>${esc(rec.text)}</dd>` : ''}
          ${rec.testId ? `<dt>Test id</dt><dd class="mono">${esc(rec.testId)}</dd>` : ''}
          ${rec.id ? `<dt>id</dt><dd class="mono">${esc(rec.id)}</dd>` : ''}
          ${rec.tag ? `<dt>Tag</dt><dd><span class="tag">${esc(rec.tag)}</span></dd>` : ''}
          ${(rec.container || []).length ? `<dt>Inside</dt><dd>${esc(rec.container.join(' / '))}</dd>` : ''}
        </dl>` : ''}
    </div>
  </details>`;
}

/** Console errors, failed requests, dialogs and URL rewrites: one tab each, only the ones with data. */
function evidenceTabs(run) {
  const tabs = [
    ['console', 'Console errors', run.consoleErrors || []],
    ['network', 'Network failures', run.networkErrors || []],
    ['dialogs', 'Dialogs', run.dialogs || []],
    ['rewrites', 'URL rewrites', run.urlRewrites || []],
  ].filter(([, , list]) => list.length);
  if (!tabs.length) return '';
  const active = tabs.some(([k]) => k === S.repEv) ? S.repEv : tabs[0][0];
  const list = (tabs.find(([k]) => k === active) || tabs[0])[2];
  const body = {
    console: () => list.map((c) => `<div class="code-line"><code>${c.step != null ? `<span class="subtle">[step ${esc(c.step)}]</span> ` : ''}${esc(c.text)}</code></div>`).join(''),
    network: () => list.map((n) => `<div class="code-line"><code>${n.step != null ? `<span class="subtle">[step ${esc(n.step)}]</span> ` : ''}<b>${esc(n.status || n.error || 'error')}</b> ${esc(n.url)}</code></div>`).join(''),
    dialogs: () => list.map((d) => `<div class="code-line"><code>${esc(d.type)}${d.stepId != null ? ` at step ${esc(d.stepId)}` : ''}: ${esc(d.message || '')} <span class="subtle">(${esc(d.action || 'accepted')})</span></code></div>`).join(''),
    rewrites: () => list.map((r) => `<div class="code-line"><code>${esc(r.from)} &rarr; ${esc(r.to)}</code></div>`).join(''),
  }[active];
  return `
  <div class="card rep-ev">
    <div class="tabs" role="tablist" style="margin:0;padding:0 var(--sp-3)">
      ${tabs.map(([k, label, l]) => `<button role="tab" aria-selected="${k === active}" data-act="rep-ev" data-tab="${k}">${esc(label)} <span class="count">(${l.length})</span></button>`).join('')}
    </div>
    <div class="rep-ev-body">${body()}</div>
  </div>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   LIVE PROGRESS
   ══════════════════════════════════════════════════════════════════════════ */
function phaseLine(run) {
  if (run.phase === 'preflight') return 'Checking the app is up and signing in…';
  if (run.status === 'starting') return 'Starting the browser…';
  const total = run.stepCount || (run.steps || []).length || 0;
  const current = run.current != null ? run.current : (run.steps || []).filter((s) => s.status !== 'pending').length;
  return total ? `Executing step ${current} of ${total}…` : 'Executing…';
}

function viewRunProgress(run) {
  const steps = run.steps || [];
  const total = run.stepCount || steps.length || 0;
  const finished = steps.filter((s) => s.status === 'passed' || s.status === 'failed' || s.status === 'skipped').length;
  const pct = total ? Math.min(100, Math.round((finished / total) * 100)) : 8;
  const tg = run.target || (run.app ? envFor(run.app) : null);

  return `
  ${pageHeader({
    crumbs: [{ label: 'Test Library', hash: '#/tests' }, { label: run.testName || run.testId, hash: '#/test/' + run.testId }, 'Running'],
    title: 'Executing test',
    subtitle: (run.testName || run.testId) + (tg ? ' on ' + (tg.label || tg.key || '') : ''),
    actions: `<button class="btn btn-danger-outline" data-act="cancel-run" ${S.cancelling ? 'disabled' : ''}>
      ${icon('stop', 'i-sm')}${S.cancelling ? 'Cancelling…' : 'Cancel run'}</button>`,
  })}

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
    <span>The run continues in the background. You can navigate away and come back to it.</span></div>

  <div class="card">
    <div class="card-head"><h3>Steps</h3><span class="meta">${finished}/${total}</span></div>
    ${renderRunSteps(run)}
  </div>`;
}

/**
 * Run steps carry their own text (the engine's describe()), so "Wait 1.2s" already reads right.
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
      </span>
      <span class="s-right">
        ${s.status === 'running' ? `<span style="color:var(--accent)">Running…</span>`
          : s.status === 'pending' ? `<span class="subtle">Pending</span>`
          : s.status === 'not-run' ? `<span class="subtle">Not run</span>`
          : s.ms != null ? `<span class="s-ms">${esc(fmtDuration(s.ms))}</span>` : ''}
      </span>
    </li>`).join('') + '</ol>';
}
