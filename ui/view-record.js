/* Views: Record (setup wizard, live workspace, review, step details, save) and the recovered draft.
 * Part of the UI bundle: classic scripts loaded in order from index.html, sharing one global
 * scope (state S, helpers, render). Screen-specific styles live in record.css.
 */
'use strict';

function recStage() {
  if (S.recStage === 'save') return 'save';
  switch (S.rec.status) {
    case 'recording': case 'stopping': case 'starting': return 'record';
    case 'stopped': return 'review';
    default: return 'setup';
  }
}

/* ── Local UI state for this screen (kept out of S: it is presentation only) ─────────────── */
const REC = {
  application: null,      // application chosen in wizard step 1 (null = derive from the URL)
  advOpen: false,         // "Advanced" disclosure in wizard step 2
  bugOpen: false,         // wizard step 3 (bug details) expanded
  inspOpen: true,         // live workspace: inspector expanded
  drawer: false,          // live workspace, <=1100px: inspector drawer open
  lastCount: null,        // step count at the previous paint (drives the new-step highlight)
  lastRun: null,          // startedAt of the recording that lastCount belongs to
  newCount: 0,            // steps that arrived while the timeline was scrolled away from the end
  sec: {},                // inspector sections the user toggled: id -> open?
  shotBad: {},            // "<startedAt>/<stepId>" -> true once the element picture 404'd
  envsRequested: false,
  replayAfter: false,     // Save stage: "Save and replay on localhost"
};
function recWorkspaceMode() { return lsGet('tf.recWorkspace') === 'compact' ? 'compact' : 'expanded'; }

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
  if (stage === 'setup')  return recoveredNotice() + viewRecordSetup();
  if (stage === 'record') return viewRecordLive();
  if (stage === 'review') return viewReview();
  return viewSaveTest();
}

