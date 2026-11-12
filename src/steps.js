/**
 * Design Studio Tester — the test step model.
 *
 * One place that knows what a step looks like, how a recorded Playwright action becomes one, how a
 * step reads in plain English, and how a step turns back into a Playwright locator for replay.
 *
 * A step is plain JSON a developer can hand-write:
 *
 *   { "id": "s3", "type": "fill",
 *     "target": { "by": "role", "role": "textbox", "name": "Design set name" },
 *     "selector": "internal:role=textbox[name=\"Design set name\"i]",   // recorder's exact choice
 *     "value": "Test Customer" }
 *
 * `target` is the readable form and is what the editor shows. `selector` is Playwright's own
 * locator string; when present, replay uses it verbatim. When a target is edited by hand the
 * selector is dropped and replay builds the locator from the target instead.
 *
 * Step types:  navigate · click · dblclick · hover · fill · press · check · uncheck · select ·
 *              upload · openPage · closePage · wait · waitForXhr · expectVisible · expectText ·
 *              expectValue · expectChecked · expectUrl · expectSnapshot
 *
 * Two of those are waits, and they exist as STEPS rather than as runner behaviour on purpose. The
 * runner already waits for the app's data calls after every action, but an invisible wait cannot
 * be seen, edited, moved or deleted by the person reading the test:
 *
 *   { "id": "s4", "type": "waitForXhr", "timeoutMs": 6000 }   // wait for the app's data calls
 *   { "id": "s5", "type": "wait", "ms": 1200 }                // a fixed pause, in milliseconds
 *
 * Neither acts on an element, so neither carries a target.
 */
'use strict';

const STEP_TYPES = [
  'navigate', 'click', 'dblclick', 'hover', 'fill', 'press', 'check', 'uncheck', 'select', 'upload',
  'openPage', 'closePage', 'wait', 'waitForXhr',
  'expectVisible', 'expectText', 'expectValue', 'expectChecked', 'expectUrl', 'expectSnapshot',
];
const TARGET_KINDS = ['role', 'label', 'placeholder', 'text', 'testid', 'alt', 'title', 'css'];
const NEEDS_TARGET = new Set([
  'click', 'dblclick', 'hover', 'fill', 'check', 'uncheck', 'select', 'upload',
  'expectVisible', 'expectText', 'expectValue', 'expectChecked',
]);

// ────────────────────────────────────────────────────────────── urls

/** Keycloak bounces back with `#state=…&code=…`; that fragment is never part of a test. */
const KEYCLOAK_FRAGMENT = /#(?=.*\bstate=)(?=.*\b(code|session_state|iss)=).*$/;

/** `http://localhost:4201/design?x=1#state=…` → `{{baseUrl}}/design?x=1`. Other origins stay absolute. */
function templateUrl(url, baseUrl) {
  if (!url) return url;
  let u = String(url).replace(KEYCLOAK_FRAGMENT, '');
  if (baseUrl && (u === baseUrl || u.startsWith(baseUrl + '/') || u.startsWith(baseUrl + '?') || u.startsWith(baseUrl + '#'))) {
    u = '{{baseUrl}}' + u.slice(baseUrl.length);
    if (u === '{{baseUrl}}') u += '/';
  }
  return u;
}

function resolveUrl(url, baseUrl) {
  return String(url || '').split('{{baseUrl}}').join(baseUrl);
}

