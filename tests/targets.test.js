/**
 * Typed application URLs and the logins saved for them (src/targets.js). Pure Node, no browser.
 *
 *   node tests/targets.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the login store at a throwaway file BEFORE targets.js is loaded.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-targets-'));
process.env.RECORDER_LOGINS_FILE = path.join(tmpDir, 'logins.json');
process.env.RECORDER_ENVIRONMENTS_FILE = path.join(tmpDir, 'environments.json');
process.env.RECORDER_TESTS_DIR = path.join(tmpDir, 'tests');
// Passwords go to the OS credential store; tests must never touch the real one.
process.env.REPLAYR_SECRETSTORE = 'memory';

const { test, assert, run } = require('./harness');
const config = require('../src/config');
const targets = require('../src/targets');

function throwsStatus(fn, status, what) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, `${what}: should throw`);
  assert.equal(err && err.status, status, `${what}: status`);
  return err;
}

test('normaliseUrl: trims, drops the fragment and trailing slashes', () => {
  assert.equal(targets.normaliseUrl('  https://example.com/studio/#/x  '), 'https://example.com/studio', 'path kept, hash dropped');
  assert.equal(targets.normaliseUrl('http://localhost:9000/'), 'http://localhost:9000', 'root');
  assert.equal(targets.normaliseUrl('http://localhost:9000/app?tenant=a'), 'http://localhost:9000/app?tenant=a', 'query kept');
});

test('normaliseUrl: refuses anything that is not a plain http(s) URL', () => {
  throwsStatus(() => targets.normaliseUrl(''), 400, 'empty');
  throwsStatus(() => targets.normaliseUrl('localhost:4201'), 400, 'no scheme');
  throwsStatus(() => targets.normaliseUrl('not a url'), 400, 'garbage');
  throwsStatus(() => targets.normaliseUrl('ftp://example.com'), 400, 'ftp');
  throwsStatus(() => targets.normaliseUrl('file:///C:/Windows'), 400, 'file');
  throwsStatus(() => targets.normaliseUrl('javascript:alert(1)'), 400, 'javascript');
  throwsStatus(() => targets.normaliseUrl('https://bob:secret@example.com'), 400, 'credentials in the URL');
});

test('resolve: a configured key is that app, unchanged', () => {
  const def = targets.resolve('ui-shell');
  assert.equal(def.key, 'ui-shell', 'key');
  assert.equal(def.baseUrl, config.apps['ui-shell'].baseUrl, 'baseUrl');
  assert.equal(def.custom, false, 'not custom');
  assert.equal(targets.resolve('').key, config.defaultApp, 'empty means the default app');
});

test('resolve: an unknown plain key is null, not a guess', () => {
  assert.equal(targets.resolve('no-such-app'), null, 'unknown key');
  throwsStatus(() => targets.require('no-such-app'), 400, 'require() on an unknown key');
});

test('resolve: a typed URL equal to a configured app IS that app', () => {
  const base = config.apps['ui-shell'].baseUrl;
  assert.equal(targets.resolve(base + '/').key, 'ui-shell', 'bare URL with trailing slash');
  assert.equal(targets.resolve('url:' + base).key, 'ui-shell', 'url: key');
});

test('resolve: any other URL becomes a url: target with no login', () => {
  const def = targets.resolve('http://127.0.0.1:5999/my-app/');
  assert.equal(def.key, 'url:http://127.0.0.1:5999/my-app', 'canonical key');
  assert.equal(def.baseUrl, 'http://127.0.0.1:5999/my-app', 'baseUrl');
  assert.equal(def.label, '127.0.0.1:5999/my-app', 'label');
  assert.equal(def.custom, true, 'custom');
  assert.equal(def.auth, false, 'no login without saved credentials');
  assert.equal(targets.resolve(def.key).key, def.key, 'the key resolves to itself');
  throwsStatus(() => targets.resolve('url:ftp://x'), 400, 'a bad url: key');
});

test('credentials: saved per origin, switch login on, never listed with values', () => {
  const url = 'https://env-a.example.com/studio';
  targets.saveCredentials(url, ' alice ', 'pw1');
  assert.equal(targets.resolve(url).auth, true, 'a saved login turns auto-login on');
  assert.equal(targets.resolve('https://env-a.example.com/other').auth, true, 'same origin, other path');
  assert.equal(targets.resolve('https://env-b.example.com').auth, false, 'another origin is unaffected');
  const got = targets.savedCredentials(url);
  assert.equal(got.username, 'alice', 'username trimmed');
  assert.equal(got.password, 'pw1', 'password kept exactly');
  assert.ok(targets.savedLoginOrigins().includes('https://env-a.example.com'), 'origin listed');
  assert.excludes(JSON.stringify(targets.savedLoginOrigins()), 'pw1', 'no password in the listing');
});

test('credentials: replace, refuse half a login, forget', () => {
  const url = 'https://env-c.example.com';
  targets.saveCredentials(url, 'bob', 'old');
  targets.saveCredentials(url, 'bob', 'new');
  assert.equal(targets.savedCredentials(url).password, 'new', 'replaced');
  throwsStatus(() => targets.saveCredentials(url, 'bob', ''), 400, 'no password');
  throwsStatus(() => targets.saveCredentials(url, '  ', 'x'), 400, 'no username');
  assert.equal(targets.forgetCredentials(url), true, 'forgotten');
  assert.equal(targets.savedCredentials(url), null, 'gone');
  assert.equal(targets.forgetCredentials(url), false, 'forgetting twice is a no-op');
});

test('credentials: a corrupt store reads as empty instead of crashing', () => {
  fs.writeFileSync(targets.CREDENTIALS_FILE, '{not json');
  assert.equal(targets.savedCredentials('https://env-a.example.com'), null, 'no login');
  assert.equal(targets.savedLoginOrigins().length, 0, 'nothing listed');
});

function corruptSiblings(file) {
  const base = path.basename(file) + '.corrupt-';
  return fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(base));
}

test('kind: config apps and typed URLs are classified', () => {
  assert.equal(targets.resolve('ui-shell').kind, 'local', 'ui-shell');
  assert.equal(targets.resolve('concierge').kind, 'local', 'concierge');
  assert.equal(targets.resolve('qa1').kind, 'staging', 'qa1');
  assert.equal(targets.resolve('qa1').source, 'config', 'config source');
  assert.equal(targets.resolve('http://localhost:5000').kind, 'local', 'localhost');
  assert.equal(targets.resolve('http://127.0.0.1:5000').kind, 'local', '127.0.0.1');
  assert.equal(targets.resolve('http://[::1]:5000').kind, 'local', 'ipv6 loopback');
  assert.equal(targets.resolve('http://app.localhost:5000').kind, 'local', '*.localhost');
  const prod = targets.resolve('https://studio.example.com/x');
  assert.equal(prod.kind, 'production', 'any other host is production');
  assert.equal(prod.source, 'typed', 'typed source');
});

test('protected: production, remote or flagged; local is not', () => {
  assert.equal(targets.resolve('qa1').protected, true, 'remote config app');
  assert.equal(targets.resolve('ui-shell').protected, false, 'local config app');
  assert.equal(targets.resolve('https://studio.example.com').protected, true, 'typed production URL');
  assert.equal(targets.resolve('http://localhost:5000').protected, false, 'typed local URL');
});

test('environments: save, list, resolve, replace, delete', () => {
  const file = targets.environmentsFile();
  assert.equal(file, process.env.RECORDER_ENVIRONMENTS_FILE, 'isolated file');
  const saved = targets.saveEnvironment({ key: 'my-prod', label: 'My Prod', baseUrl: 'https://prod.example.com/studio/', kind: 'production', auth: true });
  assert.equal(saved.key, 'my-prod', 'key');
  assert.equal(saved.baseUrl, 'https://prod.example.com/studio', 'baseUrl normalised');
  assert.equal(saved.protected, true, 'production is protected');
  assert.equal(saved.source, 'user', 'source');
  targets.saveEnvironment({ key: 'my-dev', baseUrl: 'http://localhost:9100', kind: 'development' });
  const keys = targets.listEnvironments().map((e) => e.key);
  assert.before(keys, 'ui-shell', 'my-prod', 'config apps first');
  assert.before(keys, 'my-prod', 'my-dev', 'user envs in order');
  const dev = targets.resolve('my-dev');
  assert.equal(dev.label, 'my-dev', 'label defaults to key');
  assert.equal(dev.protected, false, 'development is unprotected');
  assert.equal(targets.resolve('my-prod').kind, 'production', 'resolve finds user env');
  const flagged = targets.saveEnvironment({ key: 'my-dev', baseUrl: 'http://localhost:9100', kind: 'development', protected: true });
  assert.equal(flagged.protected, true, 'explicit protected wins');
  assert.equal(targets.listEnvironments().filter((e) => e.key === 'my-dev').length, 1, 'replaced, not duplicated');
  assert.excludes(JSON.stringify(targets.listEnvironments()), 'password', 'no credentials in the listing');
  assert.equal(targets.deleteEnvironment('my-dev'), true, 'deleted');
  assert.equal(targets.deleteEnvironment('my-dev'), false, 'second delete is a no-op');
  assert.equal(targets.resolve('my-dev'), null, 'gone');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1, 'file shape');
  targets.deleteEnvironment('my-prod');
});

test('environments: bad input is a 400', () => {
  throwsStatus(() => targets.saveEnvironment({ key: 'Bad Key', baseUrl: 'http://x.test' }), 400, 'bad key');
  throwsStatus(() => targets.saveEnvironment({ key: 'ui-shell', baseUrl: 'http://x.test' }), 400, 'collides with a config app');
  throwsStatus(() => targets.saveEnvironment({ key: 'ok', baseUrl: 'ftp://x.test' }), 400, 'bad url');
  throwsStatus(() => targets.saveEnvironment({ key: 'ok', baseUrl: 'http://x.test', kind: 'weird' }), 400, 'bad kind');
  throwsStatus(() => targets.saveEnvironment(null), 400, 'not an object');
  throwsStatus(() => targets.deleteEnvironment('qa1'), 400, 'config app cannot be deleted');
});

test('environments: a corrupt file is preserved, not overwritten', () => {
  const file = targets.environmentsFile();
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.equal(targets.listEnvironments().length, Object.keys(config.apps).length, 'starts empty');
  const kept = corruptSiblings(file);
  assert.equal(kept.length, 1, 'corrupt file set aside');
  assert.equal(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8'), '{ this is not json', 'content intact');
  targets.saveEnvironment({ key: 'after', baseUrl: 'http://localhost:1' });
  assert.equal(targets.resolve('after').key, 'after', 'new file works');
  targets.deleteEnvironment('after');
});

test('credentials: a corrupt file is preserved before the next save', () => {
  const file = targets.CREDENTIALS_FILE;
  fs.writeFileSync(file, '{"https://old.example.com": {"username": "u", "password": "p"');
  targets.saveCredentials('https://new.example.com', 'carol', 'pw');
  const kept = corruptSiblings(file);
  assert.equal(kept.length, 1, 'corrupt file set aside');
  assert.includes(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8'), 'old.example.com', 'old logins recoverable');
  assert.equal(targets.savedCredentials('https://new.example.com').username, 'carol', 'new login saved');
});

test('credentials: snapshot and restore roll a save back', () => {
  const url = 'https://rollback.example.com';
  assert.equal(targets.credentialSnapshot(url), null, 'nothing yet');
  targets.saveCredentials(url, 'a', 'b');
  const snap = targets.credentialSnapshot(url);
  targets.saveCredentials(url, 'a', 'changed');
  targets.restoreCredentials(url, snap);
  assert.equal(targets.savedCredentials(url).password, 'b', 'previous restored');
  targets.restoreCredentials(url, null);
  assert.equal(targets.savedCredentials(url), null, 'removed when there was none');
});

test('environments: application names keep their letters and collapse whitespace', () => {
  const def = targets.saveEnvironment({ key: 'apps-check', label: 'X', baseUrl: 'http://localhost:9911', kind: 'local', application: '  Admin   Consoles  ' });
  assert.equal(def.application, 'Admin Consoles', 'no letter lost, spaces collapsed');
  assert.equal(targets.saveEnvironment({ key: 'apps-check', baseUrl: 'http://localhost:9911' }).application, 'Default', 'blank → Default');
  targets.deleteEnvironment('apps-check');
});

test('storage: the environments store and the draft are never listed, loaded or overwritten as tests', () => {
  const storage = require('../src/storage');
  const dir = config.testsDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'environments.json'), '{"version":1,"environments":[]}');
  fs.writeFileSync(path.join(dir, '.draft.json'), '{}');
  const t = storage.create({ name: 'Environments', target: { app: 'ui-shell' }, steps: [{ type: 'navigate', url: '{{baseUrl}}/' }] });
  assert.equal(t.id, 'environments-2', 'a test named Environments does not take the file of the store');
  assert.equal(JSON.stringify(storage.list().map((x) => x.id)), '["environments-2"]', 'only real tests are listed');
  let status = null;
  try { storage.load('environments'); } catch (e) { status = e.status; }
  assert.equal(status, 404, 'the store cannot be loaded as a test');
  status = null;
  try { storage.remove('environments'); } catch (e) { status = e.status; }
  assert.equal(status, 404, 'the store cannot be deleted as a test');
  assert.includes(fs.readFileSync(path.join(dir, 'environments.json'), 'utf8'), '"environments"', 'store intact');
});

process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
run('targets');
