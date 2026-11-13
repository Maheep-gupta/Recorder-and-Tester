/**
 * Replayr — login session.
 *
 * The UI Shell on localhost runs the real Keycloak bootstrap, so every browser we open must carry a
 * Keycloak session. The Playwright suite already keeps one in `.auth/ui-shell.json`; this module
 * shares it and renews it the same way `helpers/auth.setup.ts` does — with the credentials in the
 * git-ignored `credentials.local.env`, never with anything stored in a test.
 *
 * Both recording and replay call `ensureSession()` first. If the saved session has expired, the
 * login happens before the recorder is attached and the state file is rewritten. A recording is
 * never started on the Keycloak page: that would bake a login into the test.
 *
 * By default the probe opens its own throwaway headless browser. A caller that already has one
 * open can lend it a `browser`, a `context` or — best — the very `page` the session is for, and
 * then no second browser is launched at all. See the ownership note on ensureSession.
 */
'use strict';

const fs = require('fs');
const { renameSyncRetry } = require('./fsutil');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');
const targets = require('./targets');
const secretstore = require('./secretstore');
const crypto = require('crypto');

/** Is there a saved session for this app? Each app keeps its own file - see config.authStateFor. */
function hasSavedState(app = config.defaultApp) {
  return fs.existsSync(config.authStateFor(app));
}

/* ── Saved sessions (Playwright storageState) ──────────────────────────────
 *
 * A session file holds cookies and tokens, so it is sensitive. Every file this module writes is
 * restricted to the current user. Files for apps other than ui-shell are also ENCRYPTED with
 * AES-256-GCM; the key lives in the OS credential store (account "session-key"), never on disk.
 *
 * The one exception is `.auth/ui-shell.json`: the external Playwright suite reads and rewrites it
 * (helpers/auth.setup.ts), so it must remain plain Playwright JSON. It is user-only restricted and
 * nothing else.
 *
 * If the OS credential store is unavailable a session is NOT written (the next run logs in again)
 * unless REPLAYR_ALLOW_PLAINTEXT_CREDENTIALS=1, which writes it plain with a loud warning.
 */
const SESSION_KEY_ACCOUNT = 'session-key';
const ENC_MARK = 'replayr-enc-v1';

/**
 * `.auth/ui-shell.json` used to be shared with an external Playwright suite, so it was kept as plain
 * Playwright JSON. Since Replayr moved out of that suite's repository the file lives in Replayr's own
 * `.auth/` and nothing else reads it, so it is encrypted like every other session. A team that really
 * does share the file can keep the old behaviour with REPLAYR_SHARE_UI_SHELL_SESSION=1 (plaintext,
 * user-only ACL).
 */
function isSharedPlainSession(app) {
  return /^(1|true|yes|on)$/i.test(String(process.env.REPLAYR_SHARE_UI_SHELL_SESSION || ''))
    && config.authStateFor(app) === config.authStatePath;
}

/** Encrypt a legacy plaintext session file in place (atomic). Best effort: on failure it stays as it was. */
function migratePlainSession(file, app) {
  if (!secretstore.available().ok) return false;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, encryptState(state), { encoding: 'utf8', mode: 0o600 });
    secretstore.restrictFile(tmp);
    renameSyncRetry(tmp, file);
    console.warn(`[replayr] the saved session for ${app} was plaintext; it is now encrypted`);
    return true;
  } catch (e) {
    console.warn(`[replayr] WARNING: could not encrypt the plaintext session for ${app} (${e.message}); it is still plaintext`);
    return false;
  }
}

function sessionKey(create) {
  let b64 = secretstore.getSecret(SESSION_KEY_ACCOUNT);
  if (!b64 && create) {
    b64 = crypto.randomBytes(32).toString('base64');
    secretstore.setSecret(SESSION_KEY_ACCOUNT, b64);
  }
  return b64 ? Buffer.from(b64, 'base64') : null;
}

function encryptState(state) {
  const key = sessionKey(true);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(state), 'utf8'), c.final()]);
  return JSON.stringify({ format: ENC_MARK, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
}

/** The decrypted state object, or throws (tampered / wrong key / no key). */
function decryptState(doc) {
  const key = sessionKey(false);
  if (!key) throw new Error('session key not found in the credential store');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(doc.iv, 'base64'));
  d.setAuthTag(Buffer.from(doc.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(doc.data, 'base64')), d.final()]).toString('utf8'));
}

