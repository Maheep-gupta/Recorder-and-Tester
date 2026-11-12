/**
 * Design Studio Tester — login session.
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
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');

/** Is there a saved session for this app? Each app keeps its own file - see config.authStateFor. */
function hasSavedState(app = config.defaultApp) {
  return fs.existsSync(config.authStateFor(app));
}

/** Context options that load the saved session for apps behind login. */
function storageStateOption(app) {
  const def = config.apps[app];
  if (!def || !def.auth || !hasSavedState(app)) return {};
  return { storageState: config.authStateFor(app) };
}

/**
 * Credentials for ONE app. A per-app pair wins over the generic pair, so a remote environment
 * never silently reuses the local account: put OPKEY_QA1_USERNAME / OPKEY_QA1_PASSWORD in
 * credentials.local.env and QA logs in as that user while localhost keeps its own.
 */
function readCredentials(app = config.defaultApp) {
  const env = { ...config.readEnvFile(config.credentialsPath), ...process.env };
  const first = (keys) => { for (const k of keys) if (env[k]) return env[k]; return undefined; };
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
  const def = config.apps[app];
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

    const { username, password, userKey, passKey } = readCredentials(app);
    if (!username || !password) {
      return {
        status: 'missing-credentials',
        message: `Session expired and no ${userKey} / ${passKey} (or OPKEY_USERNAME / OPKEY_PASSWORD) in ${config.credentialsPath}`,
      };
    }
    log('auth: session expired, logging in');
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#kc-login').click();
    try {
      await page.waitForURL((u) => u.origin === new URL(def.baseUrl).origin, { timeout: 60_000 });
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
  await context.storageState({ path: file });
}

function firstLine(e) {
  return String((e && e.message) || e).split('\n')[0];
}

module.exports = { ensureSession, storageStateOption, hasSavedState };
