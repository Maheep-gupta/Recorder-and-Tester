/**
 * A mock Keycloak-style login flow for testing Replayr's own login automation (src/auth.js).
 *
 * THIS IS NOT KEYCLOAK. It reproduces only what auth.js depends on:
 *   - an "app" origin (127.0.0.1:<port>) that serves an empty-then-booted <app-root> when the
 *     visitor has a valid session cookie, and otherwise sends them to the login page;
 *   - a separate "identity provider" origin (localhost:<port>) serving
 *     /realms/<realm>/protocol/openid-connect/auth with a form of #username, #password, #kc-login;
 *   - an authorization-code style redirect back to the app, which then sets an HttpOnly session
 *     cookie with a TTL;
 *   - Keycloak-style error text (#input-error / .kc-feedback-text) on a wrong password;
 *   - options for an OTP page (mfa), a slow login, a client-side redirect, server-side expiry.
 * Real Keycloak behaviour (tenant config, token lifetimes, MFA policy, cross-domain SSO) is NOT
 * modelled and stays unverified.
 *
 * Privacy: request bodies are parsed to compare credentials, but neither the submitted password nor
 * the body is ever stored in the request log, the stats or any response.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const rid = () => crypto.randomBytes(16).toString('hex');
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function cookieOf(req, name) {
  const m = String(req.headers.cookie || '').split(/;\s*/).find((p) => p.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : null;
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', () => resolve(new URLSearchParams()));
  });
}

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/**
 * @param {object} opts
 *   username, password   the one account the mock accepts
 *   realm                realm name in the URL (default 'replayr-test')
 *   ttlMs                app session lifetime (default 1 hour)
 *   mfa                  true = after a correct password, show an OTP page instead of finishing
 *   loginDelayMs         delay before answering the credential POST
 *   clientRedirect       true = the unauthenticated app serves an empty <app-root> and redirects to
 *                        the login page from script (as an Angular + keycloak-js app does)
 */
