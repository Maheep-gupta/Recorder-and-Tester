/**
 * Login automation (src/auth.js) against a MOCK Keycloak-style login flow.
 *
 *   node tests/auth.test.js            (run from the repo root)
 *
 * WHAT THIS PROVES: Replayr's own automation - selectors, redirect handling, session reuse,
 * renewal, per-environment storage state, failure reporting - behaves correctly against a faithful
 * mock (tests/fixtures/mock-keycloak.js).
 * WHAT IT CANNOT PROVE: anything about a real Keycloak (real tenant/realm config, MFA policy, token
 * lifetimes, cross-domain SSO, the real app). Those stay BLOCKED until an authorised environment
 * and test account exist.
 *
 * Safety: every server is 127.0.0.1/localhost on a random port started here; RECORDER_* paths and
 * the saved-session directory are temp dirs; the credential store is forced to memory/temp. No
 * credential value is printed. The failure scenarios are slow by nature (auth.js waits 60 s for a
 * redirect that never comes), so they run CONCURRENTLY, started up front.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'replayr-auth-'));
const AUTH_DIR = path.join(TMP, 'auth-state');
const TESTS_DIR = path.join(TMP, 'tests');
process.env.REPLAYR_SECRETSTORE = 'memory';
process.env.RECORDER_LOGINS_FILE = path.join(TMP, 'logins.json');
process.env.RECORDER_TESTS_DIR = TESTS_DIR;
process.env.RECORDER_ENVIRONMENTS_FILE = path.join(TMP, 'environments.json');
process.env.RECORDER_HEADLESS_RUN = '1';
// Never let the host's real OPKEY_* credentials leak into a mock login.
for (const k of Object.keys(process.env)) if (/^OPKEY_/.test(k)) delete process.env[k];

const { test, assert, run } = require('./harness');
const { startMockKeycloak } = require('./fixtures/mock-keycloak');
const config = require('../src/config');
const targets = require('../src/targets');
const auth = require('../src/auth');
const storage = require('../src/storage');
const execution = require('../src/execution');

// Same file naming as the real config.authStateFor, but inside the temp dir.
const realAuthStateFor = config.authStateFor;
config.authStateFor = function (app) { return path.join(AUTH_DIR, path.basename(realAuthStateFor.call(this, app))); };

const GOOD = 'Gd-7fQ!pw-mock-only';
const BAD = 'Bd-3zX!wrong-mock-only';
const GOOD_B = 'Gb-2kM!pw-mock-only-B';
const SLOW_BOUND_MS = 150_000;

// ─────────────────────────────────────────────────────────────── helpers

const typed = (m) => `url:${m.url}`;
const stateFile = (app) => config.authStateFor(app);
// Session files are AES-GCM encrypted at rest (src/auth.js); read them back through the public API.
const rawState = (app) => fs.readFileSync(stateFile(app), 'utf8');
const readState = (app) => {
  const doc = JSON.parse(rawState(app));
  if (doc && doc.format === 'replayr-enc-v1') return auth.storageStateOption(app).storageState;
  return doc;
};
const cookieVal = (state, name) => { const c = state.cookies.find((x) => x.name === name); return c ? c.value : null; };

function withTimeout(p, ms, label) {
  let t;
  const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} exceeded its ${ms} ms bound`)), ms); });
  return Promise.race([p, guard]).finally(() => clearTimeout(t));
}

function dirText(dir) {
  let out = '';
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out += dirText(p);
    else out += fs.readFileSync(p, 'utf8') + '\n';
  }
  return out;
}

async function withMock(opts, fn) {
  const m = await startMockKeycloak(opts);
  try { return await fn(m); } finally { await m.close().catch(() => {}); }
}

/** Run an async job, never throw: the slow scenarios report their own outcome later. */
function settle(p) { return p.then((value) => ({ value }), (error) => ({ error })); }

async function timed(label, fn) {
  const t0 = Date.now();
  const value = await fn();
  const ms = Date.now() - t0;
  console.log(`      [timing] ${label}: ${ms} ms`);
  return { value, ms };
}

let seq = 0;
const uniq = (label) => `auth ${label} ${process.pid}-${++seq}`;
const note = (msg) => console.log(`      [finding] ${msg}`);

// ─────────────────────────────────────────────────────────────── slow scenarios (concurrent)

const jobs = {};