/** A padlock for secret steps. Drawn here so the screen does not depend on the sprite having one. */
function lockGlyph(cls) {
  return `<svg class="i ${cls || 'i-sm'}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   SETUP WIZARD
   ══════════════════════════════════════════════════════════════════════════ */
/** Environments for the wizard: the real registry when loaded, the configured apps otherwise. */
function recEnvList() {
  if (S.envs && S.envs.length) return S.envs;
  return Object.entries((S.config && S.config.apps) || {}).map(([key, a]) => ({
    key, label: a.label || key, baseUrl: a.baseUrl,
    kind: a.kind || (a.remote ? 'staging' : 'local'), protected: !!a.protected, application: a.application || 'Default',
  }));
}
function recApplications() {
  const groups = [];
  const byName = {};
  recEnvList().forEach((e) => {
    const name = e.application || 'Default';
    if (!byName[name]) { byName[name] = { name, envs: [] }; groups.push(byName[name]); }
    byName[name].envs.push(e);
  });
  return groups;
}
function recWizardUrl() {
  const cfg = S.config || {};
  return S.recForm.app == null ? appBaseUrl(cfg.defaultApp) : S.recForm.app;
}
function recEnvMatching(url) {
  const base = normaliseAppUrl(String(url || '').replace(/^url:/, ''));
  if (!base) return null;
  return recEnvList().find((e) => normaliseAppUrl(e.baseUrl) === base) || null;
}
function recIsProdLike(kind, isProtected) { return kind === 'production' || !!isProtected; }

function loadRecEnvs() {
  if (REC.envsRequested || (S.envs && S.envs.length)) return;
  REC.envsRequested = true;
  api('GET', '/api/environments').then((d) => {
    S.envs = (d && d.environments) || [];
    if (S.route.name === 'record') render();
  }).catch(() => { /* the configured apps are the fallback */ });
}

function wizStep(n, title, state, bodyHtml, hint) {
  return `
  <li class="wiz-step ${state}">
    <span class="wiz-num" aria-hidden="true">${state === 'done' ? icon('check', 'i-sm') : n}</span>
    <section class="wiz-body" aria-labelledby="wiz-h${n}">
      <h2 id="wiz-h${n}" class="wiz-title">${esc(title)}${hint ? `<span class="wiz-hint">${esc(hint)}</span>` : ''}</h2>
      ${bodyHtml}
    </section>
  </li>`;
}

function viewRecordSetup() {
  loadRecEnvs();
  const appInput = recWizardUrl();
  const resolved = describeTarget(appInput);
  const urlText = String(appInput || '').trim();
  const urlInvalid = !!urlText && !resolved;
  const env = recEnvMatching(appInput);
  const apps = recApplications();
  const activeApp = REC.application && apps.some((a) => a.name === REC.application)
    ? REC.application : (env ? (env.application || 'Default') : (apps[0] && apps[0].name));
  const appGroup = apps.find((a) => a.name === activeApp) || apps[0] || { name: '', envs: [] };
  const isCustom = !!urlText && !env;
  const kind = resolved ? (resolved.kind || (env && env.kind) || 'local') : null;
  const prodLike = resolved ? recIsProdLike(kind, resolved.protected || (env && env.protected)) : false;
  const label = resolved ? (env ? env.label : resolved.label) : '';
  const typingLogin = !!(String(S.recForm.username || '').trim() || S.recForm.password);
  const halfLogin = !!String(S.recForm.username || '').trim() !== !!S.recForm.password;
  const appDef = resolved || { label: 'the app', auth: false, remote: false, custom: true };
  const willLogin = appDef.auth || typingLogin;
  const appSaved = !!appDef.hasSavedLogin;
  const loginHint = appDef.hasTypedLogin
    ? 'A username and password are saved for this URL. Type new ones to replace them.'
    : appDef.custom
      ? 'Only for Keycloak sign-in pages. Leave blank to open the page as-is and sign in by hand.'
      : 'Leave blank to use credentials.local.env.';
  const failed = S.rec.status === 'error';
  const f = S.saveForm;
  const bugCount = [f.name, f.description, f.bugExpected, f.bugActual, f.bugSeverity].filter((x) => String(x || '').trim()).length;

  const problems = [];
  if (!urlText) problems.push('Choose an environment, or enter the address of the app to record.');
  else if (urlInvalid) problems.push('Enter a full http:// or https:// address.');
  if (halfLogin) problems.push('Enter both a username and a password, or leave both blank.');
  const canStart = !problems.length && !S.launching;

  /* 1 — application */
  const appBody = apps.length ? `
    <div class="app-grid" role="radiogroup" aria-label="Application">
      ${apps.map((a) => `
        <button type="button" class="app-card" role="radio" aria-checked="${a.name === appGroup.name}"
                data-act="rec-app" data-app="${esc(a.name)}">
          <span class="app-card-name">${esc(a.name)}</span>
          <span class="app-card-sub">${a.envs.length} environment${a.envs.length === 1 ? '' : 's'}</span>
        </button>`).join('')}
    </div>` : `<p class="meta">No applications are configured yet. Enter an address in the next step, or add environments in Settings.</p>`;

  /* 2 — source environment */
  const envRows = appGroup.envs.map((e) => {
    const sel = !!env && env.key === e.key;
    const prod = recIsProdLike(e.kind, e.protected);
    return `
      <button type="button" class="env-row${sel ? ' is-sel' : ''}${prod ? ' is-prod' : ''}" role="radio" aria-checked="${sel}"
              data-act="rec-pick-env" data-url="${esc(e.baseUrl)}">
        <span class="env-row-radio" aria-hidden="true"></span>
        <span class="env-row-main">
          <span class="env-row-top">${envBadge(e.kind)}<b class="env-row-label">${esc(e.label || e.key)}</b></span>
          <span class="env-row-url mono">${esc(e.baseUrl)}</span>
          ${prod ? `<span class="env-row-warn">${icon('shield', 'i-sm')}<span>Real customer data may be recorded. Password-like fields are redacted.</span></span>` : ''}
        </span>
      </button>`;
  }).join('');
  const envBody = `
    ${envRows ? `<div class="env-rows" role="radiogroup" aria-label="Source environment">${envRows}</div>` : ''}
    <div class="env-custom${isCustom ? ' is-sel' : ''}">
      <label class="field-label" for="recApp">Or enter a different address</label>
      <input class="field" id="recApp" type="url" data-act="rec-form" data-key="app"
             value="${isCustom ? esc(appInput) : ''}" placeholder="https://any-other-app.example.com" spellcheck="false" autocomplete="off"
             ${urlInvalid ? 'aria-invalid="true" aria-describedby="recAppErr"' : ''}>
      ${urlInvalid ? `<div class="field-error" id="recAppErr" role="alert">Enter a full http:// or https:// address.</div>` : ''}
      ${isCustom && resolved && prodLike ? `<div class="env-row-warn standalone">${icon('shield', 'i-sm')}<span>Real customer data may be recorded. Password-like fields are redacted.</span></div>` : ''}
    </div>

    <button type="button" class="disclosure" data-act="rec-adv" aria-expanded="${REC.advOpen}" aria-controls="recAdv">
      ${icon('chevron-right', 'i-sm disc-chev')}<span>Advanced</span><span class="disc-sub">browser, viewport and sign-in</span>
    </button>
    ${REC.advOpen ? `
    <div class="adv" id="recAdv">
      <div class="adv-grid">
        <div class="field-row">
          <label class="label" for="recBrowser">Browser</label>
          <select class="field" id="recBrowser" data-act="rec-form" data-key="browser">${browserOptions()}</select>
        </div>
        <div class="field-row">
          <label class="label" for="recViewport">Viewport</label>
          <select class="field" id="recViewport" data-act="rec-form" data-key="viewport">
            ${['1280x800', '1440x900', '1920x1080', '1024x768'].map((v) =>
              `<option value="${v}"${S.recForm.viewport === v ? ' selected' : ''}>${v.replace('x', ' × ')}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-row">
        <label class="label" for="recUser">Sign-in <span class="subtle">(optional)</span></label>
        <div class="adv-grid">
          <input class="field" id="recUser" data-act="rec-form" data-key="username" value="${esc(S.recForm.username || '')}"
                 placeholder="Username" autocomplete="off" spellcheck="false" aria-label="Username">
          <input class="field" id="recPass" type="password" data-act="rec-form" data-key="password" value="${esc(S.recForm.password || '')}"
                 placeholder="${appDef.hasTypedLogin ? 'Saved — type to replace' : 'Password'}" autocomplete="new-password" aria-label="Password">
        </div>
        <div class="meta">${esc(loginHint)}${appDef.hasTypedLogin
          ? ` <button class="btn btn-ghost btn-sm" data-act="forget-login" type="button">Forget saved login</button>` : ''}</div>
      </div>
      <div class="opt-row">
        <span class="grow"><b>Use existing authenticated session</b>
          <div class="meta">${appSaved ? `A saved login for ${esc(appDef.label)} is available.`
            : !willLogin ? `${esc(appDef.label)} will open without signing in.`
            : `No saved session for ${esc(appDef.label)} yet — it will sign in with ${
                typingLogin || appDef.hasTypedLogin ? 'the login above' : 'credentials.local.env'}.`}</div></span>
        <label class="switch"><input type="checkbox" data-act="rec-form" data-key="useSession"
          ${S.recForm.useSession ? 'checked' : ''} ${willLogin ? '' : 'disabled'} aria-label="Use existing authenticated session"><span></span></label>
      </div>
      ${appDef.remote ? `<div class="note warn">${icon('alert', 'i-sm')}<span>
        <b>${esc(appDef.label)} is a shared remote environment.</b> Everything you do while recording happens for real
        against it. Prefer a read-only path, and avoid anything destructive.</span></div>` : ''}
    </div>` : ''}`;

  /* 3 — bug details */
  const bugBody = `
    <button type="button" class="disclosure" data-act="rec-bug" aria-expanded="${REC.bugOpen}" aria-controls="recBug">
      ${icon('chevron-right', 'i-sm disc-chev')}<span>${REC.bugOpen ? 'Hide bug details' : 'Add bug details'}</span>
      <span class="disc-sub">${bugCount ? `${bugCount} field${bugCount === 1 ? '' : 's'} filled` : 'prefills the Save screen'}</span>
    </button>
    ${REC.bugOpen ? `
    <div class="bug-form" id="recBug">
      <div class="field-row">
        <label class="label" for="bugName">Test name</label>
        <input class="field" id="bugName" data-act="wiz-save" data-key="name" value="${esc(f.name)}" placeholder="Customer save loses the tax code">
      </div>
      <div class="field-row">
        <label class="label" for="bugTitle">Bug title</label>
        <input class="field" id="bugTitle" data-act="wiz-save" data-key="description" value="${esc(f.description)}"
               placeholder="What is broken, in one line">
      </div>
      <div class="adv-grid">
        <div class="field-row">
          <label class="label" for="bugExp">Expected behaviour</label>
          <textarea class="field" id="bugExp" rows="3" data-act="wiz-save" data-key="bugExpected">${esc(f.bugExpected)}</textarea>
        </div>
        <div class="field-row">
          <label class="label" for="bugAct">Actual behaviour</label>
          <textarea class="field" id="bugAct" rows="3" data-act="wiz-save" data-key="bugActual">${esc(f.bugActual)}</textarea>
        </div>
      </div>
      <div class="field-row" style="max-width:240px">
        <label class="label" for="bugSev">Severity</label>
        <select class="field" id="bugSev" data-act="wiz-save" data-key="bugSeverity">
          ${['', 'low', 'medium', 'high', 'critical'].map((v) => `<option value="${v}"${f.bugSeverity === v ? ' selected' : ''}>${v ? v[0].toUpperCase() + v.slice(1) : 'Not set'}</option>`).join('')}
        </select>
      </div>
    </div>` : ''}`;

  /* 4 — start */
  const startBody = `
    <div class="start-card${prodLike ? ' is-prod' : ''}">
      <div class="start-sum">
        ${resolved ? `${envBadge(kind)}<b>${esc(label)}</b><span class="mono start-url">${esc(resolved.baseUrl)}</span>`
          : '<span class="muted">No environment chosen yet.</span>'}
      </div>
      ${problems.length ? `<ul class="start-problems" role="alert">${problems.map((p) => `<li>${icon('alert', 'i-sm')}${esc(p)}</li>`).join('')}</ul>` : ''}
      <button class="btn btn-primary btn-lg start-btn" data-act="launch-recording" ${canStart ? '' : 'disabled'}>
        ${S.launching ? icon('refresh', 'i-sm spinner') : icon('record', 'i-sm')}${S.launching
          ? 'Starting the browser…' : `Start recording on ${esc(label || 'the app')}`}
      </button>
      <div class="meta">Chromium opens in its own window. Do the steps that show the bug; everything is captured here as you go.</div>
    </div>`;

  return `
  <div class="page-head"><div>
    <h1>Record a bug</h1>
    <div class="sub">Capture it once where it happens, replay it on localhost, verify the fix.</div>
  </div></div>
  ${stepper('setup')}
  ${failed ? `<div class="note danger" role="alert" style="margin-bottom:var(--sp-4)">${icon('x-circle', 'i-sm')}<span class="grow">
    <b>Could not start the last recording.</b><pre class="err" style="margin:6px 0 0">${esc(S.rec.error || 'Unknown error')}</pre></span></div>` : ''}
  <ol class="wiz">
    ${wizStep(1, 'Application', apps.length ? 'done' : 'active', appBody)}
    ${wizStep(2, 'Source environment', resolved ? 'done' : 'active', envBody, 'where the bug happens')}
    ${wizStep(3, 'Bug details', bugCount ? 'done' : 'todo', bugBody, 'optional')}
    ${wizStep(4, 'Start', canStart ? 'active' : 'todo', startBody)}
  </ol>`;
}

ACTIONS['rec-app'] = (t) => {
  const name = t.getAttribute('data-app');
  REC.application = name;
  const g = recApplications().find((a) => a.name === name);
  // Move to that application's first environment unless the current pick already belongs to it.
  const cur = recEnvMatching(recWizardUrl());
  if (g && g.envs.length && !(cur && (cur.application || 'Default') === name)) S.recForm.app = g.envs[0].baseUrl;
  render();
};
ACTIONS['rec-pick-env'] = (t) => { S.recForm.app = t.getAttribute('data-url'); render(); };
ACTIONS['rec-adv'] = () => { REC.advOpen = !REC.advOpen; render(); };
ACTIONS['rec-bug'] = () => { REC.bugOpen = !REC.bugOpen; render(); };
/* Bug fields in the wizard write straight into the Save form, which is what the Save stage reads. */
const BUG_KEYS = ['name', 'description', 'bugExpected', 'bugActual', 'bugSeverity'];
const bugFilled = () => BUG_KEYS.filter((k) => String(S.saveForm[k] || '').trim()).length;
INPUTS['wiz-save'] = (node, value) => {
  const key = node.getAttribute('data-key');
  const before = bugFilled();
  S.saveForm[key] = value;
  if (key === 'name') S.recForm.name = value;
  if (key === 'description') S.recForm.description = value;
  // The "n fields filled" label is the only thing that depends on this, so repaint only when it
  // changes. render() puts focus and the caret back by id.
  if (bugFilled() !== before) render();
};

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
    Replayr service, and record the workflow again.</span></div>`;
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

/* ══════════════════════════════════════════════════════════════════════════
   STEP SUMMARIES — human sentences, never raw selectors
   ══════════════════════════════════════════════════════════════════════════ */
function recPath(u) {
  if (!u) return '';
  let x = String(u).replace(/^\{\{baseUrl\}\}/, '');
  if (/^https?:/i.test(x)) { try { const p = new URL(x); x = p.pathname + p.search; } catch { /* keep */ } }
  return x || '/';
}
/** The accessible name of the element a step touched, or null. */
function recElName(s) {
  const fp = s.target && s.target.fingerprint;
  if (fp) {
    const a = fp.attrs || {};
    return fp.name || fp.text || a.placeholder || a['aria-label'] || a.title || a.name || null;
  }
  const by = s.target && s.target.by;
  if (by) { const sh = typeof by === 'string' ? s.target : by; return sh.name || sh.text || null; }
  return null;
}
function recElKind(s) {
  const fp = s.target && s.target.fingerprint;
  if (fp) return fp.role || fp.tag || 'element';
  const by = s.target && s.target.by;
  if (by) { const sh = typeof by === 'string' ? s.target : by; return sh.role || 'element'; }
  return 'element';
}
function recSubject(s) {
  const n = recElName(s);
  return n ? `<b class="tl-obj">&ldquo;${esc(n)}&rdquo;</b>` : `<span class="tl-kind">the ${esc(recElKind(s))}</span>`;
}
function recQuote(t) { return `<b class="tl-obj">&ldquo;${esc(t)}&rdquo;</b>`; }
/** One readable sentence for a step (HTML, already escaped). */
function stepSummaryHtml(s) {
  switch (s.type) {
    case 'navigate': return `Navigated to <b class="tl-obj">${esc(recPath(s.url))}</b>`;
    case 'click': return `Clicked ${recSubject(s)}`;
    case 'dblclick': return `Double-clicked ${recSubject(s)}`;
    case 'hover': return `Hovered over ${recSubject(s)}`;
    case 'fill': return `Filled ${recSubject(s)}`;
    case 'select': return `Selected ${Array.isArray(s.values) && s.values.length ? recQuote(s.values.join(', ')) : 'an option'}`;
    case 'press': return `Pressed <kbd class="kbd">${esc(s.key || 'a key')}</kbd>`;
    case 'check': return `Ticked ${recSubject(s)}`;
    case 'uncheck': return `Unticked ${recSubject(s)}`;
    case 'upload': return `Uploaded a file to ${recSubject(s)}`;
    case 'openPage': return 'Opened a new tab';
    case 'closePage': return 'Closed a tab';
    case 'wait': return s.ms != null ? `Waited ${esc(stepDuration(s.ms))}` : 'Waited';
    case 'waitForXhr': return 'Waited for the network to go quiet';
    case 'expectVisible': return `Expect ${recSubject(s)} is visible`;
    case 'expectHidden': return `Expect ${recSubject(s)} is hidden`;
    case 'expectText': return `Expect ${recSubject(s)} has text`;
    case 'expectValue': return `Expect ${recSubject(s)} has value`;
    case 'expectCount': return `Expect ${esc(s.count == null ? '?' : s.count)} &times; ${recSubject(s)}`;
    case 'expectChecked': return `Expect ${recSubject(s)} is ${s.checked === false ? 'unticked' : 'ticked'}`;
    case 'expectUrl': return `Expect the URL to be <b class="tl-obj">${esc(recPath(s.url))}</b>`;
    default: return esc(stepActionLabel(s));
  }
}
/** The quiet second line: the typed value, the field a choice was made in, the assertion's data. */
function stepMetaText(s) {
  if (s.secret) return '';
  if (s.type === 'select') { const n = recElName(s); return n ? `in ${n}` : ''; }
  if (s.type === 'navigate' || s.type === 'press' || s.type === 'wait' || s.type === 'waitForXhr' || s.type === 'expectUrl') return '';
  if (s.type === 'expectCount') return '';
  return stepDetail(s);
}
function stepIsAssertion(s) { return !!s && String(s.type || '').indexOf('expect') === 0; }
function stepHasElement(s) { return !!s && !isTargetless(s) && !!(s.target || s.fallbackSelector) && !['navigate', 'press', 'openPage', 'closePage', 'expectUrl'].includes(s.type); }
function stepIsWarn(s) { return !!(s.warnings && s.warnings.length) || (s.locatorSummary && s.locatorSummary.verified === false) || s.identityStatus === 'none'; }
function stepIsError(s) { return s.identityStatus === 'error'; }

/** Identity status chip for a step that needs an element; '' for the rest. */
function identityChip(s) {
  if (s.identityStatus === 'resolving') return `<span class="tl-id is-resolving" title="Capturing the element's identity…">${icon('refresh', 'i-sm spinner')}</span>`;
  if (s.identityStatus === 'error') return `<span class="tl-id is-error" title="${esc(s.identityNote || 'Identity capture failed')}">${icon('x-circle', 'i-sm')}</span>`;
  if (stepIsWarn(s)) return `<span class="tl-id is-warn" title="${esc((s.warnings || []).join(' · ') || s.identityNote || 'The locator was not verified at record time')}">${icon('alert', 'i-sm')}</span>`;
  if (s.identityStatus === 'ok') return `<span class="tl-id is-ok" title="Element identity captured">${icon('check-circle', 'i-sm')}</span>`;
  return '';
}

function timelineItem(s, i, o) {
  const key = keyOf(s, i);
  const sel = key === o.sel;
  const meta = stepMetaText(s);
  const isNew = o.freshFrom != null && i >= o.freshFrom;
  return `
    <li class="tl-item${sel ? ' is-sel' : ''}${isNew ? ' is-new' : ''}${s.secret ? ' is-secret' : ''}${stepIsAssertion(s) ? ' is-assert' : ''}"
        role="option" tabindex="0" aria-selected="${sel}" data-act="select-step" data-scope="rec" data-key="${esc(key)}">
      <span class="tl-n">${i + 1}</span>
      <span class="tl-ic tile sq ${stepIconTint(s.type)}">${icon(stepIcon(s.type), 'i-sm')}</span>
      <span class="tl-main">
        <span class="tl-sum">${stepSummaryHtml(s)}</span>
        ${s.secret ? `<span class="tl-meta tl-secret">${lockGlyph('i-sm')}Password-like field — value not stored</span>`
          : meta ? `<span class="tl-meta mono truncate" title="${esc(meta)}">${esc(meta)}</span>` : ''}
        ${s.note ? `<span class="tl-note">${icon('pencil', 'i-sm')}${esc(s.note)}</span>` : ''}
      </span>
      <span class="tl-flags">
        ${s.secret ? `<span class="tl-lock" title="Secret: the recorder redacts the value">${lockGlyph('i-sm')}</span>` : ''}
        ${s.recordedIdle ? `<span class="tag" title="The recorder captured this pause because the page went quiet here">pause</span>` : ''}
        ${identityChip(s)}
        ${o.canDelete ? `<button class="btn-icon s-del danger" data-act="delete-step" data-scope="rec" data-key="${esc(key)}"
           aria-label="Delete step ${i + 1}" title="Delete this step">${icon('x', 'i-sm')}</button>` : ''}
      </span>
    </li>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   LIVE RECORDER WORKSPACE
   ══════════════════════════════════════════════════════════════════════════ */
function latestShotStep(steps) {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].target && steps[i].target.shot && !steps[i].secret) return { step: steps[i], index: i };
  return null;
}

