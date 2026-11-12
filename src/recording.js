/**
 * Design Studio Tester — recording.
 *
 * Owns the ONE browser a recording runs in, and combines two independent sources of truth:
 *
 *   1. **Playwright's own recorder** (the engine behind `playwright codegen`) tells us WHAT the
 *      user did, at the right altitude: six keystrokes arrive as one `fill`, a mouse-down and
 *      mouse-up arrive as one `click`. Getting this for free is why it is still here.
 *
 *   2. **Our identity capture**, injected into every frame, tells us WHICH ELEMENT they did it to
 *      — in full, at the instant they touched it, before any re-render can take the node away.
 *
 * Playwright alone would give us one selector of its choosing. That single selector is exactly the
 * fragility this tool exists to remove, so it is demoted to a fallback: the step's real target is
 * an identity fingerprint plus a validated, scored set of ways to find the element again.
 *
 * A third thing is recorded that neither source reports: the pauses. When an action fires no data
 * call, nothing at replay time knows the app needed a moment, so the time the user then sat still
 * is written down as a `wait` step — see `_idleWaitStep`.
 *
 * Events emitted: 'change' (whole state) — the server relays it to the page over SSE.
 */
'use strict';

const { EventEmitter } = require('events');
const { chromium, firefox, webkit } = require('playwright');
const config = require('./config');
const auth = require('./auth');
const steps = require('./steps');
const identity = require('./identity');

/** The page-side function our injected capture calls. Named to be obvious in a stack trace. */
const BINDING = '__opkeyRecorderCapture';

/**
 * The in-page recorder bar.
 *
 * `BAR_HOST_ID` is deliberately one weird, greppable string, because it is the SAME string all
 * three defences key on:
 *   1. page side — a capture-phase listener registered before anyone else's swallows every event
 *      whose composed path reaches the host, so neither Playwright's recorder nor our identity
 *      capture ever sees it;
 *   2. `_onCapture` — an identity capture that names the host is dropped;
 *   3. `_onAction` — a recorder action whose selector or code names the host is dropped.
 * Any one of them alone would do; all three are here because a toolbar that quietly writes itself
 * into the user's test is worse than no toolbar at all.
 */
const BAR_BINDING = '__opkeyRecorderBar';
const BAR_HOST_ID = '__tf_recorder_bar';
/**
 * The highlight overlay's host. Note the prefix: it CONTAINS `BAR_HOST_ID`, so every defence
 * above — the composed-path swallow, the `_onCapture` drop, the `_onAction` drop — already covers
 * it without a second rule to keep in step. Same namespace, same protection.
 */
const HIGHLIGHT_HOST_ID = BAR_HOST_ID + '_hl';

/**
 * Flash the element the recorder just latched onto, with its role and accessible name.
 *
 * ON by default: the single most common question while recording is "did it get the thing I
 * meant, or its wrapper?", and the tag answers it before the step list has even repainted.
 *
 * Lives in `config.js` next to `recordIdleWaits` — same kind of switch, same audience.
 * RECORDER_HIGHLIGHT=0 turns it off for both recording and replay.
 */
const RECORD_HIGHLIGHT = config.recordHighlight;

/** How far back to look for the element a recorder action belongs to. */
const CORRELATION_WINDOW_MS = 8000;

// The Setup form's Browser and Viewport choices. Each engine is a separate download; if the one
// asked for was never installed, say exactly that rather than letting Playwright's own
// "Executable doesn't exist" reach the user.
const ENGINES = { chromium, firefox, webkit };
function engineFor(name) {
  const key = String(name || 'chromium').toLowerCase();
  const e = ENGINES[key];
  if (!e) throw Object.assign(new Error(`Unknown browser "${name}" - choose Chrome, Firefox or WebKit`), { status: 400 });
  return { key, engine: e };
}
/**
 * Which engines are installed for THIS playwright package, without launching one.
 * `executablePath()` is a synchronous path lookup; the file is only there if the matching
 * browser build was downloaded. Used to label the Setup form's Browser choice.
 */
function availableEngines() {
  const fs = require('fs');
  return Object.keys(ENGINES).map((key) => {
    let installed = false;
    try { installed = fs.existsSync(ENGINES[key].executablePath()); } catch (e) { installed = false; }
    return { key, label: key === 'chromium' ? 'Chrome' : key === 'webkit' ? 'WebKit' : 'Firefox', installed };
  });
}

