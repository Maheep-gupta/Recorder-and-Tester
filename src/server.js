/**
 * Design Studio Tester — the local service. DEV ONLY, never committed, never deployed.
 *
 * Binds to 127.0.0.1 so nothing off this machine can drive the browser, serves the one page, and
 * exposes a small JSON API over it. It owns exactly one recording browser and one run at a time.
 *
 *   node src/server.js                   → http://127.0.0.1:4310
 *   node src/server.js     --port 4311
 *
 * Routes
 *   GET    /                        the page
 *   GET    /recorder                the narrow recorder panel, to sit beside the app being recorded
 *   GET    /api/config              apps + base URLs + where tests live
 *   GET    /api/events              server-sent events: recording state and run progress
 *   GET    /api/stats               how the whole shelf of tests stands
 *   GET    /api/recording           current recording state (the draft)
 *   POST   /api/recording/start     { app?, headed?, browser?, viewport? }
 *   POST   /api/recording/stop
 *   POST   /api/recording/pause     hold the recorder without ending the draft
 *   POST   /api/recording/resume    carry on
 *   POST   /api/recording/discard
 *   POST   /api/recording/step      { type, at?, stepId?, ms?, text?, value?, checked?, url? }
 *                                  add a step by hand: a wait, a waitForXhr or an assertion.
 *                                  `at` is the 0-based index to insert BEFORE; absent = append.
 *   POST   /api/recording/step/:id/move  { to } reorder one step of the live draft
 *   DELETE /api/recording/step/:id  drop one step from the live draft
 *   GET    /api/recording/step/:id/shot  the element's picture as a PNG — a viewport screenshot
 *                                  taken at the instant of the action, cropped to the element.
 *                                  404 when there is none; the step's `target.shot` says which.
 *   GET    /api/recording/console   ?since=&limit=  the recorded page's console output
 *   GET    /api/recording/network   ?since=&limit=  its xhr/fetch calls
 *                                  Both answer { items, nextSince }; poll with the nextSince you
 *                                  were last given. They are NOT in the snapshot on purpose —
 *                                  that goes over SSE on every keystroke.
 *   POST   /api/browser/open        { app? } a plain logged-in browser, recording nothing
 *   GET    /api/tests               list
 *   POST   /api/tests               save the draft: { name, description?, app?, steps, tags?, folder?, favorite? }
 *   POST   /api/tests/import        a whole test as JSON, from an export or by hand
 *   GET    /api/tests/:id           one test with per-step text and warnings
 *   GET    /api/tests/:id/export    the raw stored shape, as a download — feeds /api/tests/import
 *   PUT    /api/tests/:id           { name?, description?, steps?, settings?, tags?, folder?, favorite? }
 *   DELETE /api/tests/:id
 *   POST   /api/tests/:id/duplicate a copy, with no history
 *   POST   /api/tests/:id/run       { headed?, app? } → starts a run, replies with the run id
 *                                  `app` replays against a different environment than the recording
 *   GET    /api/runs                every test's runs, newest first: ?limit=50
 *   GET    /api/tests/:id/runs      run history
 *   GET    /api/tests/:id/runs/:run one run's result
 *   GET    /api/tests/:id/runs/:run/file/:name   screenshot / console log
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const config = require('./config');
const storage = require('./storage');
const steps = require('./steps');
const auth = require('./auth');
const execution = require('./execution');
const { Recording } = require('./recording');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argOf('port', config.port));
const UI_DIR = path.join(__dirname, '..', 'ui');
const PAGE = path.join(UI_DIR, 'index.html');
/** The narrow recorder panel — a second, standalone page, parked beside the app being recorded. */
const PANEL = path.join(UI_DIR, 'recorder.html');

const log = (line) => console.log(`[recorder] ${line}`);

// ────────────────────────────────────────────────────────────── live state

const recording = new Recording();
/** The run in flight, if any. One at a time: two browsers racing the same app is never what you want. */
let currentRun = null;
/** The "just open the app for me" browser. Records nothing, but it is still ours to close. */
let plainBrowser = null;