async function startMockKeycloak(opts = {}) {
  const o = { username: 'tester', password: 'correct-horse', realm: 'replayr-test', ttlMs: 3_600_000, mfa: false, loginDelayMs: 0, clientRedirect: false, ...opts };
  const appSessions = new Map();   // id -> expiresAt
  const idpSessions = new Map();   // id -> expiresAt
  const pending = new Map();       // state -> original app path
  const codes = new Map();         // code -> { state }
  const mfaTokens = new Set();
  const log = [];
  const stats = { logins: 0, failedLogins: 0, otpPages: 0, otpSubmits: 0, appHits: 0, authPageHits: 0 };
  let appPort = 0;
  let idpPort = 0;
  const appOrigin = () => `http://127.0.0.1:${appPort}`;
  const idpOrigin = () => `http://localhost:${idpPort}`;
  const authPath = `/realms/${o.realm}/protocol/openid-connect/auth`;
  const actionPath = `/realms/${o.realm}/login-actions/authenticate`;

  const live = (map, id) => {
    const exp = id && map.get(id);
    if (exp && exp > Date.now()) return true;
    if (exp) map.delete(id);
    return false;
  };
  const send = (res, status, headers, body) => { res.writeHead(status, { 'Cache-Control': 'no-store', ...headers }); res.end(body); };
  const html = (res, status, body, headers = {}) => send(res, status, { 'Content-Type': 'text/html; charset=utf-8', ...headers }, body);

  function loginUrlFor(state) {
    const q = new URLSearchParams({ client_id: 'app', response_type: 'code', state, redirect_uri: `${appOrigin()}/callback` });
    return `${idpOrigin()}${authPath}?${q}`;
  }

  function loginPage(error, state) {
    return `<!doctype html><html><head><title>Sign in to ${esc(o.realm)}</title></head><body>
<div id="kc-content">${error ? `<div class="alert alert-error"><span id="input-error" class="kc-feedback-text">${esc(error)}</span></div>` : ''}
<form id="kc-form-login" method="post" action="${actionPath}?state=${esc(state)}">
<label for="username">Username</label><input id="username" name="username" type="text" autocomplete="off">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="off">
<input id="kc-login" name="login" type="submit" value="Sign In">
</form></div></body></html>`;
  }

  function otpPage(state, token, error) {
    return `<!doctype html><html><head><title>Two-factor</title></head><body>
<div id="kc-content">${error ? `<span id="input-error" class="kc-feedback-text">${esc(error)}</span>` : ''}
<form id="kc-otp-login-form" method="post" action="${actionPath}?state=${esc(state)}">
<input type="hidden" name="mfa_token" value="${esc(token)}">
<label for="otp">One-time code</label><input id="otp" name="otp" type="text" autocomplete="off">
<input id="kc-login" name="login" type="submit" value="Sign In">
</form></div></body></html>`;
  }

  // <app-root> is in the markup from the first byte and only gets children after a short boot,
  // like an Angular shell - the trap auth.js's raceLanding is written to avoid.
  function appPage() {
    const boot = "document.querySelector('app-root').innerHTML='<main id=\"home\">Welcome to the app</main>';";
    return `<!doctype html><html><head><title>App</title></head><body><app-root></app-root><script>setTimeout(function(){${boot}},60);</script></body></html>`;
  }

  async function appHandler(req, res) {
    const url = new URL(req.url, appOrigin());
    log.push({ srv: 'app', method: req.method, path: url.pathname, cookie: req.headers.cookie || '' });
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const entry = code && codes.get(code);
      codes.delete(code);
      if (!entry || !pending.has(entry.state)) return html(res, 400, '<p>Invalid or reused code</p>');
      const back = pending.get(entry.state);
      pending.delete(entry.state);
      const id = rid();
      appSessions.set(id, Date.now() + o.ttlMs);
      return send(res, 302, {
        Location: back,
        'Set-Cookie': `APP_SESSION=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1, Math.ceil(o.ttlMs / 1000))}`,
      }, '');
    }
    stats.appHits++;
    if (live(appSessions, cookieOf(req, 'APP_SESSION'))) return html(res, 200, appPage());
    const state = rid();
    pending.set(state, url.pathname + url.search);
    if (o.clientRedirect) {
      return html(res, 200, `<!doctype html><html><body><app-root></app-root><script>setTimeout(function(){location.replace(${JSON.stringify(loginUrlFor(state))});},100);</script></body></html>`);
    }
    return send(res, 302, { Location: loginUrlFor(state) }, '');
  }

  async function idpHandler(req, res) {
    const url = new URL(req.url, idpOrigin());
    log.push({ srv: 'idp', method: req.method, path: url.pathname, cookie: req.headers.cookie || '' });
    const state = url.searchParams.get('state') || '';

    if (req.method === 'GET' && url.pathname === authPath) {
      stats.authPageHits++;
      if (!pending.has(state)) return html(res, 400, '<p>Unknown login session</p>');
      if (live(idpSessions, cookieOf(req, 'KEYCLOAK_SESSION'))) {   // SSO: no form needed
        const code = rid();
        codes.set(code, { state });
        return send(res, 302, { Location: `${appOrigin()}/callback?code=${code}&state=${state}` }, '');
      }
      return html(res, 200, loginPage(null, state));
    }

    if (req.method === 'POST' && url.pathname === actionPath) {
      const form = await readBody(req);
      if (o.loginDelayMs) await new Promise((r) => setTimeout(r, o.loginDelayMs));
      if (!pending.has(state)) return html(res, 400, '<p>Unknown login session</p>');
      const finish = () => {
        stats.logins++;
        const sid = rid();
        idpSessions.set(sid, Date.now() + o.ttlMs);
        const code = rid();
        codes.set(code, { state });
        return send(res, 302, {
          Location: `${appOrigin()}/callback?code=${code}&state=${state}`,
          'Set-Cookie': `KEYCLOAK_SESSION=${sid}; Path=/; HttpOnly; SameSite=Lax`,
        }, '');
      };
      if (form.has('otp')) {                       // second factor submission
        stats.otpSubmits++;
        const token = form.get('mfa_token');
        if (mfaTokens.has(token) && same(form.get('otp') || '', '123456')) { mfaTokens.delete(token); return finish(); }
        return html(res, 200, otpPage(state, token || '', 'Invalid authenticator code.'));
      }
      const ok = same(form.get('username') || '', o.username) && same(form.get('password') || '', o.password);
      if (!ok) {
        stats.failedLogins++;
        return html(res, 200, loginPage('Invalid username or password.', state));
      }
      if (o.mfa) {
        stats.otpPages++;
        const token = rid();
        mfaTokens.add(token);
        return html(res, 200, otpPage(state, token, null));
      }
      return finish();
    }
    return html(res, 404, '<p>Not found</p>');
  }

  const guard = (fn) => (req, res) => {
    fn(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch (e) { /* ignore */ } });
  };
  const appServer = http.createServer(guard(appHandler));
  const idpServer = http.createServer(guard(idpHandler));
  appPort = await listen(appServer);
  idpPort = await listen(idpServer);

  return {
    url: appOrigin(),
    idpUrl: idpOrigin(),
    stats,
    log,
    /** Server-side expiry. `sso:false` leaves the identity-provider session alive (silent re-login). */
    invalidate({ sso = true } = {}) { appSessions.clear(); if (sso) idpSessions.clear(); },
    close() {
      for (const s of [appServer, idpServer]) { if (s.closeAllConnections) s.closeAllConnections(); }
      return Promise.all([appServer, idpServer].map((s) => new Promise((r) => s.close(() => r())))).then(() => undefined);
    },
  };
}

module.exports = { startMockKeycloak };
