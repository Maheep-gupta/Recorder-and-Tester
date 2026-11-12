/**
 * Network safety for Replayr: host classification, destination policy, a browser-context guard
 * and a safe server-side probe.
 *
 * Why this exists. Replayr drives a real browser to user-configured URLs and replays recorded
 * (or IMPORTED, i.e. untrusted) steps against a TARGET environment. Without a guard, a crafted
 * test, a redirect, a link, an XHR or an <img> can reach: the production API while "testing"
 * localhost, the developer's LAN, or a cloud metadata service (credential theft).
 *
 * Host classes (classifyHost): 'loopback' | 'private' | 'link-local' | 'metadata' | 'public'.
 *   loopback   localhost, *.localhost, 127/8, 0/8 (0.0.0.0), ::1, ::
 *   private    10/8, 172.16/12, 192.168/16, 100.64/10 (CGNAT), 198.18/15, multicast/reserved,
 *              fc00::/7, fec0::/10, ff00::/8, single-label names and *.local/.internal/.lan/
 *              .home.arpa/.corp/.intranet/.private
 *   link-local 169.254/16 (except the metadata IPs), fe80::/10
 *   metadata   169.254.169.254, 169.254.170.2, 168.63.129.16, 100.100.100.200, fd00:ec2::254,
 *              metadata.google.internal, metadata.goog, metadata.azure.com, instance-data, ...
 *   public     everything else
 * IPv4-mapped / compatible / NAT64 / 6to4 IPv6 forms are classified by the IPv4 they embed.
 * Decimal / hex / octal / short IPv4 forms (2130706433, 0x7f.1, 0177.0.0.1, 127.1) are
 * canonicalised by the WHATWG URL parser first, so they cannot disguise themselves.
 * Severity order (worst first): metadata > link-local > private > loopback > public.
 *
 * Rules (checkDestination / checkDestinationResolved), policy =
 *   { target:{baseUrl, kind}, protectedOrigins:[..], allowOrigins:[..], mode, lookup? }
 *  1. Schemes: http/https only. about:blank is fine. file:, javascript:, data:, blob:, chrome:,
 *     about:other, ftp: ... are refused. ws/wss: record mode allows; replay mode only to the
 *     target host, an allowOrigins host, or (loopback target) another loopback host; never in
 *     server-fetch.
 *  2. The metadata class is blocked in EVERY mode, even if listed in allowOrigins or the target.
 *  3. mode 'record': only rules 1-2 (the human is browsing; we only keep them off the metadata
 *     service and non-web schemes).
 *  4. mode 'replay':
 *     - the target's own origin is always allowed (after rule 2);
 *     - a protected origin other than the target is blocked (also by host when the host is not
 *       loopback, so http vs https or another port of production is still refused). Protected
 *       wins over allowOrigins; this covers redirects, clicks and XHR to the production API;
 *     - allowOrigins (e.g. an SSO host) are allowed;
 *     - well-known non-HTTP service ports (22, 25, 3306, 5432, 6379, 11211, 27017, 9200, ...)
 *       are blocked unless it is the target's own port or an allowOrigin;
 *     - public target: loopback/private/link-local destinations are blocked (an imported test
 *       must not pivot from a production-looking target into the developer's LAN);
 *     - loopback target: other loopback ports allowed (local stacks run several), public
 *       third parties (fonts, CDN, SSO) allowed, private and link-local blocked;
 *     - private target: loopback, private and public allowed, link-local blocked.
 *  5. mode 'server-fetch' (the Node-side readiness probe): only the target's origin; metadata
 *     and link-local blocked; redirects are never followed (see probe()).
 * checkDestinationResolved additionally resolves names with dns.lookup(all:true) and uses the
 * WORST class across every address, for the destination and the target (DNS rebinding style:
 * a public name that resolves to 127.0.0.1 or 169.254.169.254 is classified as that).
 * Residual risk: the browser resolves names itself, so a hostile DNS server can answer
 * differently between our check and Chromium's connection. The guard is best effort against
 * that; probe() has no such gap because it validates inside the socket's own lookup.
 *
 * IMPORTANT - redirects. Verified against Playwright 1.62.1 / Chromium: context.route() is NOT
 * called for redirect hops (a 302 to another origin is followed inside the network stack, with
 * route.continue() and with route.fetch()+fulfill alike). So the route guard alone does NOT stop
 * "target 302 -> protected origin". The enforcement point that sees every hop is a forwarding
 * proxy: startGuardProxy() runs a small local proxy that applies the same policy to every
 * connection the browser makes (redirects, websockets, subresources), validating the resolved
 * addresses inside the socket's own lookup. Use both: the route guard gives per-URL reasons,
 * the proxy closes redirects/websockets/service workers. Create contexts with
 * `{ ...proxy.contextOptions, serviceWorkers: 'block' }`.
 */
