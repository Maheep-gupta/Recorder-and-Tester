/* View: Overview.
 * Part of the UI bundle: classic scripts loaded in order from index.html, sharing one global
 * scope (state S, helpers, render).
 *
 * Everything here is read from data the app already loads: S.tests (with each test's lastRun),
 * S.allRuns (GET /api/runs), S.envs (GET /api/environments). Nothing is invented.
 */
'use strict';

const ATTENTION_STATUSES = new Set(['failed', 'error', 'blocked']);

/** Counts for the metric strip, from the tests actually loaded. */
function homeCounts() {
  const c = { total: S.tests.length, passed: 0, failed: 0, inconclusive: 0, never: 0, attention: 0 };
  S.tests.forEach((t) => {
    const st = t.lastRun && t.lastRun.status;
    if (st === 'passed') c.passed++;
    else if (st === 'failed') c.failed++;
    else if (st === 'inconclusive') c.inconclusive++;
    else if (!st) c.never++;
    if (ATTENTION_STATUSES.has(st)) c.attention++;
  });
  return c;
}

function homeActions() {
  return `
    <button class="btn" data-act="open-palette-tests" ${S.tests.length ? '' : 'disabled'}>${icon('play', 'i-sm')}Run a test</button>
    <button class="btn btn-primary" data-act="start-recording">${icon('record', 'i-sm')}Record a bug</button>`;
}

function homeSkeleton() {
  const line = (w) => `<span class="ov-skel" style="width:${w}"></span>`;
  const rows = (n) => Array.from({ length: n }, () => `<div class="ov-row">${line('34%')}<span class="grow"></span>${line('64px')}${line('48px')}</div>`).join('');
  return `
  <div class="ov-metrics" aria-hidden="true">${Array.from({ length: 5 }, () => `<div class="ov-metric">${line('36px')}${line('64px')}</div>`).join('')}</div>
  <div class="ov-grid">
    <div class="ov-col"><section class="card ov-card" aria-hidden="true">${rows(3)}</section><section class="card ov-card" aria-hidden="true">${rows(4)}</section></div>
    <div class="ov-col"><section class="card ov-card" aria-hidden="true">${rows(3)}</section></div>
  </div>`;
}

function viewHome() {
  const header = pageHeader({
    title: 'Overview',
    subtitle: 'Record a bug on production, replay it on localhost, verify the fix.',
    actions: homeActions(),
  });
  const loaded = S.tests.length > 0 || !!S.stats;
  if (!loaded) return `${header}<div role="status" aria-label="Loading overview">${homeSkeleton()}</div>`;
  if (!S.tests.length) return `${header}${viewEmptyState()}`;

  return `${header}
  ${homeMetrics()}
  <div class="ov-grid">
    <div class="ov-col">${homeAttention()}${homeRecentRuns()}</div>
    <div class="ov-col">${homeEnvironments()}</div>
  </div>`;
}

function homeMetrics() {
  const c = homeCounts();
  const cell = (key, ic, n, label, filter) => `
    <button type="button" class="ov-metric ov-${key}${n === 0 ? ' ov-zero' : ''}" data-act="home-filter" data-filter="${filter}" aria-label="${n} ${esc(label)}. Show in Test Library">
      <span class="ov-n">${esc(n)}</span>
      <span class="ov-l">${icon(ic, 'i-sm')}${esc(label)}</span>
    </button>`;
  return `
  <div class="ov-metrics" role="group" aria-label="Test results">
    ${cell('total', 'tests', c.total, 'Tests', 'all')}
    ${cell('passed', 'check-circle', c.passed, 'Passed', 'passed')}
    ${cell('failed', 'x-circle', c.failed, 'Failed', 'failed')}
    ${cell('inconclusive', 'alert', c.inconclusive, 'Inconclusive', 'inconclusive')}
    ${cell('never', 'clock', c.never, 'Not run', 'never')}
  </div>`;
}

