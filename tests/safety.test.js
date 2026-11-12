/**
 * Network safety: host classification, destination policy matrix, DNS-rebinding style
 * classification (stubbed lookup), the server-side probe, and a real Chromium run proving the
 * network guard stops redirects, fetch(), links and metadata requests.
 *
 *   node tests/safety.test.js
 *
 * Local fixtures only: 127.0.0.1 on random ports. Nothing external is contacted - the
 * 169.254.169.254 image is aborted by the guard before any connection is attempted.
 */
'use strict';

const http = require('http');
const { chromium } = require('playwright');
const { test, assert, run } = require('./harness');
const safety = require('../src/urlsafety');

const { classifyHost, originKey, sameOrigin, checkDestination, checkDestinationResolved } = safety;

// ───────────────────────────────────────────────────────────── classification

test('classifyHost: loopback forms', () => {
  for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'foo.localhost', 'app.Localhost.', '127.0.0.1', '127.255.0.9', '0.0.0.0',
    '::1', '[::1]', '::', '::ffff:127.0.0.1', '[::ffff:7f00:1]', '2130706433', '0x7f.1', '0x7f000001', '0177.0.0.1', '127.1', '127.0.0.1.',
    '[::127.0.0.1]', '64:ff9b::127.0.0.1', '2002:7f00:1::']) {
    assert.equal(classifyHost(h), 'loopback', h);
  }
});

test('classifyHost: private forms', () => {
  for (const h of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255', '[fc00::1]', 'fd12:3456::1',
    '::ffff:10.0.0.1', '3232235777', '0xc0.0xa8.1.1', 'intranet', 'printer.local', 'db.internal', 'nas.lan', '[ff02::1]']) {
    assert.equal(classifyHost(h), 'private', h);
  }
  assert.equal(classifyHost('172.15.0.1'), 'public', '172.15 is public');
  assert.equal(classifyHost('172.32.0.1'), 'public', '172.32 is public');
  assert.equal(classifyHost('100.63.0.1'), 'public');
});

test('classifyHost: link-local and metadata', () => {
  for (const h of ['169.254.1.1', '[fe80::1]', 'fe80::abcd', '::ffff:169.254.1.1']) assert.equal(classifyHost(h), 'link-local', h);
  for (const h of ['169.254.169.254', '2852039166', '0xa9fea9fe', '[fd00:ec2::254]', '::ffff:169.254.169.254', 'metadata.google.internal',
    'METADATA.GOOGLE.INTERNAL.', 'x.metadata.google.internal', 'metadata.azure.com', '100.100.100.200', '169.254.170.2', '168.63.129.16', 'instance-data']) {
    assert.equal(classifyHost(h), 'metadata', h);
  }
});

test('classifyHost: public', () => {
  for (const h of ['example.com', 'EXAMPLE.com.', '8.8.8.8', '1.1.1.1', '[2606:4700::1111]', 'xn--bcher-kva.example', 'bücher.example', 'cdn.jsdelivr.net']) {
    assert.equal(classifyHost(h), 'public', h);
  }
  assert.equal(classifyHost('localhost.evil.com'), 'public', 'not a localhost suffix');
  assert.equal(classifyHost('127.0.0.1.evil.com'), 'public', 'hostname that merely starts with an IP');
});

test('classifyHost: garbage is treated strictly', () => {
  assert.equal(classifyHost(''), 'private');
  assert.equal(classifyHost('a b'), 'private');
  assert.equal(classifyHost(null), 'private');
});

test('originKey / sameOrigin canonicalise', () => {
  assert.equal(originKey('HTTP://Example.COM:80/x?y#z'), 'http://example.com');
  assert.equal(originKey('https://example.com.:443/'), 'https://example.com');
  assert.equal(originKey('https://bücher.example/'), 'https://xn--bcher-kva.example');
  assert.equal(originKey('http://[::1]:8080/'), 'http://[::1]:8080');
  assert.equal(originKey('http://2130706433:3000/'), 'http://127.0.0.1:3000');
  assert.equal(originKey('nope'), null);
  assert.ok(sameOrigin('http://localhost:4200/a', 'http://LOCALHOST:4200/b?x'));
  assert.notOk(sameOrigin('http://localhost:4200', 'http://localhost:4201'));
  assert.notOk(sameOrigin('http://a.com', 'https://a.com'));
});

// ───────────────────────────────────────────────────────────── DNS-rebinding style