'use strict';

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const SEVERITY = { public: 0, loopback: 1, private: 2, 'link-local': 3, metadata: 4 };
const worstOf = (classes) => classes.reduce((w, c) => (SEVERITY[c] > SEVERITY[w] ? c : w), 'public');

/** Services a web test never legitimately talks to. Blocked unless it is the target's own port. */
const BLOCKED_PORTS = new Set([
  20, 21, 22, 23, 25, 53, 110, 111, 135, 139, 143, 445, 465, 587, 993, 995, 1433, 1521, 2049, 2181,
  2375, 2376, 3306, 3389, 5432, 5672, 5900, 5984, 6379, 9042, 9092, 9200, 9300, 11211, 15672, 27017,
]);

const METADATA_HOSTS = new Set([
  'metadata', 'metadata.google.internal', 'metadata.goog', 'metadata.azure.com', 'metadata.azure.internal',
  'instance-data', 'instance-data.ec2.internal', 'metadata.tencentyun.com', 'metadata.platformequinix.com',
  'metadata.packet.net', 'kubernetes.default.svc',
]);
const PRIVATE_SUFFIXES = ['.local', '.internal', '.lan', '.home.arpa', '.corp', '.intranet', '.private'];

/* ── canonical hosts and IP parsing ────────────────────────────────────── */

/** WHATWG-canonical hostname (IPv6 stays bracketed), lowercase, no trailing dot; null if invalid. */
function canonicalHost(input) {
  let s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) return null;
  if (s.includes(':') && !s.startsWith('[')) s = `[${s}]`;
  s = s.replace(/\.+$/, '');
  if (!s) return null;
  try { return new URL(`http://${s}/`).hostname.replace(/\.+$/, ''); } catch (e) { return null; }
}

function parseV4(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** "[::ffff:7f00:1]" -> 8 groups of 16 bits, or null. */
function parseV6(h) {
  if (!h.startsWith('[') || !h.endsWith(']')) return null;
  let s = h.slice(1, -1);
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const v4 = parseV4(tail[1]);
    if (!v4) return null;
    s = s.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function classifyV4(o) {
  const [a, b, c, d] = o;
  if (a === 169 && b === 254 && ((c === 169 && d === 254) || (c === 170 && d === 2))) return 'metadata';
  if (a === 168 && b === 63 && c === 129 && d === 16) return 'metadata';      // Azure wireserver
  if (a === 100 && b === 100 && c === 100 && d === 200) return 'metadata';     // Alibaba
  if (a === 127 || a === 0) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'private';
  if (a === 192 && b === 0 && c === 0) return 'private';
  if (a >= 224) return 'private';
  return 'public';
}

function classifyV6(g) {
  const embedded = (hi, lo) => classifyV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return 'loopback';   // :: and ::1
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254) return 'metadata';
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return embedded(g[6], g[7]);   // mapped / compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6], g[7]);   // NAT64
  if (g[0] === 0x2002) return embedded(g[1], g[2]);                                                            // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return 'private';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00) return 'private';
  return 'public';
}

/** True for a literal IPv4/IPv6 address (after canonicalisation). */
function isIpLiteral(host) {
  const h = canonicalHost(host);
  return !!h && (parseV4(h) !== null || parseV6(h) !== null);
}

/** Class of one hostname, by its text alone (no DNS). Unparseable input is 'private' (strict). */
function classifyHost(hostname) {
  const h = canonicalHost(hostname);
  if (!h) return 'private';
  const v4 = parseV4(h);
  if (v4) return classifyV4(v4);
  if (h.startsWith('[')) { const v6 = parseV6(h); return v6 ? classifyV6(v6) : 'private'; }
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  if (METADATA_HOSTS.has(h) || h.endsWith('.metadata.google.internal')) return 'metadata';
  if (!h.includes('.') || PRIVATE_SUFFIXES.some((s) => h.endsWith(s))) return 'private';
  return 'public';
}

/* ── origins ───────────────────────────────────────────────────────────── */

/** Canonical origin: lowercase host, default port and trailing dot removed, IDN as punycode. null if not a URL. */
function originKey(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return null; }
  if (!u.hostname) return null;
  const host = u.hostname.replace(/\.+$/, '');
  return `${u.protocol}//${host}${u.port ? ':' + u.port : ''}`;
}

