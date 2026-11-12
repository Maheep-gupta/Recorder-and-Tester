/**
 * Browser-process reliability: every run reaches a truthful terminal state and leaves no browser
 * or temp profile behind. Local fixture on 127.0.0.1 only; RECORDER_TESTS_DIR is a temp dir.
 *
 *   node tests/reliability.test.js        (from the repo root)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// A private OS temp dir for this process tree, so counting Playwright profile dirs is not disturbed by
// other Chromium users on the machine (Playwright and Chromium both honour TEMP/TMP/TMPDIR).
const PRIVATE_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-temp-'));
process.env.TEMP = PRIVATE_TEMP; process.env.TMP = PRIVATE_TEMP; process.env.TMPDIR = PRIVATE_TEMP;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-tests-'));
process.env.RECORDER_TESTS_DIR = TMP;

const { test, assert, run } = require('./harness');
const storage = require('../src/storage');
const execution = require('../src/execution');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const uniq = (l) => `reliab ${l} ${process.pid}-${++seq}`;

function fixture() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>fx</title><h1 id="ok">ok</h1>');
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
      close: () => new Promise((r) => { if (srv.closeAllConnections) srv.closeAllConnections(); srv.close(() => r()); }),
    }));
  });
}

/** navigate, a long wait (the "slow step"), then an assertion. */
const slowSteps = (waitMs) => [
  { id: 's1', type: 'navigate', url: '{{baseUrl}}/' },
  { id: 's2', type: 'wait', ms: waitMs },
  { id: 's3', type: 'expectVisible', selector: '#ok' },
];
const mk = (label, fx, steps) => storage.load(storage.create({ name: uniq(label), target: { app: `url:${fx.url}` }, steps }).id);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const profiles = () => fs.readdirSync(os.tmpdir()).filter((n) => /^playwright/i.test(n));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}
async function withFx(fn) { const fx = await fixture(); try { return await fn(fx); } finally { await fx.close(); } }
const noRunning = (t) => assert.notOk(storage.listRuns(t.id).some((r) => r.status === 'running'), 'no run may be left in "running"');

test('R1 Chromium cannot start: error/browser_error, persisted, lastRun updated', () => withFx(async (fx) => {
  const t = mk('nolaunch', fx, slowSteps(10));
  const prev = process.env.REPLAYR_CHROMIUM_EXECUTABLE;
  process.env.REPLAYR_CHROMIUM_EXECUTABLE = path.join(TMP, 'no-such-chromium.exe');
  let r;
  try { r = await execution.runTest(t, { headed: false }); } finally { if (prev === undefined) delete process.env.REPLAYR_CHROMIUM_EXECUTABLE; else process.env.REPLAYR_CHROMIUM_EXECUTABLE = prev; }
  assert.equal(r.status, 'error', `status (${r.reason}: ${r.error})`);
  assert.equal(r.reason, 'browser_error');
  assert.ok(r.finishedAt, 'finishedAt');
  assert.equal(storage.loadRun(t.id, r.id).status, 'error', 'persisted result.json');
  assert.equal(storage.load(t.id).lastRun.status, 'error', 'lastRun');
  noRunning(t);
}));

test('R2 Chromium killed mid-run: error/browser_error quickly, later steps not-run', () => withFx(async (fx) => {
  const t = mk('crash', fx, slowSteps(30000));
  const started = Date.now();
  const p = execution.runTest(t, { headed: false });
  const pid = await until(() => execution.browserPids()[0], 20000, 'browser pid');
  await sleep(2500);
  process.kill(pid, 'SIGKILL');
  const r = await Promise.race([p, sleep(15000).then(() => 'HUNG')]);
  assert.notEqual(r, 'HUNG', 'run must not hang after a browser crash');
  assert.ok(Date.now() - started < 28000, 'finished well before the 30 s wait');
  assert.equal(r.status, 'error', `${r.status}/${r.reason}`);
  assert.equal(r.reason, 'browser_error');
  assert.equal(r.steps[r.steps.length - 1].status, 'not-run', 'final step not-run');
  assert.equal(storage.loadRun(t.id, r.id).status, 'error');
  noRunning(t);
}));

test('R3 context closed under a step: truthful error', () => withFx(async (fx) => {
  const t = mk('ctx', fx, slowSteps(30000));
  const p = execution.runTest(t, { headed: false });
  const b = await until(() => execution.activeBrowsers()[0], 20000, 'browser');
  await until(() => b.contexts()[0], 5000, 'context');
  await sleep(2500);
  await b.contexts()[0].close();
  const r = await Promise.race([p, sleep(15000).then(() => 'HUNG')]);
  assert.notEqual(r, 'HUNG', 'no hang');
  assert.equal(r.status, 'error', `${r.status}/${r.reason}`);
  assert.equal(r.reason, 'browser_error');
  noRunning(t);
}));