// 2. wrong password on a typed URL
jobs.wrongPassword = settle(withTimeout(withMock({ password: GOOD }, async (m) => {
  targets.saveCredentials(m.url, 'tester', BAD);
  const app = typed(m);
  const { value: res, ms } = await timed('wrong password -> failure', () => auth.ensureSession(app));
  return { res, ms, app, stats: { ...m.stats }, fileExists: fs.existsSync(stateFile(app)) };
}), SLOW_BOUND_MS, 'wrong-password scenario'));

// 5b. a good login, server-side expiry, then the saved password turns out wrong
jobs.expiredBadCreds = settle(withTimeout(withMock({ password: GOOD }, async (m) => {
  const app = typed(m);
  targets.saveCredentials(m.url, 'tester', GOOD);
  const first = await auth.ensureSession(app);
  const before = fs.existsSync(stateFile(app)) ? fs.readFileSync(stateFile(app), 'utf8') : null;
  m.invalidate();
  targets.saveCredentials(m.url, 'tester', BAD);
  const { value: res, ms } = await timed('expired session + wrong creds -> failure', () => auth.ensureSession(app));
  const after = fs.existsSync(stateFile(app)) ? fs.readFileSync(stateFile(app), 'utf8') : null;
  return { first, res, ms, before, after, stats: { ...m.stats } };
}), SLOW_BOUND_MS, 'expired+bad-creds scenario'));

// 6. MFA page
jobs.mfa = settle(withTimeout(withMock({ password: GOOD, mfa: true }, async (m) => {
  const app = typed(m);
  targets.saveCredentials(m.url, 'tester', GOOD);
  const { value: res, ms } = await timed('MFA page -> failure', () => auth.ensureSession(app));
  return { res, ms, stats: { ...m.stats }, fileExists: fs.existsSync(stateFile(app)) };
}), SLOW_BOUND_MS, 'MFA scenario'));

// 8b. replay with auth required and bad credentials
jobs.replayBad = settle(withTimeout(withMock({ password: GOOD }, async (m) => {
  const app = typed(m);
  targets.saveCredentials(m.url, 'tester', BAD);
  const t = storage.create({
    name: uniq('replay bad creds'),
    target: { app },
    steps: [{ type: 'navigate', url: '{{baseUrl}}/dashboard' }, { type: 'expectUrl', url: '{{baseUrl}}/dashboard' }],
  });
  const { value: result, ms } = await timed('runTest with bad creds -> blocked', () => execution.runTest(storage.load(t.id), { headed: false }));
  return { result, ms, stats: { ...m.stats }, fileExists: fs.existsSync(stateFile(app)) };
}), SLOW_BOUND_MS, 'replay bad-creds scenario'));

// ─────────────────────────────────────────────────────────────── scenarios

test('0  Replayr keeps one saved-session file per environment key (config.authStateFor)', () => {
  const a = realAuthStateFor.call(config, 'url:http://127.0.0.1:1111');
  const b = realAuthStateFor.call(config, 'url:http://127.0.0.1:2222');
  const c = realAuthStateFor.call(config, 'qa1');
  assert.equal(new Set([a, b, c, config.authStatePath]).size, 4, 'distinct origins/keys map to distinct files, none is the ui-shell file');
  assert.equal(realAuthStateFor.call(config, 'ui-shell'), config.authStatePath, 'ui-shell keeps its historic path');
  const x = realAuthStateFor.call(config, 'url:http://a.b');
  const y = realAuthStateFor.call(config, 'url:http://a_b');
  if (x === y) note('P2 config.authStateFor: "url:http://a.b" and "url:http://a_b" sanitise to the same file name (collision)');
});

test('1  successful login: renewed, state written for THAT environment only, holds the session cookie', async () => {
  await withMock({ password: GOOD }, async (m) => {
    targets.saveCredentials(m.url, 'tester', GOOD);
    const app = typed(m);
    const { value: res } = await timed('successful login', () => withTimeout(auth.ensureSession(app), 90_000, 'login'));
    assert.equal(res.status, 'renewed', `unexpected status: ${res.status} / ${res.message}`);
    assert.ok(fs.existsSync(stateFile(app)), 'state file written');
    // Other scenarios run concurrently in the same dir, so assert on this key's file, not a dir diff.
    // Typed `url:` keys carry a hash of the full key so two URLs never share a session file.
    assert.match(path.basename(stateFile(app)), /^url_http___127_0_0_1_\d+-[0-9a-f]{12}\.json$/, 'file is named for this environment key');
    const st = readState(app);
    const c = st.cookies.find((x) => x.name === 'APP_SESSION');
    assert.ok(c && c.value, 'session cookie persisted in the state file');
    assert.equal(c.httpOnly, true, 'the HttpOnly cookie is captured');
    assert.equal(m.stats.logins, 1, 'one login');
    assert.excludes(JSON.stringify(st), GOOD, 'password is not in the state');
    assert.excludes(rawState(app), c.value, 'session cookie is not readable in the file on disk (encrypted)');
    assert.equal(auth.hasSavedState(app), true);
  });
});