function sameOrigin(a, b) {
  const x = originKey(a);
  return x !== null && x === originKey(b);
}

/* ── DNS ───────────────────────────────────────────────────────────────── */

const defaultLookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * A per-run resolver with a host cache. `lookup(host)` may be injected (tests) and returns an
 * array of `{address}` or strings. Resolution failure or a 3 s timeout falls back to the text
 * class: the browser's own connection will fail anyway.
 */
function createResolver({ lookup, timeoutMs = 3000 } = {}) {
  const doLookup = lookup || defaultLookup;
  const cache = new Map();
  async function classify(hostname) {
    const h = canonicalHost(hostname);
    const textClass = classifyHost(hostname);
    if (!h || isIpLiteral(h) || textClass === 'loopback' || textClass === 'metadata') return textClass;
    if (cache.has(h)) return cache.get(h);
    const p = (async () => {
      let timer;
      try {
        const addrs = await Promise.race([
          Promise.resolve(doLookup(h)),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('dns timeout')), timeoutMs); }),
        ]);
        const classes = (Array.isArray(addrs) ? addrs : [addrs])
          .map((a) => classifyHost(typeof a === 'string' ? a : a && a.address))
          .concat(textClass);
        return worstOf(classes);
      } catch (e) {
        return textClass;
      } finally { clearTimeout(timer); }
    })();
    cache.set(h, p);
    return p;
  }
  return { classify, cache };
}

/** Worst class across all addresses a name resolves to (and its text class). */
async function resolveAndClassify(hostname, lookup) {
  return createResolver({ lookup }).classify(hostname);
}

/* ── policy ────────────────────────────────────────────────────────────── */

function portOf(u) {
  if (u.port) return Number(u.port);
  return u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : u.protocol === 'http:' || u.protocol === 'ws:' ? 80 : 0;
}
const deny = (reason, cls) => ({ ok: false, reason, class: cls });
const allow = (cls, reason) => ({ ok: true, reason: reason || 'allowed', class: cls });

function hostOnly(u) { return canonicalHost(u.hostname); }