// "1280x800" -> { width, height }. Anything unparseable falls back to the configured default
// rather than launching a window of nonsense size.
function viewportFor(v) {
  const m = /^(\d{3,5})\s*[x×]\s*(\d{3,5})$/.exec(String(v || '').trim());
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * How long Stop waits for identity work already in flight. Bounded on purpose: see stop().
 */
const STOP_IDENTITY_GRACE_MS = 2000;

/**
 * Per-step element screenshots — what the user actually clicked, as a picture.
 *
 * The shot is a plain VIEWPORT screenshot cropped to the element's rectangle. Deliberately NOT
 * `locator.screenshot()` and NOT `fullPage: true`: both of those scroll the page to do their
 * job, and the page belongs to the person recording — yanking it out from under their hands
 * mid-click is a worse bug than having no picture at all.
 *
 * The rectangle is not measured here. The identity capture already stamped it on the fingerprint
 * as `state.box`, from `getBoundingClientRect()` at the instant the user touched the element —
 * CSS pixels, relative to the viewport. That is exactly the coordinate space Playwright's `clip`
 * uses for a non-fullPage shot, so the box goes straight in with no scroll arithmetic. (Proved,
 * not assumed: clipping to a rect on a page scrolled 1200px down returns the element, while the
 * document-relative version of the same rect is rejected as "outside the resulting image".)
 *
 * Everything about this feature is optional-by-construction. See `_captureShot`.
 */
const SHOT_TIMEOUT_MS = 1200;      // hard ceiling; a slow shot is abandoned, never waited out
const SHOT_PAD = 4;                // enough to show the element's own border and focus ring
const SHOT_MAX_BYTES = 150 * 1024; // a crop bigger than this is a screenful, not an element
const SHOT_BUFFER = 300;           // PNGs held in this process, oldest dropped first

/**
 * Where the standalone panel lives, as an ABSOLUTE url.
 *
 * The bar runs inside the recorded app, which is a different origin from this service, so
 * `window.open('/recorder')` from there would resolve against the app and 404. The origin is
 * only knowable on this side, so it is baked into the injected source.
 *
 * `--port` is read the same way server.js reads it, and for the same reason: the service can be
 * started on a port other than `config.port`, and a bar pointing at the port nobody is serving
 * is worse than no button at all.
 */
function panelUrl() {
  const at = process.argv.indexOf('--port');
  const port = (at >= 0 && Number(process.argv[at + 1])) || config.port;
  return `http://${config.host}:${port}/recorder`;
}

/** Captures kept per frame. A recording touches a handful of elements between actions. */
const CAPTURE_BUFFER = 40;

/**
 * Console lines and data calls kept for the panel's Console and Network tabs.
 *
 * Bounded because the page is the app under test, not ours: a chatty Angular build in dev mode
 * logs on every change detection, and an hour of recording would otherwise be held in this
 * process for as long as the draft lives. Oldest go first — the interesting line is always the
 * one that just happened.
 */
const CONSOLE_BUFFER = 500;
const NETWORK_BUFFER = 500;

/** One console line, truncated. A stack trace or a dumped object can be megabytes on its own. */
const CONSOLE_TEXT_MAX = 2000;

/**
 * Does this console line look like it is carrying a credential?
 *
 * The same shape-based rule the identity engine applies to form fields (`SECRETY` in
 * identity/browser-lib.js) — an app will not tell us which of its own log lines are sensitive,
 * so the shape of the words is all there is to go on. `authorization` is added here because a
 * logged header dump is the common way a token reaches the console.
 *
 * The line is kept, not dropped: "something was hidden here" is information the person reading
 * the panel needs. Only its text goes.
 */
const SECRETY_TEXT = /pass(word|wd|phrase)?|secret|api[-_ ]?key|\btoken\b|\botp\b|\bpin\b|cvv|credential|authorization/i;
const REDACTED = '[redacted — looked like a credential]';

/**
 * Query-string parameters whose VALUE is never stored. Matched on the parameter name, for the
 * same reason as above: `?token=…`, `?sig=…` and `?code=…` are credentials sitting in a URL, and
 * the Network tab exists to show which call was made, not to archive its secrets.
 */
const SECRETY_PARAM = /token|secret|password|key|auth|code|session|sig|signature/i;

/**
 * The steps a person may add to a draft by hand.
 *
 * Short on purpose. A recorded action carries an element identity captured at the instant it
 * happened; nothing added afterwards can have one, so the interaction types are not offered and
 * the assertions here get their element by pointing at a step that already has it.
 */
const INSERTABLE_TYPES = [
  'wait', 'waitForXhr',
  'expectVisible', 'expectText', 'expectValue', 'expectChecked', 'expectUrl',
];

/** Which capture reasons can plausibly belong to which recorded action. */
const COMPATIBLE = {
  click: ['pointerdown', 'click', 'focus'],
  dblclick: ['dblclick', 'click', 'pointerdown'],
  fill: ['keydown', 'focus', 'change', 'pointerdown', 'click'],
  press: ['keydown', 'focus', 'pointerdown', 'click'],
  check: ['change', 'click', 'pointerdown'],
  uncheck: ['change', 'click', 'pointerdown'],
  select: ['change', 'pointerdown', 'click', 'focus'],
  upload: ['change', 'click', 'pointerdown'],
  hover: ['pointerdown', 'focus', 'click'],
};

class Recording extends EventEmitter {
  constructor() {
    super();
    this._reset();
  }

  _reset() {
    this.browser = null;
    this.context = null;
    this.pages = [];            // client Page objects, index = tab number
    this.captures = [];         // recent identity captures, newest last
    // step id → PNG Buffer of that step's element. NOT in the snapshot and never base64 on a
    // step: the snapshot goes over SSE on every keystroke of a fill, and an image riding along
    // would turn a keystroke into a megabyte. The step carries a marker; the bytes are served
    // by /api/recording/step/:id/shot. Insertion-ordered, so the oldest is the first key.
    this.shots = new Map();
    // Console and Network are NOT in the snapshot (see snapshot()) — they live here and are
    // served by their own endpoints, so a chatty app cannot make every SSE frame enormous.
    this.consoleLines = [];     // capped at CONSOLE_BUFFER, oldest dropped
    this.networkCalls = [];     // capped at NETWORK_BUFFER, oldest dropped
    this.consoleSeq = 0;        // ids are monotonic per draft: the panel polls with ?since=
    this.networkSeq = 0;
    this.requestStarts = new WeakMap();  // request → Date.now(), for durationMs
    this.seq = 0;
    this.lastStepId = null;     // step produced by the recorder's most recent action
    this.lastActionAt = null;   // when that action arrived — the clock the idle gap is measured on
    this.actionFetched = false; // did an xhr/fetch follow it inside the grace window?
    this.pending = Promise.resolve();  // serialises the async identity work per action
    this.teardown = Promise.resolve();  // browser close, running behind an already-answered stop()
    this.state = {
      status: 'idle',           // idle · starting · recording · stopping · stopped · error
      app: null,
      baseUrl: null,
      headed: true,
      startedAt: null,
      stoppedAt: null,
      paused: false,
      steps: [],
      error: null,
      captureReady: false,      // did the identity engine attach? shown in the UI
      barReady: false,          // did the in-page recorder bar attach?
      // What is ACTUALLY running, measured after launch — not what the Setup form asked for.
      // The form's choices are plumbed through now, but a maximised window still decides its own
      // size, so the panel reports what it measured rather than what was requested.
      browserLabel: null,       // e.g. "Chromium 140"
      viewport: null,           // { width, height } of the real recording window at start
    };
  }

  /** Engines installed on this machine — see availableEngines(). Instance method so the
   *  server can ask the same object it already holds. */
  availableEngines() { return availableEngines(); }

  get active() {
    return ['starting', 'recording', 'stopping'].includes(this.state.status);
  }

  /**
   * The whole draft, as the panel sees it.
   *
   * Console and Network are deliberately COUNTS here, never the arrays. This object goes out over
   * SSE on every single action — every keystroke of a fill is one — and 500 console lines plus
   * 500 requests riding along each time would turn a keystroke into a megabyte on the wire. The
   * counts are what the tab badges need; the rows themselves come from /api/recording/console and
   * /api/recording/network, which the panel polls incrementally with ?since=.
   */
  snapshot() {
    return {
      ...this.state,
      steps: this.state.steps.map((s) => steps.decorate(s)),
      consoleCount: this.consoleLines.length,
      consoleErrors: this.consoleLines.reduce((n, l) => n + (l.type === 'error' ? 1 : 0), 0),
      networkCount: this.networkCalls.length,
    };
  }

  _emit() {
    this.emit('change', this.snapshot());
  }

  /**
   * Open the recording browser on `app`. Resolves once the app page is open and both recorders are
   * listening. Rejects (and leaves state 'error') if the login cannot be made valid or the app is down.
   */
  async start({ app = config.defaultApp, headed = config.headedRecording,
                browser = 'chromium', viewport = null, log = () => {} } = {}) {
    if (this.active) throw Object.assign(new Error('A recording is already in progress'), { status: 409 });
    const def = config.apps[app];
    if (!def) throw Object.assign(new Error(`Unknown app "${app}"`), { status: 400 });

    this._reset();
    const { key: engineKey, engine } = engineFor(browser);
    const wantViewport = viewportFor(viewport);
    Object.assign(this.state, { status: 'starting', app, baseUrl: def.baseUrl, headed, startedAt: new Date().toISOString() });
    this._emit();

    try {
      // ONE browser for the whole recording.
      //
      // The session check used to run first, in a browser of its own. Nominally headless, but on
      // Windows that still flashes a window frame — so every recording began with a window
      // appearing and vanishing a moment before the real one opened, and paid for a second
      // Chromium launch to do it. The check needs a page on the app; the recording is about to
      // open exactly that page; so it is the same page, and the launch below is the only one.
      // Maximise only when no explicit size was asked for, and only on Chromium - the flag is a
      // Chrome switch, and a maximised window would silently override the size the form chose.
      const maximise = headed && !wantViewport && engineKey === 'chromium';
      try {
        this.browser = await engine.launch({ headless: !headed, args: maximise ? ['--start-maximized'] : [] });
      } catch (e) {
        if (/executable doesn't exist|please run the following command/i.test(String(e.message))) {
          throw Object.assign(new Error(
            engineKey + ' is not installed for Playwright. Run "npx playwright install ' + engineKey + '", then try again.'),
            { status: 400 });
        }
        throw e;
      }
      this.browser.on('disconnected', () => this._onBrowserGone());
      this.context = await this.browser.newContext({
        ...auth.storageStateOption(app),
        viewport: wantViewport || (headed ? null : config.viewport),
      });
      // Every page the recording ever has, including ones the app opens later — the console of a
      // popup is exactly where the interesting error tends to be.
      this.context.on('page', (p) => {
        if (!this.pages.includes(p)) this.pages.push(p);
        this._watchConsole(p);
      });

      // Did the action the user just performed set off a data call? That single bit decides
      // whether the pause after it needs recording: if it did, replay's implicit xhr wait already
      // reproduces the pause and a `wait` step on top would double it. The window used here is
      // exactly replay's `xhrGraceMs`, and it has to be: a request the runner will not wait for
      // must not count here either, or the pause it covers would be dropped from the test.
      this.context.on('request', (r) => {
        if (this.actionFetched || this.lastActionAt == null) return;
        const t = r.resourceType();
        if (t !== 'xhr' && t !== 'fetch') return;
        if (Date.now() - this.lastActionAt <= Math.max(0, Number(config.xhrGraceMs) || 0)) this.actionFetched = true;
      });

      // ── the Network tab's own view of the same traffic
      //
      // A SECOND listener rather than more work inside the one above: that one answers a single
      // question the idle-wait logic depends on and must stay as cheap and as obviously correct
      // as it is. This one is for the person watching. Only xhr/fetch — the panel is for data
      // calls, and an Angular boot alone pulls in hundreds of scripts, fonts and images nobody
      // is going to read.
      //
      // Rows are appended when a call FINISHES, not when it starts, so ids stay in completion
      // order and `?since=` can never miss an update to a row it has already handed out.
      this.context.on('request', (r) => { try { this.requestStarts.set(r, Date.now()); } catch (e) { /* not ours to fail */ } });
      this.context.on('response', (resp) => this._recordResponse(resp));
      this.context.on('requestfailed', (r) => this._recordRequestFailed(r));

      // ── identity capture, in every frame of every page, before any app code runs
      try {
        // Puts `window.playwright` in the main world of every frame, which gives our extractor
        // Playwright's own role and accessible-name computation instead of only our own.
        await this.context._exposeConsoleApi().catch(() => {});
        await this.context.exposeBinding(BINDING, (source, payload) => this._onCapture(source, payload));
        await this.context.addInitScript({ content: identity.installSource(BINDING) });
        this.state.captureReady = true;
      } catch (e) {
        // Recording without it still works; the steps just fall back to Playwright's own selector.
        log(`recording: identity capture unavailable (${String(e.message).split('\n')[0]})`);
        this.state.captureReady = false;
      }

      // ── our own recorder bar, in the page the user is actually looking at
      //
      // Added AFTER the identity script on purpose. Both are document-start scripts, but the
      // identity one defers its `install()` to DOMContentLoaded (readyState is 'loading' when an
      // init script runs), while this one registers its swallowing listener synchronously — so it
      // is first on `document` capture no matter what, and stays first when Playwright's own
      // recorder attaches later.
      try {
        await this.context.exposeBinding(BAR_BINDING, (source, payload) => this._onBarMessage(payload));
        await this.context.addInitScript({ content: barSource(BAR_BINDING, BAR_HOST_ID, HIGHLIGHT_HOST_ID, RECORD_HIGHLIGHT, panelUrl()) });
        this.state.barReady = true;
      } catch (e) {
        // A missing toolbar is cosmetic. A recording that will not start is not.
        log(`recording: in-page bar unavailable (${String(e.message).split('\n')[0]})`);
        this.state.barReady = false;
      }

      // ── the session, in the page the recording will use
      //
      // Deliberately BEFORE the recorder is attached. If the saved Keycloak session has expired
      // the login happens right here, in this window, and nothing about it can reach the draft:
      // there is no recorder listening yet. That is the same guarantee the throwaway browser used
      // to give, without the throwaway browser.
      const page = await this.context.newPage();
      const session = await auth.ensureSession(app, { log, page });
      if (!['valid', 'renewed', 'no-auth-needed'].includes(session.status)) {
        throw new Error(`Cannot record while logged out: ${session.message}`);
      }

      // ── Playwright's recorder, for the semantics of the action
      await this.context._enableRecorder(
        {
          mode: 'recording',
          recorderMode: 'api',
          language: 'jsonl',
          testIdAttributeName: config.testIdAttribute,
          omitCallTracking: true,
        },
        {
          actionAdded: (page, data, code) => this._onAction(page, data, code, false),
          actionUpdated: (page, data, code) => this._onAction(page, data, code, true),
          signalAdded: (page, data) => this._onSignal(page, data),
        },
      );

      // The first step of every draft is "go to the app", and replay depends on it — `execution`
      // navigates nowhere on its own, it replays this step. The probe above already loaded the
      // page, so this second visit is a warm one in the same profile; it exists so the recorder,
      // now listening, sees the navigation and writes that step.
      await page.goto(def.baseUrl, { timeout: config.navigationTimeoutMs })
        .catch((e) => log(`recording: first navigation: ${e.message.split('\n')[0]}`));

      // Measure what actually launched, now that there is a real window to measure. The Setup
      // form's choices are honoured, but a maximised Chromium sizes itself, so the bar must
      // report the window that exists rather than the one that was asked for. Both are cosmetic
      // - a failure to read either must not take the recording down with it.
      try {
        this.state.browserLabel = engineKey.charAt(0).toUpperCase() + engineKey.slice(1)
          + ' ' + String(this.browser.version() || '').split('.')[0];
      } catch (e) { this.state.browserLabel = null; }
      try {
        const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        this.state.viewport = (size && size.width) ? size : null;
      } catch (e) { this.state.viewport = null; }

      // Anything buffered while the user was logging in belongs to the login, not to the test.
      // Start the correlation buffer empty — and the Console and Network buffers with it, both
      // because the login's own noise is not what anyone opened those tabs to read, and because
      // a token exchange is the last traffic that should sit in this process for an hour.
      this.captures = [];
      this.consoleLines = [];
      this.networkCalls = [];
      this.state.status = 'recording';
      this._emit();
      log(`recording: started on ${def.baseUrl}${this.state.captureReady ? '' : ' (identity capture OFF)'}`);
      return this.snapshot();
    } catch (e) {
      this.state.status = 'error';
      this.state.error = String(e.message || e).split('\n')[0];
      this._emit();
      await this._closeBrowser();
      throw e;
    }
  }

  /**
   * End the recording and return the finished draft. Safe to call twice.
   *
   * Stop used to take three to ten seconds to answer, because it did all of this before replying:
   * waited up to 8 s for in-flight identity work, tore the recorder down, and closed the browser.
   * Only the FIRST of those changes the draft; the other two are housekeeping the caller has no
   * reason to sit through. So the wait is bounded to `STOP_IDENTITY_GRACE_MS` — long enough for
   * the locators of the step someone just performed, short enough not to be felt — and the
   * teardown moves to `this.teardown`, a promise anyone who genuinely needs the browser gone
   * (shutdown) can await.
   */
  async stop() {
    if (!this.active && this.state.status !== 'recording') return this.snapshot();
    this.state.status = 'stopping';
    this._emit();

    // Identity work runs IN the page, so it has to finish before the browser goes — otherwise the
    // last step of every recording is saved with no locators. In practice it is already done: a
    // fingerprint costs tens of milliseconds and the user spent longer reaching for Stop.
    await Promise.race([this.pending, new Promise((r) => setTimeout(r, STOP_IDENTITY_GRACE_MS))]);
    this._finish();                       // the draft is final here — the caller can have it now

    const ctx = this.context;
    this.teardown = (async () => {
      if (ctx) await ctx._disableRecorder().catch(() => {});
      await this._closeBrowser();
    })().catch(() => {});
    return this.snapshot();
  }

  /**
   * Delete one step from the LIVE draft.
   *
   * This exists because deleting in the page could not work: the panel holds a copy of the draft,
   * and the next action emits a fresh snapshot that puts the deleted step straight back. The draft
   * has exactly one owner, and it is this object.
   *
   * Two pieces of bookkeeping have to move with it:
   *   • a recorded-idle `wait` sitting immediately before the step was inserted to reproduce the
   *     pause before THAT action — with the action gone it reproduces nothing, so it goes too;
   *   • if the step being removed is the one `actionUpdated` is still refining, that link is cut,
   *     or the next keystroke would rewrite whatever step now occupies the slot.
   *
   * `seq` is deliberately NOT rewound: ids must stay unique for the life of the draft.
   */
  removeStep(id) {
    const list = this.state.steps;
    const at = list.findIndex((s) => s.id === id);
    if (at < 0) return false;

    const before = list[at - 1];
    list.splice(at, 1);
    if (before && before.type === 'wait' && before.recordedIdle) list.splice(at - 1, 1);
    this.shots.delete(id);   // the step is gone, so nothing can ask for its picture again

    if (this.lastStepId === id) {
      this.lastStepId = null;
      this.lastActionAt = null;     // the gap since the deleted action is not a pause to reproduce
      this.actionFetched = false;
    }
    this._emit();
    return true;
  }

  /**
   * Add a step to the LIVE draft by hand — the panel's "+ Add Step" and "Add Assertion".
   *
   * Same reasoning as `removeStep`: the draft has exactly one owner, and it is this object. A
   * step the page invented on its own would be overwritten by the next snapshot.
   *
   * Only the types a person can meaningfully add from a panel are accepted. Everything the
   * recorder produces (click, fill, …) is deliberately NOT here: those carry an element identity
   * captured at the instant of the interaction, and there is no way to conjure one after the
   * fact — a hand-written click would be exactly the fragile, selector-guessed step this tool
   * exists to stop producing.
   *
   * An assertion needs an element, and gets it by naming a step that already has one
   * (`stepId`): the user points at the step where they touched the thing, and the assertion
   * inherits its fingerprint and locators. That is the only honest source for one.
   *
   * @param spec  { type, at?, stepId?, ms?, text?, value?, checked?, url?, timeoutMs? }
   *              `at` is the 0-based index to insert BEFORE; out of range or absent = append.
   */
  insertStep(spec = {}) {
    if (this.state.status === 'idle') throw Object.assign(new Error('There is no recording draft to add to'), { status: 409 });
    const type = String(spec.type || '');
    if (!INSERTABLE_TYPES.includes(type)) {
      throw Object.assign(new Error(
        `Cannot add a "${type || '(none)'}" step by hand — choose one of ${INSERTABLE_TYPES.join(', ')}`), { status: 400 });
    }

    // The step whose element this assertion is about, if one was named.
    const src = spec.stepId ? this.state.steps.find((s) => s.id === spec.stepId) : null;
    if (spec.stepId && !src) throw Object.assign(new Error(`No step "${spec.stepId}" in the draft`), { status: 400 });

    const step = { type };

    if (type === 'wait') {
      const ms = Number(spec.ms);
      // Bounded on both ends: 0 is a step that looks like it does something and does not, and
      // ten minutes is longer than any replay should ever sit still on purpose.
      if (!Number.isInteger(ms) || ms < 1 || ms > 600000) {
        throw Object.assign(new Error('A wait needs a whole number of milliseconds between 1 and 600000'), { status: 400 });
      }
      step.ms = ms;
    } else if (type === 'waitForXhr') {
      if (spec.timeoutMs != null) step.timeoutMs = Number(spec.timeoutMs);
    } else if (type === 'expectUrl') {
      // The one assertion that is about the page rather than an element. `validateSteps` below
      // enforces the {{baseUrl}}/http(s) rule — the same one navigate is held to.
      step.url = String(spec.url == null ? '' : spec.url);
    } else {
      // Every remaining type is an assertion against an element.
      if (!src) {
        throw Object.assign(new Error(
          `An assertion of type "${type}" needs a step to attach to: pass stepId naming the step where that element was captured`), { status: 400 });
      }
      if (!src.target && !src.fallbackSelector) {
        throw Object.assign(new Error(
          `Step "${src.id}" has no element to assert on — pick a step the recorder captured an element for`), { status: 400 });
      }
      // Deep copy, because the assertion outlives the step it came from: deleting or re-recording
      // the source must not reach into a target this step is now relying on.
      if (src.target) step.target = JSON.parse(JSON.stringify(src.target));
      if (src.fallbackSelector) step.fallbackSelector = src.fallbackSelector;
      if (src.frame) step.frame = JSON.parse(JSON.stringify(src.frame));

      if (type === 'expectText') step.text = typeof spec.text === 'string' ? spec.text : '';
      if (type === 'expectChecked') step.checked = spec.checked !== false;
      if (type === 'expectValue') {
        // A redacted field has no value to assert against, and re-typing the password into an
        // assertion would put back exactly what the redaction took out. Say so instead.
        if (typeof spec.value === 'string') step.value = spec.value;
        else if (src.secret) {
          throw Object.assign(new Error(
            `Step "${src.id}" was redacted as a credential, so there is no value to assert — an expectValue on it is not allowed`), { status: 400 });
        } else step.value = typeof src.value === 'string' ? src.value : '';
      }
    }

    // The same validator save and run use. One rule set, checked here too, so a step that cannot
    // replay is refused at the moment it is added rather than at the moment it is needed.
    // "step 1: " is right when a whole test is validated and noise when one step is being added.
    const problems = steps.validateSteps([step]).map((p) => p.replace(/^step 1: /, ''));
    if (problems.length) throw Object.assign(new Error(problems.join('; ')), { status: 400 });

    // Ids come from the same counter recorded steps use, so delete, move and `lastStepId` all
    // keep working without knowing where a step came from.
    step.id = `s${++this.seq}`;
    step.addedByHand = true;
    // `at` on a step is the URL it happened at, not an index. Inherit the source step's, or fall
    // back to where the recording currently is.
    const where = (src && src.at) || steps.templateUrl(safeUrl(this.pages[0] || { url: () => '' }), this.state.baseUrl);
    if (where) step.at = where;

    const list = this.state.steps;
    const index = Number.isInteger(spec.at) && spec.at >= 0 && spec.at <= list.length ? spec.at : list.length;
    list.splice(index, 0, step);
    this._emit();
    return step;
  }

  /**
   * Move one step to another position. Ids are untouched, so `lastStepId` and every reference
   * the panel holds survive the reorder.
   */
  moveStep(id, to) {
    const list = this.state.steps;
    const from = list.findIndex((s) => s.id === id);
    if (from < 0) return false;
    const target = Math.min(Math.max(0, Number.isInteger(to) ? to : 0), list.length - 1);
    if (target === from) return true;
    const [step] = list.splice(from, 1);
    list.splice(target, 0, step);
    this._emit();
    return true;
  }

  /**
   * Stop turning interactions into steps without closing the browser. Useful for the part of a
   * reproduction that is set-up rather than the bug: log in, navigate to the right record, pause
   * off, then resume and capture only the steps that matter.
   *
   * Playwright's recorder keeps running underneath — we simply stop accepting what it reports,
   * which is both simpler and safer than re-entering `_enableRecorder` (it is memoised per
   * context, so a second call would attach a duplicate set of listeners).
   */
  pause() {
    if (this.state.status !== 'recording') throw Object.assign(new Error('Nothing is being recorded'), { status: 409 });
    this.state.paused = true;
    this.lastActionAt = null;   // the set-up the user is about to do is not a pause to reproduce
    this._emit();
    return this.snapshot();
  }

  resume() {
    if (this.state.status !== 'recording') throw Object.assign(new Error('Nothing is being recorded'), { status: 409 });
    this.state.paused = false;
    this.lastStepId = null;   // do not let an update merge across the pause
    this.lastActionAt = null; // nor let the length of the pause become a wait step
    this._emit();
    return this.snapshot();
  }

  /** Throw away the current draft so the page returns to idle. */
  discard() {
    if (this.active) throw Object.assign(new Error('Stop the recording first'), { status: 409 });
    this._reset();
    this._emit();
  }

  // ─────────────────────────────────────────── identity capture

  /**
   * Called from inside the page every time the user touches something. Cheap and synchronous on
   * this side: just remember it. The expensive part (validating locators) happens once, when we
   * know which capture the action belongs to.
   */
  _onCapture(source, payload) {
    if (!payload || !payload.fingerprint) return;
    if (barFingerprint(payload.fingerprint)) return;   // our own toolbar is not part of the test
    this.captures.push({
      uid: payload.fingerprint.uid,
      reason: payload.reason,
      at: payload.at || Date.now(),
      receivedAt: Date.now(),
      fingerprint: payload.fingerprint,
      frame: source.frame,
      page: source.page,
    });
    if (this.captures.length > CAPTURE_BUFFER) this.captures.splice(0, this.captures.length - CAPTURE_BUFFER);
  }

  /**
   * Which capture does this recorder action refer to?
   *
   * The reliable way is to ask the page: resolve Playwright's own selector and read back the uid we
   * stamped on the element. When that fails — almost always because the click navigated and the
   * element no longer exists — fall back to the most recent compatible capture, which in practice
   * is the same element, because the user had to touch it to cause the action.
   */
  async _findCapture(page, action, stepType) {
    const mine = this.captures.filter((c) => c.page === page);
    if (!mine.length) return null;

    if (action.selector) {
      try {
        const uids = await page.locator(action.selector).evaluateAll((els) => els.map((e) => e.__recUid || null));
        if (uids.length === 1 && uids[0]) {
          const hit = mine.find((c) => c.uid === uids[0]);
          if (hit) return { capture: hit, how: 'matched by element identity' };
        }
      } catch (e) { /* the element is gone, or the selector no longer resolves — fall through */ }
    }

    const c = this._recentCapture(page, stepType);
    return c ? { capture: c, how: `matched by the most recent ${c.reason} on this page` } : null;
  }

  /**
   * The newest capture on `page` that could plausibly belong to a `stepType` action — the same
   * fallback `_findCapture` uses, but synchronous, so a decision that cannot wait for a page
   * round trip (see the redaction in `_onAction`) can still be made from it.
   */
  _recentCapture(page, stepType) {
    const allowed = COMPATIBLE[stepType] || null;
    const cutoff = Date.now() - CORRELATION_WINDOW_MS;
    for (let i = this.captures.length - 1; i >= 0; i--) {
      const c = this.captures[i];
      if (c.receivedAt < cutoff) break;   // ordered by arrival: everything earlier is older still
      if (c.page !== page) continue;
      if (allowed && allowed.indexOf(c.reason) < 0) continue;
      return c;
    }
    return null;
  }

  // ─────────────────────────────────────────── the element's picture

  /**
   * Photograph the element this step acted on, and keep the PNG in this process.
   *
   * Everything here is optional. There is no path out of this method that throws, logs or waits:
   * it is wrapped in try/catch AND raced against a hard `SHOT_TIMEOUT_MS`, because a missing
   * picture is a cosmetic loss and a stuttering recording is not. Every "no" below is a silent
   * one — no capture, no box, a box of nothing, an element off-screen, a crop too big to be an
   * element, or a shot that simply took too long.
   *
   * @returns the marker to put on the target, or null. Small on purpose: it rides the SSE frame.
   */
  async _captureShot(page, capture, stepId) {
    const fp = (capture && capture.fingerprint) || null;
    if (!fp) return null;
    // A credential field's PIXELS are the credential as surely as its text is — a password box
    // shows its length, and a one-time code shows the code. Everything else in this file goes
    // out of its way not to keep one (`_onAction`, `_attachIdentity`, `_pushConsole`); storing
    // a photograph of the field would quietly undo all of it.
    if (fp.secret) return null;

    const box = fp.state && fp.state.box;
    if (!box || !(box.w > 0) || !(box.h > 0)) return null;

    let timer = null;
    try {
      const shot = await Promise.race([
        this._cropElement(page, capture.frame, box),
        // Belt and braces over the screenshot's own timeout: the evaluate and the iframe offset
        // below are separate round trips, and none of them may hold the identity queue open.
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), SHOT_TIMEOUT_MS);
          if (timer.unref) timer.unref();   // never keep the process alive for a picture
        }),
      ]);
      if (!shot) return null;
      if (shot.png.length > SHOT_MAX_BYTES) return null;

      this.shots.set(stepId, shot.png);
      // Insertion order, so `keys().next()` is the oldest. An hour of recording must not grow
      // without bound in a process that also owns the browser.
      while (this.shots.size > SHOT_BUFFER) this.shots.delete(this.shots.keys().next().value);
      return { w: shot.w, h: shot.h, bytes: shot.png.length };
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * One viewport screenshot, cropped to `box`.
   *
   * `box` is viewport CSS pixels, and so is Playwright's `clip` for a non-fullPage shot, so the
   * two line up directly. Two adjustments are still needed:
   *
   *   • an iframe's `getBoundingClientRect()` is relative to THAT frame's viewport, while the
   *     screenshot is of the top-level one — so the iframe's own position is added;
   *   • the padded crop is CLAMPED to the window. A clip that runs off the edge is an error in
   *     Playwright, not a smaller picture, and elements against the right or bottom edge are
   *     ordinary. Clamping also does the off-screen test for free: anything wholly outside
   *     collapses to a non-positive width or height.
   *
   * `scale: 'css'` so the crop comes back the size it was asked for even on a HiDPI display —
   * a device-pixel image would be four times the bytes to say the same thing.
   */
  async _cropElement(page, frame, box) {
    // Measured now, not at start(): the window can be resized mid-recording, and clamping to a
    // stale size would either error or silently cut the picture short.
    const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    if (!view || !(view.w > 0) || !(view.h > 0)) return null;

    let x = box.x;
    let y = box.y;
    if (frame && frame !== page.mainFrame()) {
      const el = await frame.frameElement();
      const at = await el.boundingBox();   // already relative to the main frame's viewport
      await el.dispose().catch(() => {});
      if (!at) return null;
      x += at.x;
      y += at.y;
    }

    const left = Math.max(0, Math.floor(x - SHOT_PAD));
    const top = Math.max(0, Math.floor(y - SHOT_PAD));
    const width = Math.min(view.w, Math.ceil(x + box.w + SHOT_PAD)) - left;
    const height = Math.min(view.h, Math.ceil(y + box.h + SHOT_PAD)) - top;
    if (width < 1 || height < 1) return null;   // off-screen, or scrolled out of the window

    const png = await page.screenshot({
      clip: { x: left, y: top, width, height },
      scale: 'css',
      timeout: SHOT_TIMEOUT_MS,
    });
    return { png, w: width, h: height };
  }

  /** The PNG for one step, or null. Served by /api/recording/step/:id/shot. */
  shotFor(stepId) { return this.shots.get(stepId) || null; }

  // ─────────────────────────────────────────── console and network, for the panel's tabs

  /**
   * Listen to one page's console.
   *
   * Both handlers are wrapped, and wrapped tightly: these fire from Playwright's event loop
   * while a recording is live, so a throw in here would surface as an unhandled rejection in the
   * middle of someone's capture. Nothing this code does is worth a lost recording.
   */
  _watchConsole(page) {
    page.on('console', (msg) => {
      try {
        this._pushConsole(consoleType(msg.type()), msg.text(), safeUrl(page));
      } catch (e) { /* a console line is never worth taking the recording down for */ }
    });
    // An uncaught page exception never reaches `console`, and it is the single most useful thing
    // this tab can show: the app broke at this step, and here is the step it broke at.
    page.on('pageerror', (err) => {
      try {
        this._pushConsole('error', String((err && err.message) || err), safeUrl(page));
      } catch (e) { /* as above */ }
    });
  }

  /**
   * One console line, stamped with the step it belongs to.
   *
   * `stepId` is the whole point of the tab: "which of my steps produced this error" is the
   * question, and `lastStepId` at the moment the message arrived is the honest answer. It is
   * null before the first action, which is also honest — that output belongs to the page load.
   */
  _pushConsole(type, rawText, url) {
    const text = String(rawText == null ? '' : rawText);
    const secret = SECRETY_TEXT.test(text);
    const line = {
      id: ++this.consoleSeq,
      at: Date.now(),
      type,
      // Redacted, not dropped: the panel should be able to say that something was hidden here,
      // otherwise a missing line looks like a bug in the recorder.
      text: secret ? REDACTED : text.slice(0, CONSOLE_TEXT_MAX),
      url: originAndPath(url),
      stepId: this.lastStepId,
    };
    if (secret) line.redacted = true;
    if (!secret && text.length > CONSOLE_TEXT_MAX) line.truncated = true;
    this.consoleLines.push(line);
    if (this.consoleLines.length > CONSOLE_BUFFER) {
      this.consoleLines.splice(0, this.consoleLines.length - CONSOLE_BUFFER);
    }
  }

  /** A finished data call. Headers and bodies are never read, let alone stored — see `netUrl`. */
  _recordResponse(resp) {
    try {
      const req = resp.request();
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      const status = resp.status();
      this._pushNetwork({
        method: req.method(),
        url: netUrl(req.url()),
        resourceType: type,
        status,
        ok: status >= 200 && status < 400,
        durationMs: this._durationOf(req),
        // Playwright has no "served from disk cache" flag. These two are the cases it can prove:
        // a service worker answered, or the server said "you already have it".
        fromCache: (typeof resp.fromServiceWorker === 'function' && resp.fromServiceWorker()) || status === 304,
      });
    } catch (e) { /* never let bookkeeping reach the recording */ }
  }

  /** A call that never came back — aborted, refused, DNS gone. Exactly the ones worth seeing. */
  _recordRequestFailed(req) {
    try {
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      const failure = req.failure();
      this._pushNetwork({
        method: req.method(),
        url: netUrl(req.url()),
        resourceType: type,
        status: null,
        ok: false,
        failed: true,
        error: failure ? String(failure.errorText || '').slice(0, 200) : null,
        durationMs: this._durationOf(req),
        fromCache: false,
      });
    } catch (e) { /* as above */ }
  }

  _durationOf(req) {
    let started = null;
    try { started = this.requestStarts.get(req) || null; } catch (e) { started = null; }
    return started == null ? null : Math.max(0, Date.now() - started);
  }

  _pushNetwork(row) {
    this.networkCalls.push({ id: ++this.networkSeq, at: Date.now(), ...row, stepId: this.lastStepId });
    if (this.networkCalls.length > NETWORK_BUFFER) {
      this.networkCalls.splice(0, this.networkCalls.length - NETWORK_BUFFER);
    }
  }

  /**
   * The rows after `since`, for the panel's incremental poll. Ids only ever go up within a draft,
   * so "everything newer than the last id I saw" is the whole protocol — and a client that has
   * fallen behind further than the buffer simply gets the oldest rows still held, rather than a
   * gap it cannot detect.
   */
  consoleSince(since, limit) { return sliceSince(this.consoleLines, since, limit); }
  networkSince(since, limit) { return sliceSince(this.networkCalls, since, limit); }

  // ─────────────────────────────────────────── the in-page bar

  /**
   * The only thing the injected bar can ask this process to do. Called from the page twice a
   * second for state, and once per button press for the rest.
   *
   * Always returns the state, whatever the op was, so the bar repaints the instant it acts
   * instead of waiting for the next poll. Unknown ops are ignored rather than thrown: this is
   * driven by a script in a page the app under test also runs code in.
   */
  _onBarMessage(payload) {
    const op = payload && payload.op;
    try {
      if (op === 'pause' && this.state.status === 'recording' && !this.state.paused) this.pause();
      else if (op === 'resume' && this.state.status === 'recording' && this.state.paused) this.resume();
      else if (op === 'stop' && this.active) {
        // NOT awaited. `stop()` closes the browser this call came from, so awaiting it here would
        // mean the page is torn down while it is still waiting for its own binding to answer.
        // Flip the state first so the bar shows "Stopping" on the reply it is about to get.
        this.state.status = 'stopping';
        this._emit();
        setTimeout(() => { this.stop().catch(() => {}); }, 0);
      }
    } catch (e) { /* a 409 from pause/resume just means the bar was a beat behind */ }
    const st = this.state;
    return {
      status: st.status,
      paused: !!st.paused,
      steps: st.steps.length,
      elapsedMs: st.startedAt ? Math.max(0, Date.now() - Date.parse(st.startedAt)) : 0,
    };
  }

  // ─────────────────────────────────────────── recorder callbacks

  _pageIndex(page) {
    let i = this.pages.indexOf(page);
    if (i < 0) { this.pages.push(page); i = this.pages.length - 1; }
    return i;
  }

  _onAction(page, data, code, isUpdate) {
    if (this.state.status !== 'recording' && this.state.status !== 'starting') return;
    if (this.state.paused) return;   // captured by the browser, deliberately not turned into a step
    // Belt and braces: the page-side guard should mean the recorder never sees our toolbar at all,
    // but if it ever does, the one thing that must not happen is it landing in the user's test.
    // `lastStepId` is deliberately left alone so a later `actionUpdated` still finds its own step.
    if (barAction(data, code)) return;
    const now = Date.now();
    const pageIndex = this._pageIndex(page);
    const step = steps.fromRecorderAction(data, code, {
      baseUrl: this.state.baseUrl,
      pageIndex,
      isFirstPage: pageIndex === 0,
    });

    // ── redact a typed secret BEFORE it goes anywhere
    //
    // `_attachIdentity` does the authoritative version of this a moment later, from the capture
    // it correlates properly. That is too late on its own: the step is pushed and `_emit()`ed
    // first, so a password would already have gone out over SSE to the panel — and every
    // keystroke of a fill arrives as another update, so it would go out repeatedly. A password
    // must not be on the wire even once, so a cheaper, pessimistic check runs here too, using
    // the same "most recent compatible capture" rule the correlator falls back on anyway.
    if (step && typeof step.value === 'string' && step.value) {
      const recent = this._recentCapture(page, step.type);
      if (recent && recent.fingerprint && recent.fingerprint.secret) {
        step.value = '';
        step.secret = true;
      }
    }

    const list = this.state.steps;

    // An update refines the step we just made (more text typed into the same field). The element
    // has not changed, so the identity work already done for it is reused untouched.
    if (isUpdate && this.lastStepId) {
      const at = list.findIndex((s) => s.id === this.lastStepId);
      if (at >= 0) {
        if (step) {
          // Carry EVERY identity field across the replacement. The element has not changed, only
          // the text typed into it, and losing these would discard locators already computed.
          const prev = list[at];
          list[at] = {
            ...step,
            id: prev.id,
            at: prev.at,
            target: prev.target,
            frame: prev.frame,
            fallbackSelector: prev.fallbackSelector || step.fallbackSelector,
            resolvedBy: prev.resolvedBy,
            identityStatus: prev.identityStatus,
            identityNote: prev.identityNote,
          };
          // Once a field has been judged secret it stays secret. The check above is per-event
          // and could miss a later keystroke; this cannot un-redact what was already redacted.
          if (prev.secret) { list[at].secret = true; list[at].value = ''; }
          // Every keystroke of a fill arrives as an update. The user is still working, so the
          // idle clock restarts here — otherwise typing a long value would be measured as a pause.
          this.lastActionAt = now;
        } else {
          list.splice(at, 1);
          this.lastStepId = null;
        }
        return this._emit();
      }
    }

    if (!step) {
      // Noise (a body click, a stray key). Later "updates" must not rewrite an unrelated step.
      if (!isUpdate) this.lastStepId = null;
      return;
    }

    // The pause goes in BEFORE the action it precedes, through the same pipeline as everything
    // else — an id from the same counter, the same list, the same `decorate` — so it appears in
    // the live step list and in the saved test with no special case anywhere downstream.
    const idle = this._idleWaitStep(now);
    if (idle) {
      idle.id = `s${++this.seq}`;
      idle.at = steps.templateUrl(safeUrl(page), this.state.baseUrl);
      list.push(idle);
    }

    step.id = `s${++this.seq}`;
    step.at = steps.templateUrl(safeUrl(page), this.state.baseUrl);
    list.push(step);
    this.lastStepId = step.id;
    this.lastActionAt = now;
    this.actionFetched = false;
    this._emit();

    if (steps.needsTarget(step.type)) this._attachIdentity(page, data.action, step);
  }

  /**
   * Build the step's real target. Runs after the step is already on screen, so the UI stays
   * instant, then fills in the locators a moment later. Serialised through `this.pending` so two
   * fast clicks cannot interleave their page evaluations.
   */
  _attachIdentity(page, action, step) {
    const stepId = step.id;
    step.identityStatus = 'resolving';

    // Look the step up by id at WRITE time, never hold the object. `actionUpdated` replaces the
    // step object on every keystroke, so a reference captured now is an orphan by the time the
    // async work finishes — which silently left every typed field with no locators at all.
    const current = () => this.state.steps.find((s) => s.id === stepId) || null;

    this.pending = this.pending.then(async () => {
      let found = null;
      try {
        found = await this._findCapture(page, action, step.type);
      } catch (e) { /* treated as "no capture" below */ }

      // The picture is taken HERE — as soon as we know WHICH element, and before the locators
      // are validated. Validation runs ten candidates against the live page and can take the
      // best part of a second; the crop is a rectangle measured at the instant of the click, so
      // every millisecond it waits is a millisecond the page has had to scroll, animate or
      // re-render underneath it. The marker still goes onto the target below, once there is one.
      const shot = found ? await this._captureShot(page, found.capture, stepId) : null;

      const target = found
        ? await identity.buildTarget(found.capture.frame || page, found.capture.fingerprint).catch((e) => ({ __error: e }))
        : null;

      const s = current();
      // The step was deleted or merged away while we worked — and so, therefore, is its picture.
      if (!s) { this.shots.delete(stepId); return; }
      if (!found) {
        s.identityStatus = 'none';
        s.identityNote = this.state.captureReady
          ? 'No identity capture matched this action; replay will use the recorder’s own selector.'
          : 'Identity capture was not available in this browser.';
      } else if (target && target.__error) {
        s.identityStatus = 'error';
        s.identityNote = String(target.__error.message || target.__error).split('\n')[0];
      } else {
        s.target = target;
        // The marker the panel keys off. Tiny on purpose — the bytes stay in `this.shots`.
        if (shot) target.shot = shot;
        // The authoritative redaction: this capture is the one the step really belongs to, so
        // if the engine marked the element secret, the typed text does not belong in the test,
        // the run report, or anything downstream of them.
        if (target.fingerprint && target.fingerprint.secret && typeof s.value === 'string') {
          s.value = '';
          s.secret = true;
        }
        s.identityStatus = 'ok';
        s.resolvedBy = found.how;
        if (found.capture.frame && found.capture.frame !== page.mainFrame()) {
          s.frame = { url: safeFrameUrl(found.capture.frame), name: found.capture.frame.name() || null };
        }
      }
      // A shot with nowhere to hang its marker is unreachable — the panel only ever asks for one
      // it has been told about. Held bytes nobody can name are just a leak, so drop them.
      if (shot && !(s.target && s.target.shot)) {
        this.shots.delete(stepId);
      }
      this._emit();
    }).catch(() => {});
  }

  /**
   * The pause before the action that is arriving now, as a step — or null when there is nothing
   * worth reproducing.
   *
   * Only silence is recorded. An action that fetched something is already covered by the runner's
   * implicit wait, and stacking a fixed sleep on top of that would make every replay slower than
   * the recording for no added fidelity. What is left is the case replay genuinely cannot see: a
   * click that opens a panel, expands a tree or runs an animation, after which the user visibly
   * waited before doing the next thing.
   *
   * @param now  the moment the incoming action arrived
   */
  _idleWaitStep(now) {
    if (!config.recordIdleWaits) return null;
    if (this.lastActionAt == null) return null;   // nothing precedes the first action
    if (this.actionFetched) return null;          // the implicit xhr wait already covers this gap
    const list = this.state.steps;
    if (!list.length) return null;
    if (list[list.length - 1].type === 'wait') return null;   // never two in a row

    const min = Math.max(0, Number(config.recordIdleMinMs) || 0);
    const max = Math.max(min, Number(config.recordIdleMaxMs) || 0);
    const gap = now - this.lastActionAt;
    if (gap < min) return null;                   // ordinary human latency, not a wait
    // Rounded to 100 ms because the exact millisecond is noise — nobody meant to wait 3,247 ms —
    // and a round number is one a person can read, judge and edit.
    const ms = Math.min(max, Math.round(gap / 100) * 100);
    return { type: 'wait', ms, recordedIdle: true };
  }

  _onSignal(page, data) {
    if (!this.lastStepId) return;
    const signal = (data && (data.signal || data)) || {};
    const name = signal.name;
    if (!name) return;
    const last = this.state.steps.find((s) => s.id === this.lastStepId);
    if (!last) return;
    last.after = Array.from(new Set([...(last.after || []), name]));
    this._emit();
  }

  // ─────────────────────────────────────────── lifecycle

  _onBrowserGone() {
    if (this.state.status === 'recording' || this.state.status === 'starting') {
      this.browser = null;
      this.context = null;
      this._finish();
    }
  }

  _finish() {
    if (this.state.status === 'stopped') return;
    this.state.status = 'stopped';
    this.state.stoppedAt = new Date().toISOString();
    this._emit();
  }

  async _closeBrowser() {
    const b = this.browser;
    this.browser = null;
    this.context = null;
    this.captures = [];
    if (b) await b.close().catch(() => {});
  }
}