const stubLookup = (table) => async (host) => {
  if (!(host in table)) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return table[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

test('resolveAndClassify: worst class across addresses', async () => {
  const lookup = stubLookup({
    'rebind.example': ['93.184.216.34', '127.0.0.1'],
    'meta.example': ['93.184.216.34', '169.254.169.254'],
    'lan.example': ['10.1.2.3'],
    'ok.example': ['93.184.216.34', '2606:2800:220:1::1'],
  });
  assert.equal(await safety.resolveAndClassify('rebind.example', lookup), 'loopback');
  assert.equal(await safety.resolveAndClassify('meta.example', lookup), 'metadata');
  assert.equal(await safety.resolveAndClassify('lan.example', lookup), 'private');
  assert.equal(await safety.resolveAndClassify('ok.example', lookup), 'public');
  assert.equal(await safety.resolveAndClassify('unknown.example', lookup), 'public', 'lookup failure falls back to text class');
  assert.equal(await safety.resolveAndClassify('localhost', async () => { throw new Error('must not be called'); }), 'loopback');
});

test('resolver caches per host', async () => {
  let calls = 0;
  const r = safety.createResolver({ lookup: async () => { calls++; return [{ address: '8.8.8.8' }]; } });
  await Promise.all([r.classify('a.example'), r.classify('a.example'), r.classify('A.example.')]);
  await r.classify('a.example');
  assert.equal(calls, 1);
});

test('checkDestinationResolved: public name resolving to loopback / metadata is caught', async () => {
  const lookup = stubLookup({ 'rebind.example': ['127.0.0.1'], 'meta.example': ['169.254.169.254'], 'cdn.example': ['93.184.216.34'] });
  const pubTarget = { target: { baseUrl: 'https://app.example.com', kind: 'production' }, lookup };
  const sync = checkDestination('http://rebind.example/x', pubTarget);
  assert.ok(sync.ok, 'string-level check cannot see the DNS answer');
  const r1 = await checkDestinationResolved('http://rebind.example/x', pubTarget);
  assert.equal(r1.ok, false);
  assert.equal(r1.class, 'loopback');
  const r2 = await checkDestinationResolved('http://meta.example/x', { target: { baseUrl: 'http://127.0.0.1:3000', kind: 'local' }, lookup });
  assert.equal(r2.ok, false);
  assert.equal(r2.class, 'metadata');
  assert.ok((await checkDestinationResolved('https://cdn.example/f.woff', pubTarget)).ok);
  // A loopback replay may still reach a name that resolves to loopback (same machine).
  const r3 = await checkDestinationResolved('http://rebind.example:9000/', { target: { baseUrl: 'http://localhost:3000' }, lookup });
  assert.ok(r3.ok);
});

// ───────────────────────────────────────────────────────────── policy matrix

const LOCAL = { baseUrl: 'http://localhost:4201', kind: 'local' };
const PRIV = { baseUrl: 'http://192.168.1.20:3000', kind: 'development' };
const PUB = { baseUrl: 'https://app.example.com', kind: 'staging' };
const PROD = 'https://prod.example.com';

const ok = (url, policy) => assert.ok(checkDestination(url, policy).ok, `${url} should be allowed: ${checkDestination(url, policy).reason}`);
const no = (url, policy, why) => {
  const r = checkDestination(url, policy);
  assert.equal(r.ok, false, `${url} should be blocked`);
  if (why) assert.match(r.reason, why, `${url} reason`);
};

test('schemes: only http(s); about:blank ok; others refused in every mode', () => {
  for (const mode of ['replay', 'record', 'server-fetch']) {
    const p = { target: LOCAL, mode };
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'chrome://settings', 'about:config', 'ftp://localhost/', 'blob:http://localhost:4201/x']) {
      no(u, p, /scheme/);
    }
  }
  ok('about:blank', { target: LOCAL });
  no('http://[::1', { target: LOCAL });
  no('not a url', { target: LOCAL });
});

test('metadata is blocked in every mode, even if allow-listed or the target', () => {
  for (const mode of ['replay', 'record', 'server-fetch']) {
    no('http://169.254.169.254/latest/meta-data/', { target: LOCAL, mode, allowOrigins: ['http://169.254.169.254'] }, /metadata/);
    no('http://metadata.google.internal/', { target: LOCAL, mode });
    no('http://[fd00:ec2::254]/', { target: LOCAL, mode });
  }
  no('http://169.254.169.254/', { target: { baseUrl: 'http://169.254.169.254' }, mode: 'server-fetch' });
});