function viewRecordLive() {
  const rec = S.rec;
  const steps = rec.steps || [];
  const starting = rec.status === 'starting';
  const stopping = rec.status === 'stopping';
  const paused = !!rec.paused;
  const mode = recWorkspaceMode();
  const baseUrl = rec.baseUrl || appBaseUrl(rec.app);
  const pg = rec.page || {};
  const lastStep = steps.length ? steps[steps.length - 1] : null;
  const currentUrl = pg.url || (lastStep && (lastStep.url || lastStep.at)) || baseUrl;
  const recTarget = rec.target || describeTarget(rec.app) || null;
  const envEntry = recEnvMatching(rec.baseUrl || rec.app);
  const envKind = (recTarget && recTarget.kind) || (envEntry && envEntry.kind) || null;
  const envLabel = (recTarget && recTarget.label) || (envEntry && envEntry.label) || appLabel(rec.app);
  const sel = S.recSel;
  const selected = findStep(steps, sel);
  const selIndex = indexOfStep(steps, sel);
  const sameRun = REC.lastRun === (rec.startedAt || '');
  const freshFrom = sameRun && REC.lastCount != null && REC.lastCount < steps.length ? REC.lastCount : null;
  const statusWord = starting ? 'Starting…' : stopping ? 'Stopping…' : paused ? 'Paused' : 'Recording';
  const shot = latestShotStep(steps);
  const shotKey = shot ? `${rec.startedAt || ''}/${shot.step.id}` : null;
  const shotOk = shot && !REC.shotBad[shotKey];

  const timeline = `
    <section class="rw-pane rw-timeline" aria-label="Action timeline">
      <header class="rw-head"><h2>Actions <span class="count">${steps.length}</span></h2>
        <span class="meta">${paused ? 'paused' : 'newest at the bottom'}</span></header>
      <div class="rw-scroll" id="tlScroll">
        ${steps.length ? `<ol class="tl" id="tlList" role="listbox" aria-label="Recorded actions">
          ${steps.map((s, i) => timelineItem(s, i, { sel, freshFrom, canDelete: !stopping })).join('')}</ol>` : `
          <div class="rw-empty">
            ${starting ? `${icon('refresh', 'i-lg spinner')}<b>Opening the browser…</b><span>Chromium is starting and the app is loading.</span>`
              : paused ? `${icon('pause', 'i-lg')}<b>Nothing captured yet</b><span>And nothing will be until you resume.</span>`
              : `${icon('pointer', 'i-lg')}<b>Waiting for your first action</b><span>Click, type or navigate in the recording window. Each action appears here.</span>`}
          </div>`}
      </div>
      <button class="tl-pill" id="tlPill" data-act="rec-jump" hidden>${icon('arrow-right', 'i-sm tl-pill-arrow')}<span id="tlPillText">New steps</span></button>
    </section>`;

  const center = `
    <section class="rw-pane rw-center" aria-label="Live page">
      <div class="live-card">
        <div class="live-src">
          <span class="live-src-label">Recording source</span>
          <span class="live-env">${envKind ? envBadge(envKind) : ''}<b>${esc(envLabel)}</b></span>
          <span class="pill ${paused ? 'block' : starting ? '' : 'run'} live-state"><span class="dot"></span>${paused ? 'Paused — not capturing' : starting ? 'Opening' : stopping ? 'Stopping' : 'Capturing'}</span>
        </div>
        <div class="live-page">
          <div class="live-page-title">${esc(pg.title || (starting ? 'Opening…' : 'Untitled page'))}</div>
          <div class="live-page-url mono" title="${esc(currentUrl || '')}">${esc(currentUrl || 'about:blank')}</div>
        </div>
        <div class="live-actions">
          <button class="btn btn-sm" data-act="rec-focus">${icon('window', 'i-sm')}Show recording window</button>
          <span class="meta">The recording happens in a separate Chromium window.</span>
        </div>
      </div>
      <figure class="shot-card">
        <div class="shot-frame">
          ${shotOk ? `<img class="shot-img" id="liveShot" data-shot-key="${esc(shotKey)}" alt="Element captured by the latest step"
              src="/api/recording/step/${encodeURIComponent(shot.step.id)}/shot?r=${encodeURIComponent(rec.startedAt || '')}">`
            : `<div class="shot-empty">${icon('image', 'i-lg')}<span>${shot ? 'The element picture is not available for this step.' : 'Element pictures appear here as you click.'}</span></div>`}
        </div>
        <figcaption class="shot-cap">${shotOk
          ? `Step ${shot.index + 1}: ${stepSummaryHtml(shot.step)}`
          : 'Latest captured element'}</figcaption>
      </figure>
      <p class="rw-hint">${icon('info', 'i-sm')}What you do in the browser window is captured here. Passwords and other secret fields are redacted.</p>
    </section>`;

  const inspector = `
    <aside class="rw-pane rw-insp${REC.inspOpen ? '' : ' is-collapsed'}${REC.drawer ? ' is-drawer-open' : ''}" aria-label="Step inspector" id="rwInsp">
      <header class="rw-head">
        ${REC.inspOpen ? `<h2>Inspector</h2>` : ''}
        <button class="btn-icon rw-insp-toggle" data-act="rec-insp" aria-expanded="${REC.inspOpen}" title="${REC.inspOpen ? 'Collapse inspector' : 'Expand inspector'}"
                aria-label="${REC.inspOpen ? 'Collapse inspector' : 'Expand inspector'}">${icon('sidebar', 'i-sm')}</button>
        <button class="btn-icon rw-drawer-close" data-act="rec-drawer" aria-label="Close inspector">${icon('x', 'i-sm')}</button>
      </header>
      ${REC.inspOpen ? `<div class="rw-scroll" id="inspScroll">${stepDetailsPanel(selected, selIndex, 'rec')}</div>` : ''}
    </aside>`;

  return `
  ${pausedBanner(rec)}
  ${captureWarning(rec)}
  <div class="recws ${mode === 'compact' ? 'is-compact' : 'is-expanded'}" id="recws">
    <div class="recws-grid${REC.inspOpen ? '' : ' insp-collapsed'}">
      ${timeline}
      ${center}
      ${inspector}
    </div>
    <div class="rec-scrim${REC.drawer ? ' is-on' : ''}" data-act="rec-drawer" aria-hidden="true"></div>
    <div class="rec-bar${paused ? ' is-paused' : ''}" role="region" aria-label="Recording controls">
      <span class="rec-ind" role="status">
        ${starting || stopping ? icon('refresh', 'i-sm spinner') : paused ? icon('pause', 'i-sm') : '<span class="rec-dot" aria-hidden="true"></span>'}
        <b>${esc(statusWord)}</b>
      </span>
      <span class="mono tnum rec-time" data-elapsed="${esc(rec.startedAt || '')}" data-long>00:00:00</span>
      <span class="rec-count"><b class="tnum">${steps.length}</b> ${steps.length === 1 ? 'action' : 'actions'}</span>
      <span class="grow"></span>
      <button class="btn btn-sm btn-ghost rec-mode" data-act="rec-mode" title="${mode === 'compact' ? 'Show the live page and inspector' : 'Timeline only'}"
              aria-pressed="${mode === 'compact'}">${icon('rows', 'i-sm')}<span>${mode === 'compact' ? 'Expanded' : 'Compact'}</span></button>
      <button class="btn btn-sm rec-insp-btn" data-act="rec-drawer">${icon('sidebar', 'i-sm')}<span>Inspector</span></button>
      <button class="btn btn-sm u-desktop-only" data-act="open-panel" title="Open the compact recorder panel beside the app">${icon('window', 'i-sm')}<span>Compact panel</span></button>
      <button class="btn${paused ? ' btn-primary' : ''}" data-act="${paused ? 'resume-rec' : 'pause-rec'}" ${starting || stopping || S.pausing ? 'disabled' : ''}>
        ${icon(paused ? 'play' : 'pause', 'i-sm')}${S.pausing ? (paused ? 'Resuming…' : 'Pausing…') : (paused ? 'Resume' : 'Pause')}
      </button>
      <button class="btn btn-danger" data-act="stop-rec" ${starting || stopping ? 'disabled' : ''}>${icon('stop', 'i-sm')}Stop</button>
      <button class="btn btn-danger-outline" data-act="rec-discard" ${starting ? 'disabled' : ''}>${icon('trash', 'i-sm')}<span>Discard</span></button>
    </div>
  </div>`;
}

