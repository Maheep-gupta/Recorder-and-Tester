/* Overlays: command palette, keyboard shortcuts, modals, context menus, toasts.
 * Part of the UI bundle: classic scripts loaded in order from index.html, sharing one global
 * scope (state S, helpers, render).
 *
 * Ownership of the keyboard: one capture-phase listener on window (below) runs BEFORE the
 * legacy document listeners in actions.js. It owns Ctrl/Cmd+K, the palette's own keys, menu
 * arrows, the modal focus trap, and every single-key shortcut. A shortcut never fires while the
 * user is typing in a field, and never while a modal, palette, menu or lightbox is open.
 */
'use strict';

function viewLightbox() {
  return `<div class="lightbox" data-act="close-lightbox" role="dialog" aria-modal="true" aria-label="Screenshot" tabindex="-1">
    <img src="${esc(S.lightbox)}" alt="Screenshot, expanded"></div>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   TOASTS — stacked, auto-dismiss, polite live region (#toasts is aria-live)
   Errors stay longer, and hovering or focusing a toast pauses its timer.
   ══════════════════════════════════════════════════════════════════════════ */
const TOAST_LIMIT = 4;
const REDUCED_MOTION = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function dismissToast(node) {
  if (!node || node.dataset.leaving) return;
  node.dataset.leaving = '1';
  clearTimeout(node._timer);
  if (REDUCED_MOTION()) { node.remove(); return; }
  node.classList.add('leaving');
  setTimeout(() => node.remove(), 170);
}

function toast(message, kind) {
  const host = $('toasts');
  if (!host) return;
  const k = kind === 'bad' ? 'bad' : kind === 'good' ? 'good' : 'info';
  const text = String(message == null ? '' : message);

  // The same message twice in a row is one event, not two: restart the first one's clock.
  const twin = Array.from(host.children).find((n) => n.dataset.key === k + '|' + text && !n.dataset.leaving);
  if (twin) { armToast(twin, k); twin.classList.remove('pulse'); void twin.offsetWidth; twin.classList.add('pulse'); return; }

  const node = document.createElement('div');
  node.className = 'toast' + (k === 'bad' ? ' bad' : k === 'good' ? ' good' : '');
  node.dataset.key = k + '|' + text;
  node.innerHTML = `${icon(k === 'bad' ? 'alert' : k === 'good' ? 'check-circle' : 'info', 'i-sm')}
    <span class="toast-msg">${esc(text)}</span>
    <button type="button" class="toast-x" aria-label="Dismiss notification">${icon('x', 'i-sm')}</button>`;
  node.querySelector('.toast-x').addEventListener('click', () => dismissToast(node));
  node.addEventListener('mouseenter', () => clearTimeout(node._timer));
  node.addEventListener('mouseleave', () => armToast(node, k, 2500));
  node.addEventListener('focusin', () => clearTimeout(node._timer));
  node.addEventListener('focusout', () => armToast(node, k, 2500));
  host.appendChild(node);
  armToast(node, k);

  // Keep the stack short: drop the oldest, preferring ones that are not errors.
  const live = Array.from(host.children).filter((n) => !n.dataset.leaving);
  while (live.length > TOAST_LIMIT) {
    const victim = live.find((n) => !n.classList.contains('bad')) || live[0];
    live.splice(live.indexOf(victim), 1);
    dismissToast(victim);
  }
}
function armToast(node, kind, ms) {
  clearTimeout(node._timer);
  node._timer = setTimeout(() => dismissToast(node), ms || (kind === 'bad' ? 9000 : 4500));
}

/* ══════════════════════════════════════════════════════════════════════════
   THEME TOGGLE
   ══════════════════════════════════════════════════════════════════════════ */
function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  paintChrome();
  announce(`${next === 'dark' ? 'Dark' : 'Light'} theme.`);
}

/* ══════════════════════════════════════════════════════════════════════════
   COMMAND PALETTE — imperative, lives outside render() so typing is never interrupted
   ══════════════════════════════════════════════════════════════════════════ */
const PAL = { open: false, query: '', index: 0, items: [], mode: 'all', opener: null, host: null };
function paletteIsOpen() { return PAL.open; }

/** Subsequence fuzzy score: higher is better, -1 is no match. Every word of the query must match. */
function fuzzyScore(query, text) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const t = String(text).toLowerCase();
  let total = 0;
  for (const q of words) {
    const at = t.indexOf(q);
    if (at >= 0) {
      total += 1000 - at * 2 + (at === 0 || /[\s\-_/:]/.test(t[at - 1]) ? 60 : 0) - (t.length - q.length) * 0.1;
      continue;
    }
    let from = 0, last = -2, score = 0;
    for (const ch of q) {
      const j = t.indexOf(ch, from);
      if (j < 0) return -1;
      score += j === last + 1 ? 6 : 1;
      if (j === 0 || /[\s\-_/:]/.test(t[j - 1])) score += 4;
      last = j; from = j + 1;
    }
    total += score;
  }
  return total;
}

function recentTests() {
  return S.tests.slice().sort((a, b) =>
    new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

function startRecordingFlow() { S.recStage = null; go('#/record'); render(); }

/** Everything the palette can do, as data. `run` is called after the palette has closed. */
function paletteCatalog() {
  const items = [];
  NAV_ITEMS.forEach((n) => items.push({
    group: 'Navigate', label: 'Go to ' + n.label, icon: n.icon, kbd: n.keys ? n.keys.join(' ') : '',
    keywords: n.label + ' ' + n.group, run: () => { go(n.hash); render(); },
  }));
  items.push(
    { group: 'Actions', label: 'Record a bug', icon: 'record', kbd: 'n', keywords: 'new recording start capture', run: startRecordingFlow },
    { group: 'Actions', label: 'Toggle light / dark theme', icon: effectiveTheme() === 'dark' ? 'sun' : 'moon', keywords: 'theme appearance', run: toggleTheme },
    { group: 'Actions', label: 'Open a logged-in browser', icon: 'window', keywords: 'browser open launch', run: () => openBrowserOnly() },
    { group: 'Actions', label: 'Import a test', icon: 'import', keywords: 'import json file', run: () => openImportModal() },
    { group: 'Actions', label: 'New folder', icon: 'folder-plus', keywords: 'folder organise', run: () => openFolderModal() },
    { group: 'Actions', label: 'Keyboard shortcuts', icon: 'keyboard', kbd: '?', keywords: 'help keys shortcuts', run: () => openShortcutsModal() },
  );
  recentTests().forEach((t) => {
    items.push({ group: 'Tests', label: t.name, hint: 'Open', icon: 'tests', keywords: [t.folder, ...(t.tags || [])].filter(Boolean).join(' '),
      run: () => { go('#/test/' + t.id); render(); } });
  });
  recentTests().forEach((t) => {
    items.push({ group: 'Run a test', label: 'Run ' + t.name, hint: t.lastRun ? STATUS_LABEL[t.lastRun.status] || '' : 'Never run', icon: 'play',
      keywords: [t.folder, ...(t.tags || [])].filter(Boolean).join(' '), run: () => runTest(t.id) });
  });
  (S.envs || []).forEach((e) => {
    items.push({ group: 'Environments', label: e.label || e.key, hint: (e.application || 'Default') + ' · ' + (e.kind || ''), icon: 'layers',
      keywords: [e.baseUrl, e.key, e.application, e.kind].filter(Boolean).join(' '), run: () => { go('#/environments'); render(); } });
  });
  return items;
}

const PAL_GROUP_ORDER = ['Navigate', 'Actions', 'Tests', 'Run a test', 'Environments'];

function paletteResults() {
  const q = PAL.query.trim();
  let all = paletteCatalog();
  if (PAL.mode === 'tests') all = all.filter((i) => i.group === 'Run a test');
  let scored;
  if (!q) {
    // No query: a short, useful default. The full test list only shows when you ask for tests.
    const cap = { Tests: 4, 'Run a test': PAL.mode === 'tests' ? 60 : 0, Environments: 4 };
    const seen = {};
    scored = all.filter((i) => { seen[i.group] = (seen[i.group] || 0) + 1; return seen[i.group] <= (cap[i.group] == null ? 99 : cap[i.group]); })
      .map((i, n) => ({ i, s: 1000 - n }));
  } else {
    scored = all.map((i, n) => ({ i, s: fuzzyScore(q, i.label + ' ' + (i.keywords || '')) - n * 0.001 })).filter((x) => x.s >= 0);
    const perGroup = {};
    scored.sort((a, b) => b.s - a.s);
    scored = scored.filter((x) => { perGroup[x.i.group] = (perGroup[x.i.group] || 0) + 1; return perGroup[x.i.group] <= 7; });
  }
  // With a query, the group holding the best match comes first; otherwise the fixed order.
  const best = (g) => scored.filter((x) => x.i.group === g).reduce((m, x) => Math.max(m, x.s), -1);
  const order = q ? PAL_GROUP_ORDER.slice().sort((a, b) => best(b) - best(a)) : PAL_GROUP_ORDER;
  const out = [];
  order.forEach((g) => scored.filter((x) => x.i.group === g).forEach((x) => out.push(x.i)));
  return out;
}

/** Kept so legacy callers still get a list; the palette itself uses paletteResults(). */
function paletteActions() { return paletteResults().map((i, n) => ({ id: String(n), label: i.label, icon: i.icon, group: i.group })); }

function paletteListHtml() {
  PAL.items = paletteResults();
  if (PAL.index >= PAL.items.length) PAL.index = Math.max(0, PAL.items.length - 1);
  if (!PAL.items.length) {
    const loading = S.loadingTests;
    return `<div class="empty-sm" role="status">${loading ? 'Loading…' : `Nothing matches “${esc(PAL.query)}”.`}</div>`;
  }
  let last = null;
  return PAL.items.map((item, i) => {
    const head = item.group !== last ? `<div class="pgroup" role="presentation">${esc(PAL.mode === 'tests' ? 'Choose a test to run' : item.group)}</div>` : '';
    last = item.group;
    return head + `<div class="pitem" role="option" id="palOpt${i}" data-i="${i}" aria-selected="${i === PAL.index}">
      ${icon(item.icon, 'i-sm')}<span class="grow truncate">${esc(item.label)}</span>
      ${item.hint ? `<span class="phint">${esc(item.hint)}</span>` : ''}
      ${item.kbd ? `<span class="pkeys">${item.kbd.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</span>` : ''}</div>`;
  }).join('');
}

function paletteRefresh() {
  if (!PAL.open) return;
  const list = $('paletteList');
  list.innerHTML = paletteListHtml();
  paletteSyncActive();
}

function paletteSyncActive() {
  const input = $('paletteInput');
  const nodes = $('paletteList').querySelectorAll('.pitem');
  nodes.forEach((n) => n.setAttribute('aria-selected', String(Number(n.dataset.i) === PAL.index)));
  const cur = $('palOpt' + PAL.index);
  if (input) {
    if (cur) input.setAttribute('aria-activedescendant', cur.id); else input.removeAttribute('aria-activedescendant');
  }
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}

function openPalette(opts) {
  if (PAL.open) { if (opts && opts.mode && opts.mode !== PAL.mode) { PAL.mode = opts.mode; PAL.index = 0; paletteRefresh(); } return; }
  if (S.overlay || S.lightbox) return;
  closeMenu();
  PAL.open = true;
  PAL.query = '';
  PAL.index = 0;
  PAL.mode = (opts && opts.mode) || 'all';
  PAL.opener = document.activeElement;
  PAL.openerSel = selectorFor(PAL.opener);

  const host = document.createElement('div');
  host.id = 'paletteHost';
  host.innerHTML = `
    <div class="overlay pal-overlay">
      <div class="palette" role="dialog" aria-modal="true" aria-label="${PAL.mode === 'tests' ? 'Run a test' : 'Command palette'}">
        <div class="pinput">
          ${icon('search', 'i-lg subtle')}
          <input id="paletteInput" type="text" role="combobox" aria-expanded="true" aria-controls="paletteList"
                 aria-autocomplete="list" autocomplete="off" spellcheck="false"
                 placeholder="${PAL.mode === 'tests' ? 'Find a test to run…' : 'Search tests, environments, actions…'}"
                 aria-label="${PAL.mode === 'tests' ? 'Find a test to run' : 'Command palette search'}">
          <kbd>Esc</kbd>
        </div>
        <div class="plist" id="paletteList" role="listbox" aria-label="Results"></div>
        <div class="pfoot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> select</span><span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>`;
  document.body.appendChild(host);
  PAL.host = host;
  document.documentElement.classList.add('scroll-locked');

  const input = $('paletteInput');
  input.addEventListener('input', () => { PAL.query = input.value; PAL.index = 0; paletteRefresh(); });
  host.addEventListener('mousedown', (e) => { if (e.target.closest('.pitem')) e.preventDefault(); });   // keep focus in the input
  host.addEventListener('click', (e) => {
    const item = e.target.closest('.pitem');
    if (item) { PAL.index = Number(item.dataset.i); paletteRun(); return; }
    if (e.target.classList.contains('pal-overlay')) closePalette();
  });
  host.addEventListener('mousemove', (e) => {
    const item = e.target.closest('.pitem');
    if (item && Number(item.dataset.i) !== PAL.index) { PAL.index = Number(item.dataset.i); paletteSyncActive(); }
  });
  paletteRefresh();
  input.focus();

  // Data the palette searches may not be loaded yet (opened straight after a reload).
  if (!S.tests.length && !S.loadingTests) loadTests().then(paletteRefresh);
  if (S.envs == null) loadEnvironments().then(paletteRefresh);
}