/** True when `actual` is on `baseUrl`'s origin (a page of the app, not Keycloak or a third party). */
function isOnApp(actual, baseUrl) {
  try {
    return new URL(actual).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** Same path, ignoring query, hash and a trailing slash. */
function samePath(actual, expected) {
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    const norm = (p) => p.replace(/\/+$/, '') || '/';
    return a.origin === e.origin && norm(a.pathname) === norm(e.pathname);
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────── recorded action → step

const MODIFIER_BITS = [[1, 'Alt'], [2, 'Control'], [4, 'Meta'], [8, 'Shift']];
function modifierNames(mask) {
  return MODIFIER_BITS.filter(([bit]) => mask & bit).map(([, name]) => name);
}

/** Kinds in Playwright's structured locator that narrow or chain rather than pick the element. */
const STRUCTURAL_KINDS = new Set([
  'nth', 'first', 'last', 'filter', 'has', 'has-not', 'hasNot', 'has-text', 'hasText', 'has-not-text',
  'and', 'or', 'visible', 'frame', 'frame-locator', 'describe',
]);

/**
 * Playwright's jsonl locator is a linked chain: `{ kind, body, options, next }`. Turn it into the
 * readable `target`. The primary node is the first one that actually names an element; everything
 * else becomes a short `chain` note the UI shows as a fragility hint.
 */
function targetFromLocator(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const nodes = [];
  for (let n = loc; n; n = n.next) nodes.push(n);

  let target = null;
  const chain = [];
  let frame = false;
  for (const n of nodes) {
    const kind = n.kind;
    const o = n.options || {};
    if (kind === 'frame' || kind === 'frame-locator') {
      frame = true;
      chain.push(`inside frame ${n.body}`);
      continue;
    }
    if (STRUCTURAL_KINDS.has(kind)) {
      if (kind === 'nth') chain.push(`match #${Number(n.body) + 1}`);
      else if (kind === 'first') chain.push('first match');
      else if (kind === 'last') chain.push('last match');
      else if (kind === 'has-text' || kind === 'hasText') chain.push(`containing "${n.body}"`);
      else if (kind === 'has-not-text') chain.push(`not containing "${n.body}"`);
      else if (kind !== 'visible') chain.push(kind);
      continue;
    }
    if (target) {
      // A second element-picking node after the first = "the X inside the Y".
      chain.push(`then ${describeTarget(primaryTarget(kind, n.body, o))}`);
      continue;
    }
    target = primaryTarget(kind, n.body, o);
  }
  if (!target) target = { by: 'css', value: nodes.map((n) => n.body).filter(Boolean).join(' ') || 'body' };
  if (frame) target.frame = true;
  if (chain.length) target.chain = chain;
  return target;
}

function primaryTarget(kind, body, o) {
  const name = o.name && typeof o.name === 'object' ? { regex: o.name.source || String(o.name) } : o.name;
  switch (kind) {
    case 'role': return compact({ by: 'role', role: body, name, exact: o.exact || undefined });
    case 'label': return compact({ by: 'label', text: body, exact: o.exact || undefined });
    case 'placeholder': return compact({ by: 'placeholder', text: body, exact: o.exact || undefined });
    case 'text': return compact({ by: 'text', text: body, exact: o.exact || undefined });
    case 'alt': return compact({ by: 'alt', text: body, exact: o.exact || undefined });
    case 'title': return compact({ by: 'title', text: body, exact: o.exact || undefined });
    case 'test-id': case 'testid': return { by: 'testid', value: body };
    default: return { by: 'css', value: body };
  }
}

function compact(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === undefined || obj[k] === null || obj[k] === '') delete obj[k];
  return obj;
}

const NOISE_SELECTORS = new Set(['html', 'body']);

/**
 * Recorded Playwright action (as delivered to the recorder sink) → step, or null when the action is
 * noise not worth a step (the very first page opening, a stray click on the page body, a printable
 * key typed into nothing, a navigation off to Keycloak).
 *
 * @param actionInContext  `{ pageGuid, action, startTime }` from the recorder
 * @param jsonlLine        the recorder's jsonl rendering of the same action (carries `locator`)
 * @param ctx              `{ baseUrl, pageIndex, isFirstPage }`
 */
function fromRecorderAction(actionInContext, jsonlLine, ctx) {
  const a = actionInContext && actionInContext.action;
  if (!a) return null;
  let entry = {};
  try { entry = JSON.parse(jsonlLine || '{}'); } catch { /* fine: fall back to the raw selector */ }

  const step = { type: null };
  /**
   * Playwright's own choice of locator. It used to BE the target; it is now the fallback of last
   * resort, used only when the identity engine could not capture the element (a frame it cannot
   * inject into, or a page that navigated away mid-action). The real target is attached separately
   * by recording.js and is a fingerprint plus a validated set of candidates.
   */
  const withTarget = () => {
    step.legacy = targetFromLocator(entry.locator) || { by: 'css', value: a.selector };
    step.fallbackSelector = a.selector;
    if (a.selector && a.selector.includes('internal:control=enter-frame')) step.legacy.frame = true;
  };

  switch (a.name) {
    case 'openPage':
      if (ctx.isFirstPage) return null;
      step.type = 'openPage';
      break;
    case 'closePage':
      step.type = 'closePage';
      break;
    case 'navigate': {
      if (!isOnApp(a.url, ctx.baseUrl)) return null;
      step.type = 'navigate';
      step.url = templateUrl(a.url, ctx.baseUrl);
      break;
    }
    case 'click': {
      if (NOISE_SELECTORS.has(a.selector)) return null;
      step.type = (a.clickCount || 1) >= 2 ? 'dblclick' : 'click';
      withTarget();
      if (a.button && a.button !== 'left') step.button = a.button;
      const mods = modifierNames(a.modifiers || 0);
      if (mods.length) step.modifiers = mods;
      break;
    }
    case 'hover':
      step.type = 'hover';
      withTarget();
      break;
    case 'fill':
      step.type = 'fill';
      withTarget();
      step.value = a.text;
      break;
    case 'press': {
      const mods = modifierNames(a.modifiers || 0);
      const onBody = NOISE_SELECTORS.has(a.selector);
      if (onBody && !mods.length && String(a.key).length === 1) return null;
      step.type = 'press';
      step.key = [...mods, a.key].join('+');
      if (!onBody) withTarget();
      break;
    }
    case 'check': case 'uncheck':
      step.type = a.name;
      withTarget();
      break;
    case 'select':
      step.type = 'select';
      withTarget();
      step.values = a.options || [];
      break;
    case 'setInputFiles':
      step.type = 'upload';
      withTarget();
      step.files = a.files || [];
      break;
    case 'assertVisible':
      step.type = 'expectVisible';
      withTarget();
      break;
    case 'assertText':
      step.type = 'expectText';
      withTarget();
      step.text = a.text;
      step.substring = a.substring !== false;
      break;
    case 'assertValue':
      step.type = 'expectValue';
      withTarget();
      step.value = a.value;
      break;
    case 'assertChecked':
      step.type = 'expectChecked';
      withTarget();
      step.checked = a.checked !== false;
      break;
    case 'assertSnapshot':
      step.type = 'expectSnapshot';
      withTarget();
      step.snapshot = a.ariaSnapshot;
      break;
    default:
      return null;
  }
  if (ctx.pageIndex > 0) step.page = ctx.pageIndex;
  return step;
}

// ────────────────────────────────────────────────────────────── plain-English description

const ROLE_WORDS = {
  button: 'button', link: 'link', textbox: 'field', searchbox: 'search field', combobox: 'dropdown',
  listbox: 'list', option: 'option', checkbox: 'checkbox', radio: 'radio', tab: 'tab', menuitem: 'menu item',
  menuitemcheckbox: 'menu item', menuitemradio: 'menu item', switch: 'switch', slider: 'slider',
  spinbutton: 'number field', row: 'row', cell: 'cell', gridcell: 'cell', heading: 'heading', img: 'image',
  dialog: 'dialog', treeitem: 'tree item', listitem: 'list item',
};

function describeTarget(t) {
  if (!t) return 'the page';
  let s;
  const nm = (v) => (v && typeof v === 'object' ? `/${v.regex}/` : `"${v}"`);
  switch (t.by) {
    case 'role': s = t.name !== undefined ? `${ROLE_WORDS[t.role] || t.role} ${nm(t.name)}` : `the ${ROLE_WORDS[t.role] || t.role}`; break;
    case 'label': s = `field "${t.text}"`; break;
    case 'placeholder': s = `field "${t.text}"`; break;
    case 'text': s = `"${t.text}"`; break;
    case 'testid': s = `[${t.value}]`; break;
    case 'alt': s = `image "${t.text}"`; break;
    case 'title': s = `"${t.text}"`; break;
    default: s = `element ${t.value}`;
  }
  if (t.chain && t.chain.length) s += ` (${t.chain.join(', ')})`;
  return s;
}

// ────────────────────────────────────────────────────────────── target shapes
//
// Two shapes exist and both must keep working:
//   NEW     step.target = { fingerprint, candidates[], primary }   ← the identity engine
//   LEGACY  step.target = { by:'role', role, name } + step.selector  ← tests saved before it, and
//                                                                     targets written by hand
// `step.legacy` + `step.fallbackSelector` carry the legacy form alongside a new target, so a step
// whose identity capture failed still has something to run.

function isIdentityTarget(t) {
  return !!(t && (t.fingerprint || t.candidates));
}

/** The legacy-style descriptor for a step, wherever it lives. Null when there is none. */
function legacyTargetOf(step) {
  if (step.legacy) return step.legacy;
  if (step.target && !isIdentityTarget(step.target) && step.target.by) return step.target;
  return null;
}

/** Does this step act on an element at all? */
function needsTarget(type) {
  return NEEDS_TARGET.has(type);
}

/** A short human phrase for whatever target the step has. */
function targetPhrase(step) {
  const t = step.target;
  if (isIdentityTarget(t)) {
    const fp = t.fingerprint || {};
    const role = ROLE_WORDS[fp.role] || fp.role || fp.tag || 'element';
    if (fp.name) return `${role} "${fp.name}"`;
    if (fp.text) return `${role} "${fp.text}"`;
    const attrs = fp.attrs || {};
    const testid = attrs['data-testid'] || attrs['data-test-id'] || attrs['data-qa'] || attrs['data-test'];
    if (testid) return `${role} [${testid}]`;
    if (attrs.id) return `${role} #${attrs.id}`;
    return `the ${role}`;
  }
  return describeTarget(legacyTargetOf(step));
}

/**
 * A duration as a person would say it: 900 → "0.9s", 1200 → "1.2s", 15000 → "15s". Sub-100 ms
 * stays in milliseconds, because "0.1s" for a 40 ms pause reads as a rounding error rather than
 * as the number the author typed.
 */
function formatDuration(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (n < 100) return `${n}ms`;
  return `${(n / 1000).toFixed(1).replace(/.0$/, '')}s`;
}

function describe(step) {
  const t = () => targetPhrase(step);
  switch (step.type) {
    case 'navigate': return `Go to ${step.url}`;
    case 'click': return `Click ${t()}`;
    case 'dblclick': return `Double-click ${t()}`;
    case 'hover': return `Hover over ${t()}`;
    case 'fill': return step.secret ? `Fill ${t()} with a hidden value` : `Fill ${t()} with "${step.value}"`;
    case 'press': return step.target ? `Press ${step.key} in ${t()}` : `Press ${step.key}`;
    case 'check': return `Tick ${t()}`;
    case 'uncheck': return `Untick ${t()}`;
    // A <select> is rarely a credential, but a security-question answer or an account
    // identifier picked from a list is the same problem, and `secret` already means
    // "do not print this". Cheaper to honour it everywhere than to reason per action.
    case 'select': return step.secret
      ? `Select a hidden value in ${t()}`
      : `Select ${(step.values || []).map((v) => `"${v}"`).join(', ')} in ${t()}`;
    case 'upload': return `Upload ${(step.files || []).length || 'a'} file(s) into ${t()}`;
    case 'openPage': return 'A new tab opens';
    case 'closePage': return 'Close the tab';
    case 'wait': return `Wait ${formatDuration(step.ms)}`;
    case 'waitForXhr': return 'Wait for network';
    case 'expectVisible': return `Expect ${t()} to be visible`;
    case 'expectText': return `Expect ${t()} to ${step.substring === false ? 'read' : 'contain'} "${step.text}"`;
    case 'expectValue': return `Expect ${t()} to have value "${step.value}"`;
    case 'expectChecked': return `Expect ${t()} to be ${step.checked === false ? 'unticked' : 'ticked'}`;
    case 'expectUrl': return `Expect the URL to be ${step.url}`;
    case 'expectSnapshot': return `Expect ${t()} to match the recorded snapshot`;
    default: return `${step.type}`;
  }
}

// ────────────────────────────────────────────────────────────── step → Playwright locator

/**
 * The locator replay acts on. A recorder-chosen `selector` wins; otherwise the target is built
 * through Playwright's public getBy* API, which applies the same matching rules the recorder used.
 */
function locatorFor(page, step) {
  const sel = step.selector || step.fallbackSelector;
  if (sel) return page.locator(sel);
  const t = legacyTargetOf(step);
  if (!t) throw new Error(`Step "${describe(step)}" has no target`);
  const name = t.name && typeof t.name === 'object' ? new RegExp(t.name.regex) : t.name;
  switch (t.by) {
    case 'role': return page.getByRole(t.role, compact({ name, exact: t.exact }));
    case 'label': return page.getByLabel(t.text, compact({ exact: t.exact }));
    case 'placeholder': return page.getByPlaceholder(t.text, compact({ exact: t.exact }));
    case 'text': return page.getByText(t.text, compact({ exact: t.exact }));
    case 'testid': return page.getByTestId(t.value);
    case 'alt': return page.getByAltText(t.text, compact({ exact: t.exact }));
    case 'title': return page.getByTitle(t.text, compact({ exact: t.exact }));
    case 'css': return page.locator(t.value);
    default: throw new Error(`Unknown target kind "${t.by}"`);
  }
}

// ────────────────────────────────────────────────────────────── validation

/**
 * A duration somebody actually meant: a finite, non-negative number, or the digits a form field
 * hands over as a string.
 *
 * `Number()` alone is not enough here. `null`, `''`, `[]` and `false` all coerce to 0, so a plain
 * `Number.isFinite(Number(v))` test waves through exactly the case this validation exists to
 * catch — a wait carrying no duration at all, which replays as a no-op while still sitting in the
 * list looking like it does something. An empty editor field posts `""`, and a cleared one posts
 * `null`, so both reach here in normal use.
 */
function isDuration(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0;
  }
  return false;
}

/** Returns a list of problems (empty = valid). Used before saving and before running. */
function validateSteps(steps) {
  const problems = [];
  if (!Array.isArray(steps)) return ['steps must be a list'];
  steps.forEach((s, i) => {
    const where = `step ${i + 1}`;
    if (!s || typeof s !== 'object') return problems.push(`${where}: not an object`);
    if (!STEP_TYPES.includes(s.type)) return problems.push(`${where}: unknown type "${s.type}"`);
    if (NEEDS_TARGET.has(s.type)) {
      const legacy = legacyTargetOf(s);
      if (isIdentityTarget(s.target)) {
        if (!s.target.fingerprint && !(s.target.candidates || []).length) {
          problems.push(`${where}: target has neither a fingerprint nor any locator candidates`);
        }
      } else if (!legacy && !s.selector && !s.fallbackSelector) {
        problems.push(`${where}: needs a target`);
      } else if (legacy && !TARGET_KINDS.includes(legacy.by)) {
        problems.push(`${where}: unknown target kind "${legacy.by}"`);
      }
    }
    if (s.type === 'navigate' || s.type === 'expectUrl') {
      // Replay drives a browser carrying the saved login and screenshots whatever it lands on,
      // so an imported test with "file:///…/credentials.local.env" would be a file-read-to-image
      // primitive. Only the app's own base URL, or an explicit http(s) address, is allowed.
      if (!s.url) problems.push(`${where}: needs a url`);
      else if (!/^(\{\{baseUrl\}\}|https?:\/\/)/.test(String(s.url))) {
        problems.push(`${where}: url must start with {{baseUrl}} or http(s):// — got "${String(s.url).slice(0, 40)}"`);
      }
    }
    if (s.type === 'fill' && typeof s.value !== 'string') problems.push(`${where}: needs a text value`);
    if (s.type === 'press' && !s.key) problems.push(`${where}: needs a key`);
    // A wait with no duration would silently become a no-op, which is worse than a bad value:
    // the step stays in the list looking like it is doing something.
    if (s.type === 'wait' && !isDuration(s.ms)) problems.push(`${where}: needs a duration in milliseconds`);
    if (s.type === 'waitForXhr' && s.timeoutMs != null && !isDuration(s.timeoutMs)) problems.push(`${where}: timeoutMs must be a number of milliseconds`);
    if (s.type === 'select' && !Array.isArray(s.values)) problems.push(`${where}: needs values`);
    if (s.type === 'expectText' && typeof s.text !== 'string') problems.push(`${where}: needs text`);
  });
  return problems;
}

/** Fragility hints for the editor: positional chains, frames, names that look generated. */
function warningsFor(step) {
  if (isIdentityTarget(step.target)) {
    // The identity engine knows far more about why a locator is weak than this file does.
    const w = require('./identity').warningsForTarget(step.target);
    if (step.identityStatus === 'error') w.push(`Identity capture failed: ${step.identityNote}`);
    return w;
  }

  const w = [];
  if (needsTarget(step.type) && step.identityStatus === 'none') {
    w.push(step.identityNote || 'No element identity was captured; replay falls back to a single recorded selector.');
  }
  const t = legacyTargetOf(step);
  if (!t) return w;
  if (t.chain && t.chain.some((c) => /^match #|first match|last match/.test(c))) w.push('positional match: breaks if the list order changes');
  if (t.by === 'css') w.push('CSS selector: nothing more stable was available');
  const nameText = typeof t.name === 'string' ? t.name : t.text;
  if (nameText && looksVolatile(nameText)) {
    w.push('name contains a date, a time-ago or a generated id: it will not match tomorrow — loosen it');
  }
  return w;
}

/**
 * The step as the page wants it: the stored fields plus everything derived. Derived fields are
 * never persisted (`stripUi` in server.js removes them), so changing how a step reads never
 * requires rewriting saved tests.
 */
function decorate(step) {
  const out = { ...step, text: describe(step), warnings: warningsFor(step) };
  if (isIdentityTarget(step.target)) {
    out.locatorSummary = require('./identity').summarise(step.target);
  } else if (legacyTargetOf(step)) {
    out.locatorSummary = { primary: step.selector || step.fallbackSelector || describeTarget(legacyTargetOf(step)), strategy: 'legacy', score: null, verified: false, fallbacks: 0 };
  }
  return out;
}

/** Fields that are computed for display and must not be written to disk. */
const DERIVED_FIELDS = ['text', 'warnings', 'locatorSummary'];

function stripDerived(step) {
  const out = { ...step };
  for (const f of DERIVED_FIELDS) delete out[f];
  return out;
}

/**
 * Names the Shell renders with a relative time ("… 1h", "5d ago"), a date, a long number or a
 * GUID fragment. A locator built on one of these stops matching as soon as the clock moves, which
 * is the single most common reason a recorded step fails later.
 */
const VOLATILE_NAME = [
  /\b\d{1,3}\s*(?:s|m|h|d|w|mo|y)\s*(?:ago)?\b/i,                                   // 1h · 5d ago · 30m
  /\b(?:just\s+)?now\b/i,
  /\b(?:yesterday|today|tomorrow)\b/i,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/i,     // Aug 25
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/,                                               // 25/08/2026
  /\b\d{2}:\d{2}\b/,                                                                 // 14:02
  /\b\d{6,}\b/,                                                                      // 1725790000
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i,                                          // GUID head
];

function looksVolatile(text) {
  return VOLATILE_NAME.some((re) => re.test(text));
}

module.exports = {
  STEP_TYPES, TARGET_KINDS, DERIVED_FIELDS,
  templateUrl, resolveUrl, isOnApp, samePath,
  fromRecorderAction, targetFromLocator,
  describe, describeTarget, targetPhrase, decorate, stripDerived, formatDuration,
  locatorFor, isIdentityTarget, legacyTargetOf, needsTarget,
  validateSteps, warningsFor,
};