ACTIONS['rec-mode'] = () => { lsSet('tf.recWorkspace', recWorkspaceMode() === 'compact' ? 'expanded' : 'compact'); render(); };
ACTIONS['rec-insp'] = () => { REC.inspOpen = !REC.inspOpen; render(); };
ACTIONS['rec-drawer'] = () => { REC.drawer = !REC.drawer; render(); };
/* A live recording cannot be discarded (the server answers 409), so stop it first, then discard. */
ACTIONS['rec-discard'] = async () => {
  if (!confirm('Discard this recording? The captured steps will be lost.')) return;
  const stopped = await guard(() => api('POST', '/api/recording/stop'), 'Could not stop the recording');
  if (stopped === undefined) return;
  const ok = await guard(() => api('POST', '/api/recording/discard'), 'Could not discard the recording');
  if (ok === undefined) return;
  onRecordingSnapshot(ok && ok.status ? ok : { status: 'idle', steps: [] });
  S.recStage = null; S.recSel = null;
  S.saveForm = blankSaveForm();
  S.recForm.name = ''; S.recForm.description = '';
  await loadTests();
  go('#/tests');
};
ACTIONS['rec-jump'] = () => { REC.newCount = 0; const sc = $('tlScroll'); if (sc) sc.scrollTop = sc.scrollHeight; paintRecPill(); };
ACTIONS['rec-sec'] = (t) => {
  const id = t.getAttribute('data-sec');
  const was = t.getAttribute('aria-expanded') === 'true';
  REC.sec[id] = !was;
  render();
};
ACTIONS['rec-focus'] = async () => {
  try { await api('POST', '/api/recording/focus'); }
  catch (e) { toast(e.status === 409 ? 'There is no recording window to show. It may have been closed.' : 'Could not show the recording window: ' + e.message, 'bad'); }
};