test('2  wrong password: login-failed, no session file, password nowhere in message or files', async () => {
  const r = await jobs.wrongPassword;
  assert.ok(!r.error, r.error && r.error.message);
  const { res, ms, stats, fileExists } = r.value;
  assert.equal(res.status, 'login-failed', `status ${res.status}`);
  assert.ok(ms < SLOW_BOUND_MS, 'bounded');
  assert.equal(fileExists, false, 'no session file written after a failed login');
  assert.equal(stats.failedLogins, 1, 'exactly one attempt, no retry loop');
  assert.equal(stats.logins, 0);
  const everything = res.message + dirText(AUTH_DIR) + dirText(TESTS_DIR);
  assert.excludes(everything, BAD, 'wrong password leaked');
  assert.excludes(everything, GOOD, 'real password leaked');
  if (!/password|credential|invalid|incorrect/i.test(res.message)) {
    note(`P2 auth.js:134-135 a wrong password is reported only as "${res.message.slice(0, 90)}" - the IdP's own error (#input-error) is never read, so the cause is not stated`);
  }
  if (ms > 30_000) note(`P1 auth.js:132 a wrong password costs ${Math.round(ms / 1000)} s before it is reported (waitForURL 60 s; the visible Keycloak error is not polled)`);
});

test('3  missing credentials: missing-credentials with an actionable message (user environment, auth:true)', async () => {
  await withMock({ password: GOOD }, async (m) => {
    const key = `nocred-${process.pid}`;
    targets.saveEnvironment({ key, label: 'No creds', baseUrl: m.url, kind: 'local', auth: true });
    const { value: res, ms } = await timed('missing credentials', () => withTimeout(auth.ensureSession(key), 90_000, 'missing creds'));
    assert.equal(res.status, 'missing-credentials');
    assert.match(res.message, /username and password/i, 'tells the user what to do');
    assert.match(res.message, /Setup/i, 'tells the user where');
    assert.equal(fs.existsSync(stateFile(key)), false, 'nothing saved');
    assert.equal(m.stats.logins + m.stats.failedLogins, 0, 'no login attempted');
    assert.ok(ms < 60_000);
    // A typed URL equal to a saved environment IS that environment (same auth flag, same result).
    assert.equal((await auth.ensureSession(typed(m))).status, 'missing-credentials');
  });
  // A purely typed URL with no saved login is intentionally "no auth": the page opens as-is.
  await withMock({ password: GOOD }, async (m2) => {
    assert.equal((await auth.ensureSession(typed(m2))).status, 'no-auth-needed');
  });
});

test('4  a valid saved session is reused: no second login', async () => {
  await withMock({ password: GOOD }, async (m) => {
    targets.saveCredentials(m.url, 'tester', GOOD);
    const app = typed(m);
    const first = await auth.ensureSession(app);
    assert.equal(first.status, 'renewed');
    const { value: second } = await timed('reuse saved session', () => withTimeout(auth.ensureSession(app), 90_000, 'reuse'));
    assert.equal(second.status, 'valid', second.message);
    assert.equal(m.stats.logins, 1, 'still exactly one login');
    assert.equal(m.stats.authPageHits, 1, 'the login page was only ever shown once');
    assert.ok(Object.keys(auth.storageStateOption(app)).includes('storageState'), 'replay would load the saved state');
  });
});

test('5a expired session (server-side): automatic re-login, renewed, new cookie saved', async () => {
  await withMock({ password: GOOD }, async (m) => {
    targets.saveCredentials(m.url, 'tester', GOOD);
    const app = typed(m);
    assert.equal((await auth.ensureSession(app)).status, 'renewed');
    const oldCookie = cookieVal(readState(app), 'APP_SESSION');
    m.invalidate();
    const { value: res } = await timed('expired -> re-login', () => withTimeout(auth.ensureSession(app), 90_000, 're-login'));
    assert.equal(res.status, 'renewed', res.message);
    assert.equal(m.stats.logins, 2);
    const newCookie = cookieVal(readState(app), 'APP_SESSION');
    assert.ok(newCookie && newCookie !== oldCookie, 'a fresh session cookie replaced the dead one');
  });
});

