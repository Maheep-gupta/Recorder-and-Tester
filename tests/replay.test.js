/**
 * Replay scenarios - record a bug flow on one environment, replay it on another, and say honestly
 * what happened. Runs real Chromium against a tiny controllable app (tests/sample-app/server.js).
 *
 *   node tests/replay.test.js            (run from the repo root)
 *
 * Real data is never touched: RECORDER_TESTS_DIR points at a fresh temp dir before any src module
 * is loaded. Every scenario owns its sample servers and closes them in a finally block.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-tests-'));
process.env.RECORDER_TESTS_DIR = TMP;

const { chromium } = require('playwright');
const { test, assert, run } = require('./harness');
const sample = require('./sample-app/server');
const identity = require('../src/identity');
const storage = require('../src/storage');
const execution = require('../src/execution');

let seq = 0;
const uniq = (label) => `replay ${label} ${process.pid}-${++seq}`;
const appKey = (srv) => `url:${srv.url}`;
const bySt = (result, status) => result.steps.filter((s) => s.status === status);

// ───────────────────────────────────────────────────────────── recording helpers

async function withRecorderPage(fn) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript({ content: identity.SOURCE });
    const page = await context.newPage();
    const targetOf = async (selector) => {
      const fp = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? window.__opkeyRec.fingerprint(el) : null;
      }, selector);
      assert.ok(fp, `fixture problem: nothing matched ${selector}`);
      return identity.buildTarget(page, fp);
    };
    return await fn(page, targetOf);
  } finally {
    await browser.close();
  }
}

/** Record the order flow on `srv` (fixed variant) through the identity public API. */
function recordFlow(srv, { withAssertion = true } = {}) {
  return withRecorderPage(async (page, targetOf) => {
    await page.goto(`${srv.url}/orders?tab=open`);
    const customer = await targetOf('#customer');
    await page.fill('#customer', 'Acme');
    const submit = await targetOf('form[aria-label="Add order"] button');
    await page.click('form[aria-label="Add order"] button');
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('Total'));
    const result = await targetOf('#result');
    const steps = [
      { id: 's1', type: 'navigate', url: '{{baseUrl}}/orders?tab=open' },
      { id: 's2', type: 'fill', target: customer, value: 'Acme' },
      { id: 's3', type: 'click', target: submit },
    ];
    if (withAssertion) steps.push({ id: 's4', type: 'expectText', target: result, text: 'Total: 42.00' });
    return steps;
  });
}

function recordDeleteAll(srv) {
  return withRecorderPage(async (page, targetOf) => {
    page.on('dialog', (d) => d.accept());
    await page.goto(`${srv.url}/orders?tab=open`);
    const del = await targetOf('#delete-all');
    await page.click('#delete-all');
    await page.waitForFunction(() => document.getElementById('deleted').textContent.includes('deleted'));
    const msg = await targetOf('#deleted');
    return [
      { id: 's1', type: 'navigate', url: '{{baseUrl}}/orders?tab=open' },
      { id: 's2', type: 'click', target: del },
      { id: 's3', type: 'expectText', target: msg, text: 'All orders deleted' },
    ];
  });
}

function recordLogin(srv) {
  return withRecorderPage(async (page, targetOf) => {
    await page.goto(`${srv.url}/login`);
    const pw = await targetOf('#pw');
    return [
      { id: 's1', type: 'navigate', url: '{{baseUrl}}/login' },
      { id: 's2', type: 'fill', target: pw, secret: true, value: 'hunter2' },
    ];
  });
}

function makeTest(label, app, steps) {
  return storage.create({ name: uniq(label), target: { app }, steps });
}

async function withServers(variants, fn) {
  const servers = [];
  try {
    for (const v of variants) servers.push(await sample.start({ variant: v, port: 0 }));
    return await fn(...servers);
  } finally {
    await Promise.all(servers.map((s) => s.close().catch(() => {})));
  }
}

const exec = (t, opts = {}) => execution.runTest(storage.load(t.id), { headed: false, ...opts });