/**
 * The recorder bar, as source for `addInitScript` — so it lands in every page and every frame of
 * the recording browser, including ones the app opens later.
 *
 * Three things about it are load-bearing rather than stylistic:
 *
 *   • It renders ONLY in the top frame. Injected scripts run per frame; without the `window.top`
 *     test an app with four iframes would grow four toolbars.
 *   • It lives in a CLOSED shadow root. Closed rather than open for two reasons: the app's script
 *     cannot reach in, and — the reason that matters here — Playwright's selector generator cannot
 *     see past the host either, so the worst selector it could ever mint for a click on our bar
 *     still contains the host id, which is exactly what the drops in `_onAction` look for.
 *   • Every event that touches it is swallowed at `document` capture phase by a listener this
 *     script registers SYNCHRONOUSLY at document-start. Playwright's recorder and our identity
 *     capture both listen on `document` with `capture: true`, and both attach later — the recorder
 *     when `_enableRecorder` injects it, our capture on DOMContentLoaded. First listener registered
 *     wins, so `stopImmediatePropagation()` here means neither of them is ever told. That is why
 *     the bar's own buttons are driven from inside that same listener instead of from ordinary
 *     click handlers: an ordinary handler would be stopped along with everyone else's.
 *
 * Every button but one is a message to this process. The exception is Panel, which opens the
 * standalone inspector: only the page can open a window, and only inside the press that asked
 * for it. It needs `panel` — the service's own absolute url — because the recorded app is a
 * different origin and a relative '/recorder' would resolve against the app.
 */
