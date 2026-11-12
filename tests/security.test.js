/**
 * OS-native credential storage (src/secretstore.js + the credential store in src/targets.js) and
 * session-file protection (src/auth.js). Pure Node, no browser, no network.
 *
 * Almost everything runs against REPLAYR_SECRETSTORE=memory. One test performs a REAL round trip
 * against the operating system's credential store with a throwaway account and always cleans up.
 *
 *   node tests/security.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-security-'));
process.env.RECORDER_LOGINS_FILE = path.join(tmpDir, 'logins.json');
process.env.RECORDER_ENVIRONMENTS_FILE = path.join(tmpDir, 'environments.json');
process.env.RECORDER_TESTS_DIR = path.join(tmpDir, 'tests');
process.env.REPLAYR_SECRETSTORE = 'memory';
delete process.env.REPLAYR_ALLOW_PLAINTEXT_CREDENTIALS;

const { test, assert, run } = require('./harness');
const secretstore = require('../src/secretstore');
const targets = require('../src/targets');
const config = require('../src/config');

const FILE = targets.CREDENTIALS_FILE;
const readFile = () => fs.readFileSync(FILE, 'utf8');
// Random per run so a leak into a file or message cannot be a coincidence, and nothing here is a real secret.
const pw = () => 'pw-' + crypto.randomBytes(9).toString('hex');

function reset() {
  secretstore._resetForTests();
  process.env.REPLAYR_SECRETSTORE = 'memory';
  delete process.env.REPLAYR_ALLOW_PLAINTEXT_CREDENTIALS;
  for (const f of fs.readdirSync(tmpDir)) if (f.startsWith('logins.json')) fs.rmSync(path.join(tmpDir, f), { force: true });
}

function captureWarn(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.warn = orig; }
  return lines;
}

test('create + retrieve: password goes to the store, the file holds metadata only', () => {
  reset();
  const url = 'https://app.example.com/studio';
  const secret = pw();
  targets.saveCredentials(url, ' alice ', secret);
  const raw = readFile();
  assert.excludes(raw, secret, 'no password in the JSON file');
  assert.notOk(/"password"/.test(raw), 'no password field in the JSON file');
  const meta = JSON.parse(raw)['https://app.example.com'];
  assert.equal(meta.username, 'alice', 'username kept as metadata');
  assert.equal(meta.store, 'keyring', 'marked as keyring-backed');
  assert.ok(meta.savedAt, 'savedAt recorded');
  assert.equal(secretstore.getSecret('https://app.example.com'), secret, 'password is in the credential store, account = origin');
  const got = targets.savedCredentials(url);
  assert.equal(got.username, 'alice', 'retrieved username');
  assert.equal(got.password, secret, 'retrieved password');
  assert.equal(targets.resolve(url).auth, true, 'auto-login switched on without reading the store');
});

test('update: a new password replaces the old one in the store', () => {
  reset();
  const url = 'https://upd.example.com';
  const a = pw(); const b = pw();
  targets.saveCredentials(url, 'bob', a);
  targets.saveCredentials(url, 'bob2', b);
  assert.equal(targets.savedCredentials(url).password, b, 'replaced');
  assert.equal(targets.savedCredentials(url).username, 'bob2', 'username replaced');
  assert.excludes(readFile(), b, 'still not in the file');
  assert.excludes(readFile(), a, 'old one not in the file either');
});

test('delete: forgetting removes the metadata and the stored password', () => {
  reset();
  const url = 'https://del.example.com';
  targets.saveCredentials(url, 'carol', pw());
  assert.equal(targets.forgetCredentials(url), true, 'forgotten');
  assert.equal(secretstore.getSecret('https://del.example.com'), null, 'secret gone from the store');
  assert.equal(targets.savedCredentials(url), null, 'no login');
  assert.equal(targets.forgetCredentials(url), false, 'second forget is a no-op');
  assert.equal(targets.resolve(url).auth, false, 'auto-login off again');
});

test('API surface: listings and resolved targets never carry a password', () => {
  reset();
  const secret = pw();
  targets.saveCredentials('https://list.example.com', 'dave', secret);
  const surface = JSON.stringify([targets.savedLoginOrigins(), targets.resolve('https://list.example.com'), targets.listEnvironments()]);
  assert.excludes(surface, secret, 'password absent');
  assert.includes(targets.savedLoginOrigins(), 'https://list.example.com', 'origin listed');
});

test('missing keyring: a save is refused with a clear 400 and nothing is written', () => {
  reset();
  process.env.REPLAYR_SECRETSTORE = 'unavailable';
  const secret = pw();
  let err = null;
  try { targets.saveCredentials('https://nokeyring.example.com', 'erin', secret); } catch (e) { err = e; }
  assert.ok(err, 'must throw');
  assert.equal(err.status, 400, '4xx status');
  assert.includes(err.message, 'REPLAYR_ALLOW_PLAINTEXT_CREDENTIALS=1', 'explains the explicit opt-in');
  assert.includes(err.message, 'credential store', 'explains the limitation');
  assert.excludes(err.message, secret, 'the error never echoes the password');
  assert.notOk(fs.existsSync(FILE), 'no credentials file created');
  assert.notOk(fs.existsSync(FILE + '.tmp'), 'no temp file left behind');
});

test('missing keyring + explicit opt-in: saved as marked plaintext with a loud warning', () => {
  reset();
  process.env.REPLAYR_SECRETSTORE = 'unavailable';
  process.env.REPLAYR_ALLOW_PLAINTEXT_CREDENTIALS = '1';
  const secret = pw();
  const warns = captureWarn(() => targets.saveCredentials('https://optin.example.com', 'fay', secret));
  assert.ok(warns.some((w) => /PLAINTEXT/.test(w)), 'loud warning logged');
  assert.excludes(warns.join('\n'), secret, 'warning does not leak the password');
  assert.equal(JSON.parse(readFile())['https://optin.example.com'].store, 'plaintext', 'entry is marked plaintext');
  assert.equal(targets.savedCredentials('https://optin.example.com').password, secret, 'still usable');
});

test('migration: a plaintext entry moves into the store and leaves the file', () => {
  reset();
  const secret = pw();
  fs.writeFileSync(FILE, JSON.stringify({
    'https://old.example.com': { username: 'gus', password: secret, savedAt: '2026-01-01T00:00:00.000Z' },
  }));
  const warns = captureWarn(() => {
    assert.equal(targets.savedCredentials('https://old.example.com').password, secret, 'still readable after migration');
  });
  assert.ok(warns.some((w) => /Moved 1 saved login/.test(w)), 'migration announced');
  assert.excludes(readFile(), secret, 'password removed from the file');
  assert.equal(JSON.parse(readFile())['https://old.example.com'].store, 'keyring', 'entry now keyring-backed');
  assert.equal(JSON.parse(readFile())['https://old.example.com'].username, 'gus', 'username kept');
  assert.equal(secretstore.getSecret('https://old.example.com'), secret, 'password is in the store');
});

test('migration with no keyring: file untouched, data kept, warning shown', () => {
  reset();
  process.env.REPLAYR_SECRETSTORE = 'unavailable';
  const secret = pw();
  const original = JSON.stringify({ 'https://keep.example.com': { username: 'hal', password: secret, savedAt: 'x' } });
  fs.writeFileSync(FILE, original);
  const warns = captureWarn(() => targets.savedLoginOrigins());
  assert.equal(readFile(), original, 'byte-for-byte unchanged');
  assert.ok(warns.length <= 1, 'warned at most once');
  assert.excludes(warns.join('\n'), secret, 'warning does not leak the password');
});

test('corrupt metadata file: set aside, never overwritten, new saves work', () => {
  reset();
  fs.writeFileSync(FILE, '{"https://x.example.com": {"username": "u", "store": "keyr');
  assert.equal(targets.savedLoginOrigins().length, 0, 'reads as empty');
  const warns = captureWarn(() => targets.saveCredentials('https://fresh.example.com', 'ivy', pw()));
  assert.ok(warns.some((w) => /kept as/.test(w)), 'set-aside announced');
  const aside = fs.readdirSync(tmpDir).filter((f) => f.startsWith('logins.json.corrupt-'));
  assert.equal(aside.length, 1, 'corrupt file preserved');
  assert.includes(fs.readFileSync(path.join(tmpDir, aside[0]), 'utf8'), 'x.example.com', 'old content intact');
  assert.equal(targets.savedCredentials('https://fresh.example.com').username, 'ivy', 'new login saved');
});

test('permission failure: unwritable file gives a clear error, no data loss, store rolled back', () => {
  reset();
  const url = 'https://perm.example.com';
  const first = pw();
  targets.saveCredentials(url, 'jo', first);
  const before = readFile();
  const dir = path.dirname(FILE);
  let undo;
  if (process.platform === 'win32') {
    fs.chmodSync(FILE, 0o444); // read-only attribute: rename over it fails with EPERM
    undo = () => fs.chmodSync(FILE, 0o666);
  } else if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return; // root ignores permissions; nothing reliable to simulate
  } else {
    fs.chmodSync(dir, 0o555); // no new files in the directory
    undo = () => fs.chmodSync(dir, 0o755);
  }
  let err = null;
  try { targets.saveCredentials(url, 'jo', pw()); } catch (e) { err = e; } finally { undo(); }
  assert.ok(err, 'must throw');
  assert.equal(err.status, 500, 'server-side failure status');
  assert.includes(err.message, 'Nothing was changed', 'says nothing was changed');
  assert.equal(readFile(), before, 'metadata file unchanged');
  assert.notOk(fs.existsSync(FILE + '.tmp'), 'temp file cleaned up');
  assert.equal(targets.savedCredentials(url).password, first, 'the previous password is still the stored one');
});

test('snapshot / restore: rolls a save back in the store as well as the file', () => {
  reset();
  const url = 'https://roll.example.com';
  const a = pw(); const b = pw();
  targets.saveCredentials(url, 'kim', a);
  const snap = targets.credentialSnapshot(url);
  targets.saveCredentials(url, 'kim', b);
  targets.restoreCredentials(url, snap);
  assert.equal(targets.savedCredentials(url).password, a, 'previous password restored');
  targets.restoreCredentials(url, null);
  assert.equal(secretstore.getSecret('https://roll.example.com'), null, 'null snapshot removes the secret');
  assert.equal(targets.savedCredentials(url), null, 'and the entry');
});

test('OPKEY_* in the credential store win over credentials.local.env / environment', () => {
  reset();
  const auth = require('../src/auth');
  const u = 'kc-' + crypto.randomBytes(3).toString('hex'); const p = pw();
  secretstore.setSecret('env:OPKEY_USERNAME', u);
  secretstore.setSecret('env:OPKEY_PASSWORD', p);
  const prevU = process.env.OPKEY_USERNAME; process.env.OPKEY_USERNAME = 'from-env';
  try {
    const got = auth.readCredentials('ui-shell');
    assert.equal(got.username, u, 'store value preferred over the environment');
    assert.equal(got.password, p, 'password from the store');
  } finally {
    if (prevU === undefined) delete process.env.OPKEY_USERNAME; else process.env.OPKEY_USERNAME = prevU;
  }
});

test('session files: encrypted at rest, round-trip, tamper detected, key is not on disk', async () => {
  reset();
  const auth = require('../src/auth');
  const key = 'sectest-' + crypto.randomBytes(3).toString('hex');
  targets.saveEnvironment({ key, baseUrl: 'http://127.0.0.1:59999', kind: 'local', auth: true });
  const file = config.authStateFor(key);
  const token = 'tok-' + crypto.randomBytes(9).toString('hex');
  const state = { cookies: [{ name: 'KEYCLOAK_SESSION', value: token, domain: '127.0.0.1', path: '/' }], origins: [] };
  try {
    await auth.saveState({ storageState: async () => state }, key);
    const raw = fs.readFileSync(file, 'utf8');
    assert.excludes(raw, token, 'session token is not readable in the file');
    assert.includes(raw, 'replayr-enc-v1', 'file is the encrypted envelope');
    assert.equal(auth.storageStateOption(key).storageState.cookies[0].value, token, 'decrypts to the original state');
    const doc = JSON.parse(raw);
    doc.data = Buffer.from(Buffer.from(doc.data, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64');
    fs.writeFileSync(file, JSON.stringify(doc));
    const warns = captureWarn(() => assert.equal(auth.storageStateOption(key), {}, 'tampered file yields no session'));
    assert.ok(warns.some((w) => /could not be decrypted/.test(w)), 'tamper warned');
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(file + '.tmp', { force: true });
  }
});

test('session files: with no keyring a session is not persisted (no silent plaintext)', async () => {
  reset();
  process.env.REPLAYR_SECRETSTORE = 'unavailable';
  const auth = require('../src/auth');
  const key = 'sectest-' + crypto.randomBytes(3).toString('hex');
  const file = config.authStateFor(key);
  const warns = await (async () => {
    const lines = []; const orig = console.warn; console.warn = (...a) => lines.push(a.join(' '));
    try { await auth.saveState({ storageState: async () => ({ cookies: [{ name: 'a', value: 'secret-cookie' }], origins: [] }) }, key); } finally { console.warn = orig; }
    return lines;
  })();
  try {
    assert.notOk(fs.existsSync(file), 'nothing written');
    assert.ok(warns.some((w) => /not saved/.test(w)), 'warned');
  } finally { fs.rmSync(file, { force: true }); }
});

test('restrictFile: only the current user keeps access', () => {
  reset();
  const f = path.join(tmpDir, 'restrict-me.json');
  fs.writeFileSync(f, '{}');
  assert.equal(secretstore.restrictFile(f), true, 'applied');
  if (process.platform === 'win32') {
    const out = spawnSync('icacls', [f], { encoding: 'utf8' }).stdout;
    assert.notOk(/Everyone|BUILTIN\\Users|Authenticated Users/i.test(out), 'no broad groups on the ACL');
    assert.includes(out.toLowerCase(), String(process.env.USERNAME).toLowerCase(), 'current user is on the ACL');
    assert.notOk(/\(I\)/.test(out), 'no inherited entries');
  } else {
    assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'mode 600');
  }
});

test('REAL OS credential store: set, get, update, delete a throwaway account', () => {
  const child = [
    "const s = require(" + JSON.stringify(path.join(__dirname, '..', 'src', 'secretstore.js')) + ");",
    "const acct = 'test-' + require('crypto').randomBytes(5).toString('hex');",
    "const a = require('crypto').randomBytes(9).toString('hex') + '\\u00e4\"\\\\ $x';",
    "const b = require('crypto').randomBytes(9).toString('hex');",
    "const out = { backend: s.backend(), ok: s.available().ok, steps: {} };",
    "try {",
    "  if (!out.ok) { out.skipped = s.available().reason; }",
    "  else {",
    "    s.setSecret(acct, a);        out.steps.set = true;",
    "    s._resetForTests();          out.steps.get = s.getSecret(acct) === a;",
    "    s.setSecret(acct, b);        s._resetForTests(); out.steps.update = s.getSecret(acct) === b;",
    "    out.steps.delete = s.deleteSecret(acct) === true;",
    "    s._resetForTests();          out.steps.gone = s.getSecret(acct) === null;",
    "  }",
    "} catch (e) { out.error = String(e.message).slice(0, 120); }",
    "finally { try { s.deleteSecret(acct); } catch (e) {} }",
    "process.stdout.write(JSON.stringify(out));",
  ].join('\n');
  const env = { ...process.env };
  delete env.REPLAYR_SECRETSTORE;
  const res = spawnSync(process.execPath, ['-e', child], { env, encoding: 'utf8', timeout: 120_000 });
  let out;
  try { out = JSON.parse(res.stdout); } catch (e) { out = null; }
  assert.ok(out, 'child produced a result (status ' + res.status + ')');
  if (!out.ok) {
    process.stdout.write(`      (no OS credential store on this machine: ${out.skipped} - not exercised)\n`);
    return;
  }
  assert.equal(out.error, undefined, 'no error from the OS store');
  assert.equal(out.steps, { set: true, get: true, update: true, delete: true, gone: true }, `all steps on ${out.backend}`);
});

run('security');
