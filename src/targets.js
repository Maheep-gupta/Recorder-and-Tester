/**
 * Where a recording or a run points: a configured app, or any URL the user typed.
 *
 * A test stores one string in `target.app`. It is either a key from `config.apps` ("ui-shell",
 * "qa1", …) or `url:<normalised base URL>` for an address typed into the Setup form. Keeping it
 * a single string means every existing caller — recording state, run requests, the Run on…
 * picker, old test files — keeps passing the same shape around.
 *
 * Login for a typed URL: only the existing Keycloak flow (auth.js) is automated, and only when
 * the user has given a username and password for that URL's origin. Those live in a git-ignored
 * file next to credentials.local.env, keyed by origin, and are never written into a test, a run
 * folder or an API response.
 */
'use strict';

const fs = require('fs');
const { renameSyncRetry } = require('./fsutil');
const path = require('path');
const config = require('./config');
const urlsafety = require('./urlsafety');
const secretstore = require('./secretstore');

const PREFIX = 'url:';
// RECORDER_LOGINS_FILE exists so the test suite never touches the real file.
const CREDENTIALS_FILE = process.env.RECORDER_LOGINS_FILE
  || path.join(config.paths.launcher, 'custom-credentials.local.json');

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * The one gate every typed URL passes. http(s) only, no embedded user:pass, no fragment, no
 * trailing slash. Throws a 400-style error with a human message.
 */
function normaliseUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw badRequest('Enter the application URL');
  let u;
  try { u = new URL(raw); } catch (e) { throw badRequest(`"${raw.slice(0, 80)}" is not a valid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    // `localhost:4201` parses as scheme "localhost:" — the user simply left off http://.
    if (!raw.includes('//')) throw badRequest(`"${raw.slice(0, 80)}" needs to start with http:// or https://`);
    throw badRequest(`Only http:// and https:// URLs can be recorded — got ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw badRequest('Do not put a username or password in the URL — use the login fields instead');
  }
  u.hash = '';
  // A cloud metadata service is never a valid application, whatever it is called.
  if (urlsafety.classifyHost(u.hostname) === 'metadata') {
    throw badRequest(`${u.hostname} is a cloud metadata service address and cannot be used as an application URL`);
  }
  return u.toString().replace(/\/+$/, '');
}

function isUrlKey(app) {
  return typeof app === 'string' && app.startsWith(PREFIX);
}

/* ── Credentials typed in the UI, per origin ───────────────────────────── */
//
// The JSON file holds METADATA only: { "<origin>": { username, savedAt, store: "keyring" } }.
// The password lives in the operating system credential store (secretstore.js), account = origin.
// The single exception is the explicit opt-in REPLAYR_ALLOW_PLAINTEXT_CREDENTIALS=1 on a machine
// with no keyring: those entries are marked store: "plaintext" and a loud warning is logged.

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    // Reading a missing or corrupt file is "no logins". WRITING over a corrupt one is what must
    // never happen silently - writeStore() moves it aside first.
    return {};
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Move an unreadable file aside as `<file>.corrupt-<stamp>` so a write cannot destroy it. */
function setAside(file) {
  const aside = `${file}.corrupt-${stamp()}`;
  try {
    fs.renameSync(file, aside);
    console.warn(`[replayr] WARNING: ${path.basename(file)} was unreadable; kept as ${path.basename(aside)}`);
  } catch (e) {
    throw Object.assign(new Error(`${path.basename(file)} is unreadable and could not be set aside: ${e.message}`), { status: 500 });
  }
}

/** Atomic rewrite. A failure leaves the previous file exactly as it was and says so clearly. */
function writeStore(store) {
  let healthy = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    healthy = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch (e) {
    healthy = e.code === 'ENOENT';
  }
  if (!healthy) setAside(CREDENTIALS_FILE);
  const tmp = CREDENTIALS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
    secretstore.restrictFile(tmp);
    renameSyncRetry(tmp, CREDENTIALS_FILE);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* nothing more to do */ }
    throw Object.assign(
      new Error(`Could not update ${path.basename(CREDENTIALS_FILE)} (${e.code || 'write error'}). Nothing was changed; check that the file is writable.`),
      { status: 500, code: e.code }
    );
  }
}

function originOf(baseUrl) {
  return new URL(baseUrl).origin;
}

function isPlainEntry(entry) {
  return !!entry && typeof entry === 'object' && typeof entry.password === 'string' && entry.password !== '';
}

function loudPlaintextWarning(why) {
  console.warn(`[replayr] WARNING: ${why} Passwords are being kept in PLAINTEXT in ${path.basename(CREDENTIALS_FILE)} ` +
    '(REPLAYR_ALLOW_PLAINTEXT_CREDENTIALS=1). Anyone who can read that file can read the passwords.');
}

let warnedUnmigrated = false;

/**
 * readStore() plus the one-time migration: an old plaintext entry (it has `password`) moves into
 * the keyring and the password is removed from the file in one atomic rewrite. If the keyring is
 * unavailable the file is left untouched (the user's data is never deleted) and a warning is logged.
 */
function loadStore() {
  const store = readStore();
  const pending = Object.keys(store).filter((o) => isPlainEntry(store[o]) && store[o].store !== 'plaintext');
  if (!pending.length) return store;
  const avail = secretstore.available();
  if (!avail.ok) {
    if (!warnedUnmigrated) {
      warnedUnmigrated = true;
      console.warn(`[replayr] WARNING: ${path.basename(CREDENTIALS_FILE)} still holds ${pending.length} plaintext password(s) and the ` +
        `OS credential store is unavailable (${avail.reason}). They were NOT moved or deleted; fix the keyring and restart.`);
    }
    return store;
  }
  const moved = [];
  try {
    for (const o of pending) {
      secretstore.setSecret(o, store[o].password);
      moved.push(o);
    }
  } catch (e) {
    console.warn(`[replayr] WARNING: could not move saved passwords into the credential store: ${e.message}`);
    return store; // file untouched; entries already copied are simply copied again next time
  }
  const next = { ...store };
  for (const o of moved) {
    next[o] = { username: store[o].username, savedAt: store[o].savedAt || new Date().toISOString(), store: 'keyring' };
  }
  try {
    writeStore(next);
    console.warn(`[replayr] Moved ${moved.length} saved login(s) from plaintext into the OS credential store.`);
    return next;
  } catch (e) {
    console.warn(`[replayr] WARNING: passwords were copied to the credential store but ${path.basename(CREDENTIALS_FILE)} could not be rewritten: ${e.message}`);
    return store;
  }
}

/** The password for an entry: keyring (or, for opted-in plaintext / unmigrated entries, the file). */
function passwordOf(origin, entry) {
  if (isPlainEntry(entry)) return entry.password;
  if (!entry || entry.store !== 'keyring') return null;
  return secretstore.getSecret(origin);
}

/** `{ username, password }` saved for this URL's origin, or null. Throws 503 if the keyring fails. */
function savedCredentials(baseUrl) {
  const origin = originOf(baseUrl);
  const entry = loadStore()[origin];
  if (!entry || !entry.username) return null;
  const password = passwordOf(origin, entry);
  return password ? { username: entry.username, password } : null;
}

/** Cheap "is a login saved?" for callers that must not touch the OS store (resolve, listings). */
function hasSavedLogin(baseUrl) {
  const entry = readStore()[originOf(baseUrl)];
  return !!(entry && entry.username && (entry.store === 'keyring' || isPlainEntry(entry)));
}

/** Save (or replace) the login for this URL's origin. Both values are required. */
function saveCredentials(baseUrl, username, password) {
  const user = String(username == null ? '' : username).trim();
  const pass = String(password == null ? '' : password);
  if (!user || !pass) throw badRequest('Both username and password are needed to save a login');
  const origin = originOf(baseUrl);
  const savedAt = new Date().toISOString();

  if (secretstore.available().ok) {
    const store = loadStore();
    const before = secretstore.getSecret(origin);
    secretstore.setSecret(origin, pass);
    try {
      store[origin] = { username: user, savedAt, store: 'keyring' };
      writeStore(store);
    } catch (e) {
      // The metadata did not land: put the keyring back so the two cannot disagree.
      try { if (before == null) secretstore.deleteSecret(origin); else secretstore.setSecret(origin, before); } catch (_) { /* best effort */ }
      throw e;
    }
    return;
  }
  if (!secretstore.allowPlaintext()) {
    // Throws the 400 that explains the limitation and the opt-in. Nothing has been written.
    secretstore.setSecret(origin, pass);
  }
  loudPlaintextWarning(`The OS credential store is unavailable (${secretstore.available().reason}).`);
  const store = loadStore();
  store[origin] = { username: user, password: pass, savedAt, store: 'plaintext' };
  writeStore(store);
}

/** The saved entry for an origin (or null) - used to roll back a failed save. In memory only. */
function credentialSnapshot(baseUrl) {
  const origin = originOf(baseUrl);
  const entry = loadStore()[origin];
  if (!entry) return null;
  const snap = { ...entry };
  if (!isPlainEntry(entry) && entry.store === 'keyring') snap.password = secretstore.getSecret(origin);
  return snap;
}

/** Put an origin's entry back as `snapshot` (null = remove it). */
function restoreCredentials(baseUrl, snapshot) {
  const origin = originOf(baseUrl);
  const store = loadStore();
  if (!snapshot) {
    if (store[origin] && store[origin].store === 'keyring') secretstore.deleteSecret(origin);
    delete store[origin];
    writeStore(store);
    return;
  }
  if (snapshot.store === 'keyring') {
    const { password, ...meta } = snapshot;
    if (password) secretstore.setSecret(origin, password);
    store[origin] = meta;
  } else {
    store[origin] = snapshot; // plaintext entry exactly as it was
  }
  writeStore(store);
}

function forgetCredentials(baseUrl) {
  const store = loadStore();
  const origin = originOf(baseUrl);
  if (!(origin in store)) return false;
  if (store[origin] && store[origin].store === 'keyring') secretstore.deleteSecret(origin);
  delete store[origin];
  writeStore(store);
  return true;
}

/** Origins with a saved login. Never the values, and never a keyring call. */
function savedLoginOrigins() {
  const store = loadStore();
  return Object.keys(store).filter((o) => store[o] && store[o].username && (store[o].store === 'keyring' || isPlainEntry(store[o])));
}

/* ── Environments ──────────────────────────────────────────────────────── */

const KINDS = ['production', 'staging', 'development', 'local'];
const ENV_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Where user-defined environments live. Lazy so tests can point it elsewhere. */
function environmentsFile() {
  return process.env.RECORDER_ENVIRONMENTS_FILE || path.join(config.testsDir, 'environments.json');
}

/** localhost / 127.0.0.1 / [::1] / *.localhost => 'local', anything else => 'production'. */
/**
 * Loopback (localhost, *.localhost, 127/8, ::1, IPv4-mapped loopback, alternate IPv4 spellings) is
 * 'local'. EVERYTHING else — including private-network hosts — is treated as 'production' until the
 * user says otherwise by saving it as an environment: plenty of real production apps live on
 * private IPs, and guessing "development" would silently drop their protection.
 */
function inferKind(baseUrl) {
  return urlsafety.classifyHost(new URL(baseUrl).hostname) === 'loopback' ? 'local' : 'production';
}

function isProtected(def) {
  return def.protected === true || def.kind === 'production' || def.remote === true;
}

function configDef(key) {
  const app = config.apps[key];
  const remote = !!app.remote;
  const kind = KINDS.includes(app.kind) ? app.kind : (remote ? 'staging' : inferKind(app.baseUrl));
  const def = { key, ...app, remote, custom: false, kind, source: 'config', application: app.application || 'Default' };
  def.protected = isProtected({ protected: app.protected, kind, remote });
  return def;
}

/** The user's environments. A corrupt file is set aside (never overwritten) and reads as empty. */
function readEnvironments() {
  const file = environmentsFile();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.environments)) return parsed.environments.filter((e) => e && typeof e === 'object');
  } catch (e) { /* fall through to set aside */ }
  setAside(file);
  return [];
}

function writeEnvironments(list) {
  const file = environmentsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, environments: list }, null, 2) + '\n');
  renameSyncRetry(tmp, file);
}

/** The application an environment belongs to: a free-text group name, e.g. "Billing web". */
function cleanApplication(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || 'Default';
}

function userDef(e) {
  let baseUrl;
  try { baseUrl = normaliseUrl(e.baseUrl); } catch (err) { return null; }
  const kind = KINDS.includes(e.kind) ? e.kind : inferKind(baseUrl);
  const def = {
    key: e.key,
    label: String(e.label || e.key),
    baseUrl,
    auth: e.auth === true || hasSavedLogin(baseUrl),
    remote: false,
    custom: false,
    kind,
    source: 'user',
    application: cleanApplication(e.application),
  };
  def.protected = isProtected({ protected: e.protected, kind, remote: false });
  return def;
}

function userEnvironment(key) {
  const e = readEnvironments().find((x) => x.key === key);
  return e ? userDef(e) : null;
}

/** Every environment: config apps first, then the user's own. Never credentials. */
function listEnvironments() {
  const out = Object.keys(config.apps).map(configDef);
  for (const e of readEnvironments()) {
    if (Object.prototype.hasOwnProperty.call(config.apps, e.key)) continue;
    const def = userDef(e);
    if (def) out.push(def);
  }
  return out;
}

/** Create or replace a user environment by key. Returns the resolved def. */
function saveEnvironment(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw badRequest('An environment must be an object');
  const key = String(obj.key == null ? '' : obj.key).trim();
  if (!ENV_KEY.test(key)) throw badRequest('Environment key must be lowercase letters, digits and dashes (max 40, starting with a letter or digit)');
  if (Object.prototype.hasOwnProperty.call(config.apps, key)) throw badRequest(`"${key}" is a built-in app and cannot be redefined`);
  const baseUrl = normaliseUrl(obj.baseUrl);
  if (obj.kind != null && obj.kind !== '' && !KINDS.includes(obj.kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
  const entry = {
    key,
    label: String(obj.label == null || String(obj.label).trim() === '' ? key : obj.label).trim().slice(0, 80),
    baseUrl,
    kind: obj.kind || inferKind(baseUrl),
    protected: obj.protected === true,
    auth: obj.auth === true,
    application: cleanApplication(obj.application),
  };
  const list = readEnvironments();
  const i = list.findIndex((x) => x.key === key);
  if (i >= 0) list[i] = entry; else list.push(entry);
  writeEnvironments(list);
  return userDef(entry);
}

/** true when something was deleted. Built-in apps cannot be deleted (400). */
function deleteEnvironment(key) {
  if (Object.prototype.hasOwnProperty.call(config.apps, key)) throw badRequest(`"${key}" is a built-in app and cannot be deleted`);
  const list = readEnvironments();
  const next = list.filter((x) => x.key !== key);
  if (next.length === list.length) return false;
  writeEnvironments(next);
  return true;
}

/* ── Resolution ────────────────────────────────────────────────────────── */

/**
 * Turn whatever the caller has — an app key, a `url:` key, or a bare typed URL — into
 * `{ key, label, baseUrl, auth, remote, custom }`. Returns null for an unknown app key; throws a
 * 400 for a malformed URL.
 *
 * A typed URL that equals a configured app's base URL IS that app, so it keeps that app's saved
 * session and credentials rather than silently starting a second, unconfigured copy.
 */
function resolve(app) {
  const input = app == null || app === '' ? config.defaultApp : String(app);
  if (Object.prototype.hasOwnProperty.call(config.apps, input)) return configDef(input);
  if (ENV_KEY.test(input)) {
    const user = userEnvironment(input);
    if (user) return user;
  }
  const looksLikeUrl = isUrlKey(input) || /^[a-z][a-z0-9+.-]*:/i.test(input);
  if (!looksLikeUrl) return null;

  const baseUrl = normaliseUrl(isUrlKey(input) ? input.slice(PREFIX.length) : input);
  for (const key of Object.keys(config.apps)) {
    if (config.apps[key].baseUrl === baseUrl) return configDef(key);
  }
  // A typed URL equal to a saved environment IS that environment: same kind, same protection.
  for (const e of readEnvironments()) {
    if (e && e.baseUrl === baseUrl && !Object.prototype.hasOwnProperty.call(config.apps, e.key)) {
      const def = userDef(e);
      if (def) return def;
    }
  }
  const u = new URL(baseUrl);
  const kind = inferKind(baseUrl);
  return {
    kind,
    protected: isProtected({ kind, remote: false }),
    source: 'typed',
    key: PREFIX + baseUrl,
    label: u.host + (u.pathname === '/' ? '' : u.pathname),
    baseUrl,
    // Only log in automatically when the user has given us a login for this origin. Without one
    // the page opens as-is and the user can sign in by hand inside the recording window.
    auth: hasSavedLogin(baseUrl),
    remote: false,
    custom: true,
  };
}

/** resolve(), but an unknown app is a 400 rather than null. */
function require_(app) {
  const def = resolve(app);
  if (!def) throw badRequest(`Unknown app "${app}"`);
  return def;
}

module.exports = {
  PREFIX,
  CREDENTIALS_FILE,
  normaliseUrl,
  isUrlKey,
  resolve,
  require: require_,
  savedCredentials,
  hasSavedLogin,
  saveCredentials,
  forgetCredentials,
  credentialSnapshot,
  restoreCredentials,
  savedLoginOrigins,
  KINDS,
  inferKind,
  environmentsFile,
  listEnvironments,
  saveEnvironment,
  deleteEnvironment,
};