test('R4 cancellation: mid-step and before the first step; browser closed', () => withFx(async (fx) => {
  const t = mk('cancel', fx, slowSteps(30000));
  const ac = new AbortController();
  const p = execution.runTest(t, { headed: false, signal: ac.signal });
  const pid = await until(() => execution.browserPids()[0], 20000, 'browser pid');
  await sleep(2500);
  ac.abort();
  const r = await p;
  assert.equal(r.status, 'cancelled');
  assert.equal(storage.loadRun(t.id, r.id).status, 'cancelled');
  assert.notOk(alive(pid), 'the browser process must be gone by the time the run reports cancelled');
  const pre = new AbortController();
  pre.abort();
  const r2 = await execution.runTest(t, { headed: false, signal: pre.signal });
  assert.equal(r2.status, 'cancelled', 'cancelled before the first step');
  assert.equal(r2.steps.filter((s) => s.status === 'not-run').length, 3, 'all steps not-run');
  assert.equal(execution.browserPids().length, 0, 'no browser left');
  noRunning(t);
}));

test('R7 temp profiles: no growth after 5 sequential runs or after a crash', () => withFx(async (fx) => {
  const t = mk('profiles', fx, [{ id: 's1', type: 'navigate', url: '{{baseUrl}}/' }, { id: 's2', type: 'expectVisible', selector: '#ok' }]);
  const before = profiles();
  for (let i = 0; i < 5; i++) {
    const r = await execution.runTest(t, { headed: false });
    assert.equal(r.status, 'passed', `run ${i}: ${r.status}/${r.reason} ${r.error}`);
  }
  await sleep(1500);
  assert.equal(profiles().filter((n) => !before.includes(n)), [], 'no new playwright temp dirs after 5 runs');
  const slow = mk('profiles2', fx, slowSteps(30000));
  const p = execution.runTest(slow, { headed: false });
  const pid = await until(() => execution.browserPids()[0], 20000, 'pid');
  await sleep(2500);
  process.kill(pid, 'SIGKILL');
  await p;
  await sleep(2500);
  assert.equal(profiles().filter((n) => !before.includes(n)), [], 'no new playwright temp dirs after a crash');
  assert.equal(execution.browserPids().length, 0);
}));

test('R8 boot sweep kills a marked browser whose owner is dead, and spares one whose owner is alive', async () => {
  const { chromium } = require('playwright');
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => dead.once('exit', r));
  const orphan = await chromium.launch({ args: [execution.OWNER_FLAG + dead.pid] });
  const mine = await chromium.launch({ args: [execution.OWNER_FLAG + process.pid] });
  try {
    await sleep(800);
    const gone = new Promise((r) => orphan.once('disconnected', r));
    const killed = await execution.sweepOrphanBrowsers();
    assert.ok(killed.length >= 1, 'the orphan was found and killed');
    assert.ok(await Promise.race([gone.then(() => true), sleep(10000).then(() => false)]), 'orphan browser is dead');
    assert.ok(mine.isConnected(), 'a browser owned by a live process is untouched');
  } finally { await mine.close().catch(() => {}); await orphan.close().catch(() => {}); }
});

// ───────────────────────────────────────────────────────────── real server

function api(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, text, json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const freePort = () => new Promise((res) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function startServer(dir) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, RECORDER_PORT: String(port), RECORDER_TESTS_DIR: dir, RECORDER_HEADLESS_RUN: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const srv = { port, child, out: '' };
  child.stdout.on('data', (c) => { srv.out += c; });
  child.stderr.on('data', (c) => { srv.out += c; });
  await until(async () => { try { return (await api(port, 'GET', '/api/config')).status === 200; } catch { return false; } }, 25000, 'server start');
  return srv;
}
const exited = (child, ms) => new Promise((res) => {
  if (child.exitCode !== null) return res(true);
  const t = setTimeout(() => res(false), ms);
  child.once('exit', () => { clearTimeout(t); res(true); });
});
const killTree = (child) => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
const idOf = (c) => c.json.id || (c.json.test && c.json.test.id);
const browserPidFromLog = (srv) => { const m = /browser pid (\d+)/.exec(srv.out); return m ? Number(m[1]) : 0; };
const graceful = (srv) => { try { if (process.platform === 'win32') srv.child.send({ type: 'shutdown' }); else srv.child.kill('SIGTERM'); } catch { /* gone */ } };

test('R5a graceful shutdown during a run: persisted terminal state, browser gone', () => withFx(async (fx) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-srv-'));
  const srv = await startServer(dir);
  try {
    const c = await api(srv.port, 'POST', '/api/tests', { name: uniq('graceful'), app: `url:${fx.url}`, steps: slowSteps(30000) });
    const id = idOf(c);
    const r = await api(srv.port, 'POST', `/api/tests/${id}/run`, {});
    assert.equal(r.status, 200, r.text);
    const pid = await until(() => browserPidFromLog(srv), 25000, 'browser pid in log');
    await sleep(1000);
    graceful(srv);
    assert.ok(await exited(srv.child, 15000), 'server exits');
    const t = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    assert.ok(t.lastRun, 'lastRun stamped');
    assert.ok(['cancelled', 'error'].includes(t.lastRun.status), `terminal: ${t.lastRun.status}`);
    await until(() => !alive(pid), 8000, 'browser pid to be gone');
  } finally { killTree(srv.child); fs.rmSync(dir, { recursive: true, force: true }); }
}));