/** The pure decision. `destClass` / `targetClass` come from text or from DNS. */
function decide(u, policy, destClass, targetClass) {
  const p = policy || {};
  const mode = p.mode || 'replay';
  const proto = u.protocol;

  if (proto === 'about:') return u.href === 'about:blank' ? allow('public', 'about:blank') : deny(`scheme ${proto} is not allowed`, 'public');
  const isWs = proto === 'ws:' || proto === 'wss:';
  if (proto !== 'http:' && proto !== 'https:' && !isWs) return deny(`scheme ${proto} is not allowed`, 'public');
  if (destClass === 'metadata') return deny('cloud metadata endpoints are always blocked', destClass);
  if (mode === 'record') return allow(destClass);

  const target = p.target && p.target.baseUrl ? safeUrl(p.target.baseUrl) : null;
  const targetOrigin = target ? originKey(target.href.replace(/^ws/, 'http')) : null;
  const httpEquiv = isWs ? new URL(u.href.replace(/^ws/, 'http')) : u;
  const destOrigin = originKey(httpEquiv.href);
  const sameAsTarget = destOrigin !== null && destOrigin === targetOrigin;

  if (mode === 'server-fetch') {
    if (isWs) return deny('websockets are not allowed in server-fetch', destClass);
    if (!sameAsTarget) return deny(`server-side fetch is limited to the target origin (${targetOrigin || 'none'})`, destClass);
    if (destClass === 'link-local') return deny('link-local addresses are blocked for server-side fetch', destClass);
    return allow(destClass);
  }

  // mode === 'replay'
  const tHost = target ? hostOnly(target) : null;
  const dHost = hostOnly(httpEquiv);
  const protectedList = (p.protectedOrigins || []).map((o) => originKey(o)).filter(Boolean);
  const isProtected = !sameAsTarget && protectedList.some((o) => {
    if (o === destOrigin) return true;
    const ph = hostOnly(new URL(o));
    return ph === dHost && classifyHost(ph) !== 'loopback';
  });
  if (isProtected) return deny(`${destOrigin} is a protected environment and is not the replay target`, destClass);

  const allowKeys = (p.allowOrigins || []).map((o) => originKey(o)).filter(Boolean);
  const allowHosts = new Set(allowKeys.map((o) => hostOnly(new URL(o))));
  if (isWs) {
    // Loopback hosts are told apart by port (a local stack runs several); other hosts by name.
    const named = (h) => classifyHost(h) !== 'loopback';
    const okWs = sameAsTarget || allowKeys.includes(destOrigin)
      || (named(dHost) && ((tHost && dHost === tHost) || allowHosts.has(dHost)))
      || (targetClass === 'loopback' && destClass === 'loopback');
    return okWs ? allow(destClass, 'websocket allowed') : deny('websocket to an origin that is not allowed', destClass);
  }
  if (sameAsTarget || allowKeys.includes(destOrigin)) return allow(destClass, sameAsTarget ? 'target origin' : 'allowOrigins');

  const port = portOf(httpEquiv);
  const targetPort = target ? portOf(target) : 0;
  if (BLOCKED_PORTS.has(port) && port !== targetPort) return deny(`port ${port} is a non-HTTP service port`, destClass);

  const t = targetClass || 'public';
  if (t === 'public') {
    if (destClass !== 'public') return deny(`a replay against a public target must not reach ${destClass} addresses`, destClass);
  } else if (t === 'loopback') {
    if (destClass === 'private' || destClass === 'link-local') return deny(`a replay against a loopback target must not reach ${destClass} addresses`, destClass);
  } else if (destClass === 'link-local') {
    return deny('link-local addresses are blocked', destClass);
  }
  return allow(destClass);
}

function safeUrl(s) { try { return new URL(String(s)); } catch (e) { return null; } }

/** Synchronous, string-level check. Names are NOT resolved here - use checkDestinationResolved for that. */
function checkDestination(url, policy) {
  const u = safeUrl(url);
  if (!u) return deny('not a valid URL', 'public');
  const target = policy && policy.target && policy.target.baseUrl ? safeUrl(policy.target.baseUrl) : null;
  const targetClass = target ? classifyHost(target.hostname) : 'public';
  const destClass = u.protocol === 'about:' ? 'public' : classifyHost(u.hostname);
  return decide(u, policy, destClass, targetClass);
}

const resolvers = new WeakMap();
function resolverFor(policy) {
  if (!policy || typeof policy !== 'object') return createResolver();
  if (policy.resolver) return policy.resolver;
  let r = resolvers.get(policy);
  if (!r) { r = createResolver({ lookup: policy.lookup }); resolvers.set(policy, r); }
  return r;
}

/** Like checkDestination, but the destination and the target are resolved via DNS first. */
async function checkDestinationResolved(url, policy) {
  const u = safeUrl(url);
  if (!u) return deny('not a valid URL', 'public');
  const r = resolverFor(policy);
  const target = policy && policy.target && policy.target.baseUrl ? safeUrl(policy.target.baseUrl) : null;
  const [destClass, targetClass] = await Promise.all([
    u.protocol === 'about:' ? 'public' : r.classify(u.hostname),
    target ? r.classify(target.hostname) : 'public',
  ]);
  return decide(u, policy, destClass, targetClass);
}

/* ── browser guard ─────────────────────────────────────────────────────── */