test('replay vs loopback target', () => {
  const p = { target: LOCAL, protectedOrigins: [PROD] };
  ok('http://localhost:4201/app', p);
  ok('http://LOCALHOST.:4201/', p);
  ok('http://127.0.0.1:4200/api', p);              // another local port
  ok('https://fonts.googleapis.com/css', p);       // public third party
  no(PROD + '/api/x', p, /protected/);
  no('http://prod.example.com/api', p, /protected/);          // other scheme, same host
  no('https://prod.example.com:8443/', p, /protected/);       // other port, same host
  no('http://192.168.1.5/', p, /private/);
  no('http://10.0.0.1:8080/', p);
  no('http://169.254.1.1/', p);
  no('http://localhost:6379/', p, /port 6379/);
  no('http://127.0.0.1:5432/', p, /port 5432/);
  ok('http://localhost:9200/', { target: { baseUrl: 'http://localhost:9200' } });   // the target's own port is fine
  ok('http://10.0.0.1:8080/', { ...p, allowOrigins: ['http://10.0.0.1:8080'] });
});

test('replay vs private target', () => {
  const p = { target: PRIV, protectedOrigins: [PROD] };
  ok('http://192.168.1.20:3000/', p);
  ok('http://192.168.1.99:8080/', p);
  ok('http://localhost:9000/', p);
  ok('https://cdn.example.net/x.js', p);
  no('http://169.254.1.1/', p, /link-local/);
  no(PROD + '/', p, /protected/);
});

test('replay vs public target cannot pivot into loopback, LAN or link-local', () => {
  const p = { target: PUB, protectedOrigins: [PROD] };
  ok('https://app.example.com/page', p);
  ok('https://sso.vendor.com/login', p);
  ok('https://cdn.example.net/x.js', p);
  no('http://localhost:3000/', p, /public target/);
  no('http://127.0.0.1/', p);
  no('http://2130706433/', p);
  no('http://[::ffff:127.0.0.1]/', p);
  no('http://192.168.0.1/', p);
  no('http://100.64.1.1/', p);
  no('http://169.254.1.1/', p);
  no(PROD + '/', p, /protected/);
  ok('http://localhost:8443/sso', { ...p, allowOrigins: ['http://localhost:8443'] });
});

test('protected loopback origin on another port is blocked by exact origin only', () => {
  const p = { target: LOCAL, protectedOrigins: ['http://localhost:4300'] };
  no('http://localhost:4300/', p, /protected/);
  ok('http://localhost:4400/', p);
  ok('http://localhost:4201/', p);
});

test('protected wins over allowOrigins; the target itself is never "protected"', () => {
  no(PROD + '/', { target: PUB, protectedOrigins: [PROD], allowOrigins: [PROD] }, /protected/);
  ok(PROD + '/', { target: { baseUrl: PROD, kind: 'production' }, protectedOrigins: [PROD] });
});

test('websockets: replay only to target host / allowed host / loopback pair', () => {
  ok('ws://localhost:4201/socket', { target: LOCAL });
  ok('ws://127.0.0.1:4202/socket', { target: LOCAL });
  no('ws://evil.example.com/s', { target: LOCAL }, /websocket/);
  ok('wss://app.example.com/s', { target: PUB });
  no('ws://127.0.0.1:9/s', { target: PUB });
  ok('wss://sso.vendor.com/s', { target: PUB, allowOrigins: ['https://sso.vendor.com'] });
  no('wss://prod.example.com/s', { target: LOCAL, protectedOrigins: [PROD] });
  ok('ws://example.org/s', { target: LOCAL, mode: 'record' });
  no('ws://localhost:4201/', { target: LOCAL, mode: 'server-fetch' });
});

test('record mode: only metadata and bad schemes are refused', () => {
  const p = { target: LOCAL, mode: 'record', protectedOrigins: [PROD] };
  ok(PROD + '/', p);
  ok('http://192.168.1.1/', p);
  ok('http://localhost:6379/', p);
});

test('server-fetch: target origin only', () => {
  const p = { target: LOCAL, mode: 'server-fetch' };
  ok('http://localhost:4201/', p);
  ok('http://localhost:4201/health?x=1', p);
  no('http://localhost:4202/', p, /target origin/);
  no('https://example.com/', p, /target origin/);
  no('http://169.254.169.254/', p);
  no('http://169.254.5.5/', { target: { baseUrl: 'http://169.254.5.5' }, mode: 'server-fetch' }, /link-local/);
});

// ───────────────────────────────────────────────────────────── probe