/** Record on a fixed instance, then replay on `variant` (addressed as a typed URL). */
function replayOn(variant, { withAssertion = true } = {}) {
  return withServers(['fixed', variant], async (rec, rep) => {
    const steps = await recordFlow(rec, { withAssertion });
    const t = makeTest(`on-${variant}`, appKey(rec), steps);
    const result = await exec(t, { app: appKey(rep) });
    return { result, rep, rec };
  });
}

const why = (r) => `status ${r.status}, reason ${r.reason}, error ${r.error}`;

// ───────────────────────────────────────────────────────────── scenarios

test('A  record on production instance, replay on localhost instance: cross-env, only localhost touched', async () => {
  await withServers(['fixed', 'fixed'], async (prod, local) => {
    const steps = await recordFlow(prod);
    const t = makeTest('cross-env', appKey(prod), steps);
    prod.requests.length = 0; // everything from here on is the replay
    const prodSubmitsBefore = prod.submits;
    const localSubmitsBefore = local.submits;
    const result = await exec(t, { app: appKey(local) });
    assert.equal(result.status, 'passed', why(result));
    assert.equal(result.crossEnv, true, 'crossEnv');
    assert.ok(local.requests.some((r) => r.path.startsWith('/orders')), 'replay must have navigated on the localhost instance');
    assert.equal(prod.requests.length, 0, `no request may reach the production instance; saw ${JSON.stringify(prod.requests)}`);
    assert.equal(local.submits - localSubmitsBefore, 1, 'the order is submitted on localhost');
    assert.equal(prod.submits - prodSubmitsBefore, 0, 'nothing submitted on production during the replay');
  });
});

test('B  bug still exists: expectText "Total: 42.00" on buggy fails with assertion_failed', async () => {
  const { result } = await replayOn('buggy');
  assert.equal(result.status, 'failed', why(result));
  assert.equal(result.reason, 'assertion_failed', 'reason');
});

test('C  bug fixed: the same test on fixed passes with assertions_passed', async () => {
  const { result } = await replayOn('fixed');
  assert.equal(result.status, 'passed', why(result));
  assert.equal(result.reason, 'assertions_passed', 'reason');
});

test('C2 no assertion: all steps run but the fix is not verified (inconclusive / no_assertions)', async () => {
  const { result } = await replayOn('fixed', { withAssertion: false });
  assert.equal(result.status, 'inconclusive', why(result));
  assert.equal(result.reason, 'no_assertions', 'reason');
});

test('D1 restructured page (extra wrappers, new class): identity still finds the Submit button', async () => {
  const { result, rep } = await replayOn('restructured');
  assert.equal(result.status, 'passed', why(result));
  assert.equal(rep.submits, 1, 'the click must have landed');
});

test('D2 ambiguous page (two identical Submit buttons): refuses, and does not click either', async () => {
  const { result, rep } = await replayOn('ambiguous');
  assert.equal(result.status, 'failed', why(result));
  assert.ok(['element_ambiguous', 'element_not_found'].includes(result.reason), `reason was ${result.reason}`);
  assert.equal(rep.submits, 0, 'no order may be submitted when the target is ambiguous');
  assert.notOk(rep.requests.some((r) => r.method === 'POST'), 'no POST of any kind may have reached the app');
});

