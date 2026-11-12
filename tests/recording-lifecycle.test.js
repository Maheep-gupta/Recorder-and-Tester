/**
 * Recorder lifecycle with a REAL Recording instance and a REAL headless Chromium.
 *
 *   node tests/recording-lifecycle.test.js
 *
 * Label, used throughout: "machine-driven real recording". The real Recording class launches a
 * real browser and attaches Playwright's real recorder; the "user" is this test, driving the
 * recording's own page with Playwright's input APIs (which the recorder captures - proved in
 * tests/compat.test.js). A recording driven by a HUMAN with a mouse in a headed window against a
 * real app is BLOCKED here (needs a person); see the manual checklist in docs.
 *
 * Isolation: temp dirs via env vars set before any src module loads, a fixture on 127.0.0.1 on a
 * random port, nothing else touched. Every browser the Recording launches is tracked (by wrapping
 * chromium.launch) so process and temp-profile leaks can be asserted.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reclife-tests-'));
process.env.RECORDER_TESTS_DIR = path.join(TMP, 'tests');
process.env.RECORDER_LOGINS_FILE = path.join(TMP, 'logins.json');
process.env.RECORDER_ENVIRONMENTS_FILE = path.join(TMP, 'environments.json');

const { chromium } = require('playwright');
const { test, assert, run } = require('./harness');
const { Recording } = require('../src/recording');
const storage = require('../src/storage');
const steps = require('../src/steps');
const config = require('../src/config');

const SECRET = 'S3cr3t-Pa55w0rd-ZQ7';
const PAGE_ONE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lifecycle One</title></head><body>
<h1>Sign up</h1>
<button id="go" type="button">Save changes</button>
<label for="nm">Full name</label><input id="nm" type="text">
<label for="pw">Account password</label><input id="pw" type="password" autocomplete="current-password">
<label for="col">Colour</label><select id="col"><option value="r">Red</option><option value="g">Green</option></select>
<label><input type="checkbox" id="agree"> Agree to terms</label>
<a href="/two">Next page</a></body></html>`;
const PAGE_TWO = '<!doctype html><html><head><title>Lifecycle Two</title></head><body><h1>Second page</h1></body></html>';

function fixture() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(req.url.startsWith('/two') ? PAGE_TWO : PAGE_ONE);
    }).listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

// ─────────────────────────────────────────────────────────────── process / profile tracking

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Command line of a process, or null (best effort; used to find the temp profile dir). */
function cmdlineOf(pid) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`], { encoding: 'utf8', timeout: 20000 });
      return r.status === 0 ? r.stdout : null;
    }
    const r = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout : null;
  } catch (e) { return null; }
}

/** Every pid Chromium reports for this browser (browser, GPU, renderers, utilities). */
async function pidsOf(browser) {
  const s = await browser.newBrowserCDPSession();
  try {
    const r = await s.send('SystemInfo.getProcessInfo');
    return r.processInfo.map((p) => p.id);
  } finally { await s.detach().catch(() => {}); }
}

/** Every browser the Recording launches, with the pids and profile dir seen at launch. */
const launches = [];
let trackProfile = false;
const origLaunch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await origLaunch(...args);
  const rec = { browser, pids: [], mainPid: null, userDataDir: null, headless: !!(args[0] && args[0].headless) };
  launches.push(rec);
  try {
    rec.pids = await pidsOf(browser);
    rec.mainPid = rec.pids[0] || null;
    if (trackProfile && rec.mainPid) {
      const cl = cmdlineOf(rec.mainPid) || '';
      const m = /--user-data-dir=("([^"]+)"|(\S+))/.exec(cl);
      rec.userDataDir = m ? (m[2] || m[3]) : null;
    }
  } catch (e) { /* closed before we could look: isConnected() still proves it is gone */ }
  return browser;
};

/** Everything seen for a launch, refreshed from the live browser (renderers come and go). */
async function refreshPids(l) {
  try { if (l.browser.isConnected()) l.pids = Array.from(new Set([...l.pids, ...(await pidsOf(l.browser))])); } catch (e) { /* ignore */ }
}

/** Assert that nothing of this launch is still running. */
async function assertGone(l, label) {
  await until(() => !l.browser.isConnected(), 10000, `${label}: browser disconnect`);
  const pids = l.pids.filter(Boolean);
  await until(() => pids.every((p) => !alive(p)), 15000, `${label}: chromium pids ${pids.join(',')} to exit`)
    .catch(() => { throw new Error(`${label}: chromium process(es) still alive: ${pids.filter(alive).join(',')}`); });
  if (l.userDataDir) {
    await until(() => !fs.existsSync(l.userDataDir), 10000, `${label}: temp profile ${l.userDataDir} to be removed`)
      .catch(() => { throw new Error(`${label}: temp profile dir leaked: ${l.userDataDir}`); });
  }
}

async function startRec(url, extra = {}) {
  const rec = new Recording();
  await rec.start({ app: `url:${url}`, headed: false, ...extra });
  return rec;
}

const typesOf = (rec) => rec.state.steps.map((s) => s.type);
const draftFile = () => path.join(config.testsDir, '.draft.json');

let fx;

// ─────────────────────────────────────────────────────────────── tests

test('[machine-driven real recording] start(headed:false) is honoured: headless browser, status recording', async () => {
  fx = await fixture();
  trackProfile = true;
  const rec = await startRec(fx.url);
  try {
    assert.equal(rec.state.status, 'recording');
    assert.equal(rec.state.headed, false, 'state.headed');
    const l = launches[launches.length - 1];
    assert.equal(l.headless, true, 'engine.launch got headless:true');
    const ua = await rec.activePage.evaluate(() => navigator.userAgent);
    assert.match(ua, /HeadlessChrome/, 'the real browser is headless');
    assert.equal(rec.state.captureReady, true, 'identity capture attached');
    assert.equal(rec.state.page.url, fx.url + '/');
    assert.ok(l.mainPid, 'could read the browser pid');
    assert.equal(typesOf(rec)[0], 'navigate', 'first step is the navigation to the app');
  } finally { await rec.stop(); await rec.teardown; }
  trackProfile = false;
});

test('[machine-driven real recording] click / fill / select / check / navigation become steps, with identity attached', async () => {
  const rec = await startRec(fx.url);
  try {
    const p = rec.activePage;
    await p.click('#go');
    await p.fill('#nm', 'Ada Lovelace');
    await p.selectOption('#col', 'g');
    await p.check('#agree');
    await p.click('a');
    await until(() => ['click', 'fill', 'select', 'check'].every((t) => typesOf(rec).includes(t)), 10000, 'steps to appear');
    await until(() => rec.state.steps.filter((s) => steps.needsTarget(s.type)).every((s) => s.identityStatus !== 'resolving'), 10000, 'identity to settle');
    const list = rec.state.steps;
    assert.equal(list[0].type, 'navigate');
    const fill = list.find((s) => s.type === 'fill');
    assert.equal(fill.value, 'Ada Lovelace', 'non-secret fill keeps its value');
    assert.ok(!fill.secret, 'a name is not a secret');
    assert.equal(list.find((s) => s.type === 'select').values, ['g']);
    const clicks = list.filter((s) => s.type === 'click');
    assert.ok(clicks.length >= 2, 'both clicks recorded');
    assert.every(list.filter((s) => steps.needsTarget(s.type)), (s) => s.identityStatus === 'ok' || s.identityStatus === 'none',
      'identity resolved or honestly reported as none');
    assert.ok(list.find((s) => s.type === 'click').target, 'click has an identity target');
    await until(() => rec.state.page && /\/two$/.test(rec.state.page.url), 8000, 'page state to follow the navigation');
    assert.equal(rec.state.page.title, 'Lifecycle Two');
    const snap = rec.snapshot();
    assert.ok(snap.steps.every((s) => typeof s.description === 'string' || s.description === undefined), 'snapshot decorates steps');
  } finally { await rec.stop(); await rec.teardown; }
});

test('[machine-driven real recording] a password value never appears in state, snapshot, console/network buffers, draft file or saved test', async () => {
  const rec = await startRec(fx.url);
  let l;
  try {
    l = launches[launches.length - 1];
    const p = rec.activePage;
    await p.fill('#pw', SECRET);
    await p.fill('#nm', 'visible');
    await p.press('#pw', 'Enter');
    await until(() => rec.state.steps.some((s) => s.type === 'fill' && s.secret), 10000, 'secret fill step');
    await until(() => rec.state.steps.filter((s) => steps.needsTarget(s.type)).every((s) => s.identityStatus !== 'resolving'), 10000, 'identity to settle');
    const pwStep = rec.state.steps.find((s) => s.type === 'fill' && s.secret);
    assert.equal(pwStep.value, '', 'secret step value is empty');
    assert.notOk(pwStep.target && pwStep.target.shot, 'no screenshot kept of a credential field');
    assert.equal(rec.shots.size === 0 || ![...rec.shots.keys()].includes(pwStep.id), true, 'no shot bytes held for the secret step');

    const live = JSON.stringify({ state: rec.state, snap: rec.snapshot(), con: rec.consoleLines, net: rec.networkCalls });
    assert.excludes(live, SECRET, 'password present in live recording state');

    await rec.stop(); await rec.teardown;
    await until(() => fs.existsSync(draftFile()) && fs.readFileSync(draftFile(), 'utf8').includes('"steps"'), 8000, 'draft file');
    await rec._draftChain;
    const draft = fs.readFileSync(draftFile(), 'utf8');
    assert.excludes(draft, SECRET, 'password present in .draft.json');
    assert.excludes(JSON.stringify(rec.snapshot()), SECRET, 'password present after stop');

    // And once saved.
    const saved = storage.create({ name: 'secret check', target: { app: rec.state.app }, steps: rec.state.steps.map((s) => steps.stripDerived(s)) });
    const onDisk = fs.readFileSync(path.join(config.testsDir, `${saved.id}.json`), 'utf8');
    assert.excludes(onDisk, SECRET, 'password present in the saved test file');
    // Whole-tmp scan: nothing this suite wrote anywhere under its own temp root has it.
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(TMP)) assert.excludes(fs.readFileSync(f, 'utf8'), SECRET, `password found in ${path.relative(TMP, f)}`);
  } finally { if (rec.active) { await rec.stop(); await rec.teardown; } }
  await assertGone(l, 'secret test');
});

test('[machine-driven real recording] pause stops capture and resume restarts it', async () => {
  const rec = await startRec(fx.url);
  try {
    const p = rec.activePage;
    await p.click('#go');
    await until(() => typesOf(rec).includes('click'), 8000, 'first click');
    const before = rec.state.steps.length;

    rec.pause();
    assert.equal(rec.state.paused, true);
    await p.click('#go'); await p.fill('#nm', 'while paused');
    await sleep(900);
    assert.equal(rec.state.steps.length, before, 'no steps while paused');

    rec.resume();
    assert.equal(rec.state.paused, false);
    await p.fill('#nm', 'after resume');
    await until(() => rec.state.steps.some((s) => s.type === 'fill'), 8000, 'step after resume');
    const f = rec.state.steps.filter((s) => s.type === 'fill').pop();
    assert.ok(rec.state.steps.length > before, 'capture restarted');
    assert.notEqual(f.value, 'while paused');
  } finally { await rec.stop(); await rec.teardown; }
});

test('[machine-driven real recording] stop: status stopped, steps intact, process gone; save, then discard clears the draft file', async () => {
  const rec = await startRec(fx.url);
  const l = launches[launches.length - 1];
  const p = rec.activePage;
  await p.click('#go');
  await p.fill('#nm', 'keep me');
  await until(() => ['click', 'fill'].every((t) => typesOf(rec).includes(t)), 8000, 'steps');
  await refreshPids(l);
  const n = rec.state.steps.length;

  const snap = await rec.stop();
  assert.equal(snap.status, 'stopped');
  assert.equal(rec.state.status, 'stopped');
  assert.ok(rec.state.stoppedAt, 'stoppedAt set');
  assert.equal(rec.state.steps.length, n, 'steps intact after stop');
  assert.equal(rec.browser, null, 'browser reference released');
  await rec.stop();                                  // second stop is a harmless no-op
  assert.equal(rec.state.status, 'stopped');
  await rec.teardown;
  await assertGone(l, 'stop');

  // save via storage.create exactly as POST /api/tests does
  const saved = storage.create({
    name: 'lifecycle save', target: { app: rec.state.app },
    steps: rec.state.steps.map((s) => steps.stripDerived(s)),
  });
  assert.equal(storage.load(saved.id).steps.length, n, 'saved test has every step');

  await until(() => fs.existsSync(draftFile()), 8000, 'draft file written');
  rec.discard();
  assert.equal(rec.state.status, 'idle');
  assert.equal(rec.state.steps.length, 0);
  await rec._draftChain;
  assert.notOk(fs.existsSync(draftFile()), 'draft file removed by discard');
  assert.notOk(fs.existsSync(draftFile() + '.tmp'), 'draft tmp removed');
});

test('[machine-driven real recording] discard while recording is refused (409); restart after stop works with a fresh draft', async () => {
  const rec = await startRec(fx.url);
  const l1 = launches[launches.length - 1];
  try {
    await rec.activePage.click('#go');
    await until(() => typesOf(rec).includes('click'), 8000, 'click');
    let err = null;
    try { rec.discard(); } catch (e) { err = e; }
    assert.equal(err && err.status, 409, 'discard refused while active');
    let err2 = null;
    try { await rec.start({ app: `url:${fx.url}`, headed: false }); } catch (e) { err2 = e; }
    assert.equal(err2 && err2.status, 409, 'second start refused while active');
    await rec.stop(); await rec.teardown;
    await assertGone(l1, 'first run');

    await rec.start({ app: `url:${fx.url}`, headed: false });      // restart on the SAME instance
    const l2 = launches[launches.length - 1];
    assert.notEqual(l2, l1, 'a new browser was launched');
    assert.equal(rec.state.status, 'recording');
    assert.equal(rec.state.steps.filter((s) => s.type === 'click').length, 0, 'fresh draft after restart');
    await rec.activePage.click('#go');
    await until(() => typesOf(rec).includes('click'), 8000, 'click after restart');
    await rec.stop(); await rec.teardown;
    await assertGone(l2, 'restart run');
  } finally { if (rec.active) { await rec.stop(); await rec.teardown; } }
});

test('[machine-driven real recording] stop during "starting" is clean: no stuck state, no browser left behind', async () => {
  const rec = new Recording();
  const before = launches.length;
  const p = rec.start({ app: `url:${fx.url}`, headed: false });
  assert.equal(rec.state.status, 'starting');
  const snap = await rec.stop();
  assert.equal(snap.status, 'stopped');
  const err = await p.then(() => null, (e) => e);
  assert.ok(err, 'start() rejects when stopped mid-start');
  assert.equal(err.status, 409);
  assert.equal(rec.state.status, 'stopped', 'status not resurrected by the aborted start');
  assert.equal(rec.browser, null);
  await sleep(300);
  for (const l of launches.slice(before)) await assertGone(l, 'stop-during-starting');
  rec.discard();
  assert.equal(rec.state.status, 'idle');
});

test('[machine-driven real recording] user closes the browser: recording finishes as stopped with steps kept', async () => {
  const rec = await startRec(fx.url);
  const l = launches[launches.length - 1];
  try {
    await rec.activePage.click('#go');
    await rec.activePage.fill('#nm', 'before close');
    await until(() => ['click', 'fill'].every((t) => typesOf(rec).includes(t)), 8000, 'steps');
    const n = rec.state.steps.length;
    await refreshPids(l);
    await l.browser.close();                                 // what clicking the window's X does
    await until(() => rec.state.status === 'stopped', 8000, 'status to become stopped');
    assert.equal(rec.state.steps.length, n, 'steps kept');
    assert.ok(rec.state.stoppedAt);
    assert.equal(rec.browser, null);
    assert.equal(rec.active, false);
    await assertGone(l, 'user close');
    rec.discard();
  } finally { if (rec.active) { await rec.stop(); await rec.teardown; } }
});

test('[machine-driven real recording] 5x start/stop leaves no chromium process and no temp profile directory behind', async () => {
  trackProfile = true;
  const rec = new Recording();
  const mine = [];
  try {
    for (let i = 0; i < 5; i++) {
      await rec.start({ app: `url:${fx.url}`, headed: false });
      const l = launches[launches.length - 1];
      mine.push(l);
      await rec.activePage.click('#go');
      await until(() => typesOf(rec).includes('click'), 8000, `click in cycle ${i + 1}`);
      await refreshPids(l);
      await rec.stop(); await rec.teardown;
      assert.equal(rec.state.status, 'stopped', `cycle ${i + 1} stopped`);
      rec.discard();
    }
  } finally { trackProfile = false; if (rec.active) { await rec.stop(); await rec.teardown; } }
  assert.equal(mine.length, 5);
  assert.every(mine, (l) => l.mainPid && l.pids.length >= 1, 'every cycle recorded a browser pid (the leak check is not vacuous)');
  for (let i = 0; i < mine.length; i++) await assertGone(mine[i], `cycle ${i + 1}`);
  const dirs = mine.map((l) => l.userDataDir).filter(Boolean);
  // The profile-dir check needs a readable command line; report honestly if it was not available.
  if (dirs.length !== mine.length) process.stdout.write(`      note: temp-profile check PARTIAL - command line readable for ${dirs.length}/${mine.length} launches\n`);
  else process.stdout.write(`      note: ${dirs.length} temp profile dirs verified removed\n`);
});

test('cleanup: no browser launched by this suite is still connected', async () => {
  const live = launches.filter((l) => l.browser.isConnected());
  for (const l of live) await l.browser.close().catch(() => {});
  assert.equal(live.length, 0, `${live.length} browser(s) still connected at the end of the suite`);
  if (fx) fx.srv.close();
  chromium.launch = origLaunch;
});

run('recording-lifecycle').then(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