function stripQuery(url) {
  try { const x = new URL(url); return (x.origin === 'null' ? x.protocol : x.origin) + x.pathname; } catch (e) { return String(url).split(/[?#]/)[0].slice(0, 300); }
}

/**
 * Abort every request the policy forbids. context.route sees every request of every page and
 * popup in the context, including each redirect hop (a redirect is a new request), so a 302 to a
 * protected origin is stopped before any connection is made. Create the context with
 * `serviceWorkers: 'block'`. Async because route registration is. Returns
 * `{ blocked, count(), resolver }`: `blocked` holds the first 100 `{url (no query), reason, at}`.
 * data:, blob: and about:blank subresources are not network traffic and are not routed.
 */
async function installNetworkGuard(context, policy, shared) {
  const blocked = shared && Array.isArray(shared.blocked) ? shared.blocked : [];
  const counter = shared && shared.counter ? shared.counter : { n: 0 };
  let total = 0;
  const guard = { blocked, count: () => counter.n, resolver: resolverFor(policy) };
  const bump = () => { total++; counter.n++; };
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    let verdict;
    try {
      verdict = /^(data|blob):|^about:blank$/i.test(url) ? { ok: true } : await checkDestinationResolved(url, policy);
    } catch (e) {
      verdict = { ok: false, reason: `safety check failed: ${e && e.message}` };   // fail closed
    }
    if (verdict.ok) { await route.continue().catch(() => {}); return; }
    bump();
    if (blocked.length < 100) blocked.push({ url: stripQuery(url), reason: verdict.reason, at: new Date().toISOString() });
    await route.abort('blockedbyclient').catch(() => {});
  });
  if (policy && policy.guardWebSockets && typeof context.routeWebSocket === 'function') {
    // Playwright wants the connect/close decision synchronously, so this is the text-level check.
    await context.routeWebSocket(/.*/, (ws) => {
      const verdict = checkDestination(ws.url(), policy);
      if (verdict.ok) { ws.connectToServer(); return; }
      bump();
      if (blocked.length < 100) blocked.push({ url: stripQuery(ws.url()), reason: verdict.reason, at: new Date().toISOString() });
      ws.close({ code: 1008, reason: 'blocked' }).catch(() => {});
    });
  }
  return guard;
}

/* ── guard proxy ───────────────────────────────────────────────────────── */

/** A socket `lookup` that refuses any resolved address the policy would not allow (no rebinding gap). */
function makeSafeLookup(u, policy) {
  const resolver = resolverFor(policy);
  const target = policy && policy.target && policy.target.baseUrl ? safeUrl(policy.target.baseUrl) : null;
  const doLookup = (policy && policy.lookup) || defaultLookup;
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    Promise.all([Promise.resolve(doLookup(hostname)), target ? resolver.classify(target.hostname) : 'public']).then(([addrs, targetClass]) => {
      const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === 'string' ? { address: a, family: a.includes(':') ? 6 : 4 } : a));
      for (const a of list) {
        const v = decide(u, policy, classifyHost(a.address), targetClass);
        if (!v.ok) return cb(Object.assign(new Error(`blocked: ${hostname} resolves to ${a.address} (${v.reason})`), { code: 'EBLOCKED' }));
      }
      return options && options.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
    }, (e) => cb(e));
  };
}

/**
 * A local forwarding proxy that enforces the policy on every connection the browser makes.
 * Returns `{ url, contextOptions, blocked, count(), close() }`. Pass `contextOptions` to
 * browser.newContext (it sets `proxy` with `bypass: '<-loopback>'` so localhost traffic is
 * filtered too). For HTTPS only host:port is visible (CONNECT), so the origin-level rules apply
 * under both schemes and a destination is refused if either reading is refused.
 */