const clients = new Set();
function broadcast(type, data) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    // A dead SSE socket must not take the process with it. This runs inside `recording`'s
    // 'change' emit, which is itself inside a Playwright recorder callback: a throw here would
    // surface as an unhandled rejection, and the service would exit mid-recording.
    try { res.write(frame); } catch { clients.delete(res); }
  }
}
recording.on('change', (state) => broadcast('recording', state));

// ────────────────────────────────────────────────────────────── helpers

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function fail(res, e) {
  const status = e && e.status ? e.status : 500;
  if (status >= 500) log(`error: ${(e && e.stack) || e}`);
  // Some handlers answer and then keep working (`POST …/run` replies before the run starts). If
  // one of those throws afterwards there is nothing left to say — and saying it anyway threw
  // ERR_HTTP_HEADERS_SENT out of the request handler, which is an unhandled rejection and, on
  // this Node, the end of the service.
  if (res.headersSent) return log(`error after reply: ${(e && e.message) || e}`);
  try {
    send(res, status, { error: String((e && e.message) || e).split('\n')[0] });
  } catch (inner) {
    log(`error while replying: ${(inner && inner.message) || inner}`);
    try { res.destroy(); } catch { /* already gone */ }
  }
}

/** One whole-number query parameter, or the default. Junk is the default, not a 400. */
function intParam(url, name, dflt) {
  const raw = Number(url.searchParams.get(name));
  return Number.isFinite(raw) ? Math.trunc(raw) : dflt;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) throw storage.httpError(413, 'Body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw storage.httpError(400, 'Body is not valid JSON');
  }
}

/** Decorate a stored test for the page: plain-English text and fragility warnings per step. */
function decorate(test) {
  // steps.js owns what "decorated" means; fall back while that export is still landing.
  const one = (s) => (typeof steps.decorate === 'function'
    ? steps.decorate(s)
    : { ...s, text: steps.describe(s), warnings: steps.warningsFor(s) });
  return { ...test, steps: (test.steps || []).map(one) };
}

/** Who is at this machine. The page badges the name; the initials fit in a small circle. */
function whoAmI() {
  const name = process.env.USERNAME || process.env.USER || 'Local';
  const initials = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('');
  return { name, initials: initials || 'L' };
}

/** Close the plain browser if one is open. Safe to call when there is none. */
async function closePlainBrowser() {
  const browser = plainBrowser;
  plainBrowser = null;
  if (browser) await browser.close().catch(() => { /* closing anyway */ });
}

const MIME = { '.png': 'image/png', '.log': 'text/plain; charset=utf-8', '.json': 'application/json', '.zip': 'application/zip' };

// ────────────────────────────────────────────────────────────── routes

