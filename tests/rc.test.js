/**
 * Release-candidate regression tests: the fixes made while closing the 0.1.0 release blockers.
 *
 *   - session files: no two environment keys share one file (typed `url:` keys used to collide)
 *   - `.auth/ui-shell.json` is encrypted by default; plaintext only with an explicit opt-in;
 *     a legacy plaintext session is encrypted in place the first time it is read
 *   - scripts/move-credentials-to-keyring.js: dry run, apply, no keyring -> nothing changed
 *   - production login state never reaches a localhost replay (real Chromium, real runTest)
 *
 * No real keyring, no real credentials: REPLAYR_SECRETSTORE=memory, everything in a temp dir.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'replayr-rc-'));
const AUTH_DIR = path.join(TMP, 'auth');
fs.mkdirSync(AUTH_DIR, { recursive: true });
process.env.REPLAYR_SECRETSTORE = 'memory';
process.env.RECORDER_LOGINS_FILE = path.join(TMP, 'logins.json');
process.env.RECORDER_TESTS_DIR = path.join(TMP, 'tests');
process.env.RECORDER_ENVIRONMENTS_FILE = path.join(TMP, 'environments.json');
process.env.RECORDER_HEADLESS_RUN = '1';
delete process.env.REPLAYR_SHARE_UI_SHELL_SESSION;
for (const k of Object.keys(process.env)) if (/^OPKEY_/.test(k)) delete process.env[k];

const { test, assert, run } = require('./harness');
const config = require('../src/config');

// Keep every session file inside the temp dir, with the real naming rules.
const realAuthStateFor = config.authStateFor;
config.authStatePath = path.join(AUTH_DIR, 'ui-shell.json');
config.authStateFor = function (app) {
  if (app === 'ui-shell') return config.authStatePath;
  return path.join(AUTH_DIR, path.basename(realAuthStateFor.call(config, app)));
};

const secretstore = require('../src/secretstore');
const targets = require('../src/targets');
const auth = require('../src/auth');
const execution = require('../src/execution');
const { migrate } = require('../scripts/move-credentials-to-keyring');

const fakeContext = (state) => ({ storageState: async () => state });
const COOKIE_STATE = (value, domain = 'localhost') => ({
  cookies: [{ name: 'sid', value, domain, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
  origins: [],
});

/* ── session file naming ─────────────────────────────────────────────── */

test('session files: typed URLs that sanitise alike get different files', () => {
  const a = realAuthStateFor.call(config, 'url:http://a.b');
  const b = realAuthStateFor.call(config, 'url:http://a_b');
  assert.ok(a !== b, `"url:http://a.b" and "url:http://a_b" must not share a session file (${path.basename(a)})`);
  assert.equal(realAuthStateFor.call(config, 'url:http://a.b'), a, 'stable for the same key');
});

test('session files: configured and user environment keys keep their historic names', () => {
  assert.equal(path.basename(realAuthStateFor.call(config, 'qa1')), 'qa1.json');
  assert.equal(path.basename(realAuthStateFor.call(config, 'prod-web')), 'prod-web.json');
  assert.equal(realAuthStateFor.call(config, 'ui-shell'), config.authStatePath, 'ui-shell keeps its path');
});

/* ── ui-shell session encryption ─────────────────────────────────────── */

test('ui-shell session: encrypted by default (no plaintext cookie on disk)', async () => {
  secretstore._resetForTests && secretstore._resetForTests();
  await auth.saveState(fakeContext(COOKIE_STATE('UI-SHELL-SECRET')), 'ui-shell');
  const raw = fs.readFileSync(config.authStatePath, 'utf8');
  assert.ok(!raw.includes('UI-SHELL-SECRET'), 'cookie value must not be on disk in plaintext');
  assert.includes(raw, 'replayr-enc-v1', 'file is in the encrypted format');
  const opt = auth.storageStateOption('ui-shell');
  assert.equal(opt.storageState.cookies[0].value, 'UI-SHELL-SECRET', 'and it decrypts back for use');
});

