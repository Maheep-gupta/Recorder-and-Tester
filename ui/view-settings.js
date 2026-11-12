/* Views: Settings, Applications & Environments, Trash.
 * Part of the UI bundle: classic scripts loaded in order from index.html, sharing one global
 * scope (state S, helpers, render). Handlers register through ACTIONS / INPUTS (core.js).
 */
'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   SHARED BITS
   ══════════════════════════════════════════════════════════════════════════ */
const ENV_KINDS = [
  ['production', 'Production'], ['staging', 'Staging'], ['development', 'Development'], ['local', 'Local'],
];
const ENV_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/* The sprite has no flask/laptop/code glyphs, so the kind badge carries its own small SVGs.
   Production uses the shared shield; every kind has an icon AND a word, never colour alone. */
function kindGlyph(kind) {
  const p = {
    production: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    staging: '<path d="M10 3h4M11 3v6l-5.5 9.5A1.5 1.5 0 0 0 6.8 21h10.4a1.5 1.5 0 0 0 1.3-2.5L13 9V3"/><path d="M8.5 14h7"/>',
    development: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"/>',
    local: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M3 19h18"/>',
  }[kind] || '';
  return `<svg class="i i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
function kindLabel(kind) { const m = ENV_KINDS.find(([k]) => k === kind); return m ? m[1] : 'Production'; }
function kindBadge(kind) {
  const k = ENV_KINDS.some(([x]) => x === kind) ? kind : 'production';
  return `<span class="env-badge env-${k} kind-badge">${kindGlyph(k)}${esc(kindLabel(k))}</span>`;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}
/** Suggest a kind from a base URL's host; null when the URL does not parse. */
function inferKindFromUrl(url) {
  let u; try { u = new URL(String(url || '').trim()); } catch { return null; }
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost') || h.endsWith('.local')) return 'local';
  if (/(^|[.-])(stg|stage|staging|qa\d*|uat|test)([.-]|$)/.test(h)) return 'staging';
  if (/(^|[.-])(dev|development|sandbox)([.-]|$)/.test(h)) return 'development';
  return 'production';
}
function urlError(v) {
  const raw = String(v || '').trim();
  if (!raw) return 'Enter the base URL.';
  let u; try { u = new URL(raw); } catch { return 'Not a valid URL. Include http:// or https://, e.g. https://staging.example.com'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Only http:// and https:// URLs are supported.';
  if (u.username || u.password) return 'Do not put a username or password in the URL.';
  return null;
}
function envFormErrors(f) {
  const e = {};
  const u = urlError(f.baseUrl); if (u) e.baseUrl = u;
  if (!f.key) e.key = 'Enter a key (it is derived from the label).';
  else if (!ENV_KEY_RE.test(f.key)) e.key = 'Lowercase letters, digits and dashes; start with a letter or digit; max 40.';
  else if (f.mode === 'new' && (S.envs || []).some((x) => x.key === f.key)) e.key = `"${f.key}" is already used by another environment.`;
  return e;
}

/* ══════════════════════════════════════════════════════════════════════════
   SETTINGS
   ══════════════════════════════════════════════════════════════════════════ */
const SHORTCUTS = [
  [['Ctrl', 'K'], 'Open the command palette'],
  [['?'], 'Show the full shortcut sheet'],
  [['/'], 'Focus the search box'],
  [['N'], 'Record a bug'],
  [['G', 'O'], 'Go to Overview (G then T Test Library, R Record, H History, E Environments)'],
  [['Esc'], 'Close a dialog, menu or palette; leave a field'],
  [['↑', '↓'], 'Move the step selection (Alt + arrows reorders the selected step)'],
  [['←', '→'], 'Move between tabs in a tab list'],
  [['Enter'], 'Open the focused row'],
];

function settingsSection(id, title, sub, body) {
  return `
  <section class="card card-pad set-section" id="set-${id}" aria-labelledby="set-${id}-h">
    <h2 class="set-h" id="set-${id}-h">${esc(title)}</h2>
    ${sub ? `<p class="set-sub">${sub}</p>` : ''}
    ${body}
  </section>`;
}

function prefRow(pref, title, text, dflt) {
  return `<div class="opt-row">
    <label class="check"><input type="checkbox" data-act="pref" data-pref="${pref}" ${prefGet(pref, dflt) ? 'checked' : ''}>
      <span><b>${esc(title)}</b><div class="meta">${text}</div></span></label>
  </div>`;
}

function viewSettings() {
  const cfg = S.config || {};
  const apps = Object.entries(cfg.apps || {});
  const choice = themeChoice();
  const authed = apps.filter(([, a]) => a.auth);
  const head = `
  <div class="page-head">
    <div><h1>Settings</h1><div class="sub">How Replayr looks and behaves on this machine. Preferences are stored in this browser; the rest comes from the Replayr service.</div></div>
  </div>`;

  const appearance = settingsSection('appearance', 'Appearance', '', `
    <div class="field-row">
      <span class="label" id="themeLbl">Theme</span>
      <div class="seg" role="group" aria-labelledby="themeLbl">
        ${[['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(([v, l, ic]) => `
          <button data-act="set-theme" data-theme="${v}" aria-pressed="${choice === v}">${icon(ic, 'i-sm')}${l}</button>`).join('')}
      </div>
      <div class="meta">System follows your operating system. Saved as <span class="mono">tf.theme</span> in this browser.</div>
    </div>`);

  const recording = settingsSection('recording', 'Recording', 'Defaults for the Record screen.', `
    <div class="field-row">
      <label class="label" for="setAppUrl">Application URL</label>
      <input class="field" id="setAppUrl" type="url" list="setAppList" data-act="set-default-app"
             value="${esc(S.recForm.app == null ? appBaseUrl(cfg.defaultApp) : S.recForm.app)}"
             placeholder="http://localhost:4201" spellcheck="false" autocomplete="off">
      <datalist id="setAppList">
        ${apps.map(([, a]) => `<option value="${esc(a.baseUrl)}">${esc(a.label)}</option>`).join('')}
      </datalist>
      <div class="meta">The URL new recordings start on. Any http:// or https:// address; suggestions are your
        <a href="#/environments">environments</a>.</div>
    </div>
    <div class="field-row">
      <label class="label" for="setBrowser">Default browser</label>
      <select class="field" id="setBrowser" data-act="set-browser">${browserOptions()}</select>
      <div class="meta">Recording is always headed: you drive the browser yourself.</div>
    </div>
    ${prefRow('autoPanel', 'Pop the recorder panel out when recording starts',
      'The recording happens in a separate Chromium window, so this page ends up behind it. The panel is a wide, short bar above the app you are driving. Turn this off to open it yourself with the Recorder Panel button.', true)}
    <dl class="kv kv-wide" style="margin-top:12px">
      <dt>Test id attribute</dt><dd class="mono">${esc(cfg.testIdAttribute || 'data-testid')}</dd>
      <dt>Locator order</dt><dd>testid, role, label, text, css, xpath, positional</dd>
      <dt>Viewport</dt><dd>${esc(String(S.recForm.viewport || '').replace('x', ' × '))}</dd>
    </dl>`);

  const replay = settingsSection('replay', 'Replay defaults', 'How a test runs when you press Execute.', `
    ${prefRow('autoOpen', 'Auto-open browser after recording', 'Re-open the app when a recording is saved.', false)}
    ${prefRow('verboseLogs', 'Show detailed logs', 'Print each locator attempt in the run detail.', false)}
    <dl class="kv kv-wide" style="margin-top:12px">
      <dt>Replay browser</dt><dd>${cfg.headedRun ? 'Headed (visible)' : 'Headless'} <span class="meta">(set in src/config.js)</span></dd>
      <dt>Step timeout</dt><dd>${cfg.stepTimeoutMs ? Math.round(cfg.stepTimeoutMs / 1000) + ' s per step' : 'default'}</dd>
      <dt>Stopping a run</dt><dd>Not supported: a run finishes on its own.</dd>
      <dt>Screenshots</dt><dd>One capture at the failing step.</dd>
      <dt>Saved logins</dt><dd>${authed.length
        ? authed.map(([, a]) => `${esc(a.label)}: ${a.hasSavedLogin ? 'saved session' : 'none yet'}`).join('<br>')
        : 'No environment here needs a login.'}</dd>
    </dl>`);

  const data = settingsSection('data', 'Data & privacy', 'Everything stays on this machine. Nothing is sent to a cloud service.', `
    <dl class="kv kv-wide">
      <dt>Tests directory</dt><dd class="mono" style="word-break:break-all">${esc(cfg.testsDir || '—')}</dd>
      <dt>Format</dt><dd>One JSON file per test, run history and screenshots beside it.</dd>
      <dt>Folders</dt><dd>${S.folders.length ? S.folders.map((f) => `<span class="tag">${esc(f)}</span>`).join(' ') : 'none'}</dd>
    </dl>
    <div class="note warn" style="margin-top:12px">${icon('alert', 'i-sm')}<span>Credentials and saved login sessions are
      <b>plain-text local files</b>, excluded from git. Do not copy them off this machine. Passwords you type are never written
      into a test, a run folder or an API response.</span></div>
    <div class="note info">${icon('shield', 'i-sm')}<span>Sensitive values typed during a recording are redacted from the
      saved steps. Screenshots, however, are pictures of real application data: treat run folders accordingly.</span></div>`);

  const keys = settingsSection('shortcuts', 'Keyboard shortcuts', 'Shortcuts are ignored while you type in a field or while a dialog is open.', `
    <dl class="kv kv-wide shortcut-list">
      ${SHORTCUTS.map(([ks, what]) => `<dt>${ks.map((k) => `<kbd class="kbd">${esc(k)}</kbd>`).join(' ')}</dt><dd>${esc(what)}</dd>`).join('')}
    </dl>`);

  const about = settingsSection('about', 'About', '', `
    <p class="set-sub" style="margin:0"><b>Replayr</b> — Record once. Replay anywhere. Record a bug on production, replay it on localhost, verify the fix.
      Everything runs locally from this service.</p>
    <dl class="kv kv-wide" style="margin-top:12px">
      <dt>Service</dt><dd class="mono">${esc(location.origin)}</dd>
      ${cfg.user ? `<dt>Signed in as</dt><dd>${esc(cfg.user)}</dd>` : ''}
    </dl>`);

  return head + `
  <div class="set-wrap">
    <nav class="set-jump" aria-label="Settings sections">
      ${[['appearance', 'Appearance'], ['recording', 'Recording'], ['replay', 'Replay'], ['data', 'Data & privacy'], ['shortcuts', 'Shortcuts'], ['about', 'About']]
        .map(([id, l]) => `<button class="btn btn-ghost btn-sm" data-act="scroll-to" data-target="set-${id}">${esc(l)}</button>`).join('')}
    </nav>
    ${appearance}${recording}${replay}${data}${keys}${about}
  </div>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   APPLICATIONS & ENVIRONMENTS
   ══════════════════════════════════════════════════════════════════════════ */
async function loadEnvironments() {
  const data = await guard(() => api('GET', '/api/environments'), 'Could not load the environments');
  if (data) { S.envs = data.environments || []; if (S.route.name === 'environments' || S.route.name === 'test') render(); }
  else if (S.route.name === 'environments' && !S.envs) { S.envs = []; S.envPageError = 'Could not load the environments. Is the Replayr service running?'; render(); }
}

function blankEnvForm(application) {
  return {
    mode: 'new', application: application || '', key: '', label: '', baseUrl: '', kind: 'staging',
    protected: false, auth: false, keyTouched: false, kindTouched: false, protectedTouched: false, original: null,
  };
}

function groupEnvsByApplication(envs) {
  const groups = new Map();
  for (const e of envs) {
    const name = e.application || 'Default';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(e);
  }
  return Array.from(groups, ([name, list]) => ({ name, list }));
}

function envAuthCell(e) {
  const a = ((S.config || {}).apps || {})[e.key];
  if (!e.auth) return '<span class="envx-auth off">Login: off</span>';
  const saved = a && a.hasSavedLogin;
  return `<span class="envx-auth on">Login: on</span>${saved ? ' <span class="pill st-passed">saved session</span>' : ''}`;
}

function envRow(e) {
  const editable = e.source === 'user';
  return `
  <div class="envx-row env-k-${esc(e.kind)}" data-env="${esc(e.key)}">
    <div class="envx-main">
      <div class="envx-title">${kindBadge(e.kind)}<span class="envx-name truncate">${esc(e.label || e.key)}</span>
        ${e.protected ? `<span class="pill st-blocked" title="Replays here need explicit confirmation">${icon('shield', 'i-sm')}Protected</span>` : ''}</div>
      <div class="envx-url mono truncate" title="${esc(e.baseUrl || '')}">${esc(e.baseUrl || '')}</div>
    </div>
    <div class="envx-meta">
      ${envAuthCell(e)}
      <span class="pill st-not-run">${editable ? 'Yours' : 'Built-in'}</span>
    </div>
    <div class="envx-actions">
      ${editable ? `
        <button class="btn btn-sm" data-act="env-edit" data-id="${esc(e.key)}" aria-label="Edit ${esc(e.label || e.key)}">${icon('pencil', 'i-sm')}Edit</button>
        <button class="btn btn-sm btn-danger-outline" data-act="env-delete" data-id="${esc(e.key)}" aria-label="Delete ${esc(e.label || e.key)}">${icon('trash', 'i-sm')}Delete</button>`
        : '<span class="meta">Read-only (src/config.js)</span>'}
    </div>
  </div>`;
}

function envFlowStrip(envs) {
  const prod = envs.find((e) => e.kind === 'production');
  if (!prod) return '';
  const local = envs.find((e) => e.kind === 'local' && e.application === prod.application) || envs.find((e) => e.kind === 'local');
  if (!local) return '';
  return `
  <div class="env-flow" aria-label="Example flow: ${esc(prod.label)} to ${esc(local.label)}">
    <div class="env-flow-node env-k-production">${kindBadge('production')}<b class="truncate">${esc(prod.label || prod.key)}</b><span class="mono truncate">${esc(prod.baseUrl)}</span><small>Record the bug here</small></div>
    <div class="env-flow-arrow" aria-hidden="true">${icon('arrow-right', 'i-lg')}<small>URLs rewritten</small></div>
    <div class="env-flow-node env-k-local">${kindBadge('local')}<b class="truncate">${esc(local.label || local.key)}</b><span class="mono truncate">${esc(local.baseUrl)}</span><small>Replay and verify the fix</small></div>
  </div>`;
}

function viewEnvironments() {
  const envs = S.envs;
  const groups = envs ? groupEnvsByApplication(envs) : [];
  const body = !envs ? `<div class="card card-pad"><span class="skeleton" style="height:14px;width:40%;margin-bottom:12px"></span><span class="skeleton" style="height:44px;margin-bottom:8px"></span><span class="skeleton" style="height:44px"></span></div>`
    : !envs.length ? `
      <div class="card empty">
        <div class="art">${icon('layers', 'i-xl')}</div>
        <h2>No environments yet</h2>
        <p>An environment is a named base URL, such as Production or your local build. Add one for each place your app runs so a test recorded on one can be replayed on another.</p>
        <button class="btn btn-primary" data-act="env-new">${icon('plus', 'i-sm')}Add your first environment</button>
      </div>`
    : groups.map((g) => `
      <section class="card envx-app" aria-labelledby="envapp-${esc(slugify(g.name) || 'x')}">
        <div class="card-head">
          <h3 id="envapp-${esc(slugify(g.name) || 'x')}">${icon('layers', 'i-sm')} ${esc(g.name)} <span class="meta">${g.list.length} environment${g.list.length === 1 ? '' : 's'}</span></h3>
          <button class="btn btn-sm" data-act="env-new" data-app="${esc(g.name)}">${icon('plus', 'i-sm')}Add environment</button>
        </div>
        ${g.list.map(envRow).join('')}
      </section>`).join('');

  return `
  <div class="page-head">
    <div><h1>Applications &amp; Environments</h1>
      <div class="sub">Record on one environment, replay on another &mdash; recorded URLs are rewritten from the source environment to the target.</div></div>
    <button class="btn btn-primary" data-act="env-new">${icon('plus', 'i-sm')}Add environment</button>
  </div>
  ${S.envPageError ? `<div class="note bad" role="alert" style="margin-bottom:12px">${icon('alert', 'i-sm')}<span>${esc(S.envPageError)}</span></div>` : ''}
  ${envs ? envFlowStrip(envs) : ''}
  <div class="env-list">${body}</div>
  ${S.envForm ? viewEnvPanel() : ''}`;
}

function viewEnvPanel() {
  const f = S.envForm;
  const apps = Array.from(new Set((S.envs || []).map((e) => e.application || 'Default')));
  const errs = envFormErrors(f);
  const isProd = f.kind === 'production';
  const touchedUrl = f.baseUrl.trim() !== '';
  const suggest = inferKindFromUrl(f.baseUrl);
  return `
  <div class="env-scrim" data-act="env-cancel"></div>
  <aside class="env-panel" role="dialog" aria-modal="true" aria-labelledby="envPanelTitle">
    <div class="env-panel-head">
      <h2 id="envPanelTitle">${f.mode === 'edit' ? 'Edit environment' : 'Add environment'}</h2>
      <button class="btn btn-icon btn-ghost" data-act="env-cancel" aria-label="Close">${icon('x', 'i-sm')}</button>
    </div>
    <form class="env-panel-body" id="envForm" novalidate onsubmit="return false">
      <div id="envFormError" ${S.envError ? '' : 'hidden'}><div class="note bad" role="alert">${icon('alert', 'i-sm')}<span id="envFormErrorText">${esc(S.envError || '')}</span></div></div>
      <div class="field-row"><label class="label" for="envApp">Application</label>
        <input class="field" id="envApp" list="envAppList" data-act="env-form" data-key="application" value="${esc(f.application)}"
               placeholder="e.g. Billing web (default: Default)" autocomplete="off" spellcheck="false">
        <datalist id="envAppList">${apps.map((a) => `<option value="${esc(a)}"></option>`).join('')}</datalist>
        <div class="field-hint meta">Environments of the same application are grouped together.</div></div>
      <div class="field-row"><label class="label" for="envLabel">Label</label>
        <input class="field" id="envLabel" data-act="env-form" data-key="label" value="${esc(f.label)}" placeholder="e.g. Production" autocomplete="off"></div>
      <div class="field-row"><label class="label" for="envKey">Key</label>
        <input class="field mono" id="envKey" data-act="env-form" data-key="key" value="${esc(f.key)}" ${f.mode === 'edit' ? 'disabled' : ''}
               placeholder="e.g. my-staging" autocomplete="off" spellcheck="false" aria-describedby="envKeyErr">
        <div class="field-error" id="envKeyErr" role="alert">${touchedUrl || f.key ? esc(errs.key || '') : ''}</div>
        <div class="field-hint meta">${f.mode === 'edit' ? 'The key cannot be changed after creation.' : 'Derived from the label; you can edit it. Lowercase letters, digits and dashes.'}</div></div>
      <div class="field-row"><label class="label" for="envUrl">Base URL</label>
        <input class="field mono" id="envUrl" type="url" inputmode="url" data-act="env-form" data-key="baseUrl" value="${esc(f.baseUrl)}"
               placeholder="e.g. https://staging.example.com" autocomplete="off" spellcheck="false" aria-describedby="envUrlErr">
        <div class="field-error" id="envUrlErr" role="alert">${f.baseUrl.trim() ? esc(errs.baseUrl || '') : ''}</div></div>
      <div class="field-row"><span class="label" id="envKindLbl">Kind</span>
        <div class="seg env-kind-seg" role="group" aria-labelledby="envKindLbl">
          ${ENV_KINDS.map(([k, l]) => `<button type="button" data-act="env-kind" data-id="${k}" aria-pressed="${f.kind === k}">${kindGlyph(k)}${l}</button>`).join('')}
        </div>
        <div class="field-hint meta" id="envKindHint">${kindHintText(f, suggest)}</div></div>
      <div class="field-row">
        <label class="check"><input type="checkbox" id="envProtected" data-act="env-form" data-key="protected" ${f.protected || isProd ? 'checked' : ''} ${isProd ? 'disabled' : ''}>
          <span><b>Protected</b><div class="meta" id="envProtectedHint">${isProd
            ? 'Always on for production: replaying here asks for explicit confirmation so a test never mutates live data by accident.'
            : 'Replays against this environment ask for explicit confirmation first.'}</div></span></label>
      </div>
      <div class="field-row">
        <label class="check"><input type="checkbox" id="envAuth" data-act="env-form" data-key="auth" ${f.auth ? 'checked' : ''}>
          <span><b>Login automation</b><div class="meta">Sign in automatically before replay when the app needs it (uses the login saved for this URL).</div></span></label>
      </div>
    </form>
    <div class="env-panel-foot">
      <button class="btn" data-act="env-cancel">Cancel</button>
      <button class="btn btn-primary" id="envSave" data-act="env-save" ${S.envSaving ? 'disabled' : ''}>${S.envSaving ? 'Saving…' : 'Save environment'}</button>
    </div>
  </aside>`;
}

function kindHintText(f, suggest) {
  if (suggest && suggest !== f.kind && f.baseUrl.trim()) return `This URL looks like <b>${esc(kindLabel(suggest))}</b>. Pick it above if that is right.`;
  if (suggest && suggest === f.kind && !f.kindTouched && f.baseUrl.trim()) return `Suggested from the URL host: ${esc(kindLabel(suggest))}.`;
  return 'Production gets a strong red treatment everywhere and is always protected.';
}

/* Update the open form's derived UI in place. Rebuilding the panel on every keystroke would
   drop the scroll position and the caret, so only the parts that changed are touched. */
function envFormSync() {
  const f = S.envForm; if (!f || !$('envForm')) return;
  const errs = envFormErrors(f);
  const setText = (id, t) => { const n = $(id); if (n) n.textContent = t; };
  const keyIn = $('envKey'); if (keyIn && keyIn.value !== f.key) keyIn.value = f.key;
  setText('envKeyErr', (f.key || f.baseUrl.trim()) ? (errs.key || '') : '');
  setText('envUrlErr', f.baseUrl.trim() ? (errs.baseUrl || '') : '');
  [['envKey', 'key'], ['envUrl', 'baseUrl']].forEach(([id, k]) => {
    const n = $(id); if (!n) return;
    const bad = !!errs[k] && (k === 'key' ? (f.key || f.baseUrl.trim()) : f.baseUrl.trim());
    n.setAttribute('aria-invalid', bad ? 'true' : 'false');
  });
  document.querySelectorAll('.env-kind-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-id') === f.kind)));
  const hint = $('envKindHint'); if (hint) hint.innerHTML = kindHintText(f, inferKindFromUrl(f.baseUrl));
  const prot = $('envProtected');
  if (prot) { prot.checked = !!f.protected || f.kind === 'production'; prot.disabled = f.kind === 'production'; }
  const ph = $('envProtectedHint');
  if (ph) ph.textContent = f.kind === 'production'
    ? 'Always on for production: replaying here asks for explicit confirmation so a test never mutates live data by accident.'
    : 'Replays against this environment ask for explicit confirmation first.';
  const err = $('envFormError'); if (err) err.hidden = !S.envError;
  setText('envFormErrorText', S.envError || '');
}

INPUTS['env-form'] = (node, value) => {
  const f = S.envForm; if (!f) return;
  const k = node.getAttribute('data-key');
  if (k === 'protected') { if (f.kind === 'production') { node.checked = true; return; } f.protected = !!value; f.protectedTouched = true; }
  else if (k === 'auth') f.auth = !!value;
  else if (k === 'key') { f.key = String(value).toLowerCase().replace(/\s+/g, '-'); f.keyTouched = true; }
  else {
    f[k] = value;
    if (k === 'label' && f.mode === 'new' && !f.keyTouched) f.key = slugify(value);
    if (k === 'baseUrl' && !f.kindTouched) {
      const guess = inferKindFromUrl(value);
      if (guess) { f.kind = guess; if (!f.protectedTouched) f.protected = guess === 'production'; }
    }
  }
  S.envError = null;
  envFormSync();
};

ACTIONS['env-kind'] = (btn) => {
  const f = S.envForm; if (!f) return;
  f.kind = btn.getAttribute('data-id'); f.kindTouched = true;
  if (f.kind === 'production') f.protected = true;
  else if (!f.protectedTouched) f.protected = false;
  envFormSync();
};

function focusEnvPanel() { const n = $('envApp') || $('envLabel'); if (n) n.focus(); }

ACTIONS['env-new'] = (trigger) => {
  S.envForm = blankEnvForm(trigger.getAttribute('data-app') || ''); S.envError = null; S.envSaving = false;
  render(); focusEnvPanel();
};
ACTIONS['env-cancel'] = () => { S.envForm = null; S.envError = null; render(); };
ACTIONS['env-edit'] = (trigger) => {
  const e = (S.envs || []).find((x) => x.key === trigger.getAttribute('data-id'));
  if (!e) return;
  S.envForm = {
    mode: 'edit', application: e.application || '', key: e.key, label: e.label || '', baseUrl: e.baseUrl || '',
    kind: e.kind || 'staging', protected: !!e.protected, auth: !!e.auth,
    keyTouched: true, kindTouched: true, protectedTouched: true,
  };
  S.envError = null; S.envSaving = false;
  render(); focusEnvPanel();
};
ACTIONS['env-save'] = () => saveEnv();
ACTIONS['env-delete'] = (trigger) => {
  const key = trigger.getAttribute('data-id');
  const e = (S.envs || []).find((x) => x.key === key);
  S.overlay = {
    kind: 'modal', title: 'Delete environment', danger: true, confirmAct: 'env-delete-confirm', confirmLabel: 'Delete',
    focusCancel: true, confirmData: { key },
    body: `<p style="margin:0">Delete <b>${esc(e ? e.label || e.key : key)}</b> <span class="mono">(${esc(key)})</span>?</p>
      <p class="meta" style="margin:8px 0 0">Tests recorded on it keep working; they just lose this named target. This cannot be undone.</p>`,
  };
  render();
};
ACTIONS['env-delete-confirm'] = async () => {
  const o = S.overlay; if (!o || !o.confirmData) return;
  const key = o.confirmData.key;
  S.overlay = null; S.envPageError = null;
  try { await api('DELETE', '/api/environments/' + encodeURIComponent(key)); toast('Environment deleted', 'good'); }
  catch (e) { S.envPageError = `Could not delete "${key}": ${e.message}`; }
  try { S.config = await api('GET', '/api/config'); } catch { /* keep */ }
  await loadEnvironments();
  render();
};

async function saveEnv() {
  const f = S.envForm;
  if (!f || S.envSaving) return;
  S.envError = null;
  const errs = envFormErrors(f);
  if (errs.baseUrl || errs.key) {
    S.envError = errs.baseUrl || errs.key;
    envFormSync();
    const bad = $(errs.baseUrl ? 'envUrl' : 'envKey'); if (bad) bad.focus();
    return;
  }
  const body = {
    application: f.application.trim(), key: f.key.trim(), label: f.label.trim() || f.key.trim(), baseUrl: f.baseUrl.trim(),
    kind: f.kind, protected: f.kind === 'production' ? true : !!f.protected, auth: !!f.auth,
  };
  S.envSaving = true;
  const btn = $('envSave'); if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    if (f.mode === 'edit') await api('PUT', '/api/environments/' + encodeURIComponent(f.key), body);
    else await api('POST', '/api/environments', body);
    S.envForm = null;
    try { S.config = await api('GET', '/api/config'); } catch { /* keep */ }
    S.envPageError = null;
    await loadEnvironments();
    toast('Environment saved', 'good');
  } catch (e) {
    S.envError = e.message || 'Could not save the environment';
  }
  S.envSaving = false;
  if (S.envForm) { const b = $('envSave'); if (b) { b.disabled = false; b.textContent = 'Save environment'; } envFormSync(); }
  else render();
}

/* ══════════════════════════════════════════════════════════════════════════
   TRASH
   ══════════════════════════════════════════════════════════════════════════ */
async function loadTrash() {
  const data = await guard(() => api('GET', '/api/trash'), 'Could not load the trash');
  if (data) S.trash = data.trash || [];
  else if (!S.trash) { S.trash = []; S.trashError = 'Could not load the trash. Is the Replayr service running?'; }
  if (S.route.name === 'trash') render();
}

function viewTrash() {
  const items = S.trash;
  return `
  <div class="page-head"><div><h1>Trash</h1>
    <div class="sub">Deleted tests can be restored from here. The 50 most recent deletions are kept; older ones are removed automatically.</div></div>
    <button class="btn" data-act="reload-trash">${icon('refresh', 'i-sm')}Refresh</button></div>
  ${S.trashError ? `<div class="note bad" role="alert" style="margin-bottom:12px">${icon('alert', 'i-sm')}<span>${esc(S.trashError)}</span></div>` : ''}
  ${!items ? `<div class="card card-pad"><span class="skeleton" style="height:14px;width:40%;margin-bottom:12px"></span><span class="skeleton" style="height:36px"></span></div>`
    : !items.length ? `
    <div class="card empty">
      <div class="art">${icon('trash', 'i-xl')}</div>
      <h2>The trash is empty</h2>
      <p>When you delete a test it waits here so you can bring it back. Nothing has been deleted.</p>
      <a class="btn" href="#/tests">${icon('tests', 'i-sm')}Go to the test library</a>
    </div>` : `
  <div class="card" style="overflow-x:auto">
    <table class="tbl trash-table">
      <thead><tr><th scope="col">Test</th><th scope="col">Deleted</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>
      ${items.map((t) => `
        <tr>
          <td><span class="trash-name">${icon('tests', 'i-sm')}<span class="truncate">${esc(t.name)}</span></span></td>
          <td>${t.deletedAt ? timeAgo(t.deletedAt) : 'at an unknown time'}</td>
          <td style="text-align:right"><button class="btn btn-sm" data-act="trash-restore" data-id="${esc(t.file)}" aria-label="Restore ${esc(t.name)}">${icon('history', 'i-sm')}Restore</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`}`;
}

async function restoreTrash(file) {
  S.trashError = null;
  try {
    const t = await api('POST', '/api/trash/restore', { file });
    toast(`Restored "${t.name}"`, 'good');
    await loadTrash();
    loadTests();
  } catch (e) {
    S.trashError = `Could not restore that test: ${e.message}`;
    render();
  }
}

ACTIONS['reload-trash'] = () => { S.trash = null; S.trashError = null; render(); loadTrash(); };
ACTIONS['trash-restore'] = (trigger) => restoreTrash(trigger.getAttribute('data-id'));