test('5b expired session + wrong saved credentials: clear failure, old state not overwritten', async () => {
  const r = await jobs.expiredBadCreds;
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(r.value.first.status, 'renewed');
  assert.equal(r.value.res.status, 'login-failed', r.value.res.status);
  assert.equal(r.value.stats.failedLogins, 1, 'one failed attempt, no loop');
  assert.equal(r.value.after, r.value.before, 'the failed renewal did not touch the saved state');
  assert.excludes(r.value.res.message, BAD);
  assert.excludes(r.value.res.message, GOOD);
});

test('5c identity-provider session alive but app session gone: silent re-auth, no form, state refreshed', async () => {
  await withMock({ password: GOOD }, async (m) => {
    targets.saveCredentials(m.url, 'tester', GOOD);
    const app = typed(m);
    assert.equal((await auth.ensureSession(app)).status, 'renewed');
    const oldCookie = cookieVal(readState(app), 'APP_SESSION');
    m.invalidate({ sso: false });
    const res = await withTimeout(auth.ensureSession(app), 90_000, 'sso reauth');
    assert.equal(res.status, 'valid', res.message);
    assert.equal(m.stats.logins, 1, 'credentials were not typed again');
    assert.notEqual(cookieVal(readState(app), 'APP_SESSION'), oldCookie, 'state file holds the refreshed cookie');
  });
});

test('6  MFA page: login-failed, no bypass attempt, no loop, bounded, no state saved', async () => {
  const r = await jobs.mfa;
  assert.ok(!r.error, r.error && r.error.message);
  const { res, ms, stats, fileExists } = r.value;
  assert.equal(res.status, 'login-failed', `status ${res.status}`);
  assert.equal(stats.otpPages, 1, 'the OTP page was shown once (password accepted)');
  assert.equal(stats.otpSubmits, 0, 'auth.js never submitted anything on the OTP page');
  assert.equal(stats.logins, 0, 'no session was granted');
  assert.equal(fileExists, false, 'no state saved for a half-finished login');
  assert.ok(ms < SLOW_BOUND_MS);
  assert.excludes(res.message, GOOD);
  if (!/otp|two-factor|mfa|authenticator|one-time/i.test(res.message)) {
    note(`P2 auth.js:134-135 an OTP/MFA page is reported as "${res.message.slice(0, 90)}" - it never says a second factor is required, and takes ${Math.round(ms / 1000)} s`);
  }
});

test('7  environment isolation: env A session/cookies never reach env B', async () => {
  await withMock({ password: GOOD }, async (a) => withMock({ password: GOOD_B, username: 'tester-b' }, async (b) => {
    const ka = `iso-a-${process.pid}`;
    const kb = `iso-b-${process.pid}`;
    targets.saveEnvironment({ key: ka, label: 'A (prod-like)', baseUrl: a.url, kind: 'staging', auth: true });
    targets.saveEnvironment({ key: kb, label: 'B (local-like)', baseUrl: b.url, kind: 'local', auth: true });
    targets.saveCredentials(a.url, 'tester', GOOD);
    targets.saveCredentials(b.url, 'tester-b', GOOD_B);

    assert.equal((await auth.ensureSession(ka)).status, 'renewed');
    const stA = readState(ka);
    const sidA = cookieVal(stA, 'APP_SESSION');
    const ssoA = cookieVal(stA, 'KEYCLOAK_SESSION');
    assert.ok(sidA && ssoA);
    assert.equal(auth.storageStateOption(kb), {}, 'B has no saved state, so a B context starts empty');
    assert.notEqual(stateFile(ka), stateFile(kb));

    const resB = await withTimeout(auth.ensureSession(kb), 90_000, 'env B login');
    assert.equal(resB.status, 'renewed', 'B had to log in itself: ' + resB.message);
    assert.equal(b.stats.logins, 1);
    assert.equal(b.stats.failedLogins, 0, "A's credentials were never tried on B");
    const stB = readState(kb);
    for (const entry of b.log) {
      assert.excludes(entry.cookie, sidA, `A's app session reached B (${entry.srv} ${entry.path})`);
      assert.excludes(entry.cookie, ssoA, `A's SSO session reached B (${entry.srv} ${entry.path})`);
    }
    for (const entry of a.log) assert.excludes(entry.cookie, cookieVal(stB, 'APP_SESSION'), "B's session reached A");
    assert.excludes(JSON.stringify(stB), sidA, "A's cookie is not in B's state file");
    assert.excludes(JSON.stringify(stB), ssoA, "A's SSO cookie is not in B's state file");
    assert.excludes(JSON.stringify(readState(ka)), cookieVal(stB, 'APP_SESSION'), "B's cookie is not in A's state file");
    // Credentials are per origin as well.
    assert.equal(targets.savedCredentials(a.url).username, 'tester');
    assert.equal(targets.savedCredentials(b.url).username, 'tester-b');
  }));
});