function listen(handler) {
  return new Promise((resolve) => {
    const hits = [];
    const srv = http.createServer((req, res) => { hits.push(req.url); handler(req, res, hits); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, port: srv.address().port, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); }) }));
  });
}

test('probe: reaches the target, does not follow a redirect', async () => {
  const other = await listen((req, res) => { res.end('other'); });
  const app = await listen((req, res) => {
    if (req.url === '/') { res.writeHead(302, { location: other.url + '/stolen' }); res.end(); } else res.end('ok');
  });
  try {
    const r = await safety.probe(app.url, { target: { baseUrl: app.url } });
    assert.equal(r.ok, true);
    assert.equal(r.status, 302);
    assert.equal(r.redirect, 'cross-origin');
    assert.equal(other.hits.length, 0, 'redirect target was never contacted');
  } finally { await app.close(); await other.close(); }
});

test('probe: refuses metadata / link-local without connecting, and a name that resolves to metadata', async () => {
  const r1 = await safety.probe('http://169.254.169.254/', { target: { baseUrl: 'http://169.254.169.254/' } });
  assert.equal(r1.ok, false);
  assert.equal(r1.blocked, true);
  const lookup = stubLookup({ 'sneaky.example': ['169.254.169.254'] });
  const r2 = await safety.probe('http://sneaky.example/', { target: { baseUrl: 'http://sneaky.example/' } }, { lookup });
  assert.equal(r2.ok, false);
  assert.equal(r2.blocked, true, 'blocked inside the socket lookup: ' + r2.reason);
});

test('probe: unreachable is reported, not blocked', async () => {
  const dead = await listen((q, s) => s.end());
  const url = dead.url; await dead.close();
  const r = await safety.probe(url, { target: { baseUrl: url } }, { timeoutMs: 1500 });
  assert.equal(r.ok, false);
  assert.notEqual(r.blocked, true);
});

// ───────────────────────────────────────────────────────────── real Chromium