function closePalette(skipRestore) {
  if (!PAL.open) return;
  PAL.open = false;
  if (PAL.host) PAL.host.remove();
  PAL.host = null;
  syncScrollLock();
  let back = PAL.opener;
  if (back && !document.contains(back) && PAL.openerSel) back = document.querySelector(PAL.openerSel);
  PAL.opener = null; PAL.openerSel = null;
  if (!skipRestore && back && document.contains(back) && back.focus) back.focus();
}

function paletteRun() {
  const item = PAL.items[PAL.index];
  if (!item) return;
  closePalette();            // focus goes back to the opener first, so anything the action opens remembers it
  item.run();
}

function paletteMove(delta) {
  if (!PAL.items.length) return;
  PAL.index = (PAL.index + delta + PAL.items.length) % PAL.items.length;
  paletteSyncActive();
}

/* ══════════════════════════════════════════════════════════════════════════
   SHORTCUT SHEET
   ══════════════════════════════════════════════════════════════════════════ */
function openShortcutsModal() {
  const row = (keys, label) => `<div class="sc-row"><span>${esc(label)}</span><span class="sc-keys">${
    keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('<span class="sc-then">then</span>')}</span></div>`;
  S.overlay = {
    kind: 'modal', title: 'Keyboard shortcuts', wide: true,
    body: `
      <div class="sc-grid">
        <section aria-label="Go to"><h4>Go to</h4>
          ${row(['g', 'o'], 'Overview')}${row(['g', 't'], 'Test Library')}${row(['g', 'r'], 'Record Bug')}
          ${row(['g', 'h'], 'Execution History')}${row(['g', 'e'], 'Applications & Environments')}
        </section>
        <section aria-label="Actions"><h4>Actions</h4>
          ${row([MOD_KEY, 'K'], 'Command palette')}${row(['n'], 'Record a bug')}${row(['/'], 'Search tests')}
          ${row(['?'], 'This sheet')}${row(['Esc'], 'Close a dialog or menu')}
        </section>
      </div>
      <p class="meta" style="margin-top:12px">Single-key shortcuts are off while you type in a field or while a dialog is open.</p>`,
  };
  render();
}