test('R5b hard kill during a run: no surviving browser; next boot marks the run interrupted', () => withFx(async (fx) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-srv-'));
  let srv = await startServer(dir);
  let pid = 0;
  try {
    const c = await api(srv.port, 'POST', '/api/tests', { name: uniq('hardkill'), app: `url:${fx.url}`, steps: slowSteps(30000) });
    const id = idOf(c);
    await api(srv.port, 'POST', `/api/tests/${id}/run`, {});
    pid = await until(() => browserPidFromLog(srv), 25000, 'browser pid in log');
    await sleep(1000);
    killTree(srv.child);
    assert.ok(await exited(srv.child, 5000), 'server killed');
    const byItself = await until(() => !alive(pid), 6000, 'x').then(() => true, () => false);
    console.log(`      (browser exited on its own after the server was hard-killed: ${byItself})`);
    srv = await startServer(dir);
    await until(() => !alive(pid), 15000, 'orphan browser to be gone after the next boot');
    const runId = fs.readdirSync(path.join(dir, 'runs', id))[0];
    const res = JSON.parse(fs.readFileSync(path.join(dir, 'runs', id, runId, 'result.json'), 'utf8'));
    assert.equal(res.status, 'error');
    assert.equal(res.reason, 'interrupted');
  } finally { killTree(srv.child); if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } fs.rmSync(dir, { recursive: true, force: true }); }
}));

test('R6 concurrency: two simultaneous run POSTs -> one 200, one 409', () => withFx(async (fx) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-srv-'));
  const srv = await startServer(dir);
  try {
    const c = await api(srv.port, 'POST', '/api/tests', { name: uniq('conc'), app: `url:${fx.url}`, steps: slowSteps(4000) });
    const id = idOf(c);
    const [a, b] = await Promise.all([api(srv.port, 'POST', `/api/tests/${id}/run`, {}), api(srv.port, 'POST', `/api/tests/${id}/run`, {})]);
    assert.equal([a.status, b.status].sort(), [200, 409], `statuses ${a.status}/${b.status}`);
    assert.equal((await api(srv.port, 'POST', '/api/run/cancel')).status, 200);
    await until(async () => (await api(srv.port, 'GET', '/api/stats')).json.running === 0, 20000, 'run to finish');
    const runs = (await api(srv.port, 'GET', `/api/tests/${id}/runs`)).json.runs;
    assert.ok(runs.length >= 1 && runs.every((r) => r.status !== 'running'), 'no run left running');
  } finally { graceful(srv); await exited(srv.child, 10000); killTree(srv.child); fs.rmSync(dir, { recursive: true, force: true }); }
}));

test('R6b run while a recording is active -> 409', () => withFx(async (fx) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-srv-'));
  const srv = await startServer(dir);
  try {
    const c = await api(srv.port, 'POST', '/api/tests', { name: uniq('rec'), app: `url:${fx.url}`, steps: slowSteps(10) });
    const id = idOf(c);
    const st = await api(srv.port, 'POST', '/api/recording/start', { app: `url:${fx.url}`, headed: false });
    assert.ok(st.status === 200 || st.status === 202, `recording start ${st.status} ${st.text.slice(0, 200)}`);
    const r = await api(srv.port, 'POST', `/api/tests/${id}/run`, {});
    assert.equal(r.status, 409, r.text);
    await api(srv.port, 'POST', '/api/recording/stop', {});
    await api(srv.port, 'POST', '/api/recording/discard', {});
  } finally { graceful(srv); await exited(srv.child, 10000); killTree(srv.child); fs.rmSync(dir, { recursive: true, force: true }); }
}));

run('reliability').then(async () => {
  try { await execution.closeAll(); } catch { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); fs.rmSync(PRIVATE_TEMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(process.exitCode || 0);
});