function barSource(binding, hostId, highlightId, highlightOn, panel) {
  return `
;(() => {
  var HOST_ID = ${JSON.stringify(hostId)};
  var HL_ID = ${JSON.stringify(highlightId)};
  var HIGHLIGHT = ${highlightOn ? 'true' : 'false'};
  var BINDING = ${JSON.stringify(binding)};
  var PANEL_URL = ${JSON.stringify(panel || '')};
  if (window.__tfRecBarInstalled) return;
  window.__tfRecBarInstalled = true;

  var isTop = false;
  try { isTop = (window.top === window); } catch (e) { isTop = false; }

  var host = null, root = null, dom = null, last = null, drag = null;

  // ── the guard. Registered now, before anything else can claim document capture phase.
  //
  // "ours" is every chrome element this script owns — the bar and the highlight overlay. The
  // overlay is pointer-events:none so it can never BE a target, but it is checked anyway: one
  // list, one rule, nothing to forget when a third piece of chrome shows up.
  function ours(n) { return !!n && (n === host || n === hlHost); }

  function inBar(e) {
    if (!host && !hlHost) return false;
    try {
      var p = e.composedPath && e.composedPath();
      if (p && p.length) { for (var i = 0; i < p.length; i++) { if (ours(p[i])) return true; } return false; }
    } catch (err) { /* fall through to the parent walk */ }
    var n = e.target;
    while (n) { if (ours(n)) return true; n = n.parentNode; }
    return false;
  }

  // A press arrives as BOTH pointerdown and mousedown. Which one comes first — or whether the
  // pointer event comes at all — depends on how the press was made: a hand on a mouse raises both,
  // while a synthetic CDP press (what a test driving this bar sends) can raise only the mouse one.
  // So act on either, and let the second of a pair fall in the dedupe window.
  var lastDown = -1e9;
  function guard(e) {
    if (!inBar(e)) {
      // Not ours — leave the event completely alone and just draw over what it touched.
      if (HIGHLIGHT) onAppEvent(e);
      return;
    }
    try {
      if (e.type === 'pointerdown' || e.type === 'mousedown') {
        var t = typeof e.timeStamp === 'number' ? e.timeStamp : Date.now();
        if (t - lastDown > 80) { lastDown = t; onDown(e); }
      } else if (e.type === 'pointerup' || e.type === 'mouseup') {
        endDrag(e);
      }
    } catch (err) { /* never let our own bug reach the app */ }
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  }

  var SWALLOW = ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click',
    'auxclick', 'dblclick', 'contextmenu', 'input', 'change', 'keydown', 'keyup', 'keypress',
    'focusin', 'focusout', 'dragstart', 'wheel', 'touchstart', 'touchend', 'submit'];
  for (var i = 0; i < SWALLOW.length; i++) document.addEventListener(SWALLOW[i], guard, true);

  // ────────────────────────────────────────────────── highlight: "this is what I captured"
  //
  // Runs in EVERY frame, unlike the toolbar. A click inside an iframe has to be outlined inside
  // that iframe: the overlay is position:fixed against the frame's own viewport, so drawing it
  // locally lands on the element with no cross-frame coordinate arithmetic at all.
  //
  // Everything it needs is read synchronously, in the event, before the app can react — a click
  // that re-renders the page away is the normal case, not the edge case, and by the time a
  // timeout fired the node would be gone. Once the fade ends there is no work left running.

  var hlHost = null, hlRoot = null, hlBox = null, hlTag = null, hlTimer = null;
  var hlLastDown = -1e9, hlLastKeyEl = null;

  var FLASH = { pointerdown: 1, mousedown: 1, change: 1, keydown: 1 };

  function hlBuild() {
    if (hlHost || !document.body) return;
    hlHost = document.createElement('div');
    hlHost.id = HL_ID;
    hlHost.setAttribute('data-testid', HL_ID);
    hlHost.setAttribute('aria-hidden', 'true');
    // pointer-events:none on the HOST, so nothing inside can ever intercept a real click —
    // whatever the shadow tree does. left/top 0 with no size: it contributes no layout at all.
    hlHost.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;' +
      'pointer-events:none;z-index:2147483646;display:none;';
    hlRoot = hlHost.attachShadow({ mode: 'closed' });
    hlRoot.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.box,.tag{position:fixed;pointer-events:none;opacity:1;transition:opacity .40s ease .40s}' +
      // Exactly what was asked for: one red hairline, nothing else. An outline rather than a
      // border, because an outline is drawn outside the box and is not part of layout at all, so
      // even a badly positioned overlay could never push anything around.
      '.box{outline:1px solid red;background:none;border:0}' +
      '.tag{font:600 11px/1.4 "Segoe UI",system-ui,sans-serif;color:#fff;background:red;' +
        'padding:1px 6px;white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis}' +
      '.out{opacity:0}' +
      '</style><div class="box"></div><div class="tag"></div>';
    hlBox = hlRoot.querySelector('.box');
    hlTag = hlRoot.querySelector('.tag');
    document.body.appendChild(hlHost);
  }

  /**
   * Role and accessible name — the two things that decide what the LOCATOR will be, which is far
   * more useful than "you clicked here". Borrowed from the identity library already in this
   * world, so the tag says what the recorder is about to say. Both are cheap reads; the whole
   * fingerprint is not, and is deliberately not called here.
   */
  function hlDescribe(el) {
    var role = null, name = null;
    try {
      var lib = window.__opkeyRec;
      if (lib && lib._internals) {
        try { role = lib._internals.computeRole(el); } catch (e) { /* fall back below */ }
        try { name = lib._internals.accessibleName(el); } catch (e) { /* fall back below */ }
      }
    } catch (e) { /* the library is not there — our own guesses will do */ }
    try {
      if (!role) role = (el.getAttribute && el.getAttribute('role')) || String(el.tagName || '').toLowerCase();
      if (!name) {
        // el.value is the LAST resort, and never for a password box: it returns the plaintext,
        // and this label is painted on screen, directly above the field the user is typing in.
        var ty = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
        var ac = String((el.getAttribute && el.getAttribute('autocomplete')) || '').toLowerCase();
        var secret = ty === 'password' || ac === 'current-password' || ac === 'new-password' || ac === 'one-time-code';
        name = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title'))) ||
          (!secret && el.value != null && typeof el.value === 'string' ? el.value : '') ||
          (el.textContent || '');
      }
    } catch (e) { /* keep whatever we have */ }
    name = String(name || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    role = String(role || 'element');
    return name ? role + ' \\u201c' + name + '\\u201d' : role;
  }

  function hlFlash(el) {
    try {
      if (!el || el.nodeType !== 1) return;
      if (el === document.documentElement || el === document.body) return;
      // Read the geometry NOW. A click that navigates or re-renders takes the node with it, and
      // anything deferred would measure a corpse — or throw into the app, which is worse.
      var r = el.getBoundingClientRect();
      if (!r || (r.width < 1 && r.height < 1)) return;
      var label = hlDescribe(el);

      hlBuild();
      if (!hlBox) return;
      // A route change can take body's children with it. Put ourselves back rather than vanish.
      if (!hlHost.isConnected && document.body) document.body.appendChild(hlHost);

      // Exactly the element's box. The outline is drawn just outside it, which is where a
      // "this is the element" line belongs.
      hlBox.style.left = r.left + 'px';
      hlBox.style.top = r.top + 'px';
      hlBox.style.width = r.width + 'px';
      hlBox.style.height = r.height + 'px';

      hlTag.textContent = label;
      hlTag.style.display = label ? 'block' : 'none';
      // Above the box, unless it would sit off the top of the viewport.
      hlTag.style.left = Math.max(0, r.left) + 'px';
      hlTag.style.top = (r.top - 19 < 0 ? r.bottom + 2 : r.top - 19) + 'px';

      hlHost.style.display = 'block';
      hlBox.className = 'box';
      hlTag.className = 'tag';
      void hlBox.offsetWidth;              // restart the transition on a repeat flash
      hlBox.className = 'box out';
      hlTag.className = 'tag out';

      if (hlTimer) clearTimeout(hlTimer);
      // Off the screen and out of the way once faded. Nothing runs between flashes.
      hlTimer = setTimeout(hlHide, 900);
    } catch (err) { /* the element went away mid-flash — there is nothing to draw, and that is fine */ }
  }

  function hlHide() {
    try {
      if (hlTimer) { clearTimeout(hlTimer); hlTimer = null; }
      if (hlHost && hlHost.style.display !== 'none') hlHost.style.display = 'none';
    } catch (e) { /* nothing to hide */ }
  }

  function onAppEvent(e) {
    if (!FLASH[e.type]) return;
    try {
      var p = e.composedPath && e.composedPath();
      var el = (p && p.length ? p[0] : e.target);
      if (e.type === 'pointerdown' || e.type === 'mousedown') {
        // One press raises both; the second of the pair must not restart the fade.
        var t = typeof e.timeStamp === 'number' ? e.timeStamp : Date.now();
        if (t - hlLastDown <= 80) return;
        hlLastDown = t;
      } else if (e.type === 'keydown') {
        if (el === hlLastKeyEl) return;    // one flash per field, not one per keystroke
        hlLastKeyEl = el;
      }
      hlFlash(el);
    } catch (err) { /* never let the overlay reach the app */ }
  }

  if (HIGHLIGHT) {
    document.addEventListener('focusout', function () { hlLastKeyEl = null; }, true);
    // A box measured before a scroll is a box pointing at the wrong thing. Cheapest honest
    // answer: stop showing it. The early return keeps this ~free on a scrolling page.
    window.addEventListener('scroll', hlHide, true);
    window.addEventListener('resize', hlHide, true);
  }

  if (!isTop) return;   // frames get the guard and the highlight, but never a second toolbar

  // ── which control is under the pointer, through the closed root
  function hit(e) {
    try {
      var el = root.elementFromPoint(e.clientX, e.clientY);
      while (el && el !== root) {
        if (el.getAttribute && el.getAttribute('data-act')) return el.getAttribute('data-act');
        el = el.parentNode;
      }
    } catch (err) { /* no hit */ }
    return null;
  }

  function call(op) {
    try {
      var fn = window[BINDING];
      if (typeof fn !== 'function') return;
      var p = fn({ op: op });
      if (p && p.then) p.then(apply, function () {});
    } catch (err) { /* the binding is gone — the recording ended */ }
  }

  /**
   * Open the standalone panel.
   *
   * The one control that is handled HERE rather than sent to the service: opening a window is
   * something only the page can do, and it has to be done inside this press, synchronously, or
   * the browser treats it as an unrequested pop-up and refuses.
   *
   * Deliberately the same arithmetic as openRecorderPanel() in ui/app.js, so the panel lands in
   * the same place whichever door it was opened from.
   */
  var panelTimer = null;
  function openPanel() {
    var win = null;
    try {
      var availW = (window.screen && window.screen.availWidth) || 1280;
      var availH = (window.screen && window.screen.availHeight) || 900;
      var w = Math.min(460, Math.max(360, Math.round(availW * 0.3)));
      var h = Math.max(560, availH - 60);
      var left = Math.max(0, availW - w - 16);
      win = window.open(PANEL_URL, 'tf-recorder',
        'popup=yes,width=' + w + ',height=' + h + ',left=' + left + ',top=0');
      if (win) { try { win.focus(); } catch (err) { /* focus is a nicety */ } }
    } catch (err) { win = null; }
    // A blocked pop-up is silent in every browser, and a button that does nothing reads as a
    // broken recorder. Say so on the button itself — there is nowhere else on this surface.
    if (!win && dom && dom.panel) {
      dom.panel.textContent = 'Blocked';
      clearTimeout(panelTimer);
      panelTimer = setTimeout(function () { if (dom && dom.panel) dom.panel.textContent = 'Panel'; }, 2000);
    }
  }

  function onDown(e) {
    var act = hit(e);
    if (act === 'panel') { openPanel(); return; }
    if (act) { call(act); return; }
    var r = host.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', endDrag, true);
  }
  function onMove(e) {
    if (!drag) return;
    var l = Math.max(0, Math.min(window.innerWidth - 60, drag.left + (e.clientX - drag.x)));
    var t = Math.max(0, Math.min(window.innerHeight - 24, drag.top + (e.clientY - drag.y)));
    host.style.left = l + 'px'; host.style.top = t + 'px'; host.style.bottom = 'auto';
    e.stopImmediatePropagation();
  }
  function endDrag(e) {
    if (!drag) return;
    drag = null;
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', endDrag, true);
    if (e) e.stopImmediatePropagation();
  }

  // ── the bar itself
  // The panel's tokens, so the two surfaces read as one product: the same accent, the same
  // radii, the same mark. The hex before each oklch is a fallback, not a duplicate — an engine
  // that does not know oklch keeps the hex and still gets a purple button rather than none.
  var CSS = '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;margin:0;padding:0;font:500 12px/1.2 "Segoe UI",system-ui,sans-serif}' +
    '.bar{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:12px;' +
      'background:#12151b;color:#e8ecf3;border:1px solid #333c4a;' +
      'box-shadow:0 6px 22px rgba(0,0,0,.45);cursor:move;user-select:none;white-space:nowrap}' +
    // The product mark. First in the row, so the bar is recognisably part of the tool before
    // any of it is read.
    '.mark{width:18px;height:18px;border-radius:5px;flex:0 0 auto;display:flex;' +
      'align-items:center;justify-content:center;background:#7c3aed;' +
      'background:oklch(54.1% 0.281 293.009)}' +
    '.mark svg{width:12px;height:12px;display:block;fill:#fff}' +
    '.dot{width:9px;height:9px;border-radius:50%;background:#e5484d;flex:0 0 auto;' +
      'animation:tfp 1.4s ease-in-out infinite}' +
    '.bar.paused .dot{background:#f5a524;animation:none}' +
    '@keyframes tfp{0%,100%{opacity:1}50%{opacity:.25}}' +
    '.state{font-weight:600;letter-spacing:.2px}' +
    '.time{font-variant-numeric:tabular-nums;color:#9aa7bb}' +
    '.steps{color:#9aa7bb}' +
    '.sep{width:1px;height:14px;background:#333c4a}' +
    'button{cursor:pointer;border:1px solid #3d4757;background:#1d222b;color:#e8ecf3;' +
      'border-radius:7px;padding:4px 9px;font-weight:600}' +
    'button:hover{background:#28303c}' +
    // Panel is the primary action — it is the only way from here to the full inspector — so it
    // wears the accent. Stop keeps its red: the one control that must never be mistaken.
    'button.panel{border-color:#7c3aed;color:#c4b5fd;' +
      'border-color:oklch(54.1% 0.281 293.009);color:oklch(80% 0.12 293.009)}' +
    'button.panel:hover{background:#241a3d}' +
    'button.stop{border-color:#7a2f33;background:#2a1618;color:#ff9ea1}' +
    'button.stop:hover{background:#3a1c1f}' +
    '</style>';
  var HTML = '<div class="bar">' +
    '<span class="mark"><svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z"></path></svg></span>' +
    '<span class="dot"></span><span class="state">Recording</span>' +
    '<span class="time">0:00</span><span class="sep"></span><span class="steps">0 steps</span>' +
    '<span class="sep"></span>' +
    '<button class="panel" data-act="panel">Panel</button>' +
    '<button data-act="pause">Pause</button>' +
    '<button class="stop" data-act="stop">Stop</button>' +
    '</div>';

  function build() {
    if (host || !document.body) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-testid', HOST_ID);
    host.setAttribute('data-' + HOST_ID, '1');
    host.style.cssText = 'all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483647;display:block;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = CSS + HTML;
    dom = {
      bar: root.querySelector('.bar'),
      state: root.querySelector('.state'),
      time: root.querySelector('.time'),
      steps: root.querySelector('.steps'),
      pause: root.querySelector('[data-act="pause"]'),
      panel: root.querySelector('[data-act="panel"]'),
    };
    document.body.appendChild(host);
    paint();
  }

  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function paint() {
    if (!dom || !host) return;
    var s = last;
    var st = s && s.status;
    var live = st === 'recording' || st === 'starting' || st === 'stopping';
    host.style.display = live ? 'block' : 'none';
    if (!live) return;
    var paused = !!(s && s.paused);
    dom.bar.className = paused ? 'bar paused' : 'bar';
    dom.state.textContent = st === 'starting' ? 'Starting' : st === 'stopping' ? 'Stopping' : (paused ? 'Paused' : 'Recording');
    dom.time.textContent = fmt(s.elapsedMs || 0);
    dom.steps.textContent = (s.steps === 1 ? '1 step' : (s.steps || 0) + ' steps');
    dom.pause.textContent = paused ? 'Resume' : 'Pause';
    dom.pause.setAttribute('data-act', paused ? 'resume' : 'pause');
  }

  function apply(s) { if (s) { last = s; paint(); } }

  function tick() {
    build();
    // The app may wipe body on a route change; put ourselves back rather than vanish.
    if (host && !host.isConnected && document.body) document.body.appendChild(host);
    call('state');
  }
  tick();
  setInterval(tick, 500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick, { once: true });
})();
`;
}