/* ══════════════════════════════════════════════════════════════════════════
   MODALS (driven by S.overlay; rendered by render())
   ══════════════════════════════════════════════════════════════════════════ */
function viewOverlay() {
  const o = S.overlay;
  if (!o || o.kind !== 'modal') return '';
  const hasConfirm = !!o.confirmAct;
  return `
  <div class="overlay" data-act="close-overlay">
    <div class="modal${o.wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1" data-stop>
      <div class="card-head"><h3 id="modalTitle">${esc(o.title)}</h3>
        <button class="btn-icon" data-act="close-overlay" aria-label="Close">${icon('x', 'i-sm')}</button></div>
      <div class="mbody">${o.body}</div>
      <div class="mfoot">
        <button class="btn" data-act="close-overlay" id="modalCancel">${hasConfirm ? 'Cancel' : 'Close'}</button>
        ${hasConfirm ? `<button class="btn ${o.danger ? 'btn-danger' : 'btn-primary'}" data-act="${esc(o.confirmAct)}">${esc(o.confirmLabel)}</button>` : ''}
      </div>
    </div>
  </div>`;
}

/* Focus handling around the modal host. render() calls these either side of painting. */
let ovShown = false;
let ovNode = null;
let ovOpenerNode = null;
let ovOpenerSel = null;