const routes = [
  ['GET', /^\/$/, async (req, res) => {
    if (!fs.existsSync(PAGE)) return send(res, 500, 'ui/index.html is missing');
    // Re-read per request, so editing the page only needs a browser reload.
    send(res, 200, fs.readFileSync(PAGE), { 'Content-Type': 'text/html; charset=utf-8' });
  }],

  /**
   * The recorder panel: the same page in miniature it is NOT — it is its own small UI, narrow
   * enough to sit beside the Chromium window you are recording, so you can watch the capture
   * without alt-tabbing away from the thing you are capturing. Opened in its own window from the
   * main page. Same re-read-per-request rule.
   */
  ['GET', /^\/recorder$/, async (req, res) => {
    if (!fs.existsSync(PANEL)) return send(res, 500, 'ui/recorder.html is missing');
    send(res, 200, fs.readFileSync(PANEL), { 'Content-Type': 'text/html; charset=utf-8' });
  }],

  /**
   * Each page's stylesheet and script, kept as separate files rather than inlined so they can be
   * edited independently. Same re-read-per-request rule: a browser reload is all an edit needs.
   * The name is whitelisted, so this cannot be walked out of the `ui/` folder. The groups are
   * non-capturing on purpose — group 1 must stay the WHOLE filename.
   */
  ['GET', /^\/ui\/((?:app|recorder)\.(?:css|js))$/, async (req, res, [name]) => {
    const file = path.join(UI_DIR, name);
    if (!fs.existsSync(file)) return send(res, 404, { error: `ui/${name} is missing` });
    const type = name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    send(res, 200, fs.readFileSync(file), { 'Content-Type': type });
  }],

  ['GET', /^\/api\/config$/, async (req, res) => send(res, 200, {
    apps: Object.fromEntries(Object.entries(config.apps).map(([k, v]) => [k, {
      label: v.label, baseUrl: v.baseUrl, auth: v.auth, remote: !!v.remote,
      // per app, because each one now keeps its own session file
      hasSavedLogin: v.auth ? auth.hasSavedState(k) : null,
    }])),
    defaultApp: config.defaultApp,
    testsDir: storage.TESTS,
    headedRun: config.headedRun,
    hasSavedLogin: auth.hasSavedState(),
    stepTimeoutMs: config.stepTimeoutMs,
    testIdAttribute: config.testIdAttribute,
    // Which engines can actually launch on THIS machine. Each is a separate Playwright download
    // and the version must match the installed playwright package, so offering a Browser choice
    // that can only 400 is worse than saying up front that it needs installing. Cheap: an
    // executable-path lookup, no launch.
    browsers: recording.availableEngines(),
    user: whoAmI(),
  })],

  ['GET', /^\/api\/stats$/, async (req, res) => send(res, 200, { ...storage.stats(), running: currentRun ? 1 : 0 })],

  ['GET', /^\/api\/runs$/, async (req, res, params, url) => {
    const asked = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(200, Math.max(1, Math.trunc(asked))) : 50;
    send(res, 200, storage.allRuns(limit));
  }],

  ['GET', /^\/api\/events$/, async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    res.write(`event: recording\ndata: ${JSON.stringify(recording.snapshot())}\n\n`);
    if (currentRun) res.write(`event: run\ndata: ${JSON.stringify(currentRun.progress)}\n\n`);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(keepAlive); clients.delete(res); });
  }],

  ['GET', /^\/api\/recording$/, async (req, res) => send(res, 200, recording.snapshot())],

  ['POST', /^\/api\/recording\/start$/, async (req, res) => {
    const body = await readBody(req);
    if (currentRun) throw storage.httpError(409, 'A test is running — wait for it to finish');
    const state = await recording.start({
      app: body.app || config.defaultApp,
      headed: body.headed !== false,
      // The Setup form's Browser and Viewport choices. Validated in recording.start(), which
      // answers 400 for an engine that is not installed rather than throwing Playwright's own
      // message at the page.
      browser: body.browser || 'chromium',
      viewport: body.viewport || null,
      log,
    });
    send(res, 200, state);
  }],

  ['POST', /^\/api\/recording\/stop$/, async (req, res) => send(res, 200, await recording.stop())],

  // Pause and resume belong to recording.js. Until it has them, say so plainly instead of pretending.
  ['POST', /^\/api\/recording\/pause$/, async (req, res) => {
    if (typeof recording.pause !== 'function') throw storage.httpError(501, 'Pause is not available in this version');
    await recording.pause();
    send(res, 200, recording.snapshot());
  }],

  ['POST', /^\/api\/recording\/resume$/, async (req, res) => {
    if (typeof recording.resume !== 'function') throw storage.httpError(501, 'Resume is not available in this version');
    await recording.resume();
    send(res, 200, recording.snapshot());
  }],

  ['POST', /^\/api\/recording\/discard$/, async (req, res) => { recording.discard(); send(res, 200, recording.snapshot()); }],

  /**
   * The recorded page's console output, and its data calls.
   *
   * Two endpoints rather than two more fields on the snapshot, because the snapshot is pushed
   * over SSE on every action — every keystroke of a fill is one — and a chatty app would then
   * put five hundred console lines on the wire per keystroke. The snapshot carries the counts;
   * the panel asks here for the rows, with the `nextSince` it was last given, and gets only what
   * it has not seen.
   *
   * Answered whatever the recording's state is: reading the console of a draft you have just
   * stopped is exactly when you want it.
   */
  ['GET', /^\/api\/recording\/console$/, async (req, res, params, url) =>
    send(res, 200, recording.consoleSince(intParam(url, 'since', 0), intParam(url, 'limit', 200)))],

  ['GET', /^\/api\/recording\/network$/, async (req, res, params, url) =>
    send(res, 200, recording.networkSince(intParam(url, 'since', 0), intParam(url, 'limit', 200)))],

  /**
   * One step's element picture — the same reasoning as the two endpoints above, for the same
   * reason: the bytes must not ride the snapshot. The step carries `target.shot`, a handful of
   * numbers; the PNG itself is fetched here, once, by the panel that decided to show it.
   *
   * 404 is the normal answer for a great many steps and is not an error: a `wait` has no
   * element, a password field is deliberately never photographed, an element scrolled out of
   * the window is skipped, and a discarded draft takes its pictures with it. The page already
   * says "the screenshot could not be loaded" for a 404, which is true — a placeholder image
   * would not be.
   */
  ['GET', /^\/api\/recording\/step\/([\w-]+)\/shot$/, async (req, res, [stepId]) => {
    const png = typeof recording.shotFor === 'function' ? recording.shotFor(stepId) : null;
    if (!png) throw storage.httpError(404, `No screenshot for step "${stepId}"`);
    send(res, 200, png, { 'Content-Type': 'image/png' });
  }],

  /**
   * Add a step to the LIVE draft by hand — the panel's "+ Add Step" and "Add Assertion".
   *
   * Same ownership rule as the delete below: the draft lives in `recording`, so this is where a
   * hand-written step has to be born, and the whole updated snapshot comes back in the reply so
   * the panel repaints now rather than waiting for the SSE frame it will also get.
   *
   * What may be added, and why an assertion must name a step to attach to, is `insertStep`'s
   * business — including the 400s. This route only carries the body to it.
   */
  ['POST', /^\/api\/recording\/step$/, async (req, res) => {
    if (typeof recording.insertStep !== 'function') throw storage.httpError(501, 'Adding a step is not available in this version');
    const body = await readBody(req);
    recording.insertStep(body || {});
    send(res, 200, recording.snapshot());
  }],

  /** Reorder one step of the live draft. `to` is the 0-based index it should end up at. */
  ['POST', /^\/api\/recording\/step\/([\w-]+)\/move$/, async (req, res, [stepId]) => {
    if (typeof recording.moveStep !== 'function') throw storage.httpError(501, 'Moving a step is not available in this version');
    const body = await readBody(req);
    if (recording.state.status === 'idle') throw storage.httpError(409, 'There is no recording draft to reorder');
    const to = Number(body && body.to);
    if (!Number.isInteger(to) || to < 0) throw storage.httpError(400, '"to" must be a 0-based position in the step list');
    if (!recording.moveStep(stepId, to)) throw storage.httpError(404, `No step "${stepId}" in the draft`);
    send(res, 200, recording.snapshot());
  }],

  /**
   * Delete one step from the LIVE draft.
   *
   * Deleting in the page alone could never stick: the panel holds a copy, and the next action
   * emits a fresh snapshot over SSE that puts the step straight back. The draft has one owner —
   * `recording` — so the delete has to happen there, and the updated snapshot comes back in this
   * reply rather than making the page wait for the next event.
   *
   * Allowed on a stopped-but-unsaved draft too: reviewing before you save is exactly when you
   * spot the stray click. 409 only when there is no draft at all.
   */
  ['DELETE', /^\/api\/recording\/step\/([\w-]+)$/, async (req, res, [stepId]) => {
    if (typeof recording.removeStep !== 'function') throw storage.httpError(501, 'Deleting a step is not available in this version');
    // 409 only when there is genuinely nothing to delete FROM. An emptied-but-live draft still
    // answers 404 for an unknown id, which is the honest answer and the one the page can act on.
    if (recording.state.status === 'idle') {
      throw storage.httpError(409, 'There is no recording draft to delete from');
    }
    if (!recording.removeStep(stepId)) throw storage.httpError(404, `No step "${stepId}" in the draft`);
    send(res, 200, recording.snapshot());
  }],

  // Just open the app, logged in, and get out of the way — no recorder, no steps, nothing saved.
  // Harmless next to a recording or a run, so it is not gated on either; the page waits for no
  // navigation, only for the window to exist.
  ['POST', /^\/api\/browser\/open$/, async (req, res) => {
    const body = await readBody(req);
    const app = body.app || config.defaultApp;
    const def = config.apps[app];
    if (!def) throw storage.httpError(400, `Unknown app "${app}"`);
    await closePlainBrowser();          // one at a time, or the desktop fills up with windows
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
    plainBrowser = browser;
    browser.on('disconnected', () => { if (plainBrowser === browser) plainBrowser = null; });
    const context = await browser.newContext({ ...auth.storageStateOption(app), viewport: null });
    const page = await context.newPage();
    page.goto(def.baseUrl, { timeout: config.navigationTimeoutMs })
      .catch((e) => log(`browser: ${String((e && e.message) || e).split('\n')[0]}`));
    log(`opened a plain browser on ${def.baseUrl}`);
    send(res, 200, { opened: true, app, baseUrl: def.baseUrl });
  }],

  ['GET', /^\/api\/tests$/, async (req, res) => send(res, 200, { tests: storage.list() })],

  ['POST', /^\/api\/tests$/, async (req, res) => {
    const body = await readBody(req);
    const test = storage.create({
      name: body.name,
      description: body.description,
      target: { app: body.app || (recording.state.app || config.defaultApp) },
      settings: body.settings,
      tags: body.tags,
      folder: body.folder,
      favorite: body.favorite,
      // NOT `(body.steps || []).map(...)`: a caller who sends `steps` as an object or a string
      // deserves storage's "steps must be a list" 400, not a TypeError dressed up as a 500.
      steps: Array.isArray(body.steps) ? body.steps.map(stripUi) : body.steps,
    });
    log(`saved test "${test.name}" (${test.steps.length} steps) → ${test.id}.json`);
    // Clearing the draft is the tidy-up, not the job. `discard()` throws 409 while a recording is
    // still open, and letting that escape reported the save as a FAILURE to a caller whose test
    // was already on disk — the worst of both answers.
    if (!recording.active) recording.discard();
    send(res, 200, decorate(test));
  }],

  // A whole test as JSON. Its id, dates and history are ignored — this machine mints its own.
  ['POST', /^\/api\/tests\/import$/, async (req, res) => {
    const body = await readBody(req);
    const test = storage.importTest({ ...body, steps: Array.isArray(body.steps) ? body.steps.map(stripUi) : body.steps });
    log(`imported test "${test.name}" (${test.steps.length} steps) → ${test.id}.json`);
    send(res, 200, decorate(test));
  }],

  /**
   * The deleted-tests shelf. `storage.remove` has always moved a test to `.trash` rather than
   * unlinking it, and `listTrash`/`restoreFromTrash` have always existed — but with no route on
   * top of them the safety net was unreachable, and recovering a recording meant a shell and a
   * copy command. That is the whole point of `.trash`, so here it is over HTTP.
   */
  ['GET', /^\/api\/trash$/, async (req, res) => send(res, 200, { trash: storage.listTrash() })],

  ['POST', /^\/api\/trash\/restore$/, async (req, res) => {
    const body = await readBody(req);
    const file = String(body.file || '');
    // `file` comes back from the listing above, but it arrives over HTTP, so it is checked here
    // as if it did not. Nothing that could name a path may through: no separator, no `..`, and a
    // plain `<name>.json` shape. (storage checks again — this is the outer of two doors.)
    if (!file || /[\\/]/.test(file) || file.includes('..') || !/^[\w.-]+\.json$/.test(file)) {
      throw storage.httpError(400, 'Bad file name');
    }
    const test = storage.restoreFromTrash(file);
    log(`restored "${test.name}" from the trash → ${test.id}.json`);
    send(res, 200, decorate(test));
  }],

  /**
   * A test as a file. Deliberately the RAW stored shape, not the decorated one, because that is
   * exactly what `POST /api/tests/import` accepts — export here, import on another machine.
   * Must sit before `GET /api/tests/:id`: `export` is not a test id.
   */
  ['GET', /^\/api\/tests\/([a-z0-9-]+)\/export$/, async (req, res, [id]) => send(res, 200, storage.load(id), {
    'Content-Disposition': `attachment; filename="${id}.json"`,
  })],

  ['GET', /^\/api\/tests\/([a-z0-9-]+)$/, async (req, res, [id]) => send(res, 200, decorate(storage.load(id)))],

  ['PUT', /^\/api\/tests\/([a-z0-9-]+)$/, async (req, res, [id]) => {
    const body = await readBody(req);
    const patch = { ...body };
    if (patch.steps) patch.steps = patch.steps.map(stripUi);
    send(res, 200, decorate(storage.update(id, patch)));
  }],

  ['DELETE', /^\/api\/tests\/([a-z0-9-]+)$/, async (req, res, [id]) => {
    if (currentRun && currentRun.testId === id) throw storage.httpError(409, 'That test is running');
    storage.remove(id);
    log(`deleted test ${id}`);
    send(res, 200, { ok: true });
  }],

  ['POST', /^\/api\/tests\/([a-z0-9-]+)\/duplicate$/, async (req, res, [id]) => {
    const copy = storage.duplicate(id);
    log(`duplicated ${id} → ${copy.id}.json`);
    send(res, 200, decorate(copy));
  }],

  ['POST', /^\/api\/tests\/([a-z0-9-]+)\/run$/, async (req, res, [id]) => {
    const body = await readBody(req);
    if (currentRun) throw storage.httpError(409, `Already running "${currentRun.testId}"`);
    if (recording.active) throw storage.httpError(409, 'Stop the recording first');
    const test = storage.load(id);
    const headed = body.headed !== undefined ? !!body.headed : config.headedRun;
    // Replay somewhere other than where it was recorded - the point of recording on QA and
    // running the same steps against the code on this machine. Steps store {{baseUrl}}, so the
    // substitution is honest; what it cannot promise is that both environments hold the same data.
    const app = body.app || (test.target && test.target.app) || config.defaultApp;
    if (!config.apps[app]) throw storage.httpError(400, `Unknown app "${app}"`);

    currentRun = { testId: id, progress: { testId: id, app, status: 'starting', total: test.steps.length, steps: [] } };
    broadcast('run', currentRun.progress);
    send(res, 200, { started: true, testId: id, app, stepCount: test.steps.length });

    // Started inside a promise so a synchronous throw out of `runTest` still lands in the
    // `.catch` below. Escaping here would leave `currentRun` set forever and 409 every later run.
    Promise.resolve().then(() => execution.runTest(test, {
      app,
      headed,
      log,
      onProgress: (p) => { if (currentRun) currentRun.progress = p; broadcast('run', p); },
    }))
      .then((result) => broadcast('run', { ...result, done: true }))
      .catch((e) => {
        log(`run failed to start: ${(e && e.message) || e}`);
        broadcast('run', { testId: id, status: 'blocked', error: String((e && e.message) || e).split('\n')[0], done: true, steps: [], total: test.steps.length });
      })
      .finally(() => { currentRun = null; });
  }],

  ['GET', /^\/api\/tests\/([a-z0-9-]+)\/runs$/, async (req, res, [id]) => send(res, 200, { runs: storage.listRuns(id) })],

  ['GET', /^\/api\/tests\/([a-z0-9-]+)\/runs\/([\w-]+)$/, async (req, res, [id, runId]) => send(res, 200, storage.loadRun(id, runId))],

  ['GET', /^\/api\/tests\/([a-z0-9-]+)\/runs\/([\w-]+)\/file\/([\w.-]+)$/, async (req, res, [id, runId, name]) => {
    const file = storage.runFile(id, runId, name);
    send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  }],
];