async function startGuardProxy(policy) {
  const blocked = [];
  const counter = { n: 0 };
  const note = (url, reason) => {
    counter.n++;
    if (blocked.length < 100) blocked.push({ url: stripQuery(url), reason, at: new Date().toISOString() });
  };
  const agent = new http.Agent({ keepAlive: false });

  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url); } catch (e) { res.writeHead(400); return res.end('bad proxy request'); }
    let verdict;
    try { verdict = await checkDestinationResolved(u.href, policy); } catch (e) { verdict = { ok: false, reason: 'safety check failed' }; }
    if (!verdict.ok) { note(u.href, verdict.reason); res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('Blocked by Replayr: ' + verdict.reason); }
    const headers = { ...req.headers };
    delete headers['proxy-connection']; delete headers['proxy-authorization'];
    const up = http.request({ host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || 80, method: req.method, path: u.pathname + u.search, headers, agent, lookup: makeSafeLookup(u, policy) }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('error', (e) => { if (e.code === 'EBLOCKED') note(u.href, e.message); if (!res.headersSent) res.writeHead(e.code === 'EBLOCKED' ? 403 : 502); res.end(); });
    req.pipe(up);
  });

  server.on('connect', async (req, client, head) => {
    const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(req.url || '');
    const refuse = (code) => { try { client.end(`HTTP/1.1 ${code}\r\n\r\n`); } catch (e) { /* gone */ } };
    if (!m) return refuse('400 Bad Request');
    const host = m[1] || m[2];
    const port = Number(m[3]);
    const hostPart = host.includes(':') ? `[${host}]` : host;
    let verdict = { ok: true };
    try {
      for (const scheme of ['https', 'http']) {
        const v = await checkDestinationResolved(`${scheme}://${hostPart}:${port}/`, policy);
        if (!v.ok) { verdict = v; break; }
      }
    } catch (e) { verdict = { ok: false, reason: 'safety check failed' }; }
    if (!verdict.ok) { note(`https://${hostPart}:${port}/`, verdict.reason); return refuse('403 Forbidden'); }
    const uCheck = new URL(`https://${hostPart}:${port}/`);
    const up = net.connect({ host, port, lookup: makeSafeLookup(uCheck, policy) }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(client); client.pipe(up);
    });
    up.on('error', (e) => { if (e.code === 'EBLOCKED') note(uCheck.href, e.message); refuse(e.code === 'EBLOCKED' ? '403 Forbidden' : '502 Bad Gateway'); });
    client.on('error', () => up.destroy());
    client.on('close', () => up.destroy());
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    contextOptions: { proxy: { server: url, bypass: '<-loopback>' } },
    blocked,
    counter,
    count: () => counter.n,
    close: () => new Promise((resolve) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/* ── server-side probe ─────────────────────────────────────────────────── */

/**
 * A safe replacement for `fetch(baseUrl)` in waitForApp. Checks the text policy, then validates
 * every resolved address inside the socket's own lookup (no DNS-rebinding gap), never follows
 * redirects, and reads no body. Resolves to
 * `{ ok, status?, redirect?: 'same-origin'|'cross-origin', blocked?, reason? }`; ok means "something
 * answered", exactly what waitForApp needs. `blocked: true` means policy refused it (do not retry).
 */
function probe(baseUrl, policy, { timeoutMs = 5000, lookup } = {}) {
  const pol = { ...(policy || {}), mode: 'server-fetch', target: (policy && policy.target) || { baseUrl } };
  const first = checkDestination(baseUrl, pol);
  if (!first.ok) return Promise.resolve({ ok: false, blocked: true, reason: first.reason });
  const u = new URL(baseUrl);
  const doLookup = lookup || defaultLookup;
  const safeLookup = (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    Promise.resolve(doLookup(hostname)).then((addrs) => {
      const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === 'string' ? { address: a, family: a.includes(':') ? 6 : 4 } : a));
      const bad = list.find((a) => ['metadata', 'link-local'].includes(classifyHost(a.address)));
      if (bad) return cb(Object.assign(new Error(`blocked: ${hostname} resolves to a ${classifyHost(bad.address)} address`), { code: 'EBLOCKED' }));
      return options && options.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
    }, (e) => cb(e));
  };
  return new Promise((resolve) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', lookup: safeLookup, timeout: timeoutMs, headers: { accept: '*/*' } }, (res) => {
      const out = { ok: true, status: res.statusCode };
      const loc = res.headers.location;
      if (loc && res.statusCode >= 300 && res.statusCode < 400) {
        let to = null;
        try { to = new URL(loc, u).href; } catch (e) { /* ignore */ }
        out.redirect = to && sameOrigin(to, u.href) ? 'same-origin' : 'cross-origin';
      }
      res.destroy();
      resolve(out);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => resolve({ ok: false, blocked: e.code === 'EBLOCKED', reason: e.message }));
    req.end();
  });
}

module.exports = {
  classifyHost, canonicalHost, isIpLiteral, originKey, sameOrigin,
  createResolver, resolveAndClassify,
  checkDestination, checkDestinationResolved,
  installNetworkGuard, startGuardProxy, probe,
  BLOCKED_PORTS, SEVERITY, worstOf,
};