/** Context options that load the saved session for apps behind login. */
function storageStateOption(app) {
  const def = targets.resolve(app);
  if (!def || !def.auth || !hasSavedState(app)) return {};
  const file = config.authStateFor(app);
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
  if (doc && doc.format === ENC_MARK) {
    try { return { storageState: decryptState(doc) }; } catch (e) {
      console.warn(`[replayr] WARNING: the saved session for ${app} could not be decrypted (${e.message}); signing in again`);
      return {};
    }
  }
  // A plaintext session written by an older Replayr: use it, and encrypt it in place.
  if (doc && typeof doc === 'object' && !isSharedPlainSession(app)) migratePlainSession(file, app);
  return { storageState: doc && typeof doc === 'object' ? doc : file };
}

/**
 * Credentials for ONE app. A per-app pair wins over the generic pair, so a remote environment
 * never silently reuses the local account: put OPKEY_QA1_USERNAME / OPKEY_QA1_PASSWORD in
 * credentials.local.env and QA logs in as that user while localhost keeps its own.
 */
function readCredentials(app = config.defaultApp) {
  // A login typed into the Setup form for this URL's origin wins: the user gave it on purpose.
  // A typed URL never falls back to the OPKEY_* env credentials — those are not meant for an
  // arbitrary host.
  const def = targets.resolve(app);
  const typed = def && targets.savedCredentials(def.baseUrl);
  if (typed) return { ...typed, userKey: 'username', passKey: 'password' };
  if (def && (def.custom || def.source === 'user')) return { userKey: 'username', passKey: 'password' };
  const env = { ...config.readEnvFile(config.credentialsPath), ...process.env };
  // Preferred source: the OS credential store, account "env:<KEY>" (e.g. env:OPKEY_USERNAME).
  // Falls back to the user-managed credentials.local.env / real environment.
  const useKeyring = secretstore.available().ok;
  const first = (keys) => {
    for (const k of keys) {
      if (useKeyring) {
        const v = secretstore.getSecret('env:' + k);
        if (v) return v;
      }
      if (env[k]) return env[k];
    }
    return undefined;
  };
  const { user, pass } = config.credentialKeys(app);
  return { username: first(user), password: first(pass), userKey: user[0], passKey: pass[0] };
}

/**
 * Make sure a browser opened on `app` lands inside the app, not on a login page.
 *
 * Options (all optional, and all absent = the original behaviour):
 *   log      progress lines
 *   page     probe in THIS page. It is navigated to the app and left there, logged in.
 *   context  probe in a new page of this context.
 *   browser  probe in a new context of this browser.
 *
 * Note for `page` callers: an app with no login returns 'no-auth-needed' WITHOUT navigating, so
 * the caller still owes that page its first `goto`.
 *
 * Resolves to `{ status, message }` with status one of:
 *   'no-auth-needed' · 'valid' · 'renewed' · 'missing-credentials' · 'login-failed' · 'app-unreachable'
 */