test('F  interrupted: abort after step 1 -> cancelled, later steps not-run, run persisted', async () => {
  await withServers(['fixed'], async (srv) => {
    const steps = [
      { id: 's1', type: 'navigate', url: '{{baseUrl}}/' },
      { id: 's2', type: 'navigate', url: '{{baseUrl}}/slow' },
      { id: 's3', type: 'navigate', url: '{{baseUrl}}/orders' },
      { id: 's4', type: 'navigate', url: '{{baseUrl}}/' },
    ];
    const t = makeTest('cancel', appKey(srv), steps);
    const ac = new AbortController();
    let aborted = false;
    const onProgress = (p) => {
      if (!aborted && p.steps && p.steps.some((s) => s.status === 'passed')) {
        aborted = true;
        ac.abort();
      }
    };
    const started = Date.now();
    const result = await exec(t, { signal: ac.signal, onProgress });
    assert.ok(aborted, 'the abort must have been triggered after the first step');
    assert.equal(result.status, 'cancelled', why(result));
    assert.equal(result.reason, 'cancelled', 'reason');
    assert.ok(Date.now() - started < 12000, 'cancel must not wait for the slow page');
    assert.ok(bySt(result, 'not-run').length >= 1, `remaining steps must be marked not-run: ${JSON.stringify(result.steps.map((s) => s.status))}`);
    assert.equal(result.steps.length, steps.length, 'the report shows the full test');
    const file = path.join(storage.runDir(t.id, result.id), 'result.json');
    assert.ok(fs.existsSync(file), 'result.json persisted in the run dir');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'cancelled', 'persisted status');
  });
});

test('G0 storage.create: the value of a secret step is not written to the saved test file', async () => {
  await withServers(['fixed'], async (srv) => {
    const t = makeTest('secret-disk', appKey(srv), await recordLogin(srv));
    const onDisk = fs.readFileSync(path.join(storage.TESTS, `${t.id}.json`), 'utf8');
    assert.notOk(onDisk.includes('hunter2'), 'saved test file must not contain the secret value of a secret step');
  });
});

test('G1 secret step: the run result and run console evidence carry neither the secret nor the logged token', async () => {
  await withServers(['fixed'], async (srv) => {
    const steps = await recordLogin(srv);
    const t = makeTest('secret', appKey(srv), steps);
    const onDisk = fs.readFileSync(path.join(storage.TESTS, `${t.id}.json`), 'utf8');
    const result = await exec(t);
    const dir = storage.runDir(t.id, result.id);
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(json|log|txt)$/.test(f)) continue;
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.excludes(text, 'hunter2', `run file ${f} must not contain the secret`);
      assert.excludes(text, 'abc123secret', `run file ${f} must not contain the token the page logged via console.error`);
    }
    assert.excludes(JSON.stringify(result), 'abc123secret', 'in-memory result must not contain the logged token');
  });
});

test('H  dialog: Delete all with confirm() is accepted and recorded in result.dialogs', async () => {
  await withServers(['fixed'], async (srv) => {
    const steps = await recordDeleteAll(srv);
    const t = makeTest('dialog', appKey(srv), steps);
    const deletesBefore = srv.deletes;
    const result = await exec(t);
    assert.equal(result.status, 'passed', why(result));
    assert.equal(srv.deletes - deletesBefore, 1, 'the accepted confirm must have deleted');
    assert.ok(Array.isArray(result.dialogs), 'result.dialogs is an array');
    assert.equal(result.dialogs.length, 1, 'exactly one dialog recorded');
    assert.equal(result.dialogs[0].type, 'confirm', 'dialog type');
    assert.equal(result.dialogs[0].message, 'Delete all orders?', 'dialog message');
    assert.equal(result.dialogs[0].action, 'accept', 'dialog action');
  });
});

// ── I and G2: the real server, over HTTP