/** Drop the display-only fields the page adds so they never reach a saved file. */
function stripUi(step) {
  // steps.js keeps the list of derived fields; this is only the fallback while that export lands.
  const out = typeof steps.stripDerived === 'function'
    ? steps.stripDerived(step || {})
    : (({ text, warnings, ...rest }) => rest)(step || {});
  // `target.shot` is a marker for bytes that only ever lived in this process, next to the draft
  // they came from. Written to a file it would be a promise nothing can keep — worse, step ids
  // restart at s1 per draft, so a saved test's s3 could be answered with a LATER recording's
  // picture of something else entirely. Cloned, not deleted in place: stripDerived's spread is
  // shallow, so `target` is still the live draft's own object.
  if (out.target && out.target.shot !== undefined) {
    const { shot, ...target } = out.target;
    out.target = target;
  }
  return out;
}

// ────────────────────────────────────────────────────────────── server

const server = http.createServer((req, res) => {
  // The dispatch is async; `createServer` does not await it, so a rejection here would be an
  // unhandled one. Catch it at the boundary rather than relying on the process not minding.
  dispatch(req, res).catch((e) => fail(res, e));
});

async function dispatch(req, res) {
  // Refuse DNS rebinding. Binding to 127.0.0.1 stops anything OFF this machine connecting, but
  // it does not stop a page on evil.com whose name re-resolves to 127.0.0.1: to the browser that
  // is same-origin, so a GET carries no Origin header and sails past the check below. It could
  // then read /api/tests — every recorded step, including anything typed into a credential field.
  // The one thing the attacker cannot forge is Host, because the browser sets it from the name
  // it dialled. Our own page is served same-origin, so it always sends one of these.
  const host = String(req.headers.host || '');
  const okHost = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
  if (!okHost.has(host)) return send(res, 403, { error: 'Bad Host header' });

  // Refuse cross-site drive-by requests: a page on another origin must not be able to start a
  // browser here. Same-origin fetches from our own page send no Origin, or send ours.
  const origin = req.headers.origin;
  if (origin && !new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]).has(origin)) {
    return send(res, 403, { error: 'Cross-origin requests are not allowed' });
  }
  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  } catch {
    return send(res, 400, { error: 'Bad URL' });
  }
  // Several routes share one path with different methods (GET/POST /api/tests, GET/PUT/DELETE
  // /api/tests/:id). A method mismatch must keep looking, not answer 405 on the first path hit —
  // that bug made "Save test", "Save changes" and "Delete" all fail with "Use GET".
  const allowed = [];
  for (const [method, pattern, handler] of routes) {
    const m = url.pathname.match(pattern);
    if (!m) continue;
    if (req.method !== method) { allowed.push(method); continue; }
    try {
      return await handler(req, res, m.slice(1).map(decodeURIComponent), url);
    } catch (e) {
      return fail(res, e);
    }
  }
  if (allowed.length) return send(res, 405, { error: `Use ${allowed.join(' or ')}` });
  send(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
}

server.listen(PORT, config.host, () => {
  storage.ensureDirs();
  log(`listening on http://${config.host}:${PORT}  (local only)`);
  log(`tests: ${storage.TESTS}`);
  for (const [key, def] of Object.entries(config.apps)) log(`app ${key}: ${def.baseUrl}${def.auth ? ' (login required)' : ''}`);
  if (!auth.hasSavedState()) log('NOTE: no saved login yet — the first recording will log in with credentials.local.env');
});

// Never leave a browser behind.
let shuttingDown = false;
async function shutdown(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${why})`);
  // `stop()` now answers before the browser is gone, so the teardown it kicked off has to be
  // awaited here — `process.exit` would otherwise orphan a Chromium.
  try { await recording.stop(); await recording.teardown; } catch { /* closing anyway */ }
  try { await closePlainBrowser(); } catch { /* closing anyway */ }
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { log(`uncaught: ${e && e.stack}`); shutdown('uncaught exception'); });
// A rejected promise nobody handled is a bug to see in the log, not a reason to drop the browser
// and lose the recording in it. Node's default for this is to terminate; that default is wrong here.
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${(e && e.stack) || e}`));