test('ui-shell session: plaintext only with REPLAYR_SHARE_UI_SHELL_SESSION=1', async () => {
  process.env.REPLAYR_SHARE_UI_SHELL_SESSION = '1';
  try {
    await auth.saveState(fakeContext(COOKIE_STATE('SHARED-PLAIN')), 'ui-shell');
    const raw = fs.readFileSync(config.authStatePath, 'utf8');
    assert.includes(raw, 'SHARED-PLAIN', 'opt-in keeps the shared file readable by the external suite');
    // Reading it with the opt-in on must NOT encrypt it behind the other suite's back.
    auth.storageStateOption('ui-shell');
    assert.includes(fs.readFileSync(config.authStatePath, 'utf8'), 'SHARED-PLAIN', 'still plain after a read');
  } finally {
    delete process.env.REPLAYR_SHARE_UI_SHELL_SESSION;
  }
});

test('legacy plaintext session: encrypted in place on first read, still usable', () => {
  fs.writeFileSync(config.authStatePath, JSON.stringify(COOKIE_STATE('LEGACY-PLAIN')));
  const opt = auth.storageStateOption('ui-shell');
  assert.equal(opt.storageState.cookies[0].value, 'LEGACY-PLAIN', 'the session is still used');
  const raw = fs.readFileSync(config.authStatePath, 'utf8');
  assert.ok(!raw.includes('LEGACY-PLAIN'), 'the file is no longer plaintext');
  assert.includes(raw, 'replayr-enc-v1');
});

test('legacy plaintext session with no keyring: left as it was (no data loss), still usable', () => {
  fs.writeFileSync(config.authStatePath, JSON.stringify(COOKIE_STATE('NO-KEYRING')));
  process.env.REPLAYR_SECRETSTORE = 'unavailable';
  try {
    const opt = auth.storageStateOption('ui-shell');
    assert.equal(opt.storageState.cookies[0].value, 'NO-KEYRING');
    assert.includes(fs.readFileSync(config.authStatePath, 'utf8'), 'NO-KEYRING', 'not destroyed');
  } finally {
    process.env.REPLAYR_SECRETSTORE = 'memory';
  }
});

/* ── credentials.local.env migration ─────────────────────────────────── */

const ENV_TEXT = [
  '# team logins',
  'OPKEY_USERNAME=dev.user',
  'OPKEY_PASSWORD="pa ss=word#1"',
  'OPKEY_QA1_PASSWORD=',
  'OTHER_SETTING=keep-me',
  '',
].join('\n');

test('credentials migration: dry run lists names only and changes nothing', () => {
  const file = path.join(TMP, 'dry.local.env');
  fs.writeFileSync(file, ENV_TEXT);
  const r = migrate({ file });
  assert.equal(JSON.stringify(r.candidates), '["OPKEY_USERNAME","OPKEY_PASSWORD"]', 'empty values are not candidates');
  assert.equal(r.applied, false);
  assert.ok(!r.message.includes('dev.user') && !r.message.includes('pa ss'), 'the message never contains a value');
  assert.equal(fs.readFileSync(file, 'utf8'), ENV_TEXT, 'file untouched');
  assert.equal(secretstore.getSecret('env:OPKEY_PASSWORD'), null, 'keyring untouched');
});

test('credentials migration: --apply moves values, verifies, blanks them, keeps everything else', () => {
  const file = path.join(TMP, 'apply.local.env');
  fs.writeFileSync(file, ENV_TEXT);
  const r = migrate({ file, apply: true });
  assert.equal(r.applied, true);
  assert.equal(secretstore.getSecret('env:OPKEY_USERNAME'), 'dev.user');
  assert.equal(secretstore.getSecret('env:OPKEY_PASSWORD'), 'pa ss=word#1', 'quotes stripped, value exact');
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(!after.includes('dev.user') && !after.includes('pa ss=word'), 'no value left in the file');
  assert.includes(after, '# team logins', 'comments kept');
  assert.includes(after, 'OTHER_SETTING=keep-me', 'other settings kept');
  assert.includes(after, 'OPKEY_PASSWORD=', 'the key stays, empty');
  assert.includes(after, 'moved to the OS keyring', 'a note says where it went');
  // Authentication still finds the values (the keyring wins over the file).
  config.credentialsPath = file;
  const creds = auth.readCredentials('ui-shell');
  assert.equal(creds.username, 'dev.user');
  assert.equal(creds.password, 'pa ss=word#1');
});

