/**
 * Replayr — Playwright compatibility adapter.
 *
 * Replayr's recorder rides on three PRIVATE Playwright client APIs (underscore-prefixed, not part
 * of the public contract, free to change in any release):
 *
 *   BrowserContext._enableRecorder(params, eventSink)   starts the codegen engine, delivers actions
 *   BrowserContext._disableRecorder()                   sets the recorder mode to "none"
 *   BrowserContext._exposeConsoleApi()                  puts `window.playwright` in every frame
 *
 * Everything in src/ that needs one goes through this file, so there is exactly one place to read,
 * test and fix when Playwright is upgraded. Where they live in the installed package
 * (playwright-core/lib/coreBundle.js, 1.62.1):
 *
 *   client   class BrowserContext   `_enableRecorder` / `_disableRecorder` / `_exposeConsoleApi`
 *            and the `recorderEvent` channel handler that fans events out to `eventSink`
 *   server   class BrowserContextDispatcher  `enableRecorder` -> RecorderApp.show(context, params)
 *            class ProgrammaticRecorderApp   emits actionAdded / actionUpdated / signalAdded
 *            class JsonlLanguageGenerator    renders the `code` string (one JSON object per action)
 *   schema   BrowserContextEnableRecorderParams  (mode, recorderMode, language, omitCallTracking ...)
 *
 * Event shape delivered to the sink (verified against 1.62.1 by tests/compat.test.js):
 *   actionAdded(page, data, code) / actionUpdated(page, data, code)
 *     data = { pageGuid, frame, action: { name, selector?, ... }, startTime, ... }   (actionInContext)
 *     code = a JSONL line: JSON of { ...action, pageGuid, locator }
 *   signalAdded(page, data)    data = { pageGuid, frame, signal: { name, ... } }
 */
'use strict';

/**
 * Versions this adapter has been verified against.
 * `tested` is exact; `range` is the minor line in which the private surface is expected to be
 * unchanged. A version inside `range` but not in `tested` is allowed with a note (the compat test
 * is the proof); outside `range` is refused.
 */
const SUPPORTED = Object.freeze({
  tested: Object.freeze(['1.62.1']),
  range: '1.62.x',
  major: 1,
  minor: 62,
});

/** The private context methods and whether the recorder can work without them. */
const API = Object.freeze({
  _enableRecorder: { required: true, what: 'starts the action recorder' },
  _disableRecorder: { required: false, what: 'switches the recorder off at stop' },
  _exposeConsoleApi: { required: false, what: 'exposes window.playwright (role / accessible-name helpers)' },
});

class IncompatiblePlaywrightError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'IncompatiblePlaywrightError';
    this.code = 'PLAYWRIGHT_INCOMPATIBLE';
    this.status = 500;
    this.version = details.version || null;
    this.missing = details.missing || [];
  }
}

/** The installed Playwright version, or null when it cannot be read. Never throws. */
function installedVersion() {
  for (const id of ['playwright-core/package.json', 'playwright/package.json']) {
    try { const v = require(id).version; if (v) return String(v); } catch (e) { /* try the next */ }
  }
  return null;
}

function versionVerdict(version) {
  if (!version) return { inRange: false, tested: false };
  const m = /^(\d+)\.(\d+)\./.exec(version);
  const inRange = !!m && Number(m[1]) === SUPPORTED.major && Number(m[2]) === SUPPORTED.minor;
  return { inRange, tested: SUPPORTED.tested.includes(version) };
}

function advice(version) {
  return `Replayr's recorder needs Playwright ${SUPPORTED.range} (tested: ${SUPPORTED.tested.join(', ')}); `
    + `installed ${version || 'unknown'}; run "npm ci" to restore the pinned version.`;
}

/**
 * Check the installed Playwright against what the recorder needs.
 *
 * Without a `context` only the version can be judged (the private methods live on the context
 * class, which cannot be reached without an instance); with one, every wrapped API is
 * feature-detected as well. recording.js passes the real context, so the check that matters runs
 * at recording start; the server may call `checkCompat()` at boot to log the version early.
 *
 * @returns {{ ok: boolean, version: string|null, tested: boolean, missing: string[], optionalMissing: string[], notes: string[] }}
 */
function checkCompat({ context } = {}) {
  const version = installedVersion();
  const { inRange, tested } = versionVerdict(version);
  const missing = [];
  const optionalMissing = [];
  const notes = [];

  if (!version) notes.push('Could not read the installed Playwright version');
  else if (!inRange) missing.push(`playwright@${version} (need ${SUPPORTED.range})`);
  else if (!tested) notes.push(`Playwright ${version} is in ${SUPPORTED.range} but not in the tested list (${SUPPORTED.tested.join(', ')}); run tests/compat.test.js`);

  if (context) {
    for (const name of Object.keys(API)) {
      if (typeof context[name] === 'function') continue;
      if (API[name].required) missing.push(name); else optionalMissing.push(name);
    }
    if (optionalMissing.length) notes.push(`optional private API missing: ${optionalMissing.join(', ')}`);
  } else {
    notes.push('version-only check (no context supplied)');
  }
  return { ok: missing.length === 0, version, tested, missing, optionalMissing, notes };
}

/** `checkCompat`, but throws IncompatiblePlaywrightError with an actionable message. */
function assertCompat(opts) {
  const r = checkCompat(opts);
  if (!r.ok) {
    throw new IncompatiblePlaywrightError(
      `${advice(r.version)} Missing: ${r.missing.join(', ')}.`,
      { version: r.version, missing: r.missing });
  }
  return r;
}

/**
 * Start Playwright's recorder on `context`, delivering actions to `handlers`
 * ({ actionAdded, actionUpdated, signalAdded }, each `(page, data, code)`).
 * `opts` are the BrowserContextEnableRecorderParams; the caller owns their values.
 */
async function enableRecorder(context, opts, handlers) {
  assertCompat({ context });
  return context._enableRecorder(opts, handlers);
}

/** Switch the recorder off. A no-op when this Playwright lacks the method. */
async function disableRecorder(context) {
  if (!context || typeof context._disableRecorder !== 'function') return false;
  await context._disableRecorder();
  return true;
}

/**
 * Put `window.playwright` in every frame. Returns false (instead of throwing a TypeError) when
 * this Playwright no longer has the method, so callers degrade to their own role computation.
 */
async function exposeConsoleApi(context) {
  if (!context || typeof context._exposeConsoleApi !== 'function') return false;
  await context._exposeConsoleApi();
  return true;
}

module.exports = {
  SUPPORTED, API, IncompatiblePlaywrightError,
  installedVersion, checkCompat, assertCompat,
  enableRecorder, disableRecorder, exposeConsoleApi,
};