function overlayIsUp() { return !!(S.overlay || S.lightbox); }

function selectorFor(el) {
  if (!el || el === document.body || !el.getAttribute) return null;
  if (el.id) return '#' + CSS.escape(el.id);
  const act = el.getAttribute('data-act');
  if (!act) return null;
  let sel = `[data-act="${CSS.escape(act)}"]`;
  ['data-id', 'data-test', 'data-run', 'data-key', 'data-tab'].forEach((a) => {
    const v = el.getAttribute(a);
    if (v != null) sel += `[${a}="${CSS.escape(v)}"]`;
  });
  return sel;
}

function overlayBeforePaint() {
  if (!ovShown && overlayIsUp()) {
    ovOpenerNode = document.activeElement;
    ovOpenerSel = selectorFor(ovOpenerNode);
  }
}

function modalFocusable(root) {
  return Array.from(root.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((n) => !n.disabled && n.offsetParent !== null);
}

function overlayAfterPaint() {
  const up = overlayIsUp();
  const host = $('overlayHost');
  const node = host.firstElementChild;
  if (up && (!ovShown || node !== ovNode)) {
    const needFocus = !ovShown || document.activeElement === document.body || !host.contains(document.activeElement);
    ovShown = true;
    ovNode = node;
    if (needFocus && node) {
      const modal = node.querySelector('.modal') || node;
      const first = modal.querySelector('.mbody input:not([type=hidden]), .mbody textarea, .mbody select');
      (first || modal).focus();
    }
  } else if (!up && ovShown) {
    ovShown = false;
    ovNode = null;
    let back = ovOpenerNode && document.contains(ovOpenerNode) ? ovOpenerNode : null;
    if (!back && ovOpenerSel) back = document.querySelector(ovOpenerSel);
    ovOpenerNode = null; ovOpenerSel = null;
    if (back && back.focus) back.focus();
  }
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

/* ══════════════════════════════════════════════════════════════════════════
   MENUS
   ══════════════════════════════════════════════════════════════════════════ */
let menuNode = null;
let menuOpener = null;
function closeMenu() {
  if (!menuNode) return;
  const hadFocus = menuNode.contains(document.activeElement);
  menuNode.remove();
  menuNode = null;
  const back = menuOpener;
  menuOpener = null;
  if (hadFocus && back && document.contains(back) && back.focus) back.focus();
}

function openMenuAt(anchor, html) {
  closeMenu();
  menuOpener = anchor;
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
    ${[['all', 'All'], ['passed', 'Passed'], ['failed', 'Failed or blocked'], ['inconclusive', 'Inconclusive'], ['error', 'Error'], ['never', 'Never run']].map(([v, l]) => `
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
   ACTIONS + KEYBOARD
   ══════════════════════════════════════════════════════════════════════════ */
ACTIONS['open-palette'] = () => openPalette();
ACTIONS['open-palette-tests'] = () => openPalette({ mode: 'tests' });
ACTIONS['open-shortcuts'] = () => openShortcutsModal();
ACTIONS['toggle-theme'] = () => toggleTheme();
ACTIONS['theme-menu'] = () => toggleTheme();

const G_TARGETS = { o: '#/home', t: '#/tests', r: '#/record', h: '#/executions', e: '#/environments' };
let gPendingAt = 0;
let gHintTimer = null;

function showGHint(on) {
  let hint = $('gHint');
  clearTimeout(gHintTimer);
  if (!on) { if (hint) hint.remove(); return; }
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'gHint';
    hint.className = 'g-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.innerHTML = '<kbd>g</kbd> then <kbd>o</kbd> Overview <kbd>t</kbd> Tests <kbd>r</kbd> Record <kbd>h</kbd> History <kbd>e</kbd> Environments';
    document.body.appendChild(hint);
  }
  gHintTimer = setTimeout(() => { gPendingAt = 0; showGHint(false); }, 1500);
}

function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}

function anyOverlayOpen() { return PAL.open || !!S.overlay || !!S.lightbox || !!menuNode || !!S.envForm || !!document.querySelector('[role=dialog][aria-modal=true]'); }

function onShellKeydown(e) {
  if (e.isComposing) return;
  const key = e.key;
  const mod = e.ctrlKey || e.metaKey;
  const stop = () => { e.stopImmediatePropagation(); };

  // Command palette toggle works from anywhere, including inside a field.
  if (mod && !e.altKey && (key === 'k' || key === 'K')) {
    e.preventDefault(); stop();
    if (PAL.open) closePalette();
    else if (!S.overlay && !S.lightbox) openPalette();
    return;
  }

  // The palette owns the keyboard while it is open.
  if (PAL.open) {
    if (key === 'Escape') { e.preventDefault(); stop(); closePalette(); return; }
    if (key === 'ArrowDown') { e.preventDefault(); stop(); paletteMove(1); return; }
    if (key === 'ArrowUp') { e.preventDefault(); stop(); paletteMove(-1); return; }
    if (key === 'Enter') { e.preventDefault(); stop(); paletteRun(); return; }
    if (key === 'Tab') { e.preventDefault(); stop(); const i = $('paletteInput'); if (i) i.focus(); return; }
    stop();          // typing: keep every other listener out of it
    return;
  }

  // Open context menu: arrows move, Esc closes and returns focus to its opener.
  if (menuNode) {
    if (key === 'Escape') { e.preventDefault(); stop(); closeMenu(); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      e.preventDefault(); stop();
      const items = Array.from(menuNode.querySelectorAll('button:not(:disabled)'));
      if (!items.length) return;
      const at = items.indexOf(document.activeElement);
      const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1
        : (at + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
      return;
    }
    if (key === 'Tab') { closeMenu(); return; }
  }

  // Modal and lightbox: trap Tab inside the dialog. (Esc is handled by actions.js, and the focus
  // goes back to the opener from overlayAfterPaint when the modal closes.)
  const dialog = S.overlay && $('overlayHost').querySelector('.modal');
  if (dialog && key === 'Tab') {
    const items = modalFocusable(dialog);
    if (!items.length) { e.preventDefault(); dialog.focus(); return; }
    const first = items[0], last = items[items.length - 1];
    if (!dialog.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    return;
  }
  if (S.lightbox && key === 'Tab') { e.preventDefault(); return; }

  // Everything below is a bare-key shortcut.
  if (mod || e.altKey) return;
  const typing = isTypingTarget(e.target) || isTypingTarget(document.activeElement);
  if (typing) return;
  if (anyOverlayOpen()) {
    // With a dialog up, a bare key must not reach the page behind it (this is what used to let
    // "n" start a recording from inside a modal).
    if (key.length === 1 || key === 'ArrowDown' || key === 'ArrowUp') stop();
    return;
  }

  if (gPendingAt && Date.now() - gPendingAt < 1500) {
    gPendingAt = 0;
    showGHint(false);
    const target = G_TARGETS[key.toLowerCase()];
    if (target) {
      e.preventDefault(); stop();
      if (target === '#/record') S.recStage = null;
      go(target);
      return;
    }
    // Not a destination: fall through and treat it as a normal key.
  }
  if (key === 'g') { e.preventDefault(); stop(); gPendingAt = Date.now(); showGHint(true); return; }
  if (key === '/') { e.preventDefault(); stop(); const g = $('globalSearch'); if (g) { g.focus(); g.select(); } return; }
  if (key === 'n') { e.preventDefault(); stop(); startRecordingFlow(); return; }
  if (key === '?') { e.preventDefault(); stop(); openShortcutsModal(); return; }
}
window.addEventListener('keydown', onShellKeydown, true);