/** Does this recorder action point at our own toolbar rather than at the app? */
function barAction(data, code) {
  const a = (data && data.action) || {};
  if (typeof a.selector === 'string' && a.selector.includes(BAR_HOST_ID)) return true;
  if (typeof code === 'string' && code.includes(BAR_HOST_ID)) return true;
  return false;
}

/** Same question for an identity capture. Cheap field checks, not a whole-object stringify. */
function barFingerprint(fp) {
  if (!fp) return false;
  const attrs = fp.attrs || {};
  for (const k of Object.keys(attrs)) {
    if (String(attrs[k]).includes(BAR_HOST_ID)) return true;
  }
  const ancestors = (fp.context && fp.context.ancestors) || [];
  for (const a of ancestors) {
    if (a && JSON.stringify(a).includes(BAR_HOST_ID)) return true;
  }
  return false;
}

/** Playwright's console types are a longer list than the panel's; fold the rest into 'log'. */
function consoleType(t) {
  const s = String(t || '').toLowerCase();
  if (s === 'warning') return 'warn';
  return ['log', 'info', 'warn', 'error', 'debug'].includes(s) ? s : 'log';
}

/**
 * A page URL for the Console tab: origin and path, nothing else.
 *
 * The query string of the page the user is ON is as likely to carry a session id or an OAuth
 * code as any other, and the tab only needs it to say WHERE the line came from.
 */