test('credentials migration: no keyring -> error, file and keyring untouched', () => {
  const file = path.join(TMP, 'nokeyring.local.env');
  fs.writeFileSync(file, ENV_TEXT);
  process.env.REPLAYR_SECRETSTORE = 'unavailable';
  let threw = null;
  try { migrate({ file, apply: true }); } catch (e) { threw = e; } finally { process.env.REPLAYR_SECRETSTORE = 'memory'; }
  assert.ok(threw && /Nothing was changed/.test(threw.message), 'clear error');
  assert.equal(fs.readFileSync(file, 'utf8'), ENV_TEXT, 'file byte-identical');
});

/* ── production login state never reaches a localhost replay ─────────── */

function startServer(label) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie || '' });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>${label}</title><h1>${label}</h1>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

test('isolation: a localhost replay of a production-recorded test never sends production cookies', async () => {
  const prod = await startServer('PROD');
  const local = await startServer('LOCAL');
  try {
    // Production: protected, behind login, with a saved session. Its cookie is scoped to the
    // host the LOCAL app also uses (cookies ignore ports), so loading the wrong state WOULD leak.
    targets.saveEnvironment({ key: 'rc-prod', label: 'RC Prod', baseUrl: `http://127.0.0.1:${prod.port}`, kind: 'production', auth: true, application: 'RC' });
    targets.saveEnvironment({ key: 'rc-local', label: 'RC Local', baseUrl: `http://127.0.0.1:${local.port}`, kind: 'local', auth: false, application: 'RC' });
    await auth.saveState(fakeContext(COOKIE_STATE('PROD-SESSION-TOKEN', '127.0.0.1')), 'rc-prod');

    // Sanity: the production state really holds the cookie, so the check below can fail.
    assert.equal(auth.storageStateOption('rc-prod').storageState.cookies[0].value, 'PROD-SESSION-TOKEN');
    assert.equal(JSON.stringify(auth.storageStateOption('rc-local')), '{}', 'local loads no state at all');

    const testObj = {
      id: 'rc-isolation', name: 'rc isolation', target: { app: 'rc-prod' },
      steps: [{ id: 's1', type: 'navigate', url: '{{baseUrl}}/page' }],
    };
    const result = await execution.runTest(testObj, { app: 'rc-local', headed: false });
    assert.ok(['inconclusive', 'passed'].includes(result.status), `the replay ran (${result.status}/${result.reason}: ${result.error || ''})`);
    assert.ok(local.seen.length > 0, 'the local app was contacted');
    assert.ok(local.seen.every((r) => !r.cookie.includes('PROD-SESSION-TOKEN')), 'no production cookie reached localhost');
    assert.equal(prod.seen.length, 0, 'production was never contacted');
    assert.equal(result.target.key, 'rc-local');
  } finally {
    prod.server.close(); local.server.close();
  }
});

/* ── recording browsers are marked, so orphan sweeps and cleanup checks can see them ── */

function markedChromePids(ownerPid) {
  const { execFileSync } = require('child_process');
  const flag = `--replayr-owner=${ownerPid}`;
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      // Restrict to browser executables: this PowerShell query's own command line contains the flag.
      `Get-CimInstance Win32_Process -Filter "Name like 'chrom%' AND CommandLine like '%${flag}%'" | ForEach-Object { $_.ProcessId }`],
    { encoding: 'utf8', timeout: 30000 });
    return out.split(/\s+/).filter(Boolean).map(Number);
  }
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.includes(flag)).map((l) => Number(l.trim().split(/\s+/)[0]));
}

test('recording: the recording browser carries the owner marker and is gone after stop', async () => {
  const app = await startServer('REC');
  const { Recording } = require('../src/recording');
  const rec = new Recording();
  try {
    await rec.start({ app: `url:http://127.0.0.1:${app.port}`, headed: false });
    const during = markedChromePids(process.pid);
    assert.ok(during.length > 0, 'a live recording browser is findable by --replayr-owner');
    await rec.stop();
    if (rec.teardown) await rec.teardown;
    await new Promise((r) => setTimeout(r, 1500));
    const after = markedChromePids(process.pid);
    assert.equal(after.length, 0, `no marked browser left after stop (found ${after.join(', ')})`);
  } finally {
    try { if (rec.active) await rec.stop(); } catch (e) { /* best effort */ }
    try { rec.discard && rec.discard(); } catch (e) { /* best effort */ }
    app.server.close();
  }
});

process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
run('rc');
