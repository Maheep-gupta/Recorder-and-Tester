/**
 * Design Studio Tester — configuration. LOCAL ONLY, lives in the launcher folder.
 *
 * Everything the other modules need to know about the machine: which apps can be recorded and
 * where they run, where tests and run evidence are stored, where the saved login lives, and the
 * port the service binds to. Nothing here is a test; nothing here is a secret.
 *
 * Override any value with an environment variable or a `recorder.local.env` file in the launcher
 * folder (KEY=VALUE lines). Real environment variables win over the file.
 *
 *   RECORDER_PORT=4310
 *   RECORDER_UI_SHELL_URL=http://localhost:4201
 *   RECORDER_CONCIERGE_URL=http://localhost:8080
 *   RECORDER_QA1_URL=https://qa1.perf-eks.opkeyone.com/studio
 *   OPKEY_QA1_USERNAME / OPKEY_QA1_PASSWORD   (in credentials.local.env; falls back to OPKEY_USERNAME/PASSWORD)
 *   RECORDER_TESTS_DIR=<repo>/local-tests   (default)
 *   RECORDER_HEADLESS_RUN=1          replay without a visible browser by default
 *   RECORDER_XHR_WAIT_MS=6000        cap on the post-step wait for the app's xhr/fetch (0 = off)
 *   RECORDER_XHR_GRACE_MS=500        how long after an action a new request still counts as its own
 *   RECORDER_XHR_STALE_MS=15000      a request older than this is a poll/stream and is ignored
 *   RECORDER_RECORD_IDLE_WAITS=1     record the pauses the user takes as explicit `wait` steps
 *   RECORDER_RECORD_IDLE_MIN_MS=800  a shorter pause is human latency, not something to reproduce
 *   RECORDER_RECORD_IDLE_MAX_MS=10000  the longest pause a recording will reproduce
 *   RECORDER_HIGHLIGHT_MS=300       outline each element for this long during a HEADED replay (0 = off)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HERE = path.resolve(__dirname, '..');      // project root (this file lives in src/)
const SUITE = HERE;                              // project root (holds .auth/)
const LAUNCHER = HERE;                           // project root (holds *.local.env, local-tests/)

/** Parse a KEY=VALUE file (`#` comments, optional quotes). Missing file → {}. */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const env = { ...readEnvFile(path.join(LAUNCHER, 'recorder.local.env')), ...process.env };
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
const flag = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
/** A flag that is ON unless the environment explicitly turns it off (unset means "yes, please"). */
const flagOn = (v) => (v == null || v === '' ? true : !/^(0|false|no|off)$/i.test(String(v)));