function originAndPath(u) {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return parsed.origin + parsed.pathname;
  } catch (e) {
    return String(u).split('?')[0].split('#')[0] || null;
  }
}

/**
 * A request URL safe to keep.
 *
 * The whole path and query are kept, because "which call, with which id" is the question the
 * Network tab answers — but the VALUE of any parameter whose name looks like a credential is
 * replaced. Nothing else about the request is stored anywhere: no headers (so no cookie, no
 * authorization), no request body, no response body. There is nowhere in this file that reads
 * them, and there must not be.
 */
function netUrl(u) {
  const raw = String(u || '');
  try {
    const parsed = new URL(raw);
    // A data: or blob: URL can be the whole payload inline; keep the scheme and nothing else.
    if (/^(data|blob):/i.test(parsed.protocol)) return parsed.protocol + '…';
    for (const name of Array.from(new Set(parsed.searchParams.keys()))) {
      if (SECRETY_PARAM.test(name)) parsed.searchParams.set(name, '***');
    }
    return parsed.origin + parsed.pathname + (parsed.search || '');
  } catch (e) {
    // Unparseable: drop the query wholesale rather than guess which half of it was a token.
    return raw.split('?')[0];
  }
}

/** `?since=` paging shared by the Console and Network endpoints. */
function sliceSince(buffer, since, limit) {
  const from = Number.isFinite(since) ? since : 0;
  const take = Math.min(1000, Math.max(1, Number.isFinite(limit) ? limit : 200));
  const items = buffer.filter((r) => r.id > from).slice(0, take);
  return { items, nextSince: items.length ? items[items.length - 1].id : from };
}

function safeUrl(page) {
  try { return page.url(); } catch { return ''; }
}

function safeFrameUrl(frame) {
  try { return frame.url(); } catch { return null; }
}

module.exports = { Recording, BINDING, BAR_BINDING, BAR_HOST_ID, HIGHLIGHT_HOST_ID, RECORD_HIGHLIGHT, barSource };