async function ensureSession(app = config.defaultApp, {
  log = () => {},
  browser: lentBrowser = null,
  context: lentContext = null,
  page: lentPage = null,
} = {}) {
  let def;
  try { def = targets.resolve(app); } catch (e) { return { status: 'app-unreachable', message: e.message }; }
  if (!def) return { status: 'app-unreachable', message: `Unknown app "${app}"` };
  if (!def.auth) return { status: 'no-auth-needed', message: `${def.label} has no login` };

  // Whatever the caller already has open, use it. Called with no options this behaves exactly as
  // it always has — launch a throwaway, close it — which is what `execution.js` still relies on.
  //
  // The reason the options exist: recording used to launch a SECOND browser here, and on Windows
  // even a headless Chromium flashes a window frame, so every recording began with a window
  // appearing and vanishing before the real one opened. Lending this function the page the
  // recording is about to use removes the second browser entirely — and the probe navigation
  // becomes the page load the recording needed anyway.
  //
  // Ownership rule, the only one that matters here: close exactly what we opened, never what we
  // were lent.
  let context = lentContext || (lentPage ? lentPage.context() : null);
  const ownContext = !context;
  const ownBrowser = ownContext && !lentBrowser;
  const browser = ownBrowser ? await chromium.launch({ headless: true }) : lentBrowser;

  try {
    if (!context) context = await browser.newContext({ ...storageStateOption(app), viewport: config.viewport });
    const page = lentPage || await context.newPage();
    log(`auth: probing ${def.baseUrl}`);
    try {
      await page.goto(def.baseUrl, { waitUntil: 'commit', timeout: config.navigationTimeoutMs });
    } catch (e) {
      return { status: 'app-unreachable', message: `${def.label} did not answer at ${def.baseUrl}: ${firstLine(e)}` };
    }

    const landed = await raceLanding(page, 90_000);
    if (landed === 'app') {
      await saveState(context, app);
      return { status: 'valid', message: 'Saved session is valid' };
    }
    if (landed !== 'login') {
      return { status: 'login-failed', message: 'Neither the app nor a login page appeared within 90 s' };
    }

    let creds;
    try { creds = readCredentials(app); } catch (e) {
      return { status: 'missing-credentials', message: `Saved login could not be read: ${firstLine(e)}` };
    }
    const { username, password, userKey, passKey } = creds;
    if (!username || !password) {
      if (def.custom || def.source === 'user') {
        return { status: 'missing-credentials', message: `${def.label} asks for a login and none is saved for it — enter a username and password on the Setup form` };
      }
      return {
        status: 'missing-credentials',
        message: `Session expired and no ${userKey} / ${passKey} (or OPKEY_USERNAME / OPKEY_PASSWORD) in ${config.credentialsPath}`,
      };
    }
    log('auth: session expired, logging in');
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#kc-login').click();
    // Watch for the three ways a submit can end, and stop at the FIRST one: back on the app (success),
    // Keycloak re-rendering the form with an error (bad credentials), or a second-factor page (MFA —
    // never automated, never bypassed). Waiting blindly for the app cost a full minute per wrong
    // password and reported only a timeout; repeated slow retries also feed account lockout.
    const outcome = await loginOutcome(page, def.baseUrl, 60_000);
    if (outcome === 'bad-credentials') {
      return { status: 'login-failed', message: `${def.label} rejected the saved username or password. Update the login and try again (it was not retried, to avoid an account lockout).` };
    }
    if (outcome === 'second-factor') {
      return { status: 'login-failed', message: `${def.label} asks for a second factor (one-time code / MFA). Replayr does not automate or bypass it: sign in once in a recording window and the saved session is reused.` };
    }
    if (outcome !== 'app') {
      return { status: 'login-failed', message: `Login did not return to ${def.label} within 60 s.` };
    }
    try {
      await page.locator('app-root').waitFor({ state: 'attached', timeout: 60_000 });
    } catch (e) {
      return { status: 'login-failed', message: `Login did not return to the app: ${firstLine(e)}` };
    }
    await saveState(context, app);
    return { status: 'renewed', message: `Session renewed and saved for ${def.label}` };
  } finally {
    // Close only what this call opened. A lent page stays open — it is the one the recording is
    // about to use, already sitting on the app, already logged in.
    if (ownContext && context) await context.close().catch(() => {});
    if (ownBrowser && browser) await browser.close().catch(() => {});
  }
}

/**
 * After the login form is submitted: 'app' once the page is back on the app's origin,
 * 'bad-credentials' when Keycloak shows its form error, 'second-factor' on an OTP / WebAuthn page,
 * else 'timeout'. Polls the page state instead of racing waitFor promises, so nothing is left
 * pending when it returns.
 */
async function loginOutcome(page, baseUrl, timeoutMs) {
  const appOrigin = new URL(baseUrl).origin;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let origin = null;
    try { origin = new URL(page.url()).origin; } catch (e) { /* about:blank mid-redirect */ }
    if (origin === appOrigin) return 'app';
    const seen = await page.evaluate(() => {
      const visible = (sel) => Array.from(document.querySelectorAll(sel)).some((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (el.textContent || el.value || '').trim() !== '';
      });
      if (document.querySelector('#otp, input[name="otp"], #kc-otp-login-form, input[autocomplete="one-time-code"], #kc-form-webauthn')) return 'second-factor';
      if (visible('#input-error, #input-error-username, #input-error-password, .kc-feedback-text, .alert-error, .pf-c-alert.pf-m-danger, .pf-v5-c-alert.pf-m-danger')) return 'bad-credentials';
      return null;
    }).catch(() => null);        // navigation in flight: the context is gone, look again shortly
    if (seen) return seen;
    await page.waitForTimeout(250);
  }
  return 'timeout';
}

