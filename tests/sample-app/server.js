/**
 * A tiny controllable web app used by tests/replay.test.js.
 *
 *   const app = await start({ variant: 'buggy' | 'fixed' | 'restructured' | 'ambiguous', port: 0 });
 *   app.url        'http://127.0.0.1:<port>'
 *   app.requests   every request the server has seen: { method, path, at }
 *   app.submits    number of order submissions that reached the server
 *   await app.close()
 *
 * Node's http module only; no dependencies.
 */
'use strict';

const http = require('http');

const SHELL = (title, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px system-ui;margin:24px} label{display:block;margin:8px 0 2px} button{margin:6px 6px 6px 0}</style></head>
<body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

function submitButton(variant) {
  if (variant === 'ambiguous') {
    // Two identical buttons, nothing around them that tells one from the other.
    return '<div><button type="submit">Submit</button><button type="submit">Submit</button></div>';
  }
  if (variant === 'restructured') {
    return '<div class="layout-v2"><div class="actions-v2"><button type="submit" class="cta-v2">Submit</button></div></div>';
  }
  return '<button type="submit" class="btn">Submit</button>';
}

function ordersPage(variant) {
  const total = variant === 'buggy' ? 'Total: NaN' : 'Total: 42.00';
  return SHELL('Orders', `
<h1>Orders</h1>
<form id="order-form" aria-label="Add order">
  <label for="customer">Customer</label>
  <input id="customer" name="customer" type="text">
  ${submitButton(variant)}
</form>
<p id="result" role="status"></p>
<button type="button" id="delete-all">Delete all</button>
<p id="deleted" role="status"></p>`, `
document.getElementById('order-form').addEventListener('submit', function (e) {
  e.preventDefault();
  fetch('/api/order', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customer: document.getElementById('customer').value }) })
    .then(function (r) { return r.json(); })
    .then(function (j) { document.getElementById('result').textContent = j.total; });
});
document.getElementById('delete-all').addEventListener('click', function () {
  if (confirm('Delete all orders?')) {
    fetch('/api/delete-all', { method: 'POST' }).then(function () {
      document.getElementById('deleted').textContent = 'All orders deleted';
    });
  }
});
window.__total = ${JSON.stringify(total)};`);
}

function start({ variant = 'fixed', port = 0 } = {}) {
  const requests = [];
  const state = { submits: 0, deletes: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: url.pathname + url.search, at: Date.now() });
    const html = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    const json = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'POST' && url.pathname === '/api/order') {
      req.resume();
      state.submits++;
      return json({ total: variant === 'buggy' ? 'Total: NaN' : 'Total: 42.00' });
    }
    if (req.method === 'POST' && url.pathname === '/api/delete-all') {
      req.resume();
      state.deletes++;
      return json({ ok: true });
    }
    if (url.pathname === '/') {
      return html(SHELL('Home', '<h1>Sample app</h1><p><a href="/orders?tab=open">Orders</a></p><p><a href="/login">Sign in</a></p>'));
    }
    if (url.pathname === '/orders') return html(ordersPage(variant));
    if (url.pathname === '/login') {
      return html(SHELL('Login', `
<h1>Sign in</h1>
<form id="login-form" onsubmit="return false">
  <label for="user">Username</label><input id="user" name="user" type="text">
  <label for="pw">Password</label><input id="pw" name="pw" type="password">
  <button type="submit">Sign in</button>
</form>`, "console.error('token=abc123secret');"));
    }
    if (url.pathname === '/slow') {
      return setTimeout(() => html(SHELL('Slow', '<h1>Slow page</h1>')), 3000);
    }
    return html(SHELL('Not found', '<h1>Not found</h1>'), 404);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        requests,
        get submits() { return state.submits; },
        get deletes() { return state.deletes; },
        close: () => new Promise((r) => {
          server.closeAllConnections && server.closeAllConnections();
          server.close(() => r());
        }),
      });
    });
  });
}

module.exports = { start };