module.exports = {
  paths: { here: HERE, suite: SUITE, launcher: LAUNCHER },

  /** The service binds here. 127.0.0.1 on purpose: nothing off this machine may drive the browser. */
  host: '127.0.0.1',
  port: Number(env.RECORDER_PORT || 4310),

  /**
   * Apps a test can target. A test stores only the key (`target.app`); the URL is resolved at
   * record and run time, so the same test follows whatever is running locally today.
   */
  apps: {
    'ui-shell': { label: 'UI Shell', baseUrl: trimSlash(env.RECORDER_UI_SHELL_URL || 'http://localhost:4201'), auth: true },
    qa1: {
      label: 'QA1 Studio',
      baseUrl: trimSlash(env.RECORDER_QA1_URL || 'https://qa1.perf-eks.opkeyone.com/studio'),
      auth: true,
      // Shared, remote, and NOT yours. Anything recorded here is done against real QA data with
      // whatever account credentials.local.env holds, so the UI marks it and warns before use.
      remote: true,
    },
    concierge: { label: 'Concierge UI', baseUrl: trimSlash(env.RECORDER_CONCIERGE_URL || 'http://localhost:8080'), auth: false },
  },
  defaultApp: 'ui-shell',

  /** One JSON file per test, plus `runs/<test-id>/<run-id>/` for evidence. */
  testsDir: env.RECORDER_TESTS_DIR || path.join(LAUNCHER, 'local-tests'),

  /** Saved Keycloak session shared with the Playwright suite, and the git-ignored credentials that renew it. */
  authStatePath: path.join(SUITE, '.auth', 'ui-shell.json'),
  credentialsPath: path.join(LAUNCHER, 'credentials.local.env'),

  /**
   * Every app that needs a login gets its OWN saved session.
   *
   * `ui-shell` deliberately keeps the historic path, because `helpers/auth.setup.ts` in the
   * Playwright suite owns that file too. Pointing a second environment at it would mean each
   * login rewrote the other's file, and a remote QA session landing in the suite's state is the
   * kind of surprise that costs an afternoon. One environment, one file.
   */
  authStateFor(app) {
    if (app === 'ui-shell') return this.authStatePath;
    return path.join(SUITE, '.auth', String(app).replace(/[^a-z0-9_-]/gi, '_') + '.json');
  },

  /**
   * Credentials for one app: `OPKEY_QA1_USERNAME` / `OPKEY_QA1_PASSWORD` if present, otherwise
   * the plain `OPKEY_USERNAME` / `OPKEY_PASSWORD`. Nothing is read from a test, ever.
   */
  credentialKeys(app) {
    const k = String(app).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    return { user: ['OPKEY_' + k + '_USERNAME', 'OPKEY_USERNAME'], pass: ['OPKEY_' + k + '_PASSWORD', 'OPKEY_PASSWORD'] };
  },

  /** Playwright's test-id attribute. The Shell barely uses one, so role/name locators dominate. */
  testIdAttribute: 'data-testid',

  viewport: { width: 1400, height: 900 },
  /** Per-step wait for an element to be ready. A test may override with `settings.stepTimeoutMs`. */
  stepTimeoutMs: 30_000,

  /**
   * After every step, wait for the app's OWN data calls to finish before moving to the next one.
   *
   * Playwright's actionability checks answer "is this element clickable", not "has the screen
   * finished loading its data" — so a click that fires a save, or a route change that fetches a
   * list, would hand over to the next step while the request was still in the air. On localhost
   * that mostly gets away with it. Against a remote environment like QA1 it does not.
   *
   * This deliberately is NOT `waitForLoadState('networkidle')`, and just as deliberately NOT
   * "wait until nothing is in flight" either. An app that polls every 300 ms never leaves a gap
   * long enough to call quiet, so a quiet-window rule makes every single step burn the full cap.
   * What a step actually needs is ITS OWN requests, so that is what is waited for: the ones
   * already in the air when the action finished, plus any that start during the next
   * `xhrGraceMs` — the window in which a new request can still be blamed on the action.
   * Anything older than `xhrStaleMs` is a poll or an open stream, and is ignored on entry or
   * abandoned mid-wait so it cannot hold the step. The whole thing is capped at `xhrWaitMs` and
   * NEVER fails a step — a busy network is a note, not a verdict.
   *
   * `xhrGraceMs` is also the floor on what the wait costs every step, so it stays short. 500 ms
   * is comfortably clear of the gap between an action and the request it fires (measured at
   * 5-40 ms through Playwright's request event) while still covering a debounced input.
   *
   * Set RECORDER_XHR_WAIT_MS=0 to turn the implicit wait off. An explicit `waitForXhr` step is
   * something the author asked for and still runs. A test may override with `settings.xhrWaitMs`.
   */
  xhrWaitMs: Number(env.RECORDER_XHR_WAIT_MS != null ? env.RECORDER_XHR_WAIT_MS : 6000),
  xhrGraceMs: Number(env.RECORDER_XHR_GRACE_MS != null ? env.RECORDER_XHR_GRACE_MS : 500),
  xhrStaleMs: Number(env.RECORDER_XHR_STALE_MS || 15_000),
  navigationTimeoutMs: 60_000,
  /** How long to wait for the app to answer before a run starts (ng serve recompiling). */
  appReadyTimeoutMs: 30_000,

  /**
   * Record the pauses the user takes as explicit `wait` steps.
   *
   * A user who clicks, watches a panel animate, reads a toast and only then clicks again has told
   * us something replay cannot infer: those two clicks are not back to back. When the first click
   * fetched data the implicit xhr wait already reproduces the pause, so nothing is inserted. When
   * it fetched NOTHING there is no signal at all and replay races ahead of the app — that is the
   * gap worth writing down, and writing it down as a visible step the author can see, edit or
   * delete beats an invisible sleep buried in the runner.
   *
   * `recordIdleMinMs` keeps ordinary human latency (finding the next button) out of the test;
   * `recordIdleMaxMs` keeps a coffee break out of it.
   */
  recordIdleWaits: flagOn(env.RECORDER_RECORD_IDLE_WAITS),
  recordIdleMinMs: Number(env.RECORDER_RECORD_IDLE_MIN_MS || 800),
  recordIdleMaxMs: Number(env.RECORDER_RECORD_IDLE_MAX_MS || 10_000),

  /**
   * Outline each element for this long, just before the step acts on it, so a headed replay can
   * be WATCHED.
   *
   * This is not decoration for its own sake. The identity engine's whole job is to find the
   * element again on a page that has changed, and the failure nobody catches is the one where it
   * finds a plausible wrong element and the step passes. Seeing "4 · Click" light up on the row
   * you did not mean is how that gets caught in the two seconds it takes to notice.
   *
   * The marker is a 1px solid red `outline` on a `position: fixed`, `pointer-events: none` overlay
   * appended to the documentElement, and it is REMOVED BEFORE the action runs, so it cannot
   * shift the layout, cannot swallow the click, and is not on screen when Playwright decides
   * whether the element is hittable. A step's outcome is exactly what it would have been with
   * this switched off.
   *
   * It costs this many milliseconds per element step, so it is a headed-run affordance only:
   * a headless run never draws it. `RECORDER_HIGHLIGHT_MS=0` turns it off entirely, including the
   * red outline left around a failing step's element for the evidence screenshot.
   */
  highlightMs: Number(env.RECORDER_HIGHLIGHT_MS != null ? env.RECORDER_HIGHLIGHT_MS : 300),
  // Draw the 1px red outline on the element being clicked, while recording and while replaying.
  // Off turns off BOTH; it is a diagnostic aid, and someone recording a screen capture may not
  // want it in the video. RECORDER_HIGHLIGHT=0 disables.
  recordHighlight: String(env.RECORDER_HIGHLIGHT == null ? '1' : env.RECORDER_HIGHLIGHT) !== '0',

  headedRecording: true,
  headedRun: !flag(env.RECORDER_HEADLESS_RUN),

  readEnvFile,
};
