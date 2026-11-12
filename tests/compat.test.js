/**
 * Playwright compatibility canary.
 *
 * Replayr's recorder depends on private Playwright APIs (see src/pw-compat.js). This suite is what
 * must be run, and must pass, before a Playwright upgrade is accepted: it drives a REAL headless
 * Chromium through the private recorder and checks that the actions it emits still have the
 * names and field shapes steps.fromRecorderAction converts into step types.
 *
 *   node tests/compat.test.js
 *
 * No network beyond a local fixture on 127.0.0.1; no credentials; no human.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-tests-'));
process.env.RECORDER_TESTS_DIR = TMP;

const { chromium } = require('playwright');
const { test, assert, run } = require('./harness');
const compat = require('../src/pw-compat');
const steps = require('../src/steps');

const PAGE_ONE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>One</title></head><body>
<button id="go" type="button">Save changes</button>
<label for="nm">Full name</label><input id="nm" type="text">
<label for="col">Colour</label><select id="col"><option value="r">Red</option><option value="g">Green</option></select>
<label><input type="checkbox" id="agree"> Agree to terms</label>
<a href="/two">Next page</a></body></html>`;
const PAGE_TWO = '<!doctype html><html><head><title>Two</title></head><body><h1>Second page</h1></body></html>';

function fixture() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(req.url.startsWith('/two') ? PAGE_TWO : PAGE_ONE);
    }).listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));

test('the installed Playwright version is in SUPPORTED.tested', () => {
  const v = compat.installedVersion();
  assert.ok(v, 'could not read the installed Playwright version');
  assert.includes(compat.SUPPORTED.tested, v, `installed ${v} is not a tested version; run this suite and add it deliberately`);
  assert.equal(compat.checkCompat().ok, true, 'version-only checkCompat must pass on the installed version');
});

test('every wrapped private API exists on a real BrowserContext', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const r = compat.checkCompat({ context: ctx });
    assert.equal(r.missing, [], 'missing required APIs');
    assert.equal(r.optionalMissing, [], 'missing optional APIs');
    assert.equal(r.ok, true);
    for (const name of Object.keys(compat.API)) assert.equal(typeof ctx[name], 'function', name);
    assert.equal(await compat.exposeConsoleApi(ctx), true);
  } finally { await browser.close(); }
});

test('checkCompat reports a missing API with an actionable IncompatiblePlaywrightError', () => {
  const r = compat.checkCompat({ context: {} });
  assert.equal(r.ok, false);
  assert.includes(r.missing, '_enableRecorder');
  let err = null;
  try { compat.assertCompat({ context: {} }); } catch (e) { err = e; }
  assert.ok(err instanceof compat.IncompatiblePlaywrightError, 'typed error');
  assert.match(err.message, /needs Playwright 1\.62\.x/);
  assert.match(err.message, /npm ci/);
  assert.match(err.message, /installed 1\./);
});

test('adapter degrades (no throw) when optional APIs are absent', async () => {
  assert.equal(await compat.exposeConsoleApi({}), false);
  assert.equal(await compat.disableRecorder({}), false);
});

test('REAL headless recording through the private recorder: Playwright-driven input is captured and converts to steps', async () => {
  const { srv, url } = await fixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const events = [];
    await compat.enableRecorder(ctx,
      { mode: 'recording', recorderMode: 'api', language: 'jsonl', omitCallTracking: true },
      {
        actionAdded: (page, data, code) => events.push({ kind: 'add', page, data, code }),
        actionUpdated: (page, data, code) => events.push({ kind: 'update', page, data, code }),
        signalAdded: (page, data) => events.push({ kind: 'signal', page, data }),
      });
    const page = await ctx.newPage();
    await page.goto(url);
    await settle();

    // Playwright's normal input APIs. The recorder runs in "api" mode, which reports what the
    // automation itself does (verified here, not assumed).
    await page.click('#go'); await settle();
    await page.fill('#nm', 'Ada Lovelace'); await settle();
    await page.selectOption('#col', 'g'); await settle();
    await page.check('#agree'); await settle();
    await page.press('#nm', 'Enter'); await settle();
    await page.click('a'); await settle(600);   // navigation

    const actions = events.filter((e) => e.kind === 'add' || e.kind === 'update');
    const names = actions.map((e) => e.data.action.name);
    for (const n of ['openPage', 'navigate', 'click', 'fill', 'select', 'check', 'press']) {
      assert.includes(names, n, `recorder did not emit "${n}" (got ${names.join(',')})`);
    }

    // Event / field shape the adapter and steps.js rely on.
    for (const e of actions) {
      assert.equal(typeof e.data.action.name, 'string', 'action.name');
      assert.equal(typeof e.code, 'string', 'jsonl code string');
      const entry = JSON.parse(e.code);
      assert.equal(entry.name, e.data.action.name, 'jsonl entry name matches action');
      assert.ok(e.page && typeof e.page.url === 'function', 'handler receives a Page');
    }
    const by = (n) => actions.find((e) => e.data.action.name === n);
    assert.match(by('click').data.action.selector, /Save changes/, 'click selector names the button');
    assert.equal(JSON.parse(by('click').code).locator.kind, 'role', 'jsonl locator.kind');
    assert.equal(by('fill').data.action.text, 'Ada Lovelace', 'fill.text');
    assert.equal(by('select').data.action.options, ['g'], 'select.options');
    assert.equal(by('press').data.action.key, 'Enter', 'press.key');
    assert.equal(by('navigate').data.action.url, url + '/', 'navigate.url');

    // ...and steps.fromRecorderAction still converts them.
    const ctxFor = { baseUrl: url, pageIndex: 0, isFirstPage: true };
    const converted = actions.map((e) => steps.fromRecorderAction(e.data, e.code, ctxFor)).filter(Boolean);
    const types = converted.map((s) => s.type);
    for (const t of ['navigate', 'click', 'fill', 'select', 'check', 'press']) {
      assert.includes(types, t, `no "${t}" step produced (got ${types.join(',')})`);
    }
    assert.equal(converted.find((s) => s.type === 'fill').value, 'Ada Lovelace');
    assert.equal(converted.find((s) => s.type === 'select').values, ['g']);
    assert.equal(converted.find((s) => s.type === 'press').key, 'Enter');
    assert.ok(converted.find((s) => s.type === 'click').fallbackSelector, 'click keeps the fallback selector');
    assert.ok(converted.find((s) => s.type === 'navigate').url.startsWith('{{baseUrl}}'), 'navigate is templated');
    assert.equal(steps.fromRecorderAction({ action: { name: 'noSuchAction' } }, '{}', ctxFor), null, 'unknown names are dropped (recording.js logs them)');

    await compat.disableRecorder(ctx);
  } finally { await browser.close(); srv.close(); }
});

test('page.mouse / page.keyboard input is captured too', async () => {
  const { srv, url } = await fixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const got = [];
    await compat.enableRecorder(ctx,
      { mode: 'recording', recorderMode: 'api', language: 'jsonl', omitCallTracking: true },
      { actionAdded: (p, d) => got.push(d.action), actionUpdated: (p, d) => got.push(d.action), signalAdded() {} });
    const page = await ctx.newPage();
    await page.goto(url); await settle();
    const box = await page.locator('#go').boundingBox();
    await page.mouse.click(box.x + 4, box.y + 4); await settle();
    await page.locator('#nm').focus();
    await page.keyboard.type('xyz'); await settle();
    const names = got.map((a) => a.name);
    assert.includes(names, 'click', 'mouse.click captured');
    assert.includes(names, 'fill', 'keyboard.type captured as fill');
    assert.equal(got.filter((a) => a.name === 'fill').pop().text, 'xyz');
  } finally { await browser.close(); srv.close(); }
});

run('compat');