/* Scroll + highlight bookkeeping around every paint of this screen. render() rebuilds #page, which
   would otherwise throw the timeline back to the top on every captured action. */
function recScrollState() {
  const out = {};
  const tl = $('tlScroll');
  if (tl) out.tl = { top: tl.scrollTop, atEnd: tl.scrollHeight - tl.scrollTop - tl.clientHeight < 48 };
  const ins = $('inspScroll');
  if (ins) out.insp = ins.scrollTop;
  return out;
}
function paintRecPill() {
  const pill = $('tlPill');
  if (!pill) return;
  pill.hidden = REC.newCount <= 0;
  const t = $('tlPillText');
  if (t) t.textContent = REC.newCount === 1 ? '1 new step' : `${REC.newCount} new steps`;
}
function recAfterRender(before) {
  const steps = S.rec.steps || [];
  const run = S.rec.startedAt || '';
  const first = REC.lastRun !== run;
  const added = first || REC.lastCount == null ? 0 : Math.max(0, steps.length - REC.lastCount);
  const tl = $('tlScroll');
  if (tl) {
    if (first || !before.tl || before.tl.atEnd) { tl.scrollTop = tl.scrollHeight; REC.newCount = 0; }
    else { tl.scrollTop = before.tl.top; REC.newCount += added; }
    const ins = $('inspScroll');
    if (ins && before.insp) ins.scrollTop = before.insp;
    paintRecPill();
    const img = $('liveShot');
    if (img) img.addEventListener('error', () => {
      REC.shotBad[img.getAttribute('data-shot-key')] = true;
      const frame = img.parentNode;
      if (frame) frame.innerHTML = `<div class="shot-empty">${icon('image', 'i-lg')}<span>The element picture is not available for this step.</span></div>`;
    }, { once: true });
  }
  REC.lastRun = run;
  REC.lastCount = steps.length;
}
document.addEventListener('scroll', (e) => {
  if (e.target && e.target.id === 'tlScroll' && REC.newCount) {
    const tl = e.target;
    if (tl.scrollHeight - tl.scrollTop - tl.clientHeight < 48) { REC.newCount = 0; paintRecPill(); }
  }
}, true);
(function wrapRender() {
  const baseRender = render;
  render = function recAwareRender() {
    if (!S.route || S.route.name !== 'record') { baseRender(); return; }
    const before = recScrollState();
    baseRender();
    recAfterRender(before);
  };
})();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && REC.drawer) { REC.drawer = false; render(); } });

/* ══════════════════════════════════════════════════════════════════════════
   REVIEW
   ══════════════════════════════════════════════════════════════════════════ */
function reviewCounts(steps) {
  return {
    errors: steps.filter(stepIsError).length,
    warnings: steps.filter((s) => !stepIsError(s) && stepIsWarn(s)).length,
    assertions: steps.filter(stepIsAssertion).length,
  };
}

function viewReview() {
  const steps = S.rec.steps || [];
  const durationMs = (S.rec.startedAt && S.rec.stoppedAt)
    ? new Date(S.rec.stoppedAt) - new Date(S.rec.startedAt) : null;
  const c = reviewCounts(steps);
  const target = S.rec.target || describeTarget(S.rec.app) || null;
  const sel = S.recSel;
  const selected = findStep(steps, sel);
  const index = indexOfStep(steps, sel);
  const asSheet = isNarrow() && S.sheetOpen && !!selected;

  const nudge = steps.length && !c.assertions ? `
    <div class="assert-nudge" role="note">
      <span class="assert-nudge-ic">${icon('eye', 'i-lg')}</span>
      <span class="grow"><b>No assertion yet.</b> Without an assertion a replay can only say the steps completed &mdash; add one to verify the fix.
        <span class="meta" style="display:block">Select the step where the broken result shows (a click, a fill) and choose <i>Add assertion</i> in the inspector.</span></span>
      <button class="btn btn-sm btn-primary" data-act="rec-suggest-assert">Add an assertion</button>
    </div>` : '';

  return `
  <div class="page-head">
    <div>
      <h1>Review the steps</h1>
      <div class="sub">Check what was captured, tidy it, and add an assertion that proves the bug.</div>
    </div>
    <div class="row wrap">
      ${target && target.kind ? `<span class="rv-src">${envBadge(target.kind)}<span class="muted">recorded on</span> <b>${esc(target.label || appLabel(S.rec.app))}</b></span>` : ''}
      <button class="btn" data-act="discard-draft">Discard</button>
      <button class="btn btn-primary" data-act="goto-save" ${steps.length ? '' : 'disabled'}>
        Continue${icon('arrow-right', 'i-sm')}
      </button>
    </div>
  </div>
  ${stepper('review')}
  ${captureWarning(S.rec)}
  ${steps.length ? `
  <div class="rv-summary" role="status">
    <span class="rv-chip">${steps.length} ${steps.length === 1 ? 'step' : 'steps'}</span>
    ${durationMs != null ? `<span class="rv-chip">${esc(fmtDuration(durationMs))}</span>` : ''}
    <span class="rv-chip ${c.assertions ? 'is-ok' : 'is-none'}">${icon('eye', 'i-sm')}${c.assertions} ${c.assertions === 1 ? 'assertion' : 'assertions'}</span>
    <span class="rv-chip ${c.warnings ? 'is-warn' : ''}">${icon('alert', 'i-sm')}${c.warnings} ${c.warnings === 1 ? 'warning' : 'warnings'}</span>
    <span class="rv-chip ${c.errors ? 'is-error' : ''}">${icon('x-circle', 'i-sm')}${c.errors} ${c.errors === 1 ? 'error' : 'errors'}</span>
  </div>
  ${nudge}
  <div class="split rv-split">
    <div class="card">
      <div class="card-head"><h3>Steps</h3>
        <span class="row" style="gap:var(--sp-2)">${insertWaitButton(steps, index)}</span>
      </div>
      ${renderReviewList(steps, sel)}
    </div>
    <div class="card sheet${asSheet ? ' sheet-open' : ''}" id="stepSheet"
         role="${asSheet ? 'dialog' : 'group'}"${asSheet ? ' aria-modal="true"' : ''} aria-label="Step details">
      <span class="u-mobile-only"><button class="btn-icon sheet-close" id="sheetClose" data-act="close-sheet"
              title="Close step details" aria-label="Close step details">${icon('x', 'i-sm')}</button></span>
      ${stepDetailsPanel(selected, index, 'rec')}
    </div>
  </div>` : `<div class="card empty-sm" style="padding:44px 16px">
      Nothing was captured. <button class="btn btn-sm" data-act="discard-draft">Start over</button></div>`}`;
}