ACTIONS['home-filter'] = (trigger) => {
  S.libTab = 'all';
  S.libFolder = null;
  S.libFilter = trigger.getAttribute('data-filter') || 'all';
  go('#/tests');
};

/** One short line of "why" for a test that needs attention. */
function attentionReason(t) {
  const lr = t.lastRun || {};
  if (lr.summary) return String(lr.summary);
  if (lr.failedStep) return `Failed at step ${lr.failedStep}`;
  const r = lr.reason && REASON_TEXT[lr.reason];
  return r ? r.split('. ')[0].replace(/\.$/, '') : '';
}

function homeAttention() {
  const list = S.tests.filter((t) => t.lastRun && ATTENTION_STATUSES.has(t.lastRun.status))
    .sort((a, b) => new Date(b.lastRun.at || 0) - new Date(a.lastRun.at || 0));
  const shown = list.slice(0, 6);
  const body = !list.length
    ? `<div class="ov-ok">${icon('check-circle', 'i-lg')}<div><b>Nothing needs attention.</b>
        <div class="meta">No test's latest run failed, errored or was blocked.</div></div></div>`
    : shown.map((t) => {
      const lr = t.lastRun;
      const kind = envKindFor(lr.app);
      const why = attentionReason(t);
      return `
      <div class="ov-row ov-attn">
        <div class="ov-main">
          <a class="ov-name truncate" href="#/test/${esc(t.id)}">${esc(t.name)}</a>
          <div class="ov-sub">${statusPill(lr.status)}${kind ? envBadge(kind) : ''}
            ${why ? `<span class="truncate ov-why" title="${esc(why)}">${esc(why)}</span>` : ''}
            <span class="meta nowrap">${timeAgo(lr.at)}</span></div>
        </div>
        <div class="ov-btns">
          <button class="btn btn-sm" data-act="run-test" data-id="${esc(t.id)}" aria-label="Run ${esc(t.name)} again">${icon('refresh', 'i-sm')}Run again</button>
          <button class="btn btn-sm btn-ghost" data-act="open-test" data-id="${esc(t.id)}" aria-label="Open ${esc(t.name)}">Open</button>
        </div>
      </div>`;
    }).join('');
  return `
  <section class="card ov-card" aria-labelledby="ovAttn">
    <div class="ov-head"><h2 id="ovAttn">Needs attention${list.length ? ` <span class="ov-count">${list.length}</span>` : ''}</h2>
      ${list.length > shown.length ? `<button class="btn btn-sm btn-ghost" data-act="home-filter" data-filter="failed">View all ${list.length}</button>` : ''}</div>
    ${body}
  </section>`;
}

function homeRecentRuns() {
  const runs = S.allRuns;
  // The newest run per test carries its target in the test's own lastRun stamp; older runs do not.
  const appOf = (r) => {
    const t = S.tests.find((x) => x.id === r.testId);
    return t && t.lastRun && t.lastRun.runId === r.id ? t.lastRun.app : null;
  };
  let body;
  if (S.runsError && !runs) {
    body = `<div class="empty-sm" role="alert">${icon('alert', 'i-sm')} Could not read the history: ${esc(S.runsError)}</div>`;
  } else if (!runs) {
    body = Array.from({ length: 4 }, () => `<div class="ov-row" aria-hidden="true"><span class="ov-skel" style="width:40%"></span><span class="grow"></span><span class="ov-skel" style="width:64px"></span></div>`).join('');
  } else if (!runs.length) {
    body = `<div class="empty-sm">No replays yet. Run a test to see results here.</div>`;
  } else {
    body = runs.slice(0, 8).map((r) => {
      const kind = envKindFor(appOf(r));
      return `
      <div class="ov-row">
        <div class="ov-main">
          <a class="ov-name truncate" href="#/run/${esc(r.testId)}/${esc(r.id)}">${esc(r.testName || r.testId)}</a>
          <div class="ov-sub">${statusPill(r.status)}${kind ? envBadge(kind) : ''}
            <span class="meta nowrap tnum">${esc(fmtDuration(r.durationMs))}</span></div>
        </div>
        <span class="meta nowrap">${timeAgo(r.startedAt)}</span>
      </div>`;
    }).join('');
  }
  return `
  <section class="card ov-card" aria-labelledby="ovRuns">
    <div class="ov-head"><h2 id="ovRuns">Recent executions</h2>
      <a class="btn btn-sm btn-ghost" href="#/executions">View all</a></div>
    ${body}
  </section>`;
}