test('network guard: redirects, fetch, links and metadata images are blocked; target traffic still works', async () => {
  const protectedSrv = await listen((req, res) => {
    res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' });
    res.end('protected data');
  });
  const target = await listen((req, res, hits) => {
    if (req.url === '/redir') { res.writeHead(302, { location: protectedSrv.url + '/via-redirect' }); return res.end(); }
    if (req.url === '/ok.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"fine":true}'); }
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><title>t</title>
        <a id="go" href="${protectedSrv.url}/via-link">to protected</a>
        <img id="meta" src="http://169.254.169.254/latest/meta-data/iam?token=SECRET">
        <script>
          window.results = {};
          fetch('${protectedSrv.url}/via-fetch').then(() => { window.results.protectedFetch = 'reached'; }, () => { window.results.protectedFetch = 'blocked'; });
          fetch('/ok.json').then(r => r.json()).then(j => { window.results.targetFetch = j.fine; });
        </script>`);
    }
    res.writeHead(404); res.end();
  });
  const policy = { target: { baseUrl: target.url, kind: 'local' }, protectedOrigins: [protectedSrv.url], mode: 'replay' };
  const browser = await chromium.launch({ headless: true });
  let proxy;
  try {
    proxy = await safety.startGuardProxy(policy);
    const context = await browser.newContext({ ...proxy.contextOptions, serviceWorkers: 'block' });
    const guard = await safety.installNetworkGuard(context, policy, proxy);
    const page = await context.newPage();

    const started = Date.now();
    await page.goto(target.url + '/page');
    await page.waitForFunction(() => window.results && window.results.protectedFetch && window.results.targetFetch !== undefined, null, { timeout: 8000 });
    const results = await page.evaluate(() => window.results);
    assert.equal(results.targetFetch, true, 'allowed target traffic works');
    assert.equal(results.protectedFetch, 'blocked', 'fetch to protected origin fails');
    await page.waitForFunction(() => document.getElementById('meta').complete, null, { timeout: 8000 });
    assert.ok(Date.now() - started < 8000, 'metadata image failed without waiting on a network timeout');
    assert.equal(await page.evaluate(() => document.getElementById('meta').naturalWidth), 0);

    // (3) a click on the link to the protected origin
    await page.click('#go').catch(() => {});
    await page.waitForTimeout(300);
    assert.notOk(page.url().startsWith(protectedSrv.url), 'did not reach the protected origin: ' + page.url());

    // (1) a 302 to the protected origin
    const page2 = await context.newPage();
    // The route handler never sees redirect hops (verified); the proxy is what stops this one.
    const nav = await page2.goto(target.url + '/redir').catch((e) => e);
    const status = nav instanceof Error ? 'error' : nav.status();
    assert.ok(status === 'error' || status === 403, 'navigation through the redirect is refused: ' + status);

    assert.equal(protectedSrv.hits.length, 0, 'the protected server received ZERO requests: ' + JSON.stringify(protectedSrv.hits));
    const urls = guard.blocked.map((b) => b.url);
    assert.includes(urls, protectedSrv.url + '/via-fetch');
    assert.includes(urls, protectedSrv.url + '/via-link');
    assert.includes(urls, protectedSrv.url + '/via-redirect');
    assert.includes(urls, 'http://169.254.169.254/latest/meta-data/iam');
    assert.every(guard.blocked, (b) => !b.url.includes('SECRET') && !b.url.includes('?'), 'queries are never recorded');
    assert.every(guard.blocked, (b) => b.reason && b.at);
    assert.ok(target.hits.includes('/ok.json'));
    assert.ok(guard.count() >= 4, 'shared counter covers route and proxy blocks');
  } finally {
    await browser.close().catch(() => {});
    if (proxy) await proxy.close();
    await target.close(); await protectedSrv.close();
  }
});

test('network guard: record-mode policy leaves normal browsing alone but blocks metadata', async () => {
  const other = await listen((req, res) => { res.setHeader('content-type', 'text/plain'); res.end('hello'); });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const guard = await safety.installNetworkGuard(context, { mode: 'record', target: { baseUrl: other.url } });
    const page = await context.newPage();
    await page.goto(other.url + '/x');
    assert.equal(await page.textContent('body'), 'hello');
    const err = await page.goto('http://169.254.169.254/').catch((e) => e);
    assert.ok(err instanceof Error);
    assert.equal(guard.blocked.length, 1);
  } finally { await browser.close().catch(() => {}); await other.close(); }
});

test('network guard: websocket to a non-allowed origin is closed (guardWebSockets)', async () => {
  const hits = [];
  const wsSrv = http.createServer(() => {});
  wsSrv.on('upgrade', (req, sock) => { hits.push(req.url); sock.destroy(); });
  await new Promise((r) => wsSrv.listen(0, '127.0.0.1', r));
  const wsPort = wsSrv.address().port;
  const page0 = await listen((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>w</title>'); });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    // target is public-looking, so the loopback websocket is not an allowed origin
    const policy = { target: { baseUrl: 'https://app.example.com' }, guardWebSockets: true, allowOrigins: [page0.url] };
    const guard = await safety.installNetworkGuard(context, policy);
    const page = await context.newPage();
    await page.goto(page0.url + '/');
    const state = await page.evaluate((port) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/s`);
      ws.onerror = () => resolve('error'); ws.onclose = () => resolve('closed'); ws.onopen = () => resolve('open');
      setTimeout(() => resolve('timeout'), 4000);
    }), wsPort);
    assert.notEqual(state, 'open');
    assert.equal(hits.length, 0, 'the websocket server saw no upgrade');
    assert.ok(guard.blocked.some((b) => b.url.startsWith('ws://127.0.0.1')));
  } finally { await browser.close().catch(() => {}); await page0.close(); await new Promise((r) => { wsSrv.close(r); }); }
});

test('guard proxy: CONNECT tunnels obey the policy (metadata, protected, target)', async () => {
  const net = require('net');
  const prot = await listen((q, r) => r.end('p'));
  const tgt = await listen((q, r) => r.end('t'));
  const policy = { target: { baseUrl: tgt.url }, protectedOrigins: [prot.url] };
  const proxy = await safety.startGuardProxy(policy);
  const connect = (hostPort) => new Promise((resolve) => {
    const sock = net.connect(Number(proxy.url.split(':').pop()), '127.0.0.1', () => sock.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`));
    sock.once('data', (d) => { sock.destroy(); resolve(String(d).split('\r\n')[0]); });
    sock.on('error', () => resolve('error'));
  });
  try {
    assert.match(await connect('169.254.169.254:80'), /403/);
    assert.match(await connect('127.0.0.1:' + new URL(prot.url).port), /403/);
    assert.match(await connect('127.0.0.1:' + new URL(tgt.url).port), /200/);
    assert.equal(prot.hits.length, 0);
    assert.ok(proxy.blocked.length >= 2);
  } finally { await proxy.close(); await prot.close(); await tgt.close(); }
});

run('safety');