/** The review timeline: summaries, a visible note, red errors and amber warnings, reorder + delete. */
function renderReviewList(steps, selectedKey) {
  if (!steps.length) return `<div class="empty-sm">No steps.</div>`;
  return `<ol class="tl tl-review" role="listbox" aria-label="Steps">` + steps.map((s, i) => {
    const key = keyOf(s, i);
    const sel = key === selectedKey;
    const meta = stepMetaText(s);
    const err = stepIsError(s);
    const warn = !err && stepIsWarn(s);
    const flagText = err ? (s.identityNote || 'Identity capture failed')
      : warn ? ((s.warnings || []).join(' · ') || s.identityNote || 'The locator was not verified at record time') : '';
    return `
    <li class="tl-item${sel ? ' is-sel' : ''}${err ? ' has-error' : warn ? ' has-warn' : ''}${stepIsAssertion(s) ? ' is-assert' : ''}"
        role="option" tabindex="0" aria-selected="${sel}" data-act="select-step" data-scope="rec" data-key="${esc(key)}">
      <span class="tl-n">${i + 1}</span>
      <span class="tl-ic tile sq ${stepIconTint(s.type)}">${icon(stepIcon(s.type), 'i-sm')}</span>
      <span class="tl-main">
        <span class="tl-sum">${stepSummaryHtml(s)}${s.addedByHand || String(s.id || '').indexOf('new-') === 0 ? '<span class="tag tl-tag">added</span>' : ''}${s.recordedIdle ? '<span class="tag tl-tag" title="The recorder captured this pause because the page went quiet here">recorded pause</span>' : ''}</span>
        ${s.secret ? `<span class="tl-meta tl-secret">${lockGlyph('i-sm')}Password-like field — value not stored</span>`
          : meta ? `<span class="tl-meta mono truncate" title="${esc(meta)}">${esc(meta)}</span>` : ''}
        ${s.note ? `<span class="tl-note">${icon('pencil', 'i-sm')}${esc(s.note)}</span>` : ''}
        ${flagText ? `<span class="tl-flagtext ${err ? 'is-error' : 'is-warn'}">${icon(err ? 'x-circle' : 'alert', 'i-sm')}${esc(flagText)}</span>` : ''}
      </span>
      <span class="tl-flags">
        ${s.secret ? `<span class="tl-lock" title="Secret: the recorder redacts the value">${lockGlyph('i-sm')}</span>` : ''}
        ${moveButtons('rec', key, i, steps.length)}
        <button class="btn-icon s-del danger" data-act="delete-step" data-scope="rec" data-key="${esc(key)}"
           aria-label="Delete step ${i + 1}" title="Delete this step">${icon('x', 'i-sm')}</button>
      </span>
    </li>`;
  }).join('') + '</ol>';
}

ACTIONS['rec-suggest-assert'] = () => {
  const steps = S.rec.steps || [];
  // The step the person was last pointing at is the best guess; otherwise the last element step.
  let pick = findStep(steps, S.recSel);
  if (!stepHasElement(pick) || pick.secret) {
    for (let i = steps.length - 1; i >= 0; i--) if (stepHasElement(steps[i]) && !steps[i].secret) { pick = steps[i]; break; }
  }
  if (!pick || !stepHasElement(pick)) { toast('None of these steps touched an element, so there is nothing to assert on.', 'bad'); return; }
  S.recSel = keyOf(pick, steps.indexOf(pick));
  REC.sec.assert = true;
  if (isNarrow()) S.sheetOpen = true;
  render();
  const sec = $('assertSection');
  if (sec) sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};

/**
 * Add an assertion after the selected step, carrying that step's element identity.
 * Done on the client like Insert wait: once recording has stopped the draft is this page's array
 * until Save, and the server's insertStep would replace it wholesale with a fresh snapshot,
 * discarding edits made in this review.
 */
function addAssertion(kind) {
  const steps = S.rec.steps || [];
  const idx = indexOfStep(steps, S.recSel);
  const src = steps[idx];
  if (!src || !stepHasElement(src)) return;
  const ok = { expectVisible: 1, expectHidden: 1, expectText: 1, expectValue: 1, expectCount: 1 };
  if (!ok[kind]) return;
  if (kind === 'expectValue' && src.secret) { toast('That field was redacted as a credential, so there is no value to assert on.', 'bad'); return; }
  const a = { id: newStepId(), type: kind, addedByHand: true };
  if (src.target) a.target = JSON.parse(JSON.stringify(src.target));
  if (src.target && src.target.shot !== undefined) delete a.target.shot;
  if (src.fallbackSelector) a.fallbackSelector = src.fallbackSelector;
  if (src.selector) a.selector = src.selector;
  if (src.frame) a.frame = JSON.parse(JSON.stringify(src.frame));
  if (src.at) a.at = src.at;
  const fp = src.target && src.target.fingerprint;
  if (kind === 'expectText') a.text = (fp && (fp.text || fp.name)) || (typeof src.value === 'string' ? src.value : '') || '';
  if (kind === 'expectValue') a.value = typeof src.value === 'string' ? src.value : '';
  if (kind === 'expectCount') a.count = 1;
  steps.splice(idx + 1, 0, a);
  S.recSel = keyOf(a, idx + 1);
  if (kind === 'expectText' || kind === 'expectValue' || kind === 'expectCount') S.inspEdit = true;
  announce(`${actionLabel(kind)} added after step ${idx + 1}.`);
  render();
  const field = $('inspValue');
  if (field && !field.readOnly) field.focus();
}
ACTIONS['add-assertion'] = (t) => addAssertion(t.getAttribute('data-kind'));
ACTIONS['toggle-assert-sec'] = () => { REC.sec.assert = !(REC.sec.assert !== false); render(); };
INPUTS['edit-count'] = (node, value) => {
  const step = findStep(S.rec.steps || [], node.getAttribute('data-key'));
  if (!step) return;
  const n = Math.round(Number(value));
  step.count = Number.isFinite(n) && n >= 0 ? n : 0;
  step.text = null;
  render();
};
INPUTS['edit-note'] = (node, value) => {
  const step = findStep(S.rec.steps || [], node.getAttribute('data-key'));
  if (!step) return;
  if (value.trim()) step.note = value.slice(0, 200); else delete step.note;
  render();     // the note is shown in the step list as it is typed; focus and caret are restored by id
};

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
  if (status === 'not-run') return `<svg class="i i-sm subtle" role="img" aria-label="not run"><use href="#i-circle"/></svg>`;
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
  const live = scope === 'rec' && recordingIsLive();
  const editable = S.inspEdit && !live;
  const targetless = isTargetless(step);

  const head = `
    <div class="card-head">
      <h3>Step Details <span class="muted" style="font-weight:400">· ${index + 1}</span></h3>
      <div class="row">
        ${live ? '' : `<button class="btn btn-sm ${editable ? 'btn-primary' : ''}" data-act="toggle-insp-edit">
          ${icon('pencil', 'i-sm')}${editable ? 'Done' : 'Edit'}
        </button>`}
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
      ${step.type === 'expectCount' ? `
        <div class="field-row" style="margin-bottom:0">
          <label class="label" for="inspValue">Expected number of matches</label>
          <input class="field" id="inspValue" type="number" min="0" step="1" inputmode="numeric" value="${esc(step.count == null ? '' : step.count)}" ${editable ? '' : 'readonly'}
                 data-act="edit-count" data-key="${esc(keyOf(step, index))}">
          <div class="meta">${editable ? 'Saved with the test.' : 'Press Edit to change this value.'}</div>
        </div>` : ''}
      ${step.secret ? `<div class="note info" style="margin-top:var(--sp-2)">${lockGlyph('i-sm')}<span>Password-like field. The value was redacted and is never stored or replayed from this recording.</span></div>` : ''}
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

    ${fallbacks.length ? recSection('fallbacks', `Fallback locators (${fallbacks.length})`, `
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
      }).join('')}`, false) : ''}

    ${fp ? elementSection(fp) : target ? legacyTargetSection(target) : ''}
    ${fp && fp.context ? contextSection(fp) : ''}
    ${fp ? distrustSection(fp) : ''}
    ${(step.warnings && step.warnings.length) ? `
      <div class="insp-sec"><h4>Warnings</h4>
        ${step.warnings.map((w) => `<div class="note warn">${icon('alert', 'i-sm')}<span>${esc(w)}</span></div>`).join('')}
      </div>` : ''}
    ${scope === 'rec' && !live ? reviewExtras(step, index) : ''}
    ${diagnosticsSection(step)}`;
}