function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: { Host: `127.0.0.1:${port}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

async function startRecorderServer(dir) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, RECORDER_PORT: String(port), RECORDER_TESTS_DIR: dir, RECORDER_HEADLESS_RUN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const r = await request(port, 'GET', '/api/config');
      if (r.status === 200) break;
    } catch (e) { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`server exited early: ${out.slice(-500)}`);
    if (Date.now() > deadline) { child.kill(); throw new Error(`server did not start: ${out.slice(-500)}`); }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { port, child };
}

async function stopRecorderServer(rec) {
  if (!rec) return;
  rec.child.kill();
  await new Promise((r) => {
    if (rec.child.exitCode !== null) return r();
    rec.child.once('exit', r);
    setTimeout(r, 3000);
  });
}

const idOf = (r) => r.json && (r.json.id || (r.json.test && r.json.test.id));

test('I  protected guard (real server): production env needs confirmation, then runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-server-'));
  let rec = null;
  await withServers(['fixed'], async (srv) => {
    // regex rather than text: see scenario J for why a plain-text expectText cannot be saved over HTTP.
    const steps = (await recordFlow(srv)).map((st) => (st.type === 'expectText' ? { id: st.id, type: st.type, target: st.target, regex: 'Total: 42\.00' } : st));
    try {
      rec = await startRecorderServer(dir);
      const { port } = rec;
      const env = await request(port, 'POST', '/api/environments', {
        key: 'sample-prod', label: 'Sample production', baseUrl: srv.url, kind: 'production', protected: true,
      });
      assert.equal(env.status, 201, `create environment: ${env.text}`);
      const created = await request(port, 'POST', '/api/tests', { name: uniq('guard'), app: 'sample-prod', steps });
      assert.ok(created.status === 200 || created.status === 201, `create test: ${created.status} ${created.text}`);
      const id = idOf(created);
      assert.ok(id, 'test id returned');

      const before = srv.requests.length;
      const blocked = await request(port, 'POST', `/api/tests/${id}/run`, {});
      assert.equal(blocked.status, 428, `unconfirmed run on a protected env: ${blocked.text}`);
      assert.equal(blocked.json && blocked.json.code, 'confirm-protected', 'error code');
      assert.equal(blocked.json.target && blocked.json.target.key, 'sample-prod', 'target in the body');
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(srv.requests.length, before, 'nothing may run (the app saw no request) before confirmation');

      const ok = await request(port, 'POST', `/api/tests/${id}/run`, { confirmProtected: true });
      assert.ok(ok.status === 200 || ok.status === 202, `confirmed run: ${ok.status} ${ok.text}`);

      let finished = null;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const r = await request(port, 'GET', `/api/tests/${id}/runs`);
        finished = ((r.json && r.json.runs) || []).find((x) => x.status && x.status !== 'running');
        if (finished) break;
        await new Promise((r2) => setTimeout(r2, 500));
      }
      assert.ok(finished, 'a finished run must appear in /runs');
      assert.equal(finished.status, 'passed', `finished run: ${JSON.stringify(finished)}`);
      assert.ok(srv.requests.length > before, 'the confirmed run reached the app');
    } finally {
      await stopRecorderServer(rec);
    }
  });
});

test('J  expectText with plain text can be saved through the HTTP API (text is not stripped as a display field)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-server-'));
  let rec = null;
  await withServers(['fixed'], async (srv) => {
    const steps = await recordFlow(srv);
    try {
      rec = await startRecorderServer(dir);
      const created = await request(rec.port, 'POST', '/api/tests', { name: uniq('text'), app: appKey(srv), steps });
      assert.ok(created.status === 200 || created.status === 201, `create: ${created.status} ${created.text}`);
      const saved = await request(rec.port, 'GET', `/api/tests/${idOf(created)}/export`);
      const exp = saved.json.steps.find((x) => x.type === 'expectText');
      assert.equal(exp && exp.text, 'Total: 42.00', 'the expected text must survive the round trip');
    } finally {
      await stopRecorderServer(rec);
    }
  });
});

test('G2 export of a test with a secret step carries no secret value (real server)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-server-'));
  let rec = null;
  await withServers(['fixed'], async (srv) => {
    const steps = await recordLogin(srv);
    try {
      rec = await startRecorderServer(dir);
      const created = await request(rec.port, 'POST', '/api/tests', { name: uniq('export'), app: appKey(srv), steps });
      assert.ok(created.status === 200 || created.status === 201, `create: ${created.status} ${created.text}`);
      const exp = await request(rec.port, 'GET', `/api/tests/${idOf(created)}/export`);
      assert.equal(exp.status, 200, 'export status');
      assert.excludes(exp.text, 'hunter2', 'export must not contain the secret value');
    } finally {
      await stopRecorderServer(rec);
    }
  });
});

run('replay').then(async () => {
  try { if (typeof execution.closeAll === 'function') await execution.closeAll(); } catch (e) { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(process.exitCode || 0);
});