test('8a replay through execution.runTest with auth required and good credentials: passes, session reused on the next run', async () => {
  await withMock({ password: GOOD }, async (m) => {
    const app = typed(m);
    targets.saveCredentials(m.url, 'tester', GOOD);
    const t = storage.create({
      name: uniq('replay good creds'),
      target: { app },
      steps: [{ type: 'navigate', url: '{{baseUrl}}/dashboard' }, { type: 'expectUrl', url: '{{baseUrl}}/dashboard' }],
    });
    const { value: r1 } = await timed('runTest good creds (login)', () => withTimeout(execution.runTest(storage.load(t.id), { headed: false }), 120_000, 'replay'));
    assert.equal(r1.status, 'passed', `status ${r1.status} reason ${r1.reason} error ${r1.error}`);
    assert.ok((r1.notes || []).some((n) => /renewed/i.test(n)), 'run notes say the session was renewed');
    assert.equal(m.stats.logins, 1);
    const { value: r2 } = await timed('runTest good creds (reuse)', () => withTimeout(execution.runTest(storage.load(t.id), { headed: false }), 120_000, 'replay 2'));
    assert.equal(r2.status, 'passed', `status ${r2.status} reason ${r2.reason}`);
    assert.equal(m.stats.logins, 1, 'second run reused the saved session');
    assert.excludes(dirText(TESTS_DIR), GOOD, 'password not in any run evidence');
  });
});

test('8b replay with auth required and BAD credentials: blocked / auth_failed, nothing replayed', async () => {
  const r = await jobs.replayBad;
  assert.ok(!r.error, r.error && r.error.message);
  const { result, stats, fileExists } = r.value;
  assert.equal(result.status, 'blocked', `status ${result.status}`);
  assert.equal(result.reason, 'auth_failed');
  assert.match(String(result.error), /logged out|sign in|login/i);
  assert.equal(fileExists, false);
  assert.equal(stats.failedLogins, 1, 'no retry loop');
  assert.excludes(JSON.stringify(result), BAD, 'password not in the run result');
  assert.excludes(JSON.stringify(result), GOOD);
  assert.equal(result.steps.filter((s) => s.status === 'passed').length, 0, 'no step ran while logged out');
});

test('9  app that boots empty and redirects to the IdP from script is NOT mistaken for a valid session', async () => {
  await withMock({ password: GOOD, clientRedirect: true }, async (m) => {
    targets.saveCredentials(m.url, 'tester', GOOD);
    const res = await withTimeout(auth.ensureSession(typed(m)), 90_000, 'client redirect');
    assert.equal(res.status, 'renewed', res.message);
    assert.equal(m.stats.logins, 1);
  });
});

test('10 slow login (3 s) still succeeds', async () => {
  await withMock({ password: GOOD, loginDelayMs: 3000 }, async (m) => {
    targets.saveCredentials(m.url, 'tester', GOOD);
    const { value: res, ms } = await timed('slow login', () => withTimeout(auth.ensureSession(typed(m)), 90_000, 'slow login'));
    assert.equal(res.status, 'renewed', res.message);
    assert.ok(ms >= 3000);
  });
});

test('11 app unreachable is reported as app-unreachable, quickly', async () => {
  const m = await startMockKeycloak({});
  const url = m.url;
  await m.close();
  targets.saveCredentials(url, 'tester', GOOD);
  const { value: res, ms } = await timed('unreachable app', () => withTimeout(auth.ensureSession(`url:${url}`), 90_000, 'unreachable'));
  assert.equal(res.status, 'app-unreachable', res.message);
  assert.ok(ms < 60_000);
  assert.excludes(res.message, GOOD);
});

// The slow jobs started at module load: make sure none can outlive the run.
run('auth (mock Keycloak)').then(async () => {
  await Promise.all(Object.values(jobs));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
});