/** A collapsible inspector section: progressive disclosure for the advanced parts. */
function recSection(id, title, inner, def) {
  const open = REC.sec[id] == null ? !!def : !!REC.sec[id];
  return `<div class="insp-sec insp-coll">
    <button type="button" class="insp-h" id="sec-${esc(id)}" data-act="rec-sec" data-sec="${esc(id)}" aria-expanded="${open}">
      ${icon('chevron-right', 'i-sm disc-chev')}<span>${esc(title)}</span></button>
    ${open ? `<div class="insp-body">${inner}</div>` : ''}</div>`;
}

/** What the recorder knew about capturing this step, for when a locator looks wrong. */
function diagnosticsSection(step) {
  const sum = step.locatorSummary || {};
  const rows = [];
  if (step.identityStatus) rows.push(['Identity', step.identityStatus === 'ok' ? 'captured' : step.identityStatus]);
  if (step.identityNote) rows.push(['Note', step.identityNote]);
  if (sum.strategy) rows.push(['Strategy', sum.strategy]);
  if (sum.verified != null) rows.push(['Verified', sum.verified ? 'yes, one match at record time' : 'no']);
  if (sum.fallbacks != null) rows.push(['Fallbacks', String(sum.fallbacks)]);
  if (step.id != null) rows.push(['Step id', String(step.id)]);
  if (!rows.length) return '';
  return recSection('diag', 'Diagnostics', `<dl class="kv kv-narrow">${rows.map(([k, v]) =>
    `<dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`).join('')}</dl>`, false);
}