/** 'app' when the Shell booted on its own origin, 'login' when Keycloak's form showed, else 'timeout'. */
/**
 * Did we land in the app, or at a login page?
 *
 * The obvious test — wait for `app-root` to be attached — is WRONG, and reported a dead session as
 * a good one. `<app-root>` is written into the served index.html, so it is in the DOM from the
 * first byte, before Angular boots and before the Keycloak redirect has had a chance to fire.
 * The race would settle on 'app' instantly, the caller would skip the login, and the recording
 * would then run against the sign-in page. That is the worst possible failure for this tool: it
 * records a login as if it were the workflow.
 *
 * What actually distinguishes the two is whether the app BOOTED — `app-root` having rendered
 * children — rather than whether its tag exists.
 */
async function raceLanding(page, timeout) {
  const booted = page
    .waitForFunction(() => {
      const root = document.querySelector('app-root');
      return !!root && root.children.length > 0;
    }, undefined, { timeout })
    .then(() => 'app');
  const loginForm = page.locator('#kc-login').waitFor({ state: 'visible', timeout }).then(() => 'login');
  const result = await Promise.race([booted, loginForm]).catch(() => 'timeout');

  // Belt and braces: an identity provider can render its own page inside our origin, and a
  // redirect can land after the race settles.
  if (result === 'app' && /openid-connect|\/auth\/realms\//.test(page.url())) return 'login';
  if (result === 'app' && await page.locator('#kc-login').isVisible().catch(() => false)) return 'login';
  return result;
}

async function saveState(context, app = config.defaultApp) {
  const file = config.authStateFor(app);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const state = await context.storageState();
  let text;
  if (isSharedPlainSession(app)) {
    text = JSON.stringify(state, null, 2); // shared with the external Playwright suite: stays plain
  } else if (secretstore.available().ok) {
    try { text = encryptState(state); } catch (e) {
      console.warn(`[replayr] WARNING: could not encrypt the session for ${app} (${e.message}); it was not saved`);
      return;
    }
  } else if (secretstore.allowPlaintext()) {
    console.warn(`[replayr] WARNING: the OS credential store is unavailable; the session for ${app} is saved UNENCRYPTED (REPLAYR_ALLOW_PLAINTEXT_CREDENTIALS=1).`);
    text = JSON.stringify(state, null, 2);
  } else {
    console.warn(`[replayr] WARNING: the OS credential store is unavailable (${secretstore.available().reason}); the session for ${app} was not saved, so the next run signs in again.`);
    return;
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  secretstore.restrictFile(tmp);
  renameSyncRetry(tmp, file);
}

/**
 * credentials.local.env is user-managed plaintext and is never rewritten. If it holds OPKEY_*
 * values, say so once (names only, never values) and point at the keyring alternative.
 */
let warnedEnvFile = false;
function warnPlaintextEnvFile() {
  if (warnedEnvFile) return;
  warnedEnvFile = true;
  let names = [];
  try { names = Object.entries(config.readEnvFile(config.credentialsPath)).filter(([k, v]) => /^OPKEY_/.test(k) && v).map(([k]) => k); } catch (e) { return; }
  if (!names.length) return;
  console.warn(`[replayr] WARNING: ${path.basename(config.credentialsPath)} holds ${names.length} plaintext OPKEY_* value(s) (${names.join(', ')}). ` +
    'Prefer the OS credential store: save each value under the account env:<NAME> (service "Replayr"), e.g. env:OPKEY_PASSWORD; ' +
    'those take priority over this file. Run "node scripts/move-credentials-to-keyring.js" to move them (dry run first; --apply to do it).');
}
warnPlaintextEnvFile();

function firstLine(e) {
  return String((e && e.message) || e).split('\n')[0];
}

module.exports = { ensureSession, storageStateOption, hasSavedState, saveState, readCredentials, warnPlaintextEnvFile };