function homeEnvironments() {
  const envs = S.envs;
  let body;
  if (!envs) {
    body = Array.from({ length: 3 }, () => `<div class="ov-row" aria-hidden="true"><span class="ov-skel" style="width:46%"></span><span class="grow"></span><span class="ov-skel" style="width:72px"></span></div>`).join('');
  } else if (!envs.length) {
    body = `<div class="empty-sm">No environments yet. Add one so a bug recorded on production can be replayed on localhost.</div>`;
  } else {
    const groups = new Map();
    envs.forEach((e) => {
      const app = e.application || 'Default';
      if (!groups.has(app)) groups.set(app, []);
      groups.get(app).push(e);
    });
    body = Array.from(groups.entries()).map(([app, list]) => `
      <div class="ov-envgroup">
        <div class="ov-grouplabel">${esc(app)}</div>
        ${list.map((e) => `
          <div class="ov-row ov-env">
            <div class="ov-main">
              <div class="ov-envname"><span class="truncate">${esc(e.label || e.key)}</span>${envBadge(e.kind)}
                ${e.protected ? `<span class="ov-prot" title="Replays here ask for confirmation first">${icon('shield', 'i-sm')}Protected</span>` : ''}</div>
              <div class="mono ov-url truncate" title="${esc(e.baseUrl)}">${esc(e.baseUrl)}</div>
            </div>
          </div>`).join('')}
      </div>`).join('');
  }
  return `
  <section class="card ov-card" aria-labelledby="ovEnvs">
    <div class="ov-head"><h2 id="ovEnvs">Environments</h2>
      <a class="btn btn-sm btn-ghost" href="#/environments">Manage</a></div>
    ${body}
  </section>`;
}

/** Every async screen gets one of these instead of an empty page. */
function loadingCard(label) {
  return `<div class="card empty-sm" role="status">${icon('refresh', 'i-sm spinner')} ${esc(label)}</div>`;
}

/** First run: nothing recorded yet. Also what the Test Library shows when it has no tests. */
function viewEmptyState() {
  const step = (n, ic, title, text) => `
    <li class="ov-step">
      <span class="ov-stepn" aria-hidden="true">${n}</span>
      <span class="ov-stepi">${icon(ic, 'i-lg')}</span>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
    </li>`;
  return `
  <section class="card ov-first" aria-labelledby="ovFirst">
    <p class="ov-kicker">Welcome to Replayr</p>
    <h2 id="ovFirst">Record once. Replay anywhere.</h2>
    <p class="muted">Reproduce a production bug once, then prove it is fixed on localhost. Nothing is recorded yet. The whole workflow is three steps.</p>
    <ol class="ov-steps">
      ${step(1, 'record', 'Record on production', 'Open the failing flow in a real browser and click through it. Every action becomes a replayable step.')}
      ${step(2, 'laptop', 'Replay on localhost', 'Run the same steps against your local build and watch the bug reproduce.')}
      ${step(3, 'check-circle', 'Verify the fix', 'Replay again after the change. A passing run with assertions is your proof.')}
    </ol>
    <button class="btn btn-primary btn-lg" data-act="start-recording">${icon('record')}Record a bug</button>
  </section>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   VIEW — TEST LIBRARY
   ══════════════════════════════════════════════════════════════════════════ */