/** Review-only controls: a note on the step, and assertions that reuse its element. */
function reviewExtras(step, index) {
  const key = keyOf(step, index);
  const note = `<div class="insp-sec">
      <div class="field-row" style="margin-bottom:0">
        <label class="label" for="inspNote">Note <span class="subtle">(optional)</span></label>
        <input class="field" id="inspNote" maxlength="200" value="${esc(step.note || '')}" placeholder="Why this step matters"
               data-act="edit-note" data-key="${esc(key)}">
        <div class="meta">Shown in the step list and saved with the test.</div>
      </div></div>`;
  if (!stepHasElement(step) || stepIsAssertion(step)) return note;
  const opts = [
    ['expectVisible', 'Visible', 'The element is on screen'],
    ['expectHidden', 'Hidden', 'The element is gone'],
    ['expectText', 'Text', 'It shows this text'],
    ['expectValue', 'Value', 'The field holds this value'],
    ['expectCount', 'Count', 'This many elements match'],
  ];
  const body = `<div class="assert-grid">${opts.map(([kind, name, hint]) => {
      const off = kind === 'expectValue' && step.secret;
      return `<button type="button" class="assert-opt" data-act="add-assertion" data-kind="${kind}" ${off ? 'disabled title="Redacted credential: no value to assert"' : ''}>
        <b>Expect ${esc(name.toLowerCase())}</b><span>${esc(hint)}</span></button>`;
    }).join('')}</div>
    <div class="meta" style="margin-top:var(--sp-2)">Adds the assertion after step ${index + 1}, on this same element.</div>`;
  return note + `<div id="assertSection">${recSection('assert', 'Add assertion', body, true)}</div>`;
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
  return recSection('element', 'Element', `
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
        state.visible === false && state.enabled === false ? ' and ' : ''}${state.enabled === false ? 'disabled' : ''}.</span></div>` : ''}`, true);
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
  return recSection('context', 'Context', `
    <div class="crumb">${crumbs.map((c, i) =>
      `${i ? icon('chevron-right', 'i-sm') : ''}${i === crumbs.length - 1 ? `<b>${esc(c)}</b>` : esc(c)}`).join('')}</div>
    ${(ctx.heading || ctx.landmark || ctx.list) ? `<dl class="kv" style="margin-top:10px">
      ${ctx.heading ? `<dt>Heading</dt><dd>${esc(ctx.heading)}</dd>` : ''}
      ${ctx.landmark ? `<dt>Landmark</dt><dd>${esc(ctx.landmark)}</dd>` : ''}
      ${ctx.list ? `<dt>List</dt><dd>${esc(typeof ctx.list === 'object' ? JSON.stringify(ctx.list) : ctx.list)}</dd>` : ''}
    </dl>` : ''}`, false);
}

function distrustSection(fp) {
  const volatile = fp.volatile || {};
  const keys = Object.keys(volatile);
  if (!keys.length && !fp.blindSpot) return '';
  return recSection('distrust', 'Signals we distrust', `
    ${fp.blindSpot ? `<div class="note warn" style="margin-bottom:${keys.length ? '10px' : '0'}">
      ${icon('alert', 'i-sm')}<span><b>Blind spot.</b> ${esc(fp.blindSpot)}</span></div>` : ''}
    ${keys.length ? `<dl class="kv kv-narrow">
      ${keys.map((k) => `<dt>${esc(k)}</dt><dd class="muted">${esc(volatile[k])}</dd>`).join('')}</dl>` : ''}`, false);
}


/* ── Save Test ─────────────────────────────────────────────────────────── */
function viewSaveTest() {
  const steps = S.rec.steps || [];
  const cfg = S.config || {};
  const durationMs = (S.rec.startedAt && S.rec.stoppedAt) ? new Date(S.rec.stoppedAt) - new Date(S.rec.startedAt) : null;
  const f = S.saveForm;
  const target = S.rec.target || describeTarget(S.rec.app) || null;
  const envEntry = recEnvMatching(S.rec.baseUrl || S.rec.app);
  const kind = (target && target.kind) || (envEntry && envEntry.kind) || null;
  const label = (target && target.label) || (envEntry && envEntry.label) || appLabel(S.rec.app);
  const c = reviewCounts(steps);
  const localEnv = recLocalEnvFor(envEntry);
  const canSave = steps.length && !S.saving;

  return `
  <div class="page-head">
    <div><h1>Save the test</h1><div class="sub">Name it, add the bug details, then replay it on localhost.</div></div>
    <button class="back" data-act="goto-review" style="margin:0">${icon('arrow-left', 'i-sm')}Back to steps</button>
  </div>
  ${stepper('save')}

  <div class="split">
    <div class="card card-pad">
      <div class="field-row">
        <label class="label" for="saveName">Test name</label>
        <input class="field" id="saveName" data-act="save-form" data-key="name" value="${esc(f.name)}"
               placeholder="Customer save loses the tax code">
      </div>
      <div class="field-row">
        <label class="label" for="saveDesc">Description <span class="subtle">(optional)</span></label>
        <textarea class="field" id="saveDesc" rows="3" data-act="save-form" data-key="description"
                  placeholder="What is broken, and what should happen instead">${esc(f.description)}</textarea>
      </div>
      <fieldset class="bug-fields">
        <legend class="label">Bug details <span class="subtle">(optional)</span></legend>
        <div class="field-row">
          <label class="label" for="saveBugExp">Expected behaviour</label>
          <textarea class="field" id="saveBugExp" rows="2" data-act="save-form" data-key="bugExpected">${esc(f.bugExpected)}</textarea>
        </div>
        <div class="field-row">
          <label class="label" for="saveBugAct">Actual behaviour</label>
          <textarea class="field" id="saveBugAct" rows="2" data-act="save-form" data-key="bugActual">${esc(f.bugActual)}</textarea>
        </div>
        <div class="field-row" style="margin-bottom:0">
          <label class="label" for="saveBugSev">Severity</label>
          <select class="field" id="saveBugSev" data-act="save-form" data-key="bugSeverity">
            ${['', 'low', 'medium', 'high', 'critical'].map((v) => `<option value="${v}"${f.bugSeverity === v ? ' selected' : ''}>${v ? v[0].toUpperCase() + v.slice(1) : 'Not set'}</option>`).join('')}
          </select>
        </div>
      </fieldset>
      <div class="field-row">
        <label class="label" for="saveFolder">Folder <span class="subtle">(optional)</span></label>
        <select class="field" id="saveFolder" data-act="save-form" data-key="folder">
          <option value="">No folder</option>
          ${S.folders.map((x) => `<option value="${esc(x)}"${f.folder === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}
        </select>
      </div>
      <div class="field-row" style="margin-bottom:0">
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
      <div class="card-head"><h3>Summary</h3></div>
      <div class="card-pad">
        <div class="sv-src">
          <span class="field-label">Recorded on</span>
          <div class="sv-src-row">${kind ? envBadge(kind) : ''}<b>${esc(label)}</b></div>
          <div class="mono meta">${esc(S.rec.baseUrl || appBaseUrl(S.rec.app) || '—')}</div>
        </div>
        <dl class="kv kv-narrow" style="margin-top:var(--sp-3)">
          <dt>Steps</dt><dd>${steps.length}</dd>
          <dt>Assertions</dt><dd>${c.assertions
            ? `${c.assertions}` : `<span class="st-warn">none &mdash; a replay can only say the steps completed</span>`}</dd>
          <dt>Length</dt><dd>${esc(durationMs != null ? fmtDuration(durationMs) : '—')}</dd>
          <dt>Browser</dt><dd>${esc(S.recForm.browser === 'chromium' ? 'Chrome' : S.recForm.browser)} · ${esc(S.recForm.viewport.replace('x', ' × '))}</dd>
          <dt>Saved to</dt><dd class="mono" style="word-break:break-all">${esc(cfg.testsDir || '—')}</dd>
        </dl>
        ${!c.assertions ? `<div class="note warn" style="margin-top:var(--sp-3)">${icon('alert', 'i-sm')}<span>
          Add an assertion in <button class="btn btn-ghost btn-sm" data-act="goto-review" type="button">Review</button> to verify the fix.</span></div>` : ''}
      </div>
    </div>
  </div>

  <div class="sv-actions">
    <button class="btn" data-act="goto-review">Back</button>
    <span class="grow"></span>
    <button class="btn" data-act="save-and-replay" ${canSave ? '' : 'disabled'}
            title="Saves the test, then opens it ready to replay${localEnv ? ' on ' + esc(localEnv.label) : ' on localhost'}">
      ${icon('play', 'i-sm')}Save and replay on localhost
    </button>
    <button class="btn btn-primary" data-act="save-draft" ${canSave ? '' : 'disabled'}>
      ${S.saving ? icon('refresh', 'i-sm spinner') : icon('check', 'i-sm')}${S.saving ? 'Saving test…' : 'Save test'}
    </button>
  </div>`;
}

/** The local environment to replay on: the one of the same application when there is one. */
function recLocalEnvFor(sourceEnv) {
  const locals = recEnvList().filter((e) => e.kind === 'local');
  const app = sourceEnv && (sourceEnv.application || 'Default');
  return locals.find((e) => (e.application || 'Default') === app) || locals[0] || null;
}

/**
 * "Save and replay on localhost": save exactly as Save does (it lands on the test), then arm that
 * test's run target with the local environment. The replay itself is NOT started here: the test
 * page shows where it will run and the person presses Run, so a replay never fires at the wrong
 * environment by accident.
 */
ACTIONS['save-and-replay'] = async () => {
  if (S.saving) return;
  S.saveForm.runAfter = false;
  const local = recLocalEnvFor(recEnvMatching(S.rec.baseUrl || S.rec.app));
  await saveDraft();
  if (!local) return;
  // onRouteChange clears runTarget when the route changes, so wait for the test page to be current.
  for (let i = 0; i < 40; i++) {
    if (S.route && S.route.name === 'test') { S.runTarget = local.key; render(); return; }
    await new Promise((r) => setTimeout(r, 100));
  }
};

/* ── Recovered recording draft ── */
async function loadRecovered() {
  if (recordingIsLive() || S.rec.status === 'stopped') { S.recovered = null; return; }
  try {
    const data = await api('GET', '/api/recording/recovered');
    const d = data && (data.draft || data.recovered || data);
    S.recovered = d && Array.isArray(d.steps) && d.steps.length ? { ...d, saveName: S.recovered ? S.recovered.saveName : '' } : null;
  } catch (e) {
    S.recovered = null;                  // 404 = nothing to recover
  }
  if (S.route.name === 'record') render();
}

function recoveredNotice() {
  const d = S.recovered;
  if (!d || recordingIsLive() || S.rec.status === 'stopped') return '';
  return `<div class="note warn recovered-draft" role="status" style="margin-bottom:16px">${icon('info', 'i-sm')}
    <span class="grow"><b>An unsaved recording was recovered</b> (${d.steps.length} ${d.steps.length === 1 ? 'step' : 'steps'}${d.app ? ' on ' + esc(appLabel(d.app)) : ''}).
      Save it as a test, or discard it.</span>
    <label class="sr-only" for="recoveredName">Name for the recovered test</label>
    <input class="field" id="recoveredName" style="width:200px" placeholder="Test name" data-act="recovered-name" value="${esc(d.saveName || '')}">
    <button class="btn btn-sm btn-primary" data-act="recovered-save">Save as test</button>
    <button class="btn btn-sm btn-danger-outline" data-act="recovered-discard">Discard</button></div>`;
}

async function saveRecovered() {
  const d = S.recovered;
  if (!d) return;
  const name = String(d.saveName || '').trim();
  if (!name) { toast('Give the recovered test a name first', 'bad'); const n = $('recoveredName'); if (n) n.focus(); return; }
  const saved = await guard(() => api('POST', '/api/tests', {
    name, description: d.description || '', app: d.app, steps: d.steps, ...(d.bug ? { bug: d.bug } : {}),
  }), 'Could not save the recovered draft');
  if (!saved) return;
  try { await api('DELETE', '/api/recording/recovered'); } catch { /* the test is saved; the draft file is harmless */ }
  S.recovered = null;
  toast(`Saved "${saved.name}" from the recovered draft`, 'good');
  await loadTests();
  go('#/test/' + saved.id);
}

async function discardRecovered() {
  if (!confirm('Discard the recovered recording? Its steps will be lost.')) return;
  try { await api('DELETE', '/api/recording/recovered'); } catch (e) { if (e.status !== 404) { toast('Could not discard: ' + e.message, 'bad'); return; } }
  S.recovered = null;
  render();
}

