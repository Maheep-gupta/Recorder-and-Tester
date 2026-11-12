/**
 * Browser tests for the in-page half of the element-identity engine.
 *
 *   node tests/fingerprint.test.js      (run from the repo root)
 *
 * One headless Chromium, launched once, plus the static fixture pages in
 * `identity/__fixtures__/`. `browser-lib.js` is injected exactly the way the recorder injects it —
 * `addInitScript({ content: SOURCE })` — so what is tested here is the same code that runs in a
 * real recording session, not a re-implementation of it.
 *
 * Two halves:
 *   §A EXTRACTION — is the fingerprint of a given element correct?
 *   §B REPLAY     — record on `*-before.html`, then ask the `*-after.html` page which elements each
 *                   candidate actually matches. `validate.js`, `locators.js`, `similarity.js` and
 *                   `resolver.js` from CONTRACT.md do not exist yet, so §B uses a deliberately
 *                   small stand-in matcher (MATCHER, below) that follows the contract's rule:
 *                   count the matches, and a locator matching one element that is NOT the recorded
 *                   one is a failure, never a near-miss.
 *
 * Determinism: no sleeps anywhere. The one fixture with delayed content is waited for with
 * `page.waitForSelector`. No network is used — every fixture is self-contained, the only image is
 * a data: URI, and the browser never leaves file://.
 *
 * Tests marked [known bug] fail on purpose and are listed in the accompanying report.
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { test, assert, run } = require('./harness');
const { SOURCE, installSource } = require('../src/identity/browser-lib');
const { candidatesFor } = require('../src/identity/candidates');
// The whole engine, wired exactly as the recorder and the replayer wire it. §B mostly uses the
// small in-page MATCHER below, but the invariants that live in the RESOLVER cannot be seen from
// there, so the tests that own those call buildTarget()/resolve() for real.
const identity = require('../src/identity');

const FIXTURES = path.join(__dirname, '..', 'src', 'identity', '__fixtures__');
const urlFor = (name) => pathToFileURL(path.join(FIXTURES, `${name}.html`)).href;

/**
 * The stand-in for locators.js + validate.js. It answers one question per candidate: which
 * elements does this descriptor match, right now, on this page? Every strategy in CONTRACT.md §3
 * is handled, `scope` narrows the search to the container it names, and the answer identifies each
 * match by its `x-expect*` marker class — a class, because classes are the one thing the engine is
 * forbidden from identifying by, so the marker can never be what makes a test pass.
 */
const MATCHER = `
;(() => {
  if (window.__match) return;
  const I = () => window.__opkeyRec._internals;
  const all = (root) => Array.prototype.slice.call((root || document).querySelectorAll('*'));
  const nameOf = (el) => I().clean(I().nameWithSource(el).name || '');
  const roleOf = (el) => I().computeRole(el);
  const textOf = (el) => I().ownText(el);
  const q = (root, sel) => { try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; } };
  const xp = (root, expr) => {
    const out = [];
    try {
      const r = document.evaluate(expr, (root && root.nodeType === 1) ? root : document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
    } catch (e) { return []; }
    return out;
  };

  function runOne(cand, root) {
    const p = cand.params || {};
    switch (cand.strategy) {
      case 'testid':
        return q(root, '[' + (p.attr || 'data-testid') + '="' + String(p.value).replace(/"/g, '\\\\"') + '"]');
      case 'id':
        return all(root).filter((e) => e.getAttribute('id') === p.value);
      case 'role':
        return all(root).filter((e) => roleOf(e) === p.role && (
          p.name == null ? true
            : p.exact ? nameOf(e) === p.name
            : nameOf(e).toLowerCase().indexOf(String(p.name).toLowerCase()) >= 0));
      case 'label':
        return all(root).filter((e) => {
          const n = I().nameWithSource(e);
          if (n.source !== 'label') return false;
          return p.exact ? n.name === p.text : String(n.name).indexOf(p.text) >= 0;
        });
      case 'placeholder': return all(root).filter((e) => e.getAttribute('placeholder') === p.text);
      case 'altText': return all(root).filter((e) => e.getAttribute('alt') === p.text);
      case 'title': return all(root).filter((e) => e.getAttribute('title') === p.text);
      case 'attr': {
        const pairs = p.pairs || [[p.name, p.value]];
        return all(root).filter((e) => pairs.every(([k, v]) => e.getAttribute(k) === v)
          && (!p.tag || e.tagName.toLowerCase() === p.tag));
      }
      case 'text':
        return all(root).filter((e) => (!p.tag || e.tagName.toLowerCase() === p.tag)
          && (p.exact ? textOf(e) === p.text : textOf(e).indexOf(p.text) >= 0));
      case 'css': return q(root, p.value);
      case 'xpath': return xp(root, p.value);
      case 'positional': return p.kind === 'xpath' ? xp(root, p.value) : q(root, p.value);
      case 'domIndex': {
        if (p.kind === 'ordinal') {
          const pool = Array.prototype.slice.call((root || document).getElementsByTagName(p.tag || '*'));
          return pool[p.index] ? [pool[p.index]] : [];
        }
        return q(root, p.value);
      }
      case 'relativeXPath': return xp(root, p.value);
      case 'absoluteXPath': return xp(root, p.value);
      default: return [];
    }
  }

  const describe = (el) => {
    const cls = (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean);
    return {
      mark: cls.filter((c) => c.indexOf('x-expect') === 0)[0] || null,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    };
  };

  window.__match = function (cand) {
    let roots = [null];
    if (cand.scope) {
      roots = runOne(cand.scope, null);
      if (!roots.length) return [];
    }
    const seen = [];
    for (const r of roots) for (const el of runOne(cand, r)) if (seen.indexOf(el) < 0) seen.push(el);
    return seen.map(describe);
  };
})();
`;

// ─────────────────────────────────────────────────────────────────────────────
// browser plumbing
// ─────────────────────────────────────────────────────────────────────────────

let browser;
let context;
let page;

async function boot() {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  // Playwright's own role / accessible-name implementation in the main world — the same wiring
  // execution.js uses at replay time, and what `getByRole` needs to agree with browser-lib.
  await context._exposeConsoleApi().catch(() => {});
  await context.addInitScript({ content: SOURCE });
  await context.addInitScript({ content: MATCHER });
  page = await context.newPage();
}

async function shutdown() {
  if (browser) await browser.close();
}

/** Navigate to a fixture. Returns the shared page. */
async function open(fixture) {
  await page.goto(urlFor(fixture));
  return page;
}

/** Fingerprint the element `selector` points at, on whatever page is currently open. */
function fingerprint(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('fixture selector matched nothing: ' + sel);
    return window.__opkeyRec.fingerprint(el);
  }, selector);
}

/** Open a fixture and fingerprint one element on it, in one step. */
async function fingerprintOn(fixture, selector) {
  await open(fixture);
  return fingerprint(selector);
}

/**
 * Record on `<name>-before`, then run every candidate against `<name>-after`.
 * @returns {Promise<Array<{strategy,score,scoped,why,matches}>>} best-scoring candidate first
 */
async function replay(name, selector, opts) {
  const options = opts || {};
  const fp = await fingerprintOn(`${name}-before`, selector);
  const list = candidatesFor(fp);
  await open(`${name}-after`);
  if (options.waitFor) await page.waitForSelector(options.waitFor);
  const out = [];
  for (const c of list) {
    const matches = await page.evaluate((cand) => window.__match(cand), {
      strategy: c.strategy, params: c.params, scope: c.scope || null,
    });
    out.push({ strategy: c.strategy, score: c.score, scoped: !!c.scope, why: c.why, params: c.params, matches });
  }
  out.fingerprint = fp;
  return out;
}

/**
 * The strategies that find an element by WHERE it sits: domIndex, relativeXPath, absoluteXPath
 * (and `positional`, the single lump they were split out of). CONTRACT.md §3.
 */
const POSITIONAL = new Set(['domIndex', 'relativeXPath', 'absoluteXPath', 'positional']);
const isPositional = (c) => POSITIONAL.has(c.strategy);

/**
 * The subset of the positional band that describes a PATH THROUGH THE TREE — a child-position
 * chain, an absolute XPath, or the relative XPath derived by cutting an absolute one loose. These
 * die the moment the element moves.
 *
 * `relativeXPath` built from `semanticXPath` is deliberately NOT one of them: it is an XPath made
 * of meaning (`//button[normalize-space()='Save Customer']`) that happens to be expressed as a
 * path, so it survives re-nesting and dies when the element is renamed. It sits in the positional
 * band because the user asked for XPath fallbacks and this is where they are tried, not because
 * it is index-shaped.
 */
const isPathShaped = (c) => (c.strategy === 'domIndex' && (c.params || {}).kind === 'path')
  || c.strategy === 'absoluteXPath'
  || (c.strategy === 'relativeXPath' && (c.params || {}).derivedFrom === 'absoluteXPath');

/**
 * The candidate the resolver would accept ON MEANING ALONE: best score first, exactly one match.
 *
 * The positional band is excluded on purpose. Those candidates are tried by the resolver — the
 * user asked for them to be — but only after every semantic strategy has failed, and only behind
 * an identity check that this stand-in matcher cannot perform: MATCHER answers "which elements
 * does this descriptor match", and a position matching one element says nothing about WHICH
 * element it is. The tests that own the positional band call the real resolver instead.
 */
function firstResolution(results, minScore) {
  const floor = minScore == null ? 11 : minScore;
  return results.find((r) => r.score >= floor && !isPositional(r) && r.matches.length === 1) || null;
}

const summarise = (results) => results.map((r) => `${r.strategy}${r.scoped ? '(scoped)' : ''}@${r.score}×${r.matches.length}`).join(' ');

// ── the real engine, for the invariants the stand-in matcher cannot see ──────────────────────
// MATCHER answers "which elements does this candidate match?" and nothing else. Some invariants
// are not properties of the candidate list at all — they are enforced one layer up, by the
// resolver comparing what it found against what was recorded. Those are asserted through the
// public API, `identity.buildTarget` then `identity.resolve`, on the same fixtures.

/** Record `selector` on whatever page is open, the way the recorder does: the saved `target`. */
async function recordTarget(selector) {
  return identity.buildTarget(page, await fingerprint(selector));
}

/**
 * A named region whose only button carries `label` and nothing else — no id, no test id, no
 * attribute of any kind that could vouch for it. The pair of pages made by calling this twice is
 * the smallest thing that separates a RENAME from a REPLACEMENT, and there is no fixture for it:
 * every `*-before/-after` pair that swaps a button also swaps its test id.
 */
const REGION_WITH_BUTTON = (label) => `<title>Customers</title>
<h1>Customers</h1>
<section aria-label="Customer Details">
  <h2>Customer Details</h2>
  <button class="btn">${label}</button>
</section>`;

/** Load a page from a string, for pairs no fixture covers. Init scripts run on it as usual. */
async function setPage(html) {
  await page.setContent(html);
  return page;
}

/** One line per attempt, for a failure message worth reading. */
const summariseAttempts = (attempts) => attempts
  .map((a) => `\n        ${a.strategy}@${a.score} ${a.locator} → ${a.matches} match(es)${a.rejected ? `, rejected: ${a.rejected}` : ''}`)
  .join('');

/**
 * `identity.resolve` must refuse. Returns the ResolutionError it threw; fails the test loudly —
 * naming the element it wrongly accepted — if it returned instead.
 */
async function refusal(target, options) {
  let won = null;
  try {
    won = await identity.resolve(page, target, options || {});
  } catch (err) {
    if (err.name !== 'ResolutionError') throw err;
    return err;
  }
  const text = (await won.locator.textContent().catch(() => '?')).trim();
  assert.ok(false, `resolution had to be refused, but "${text}" was accepted via ${won.candidate.strategy}@${won.candidate.score}`);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §A EXTRACTION — roles, names, attributes, context, selectors
// ─────────────────────────────────────────────────────────────────────────────

test('role + name: a button named by its own text', async () => {
  const fp = await fingerprintOn('text-change-before', 'button.x-expect');
  assert.equal(fp.tag, 'button', 'tag');
  assert.equal(fp.role, 'button', 'implicit role');
  assert.equal(fp.name, 'Save Customer', 'accessible name');
  assert.equal(fp.nameSource, 'contents', 'named by its contents');
  assert.equal(fp.text, 'Save Customer', 'own text');
});

test('role + name: a button named by aria-label beats its contents', async () => {
  const fp = await fingerprintOn('text-change-before', 'button.x-expect-close');
  assert.equal(fp.role, 'button', 'role');
  assert.equal(fp.name, 'Close panel', 'aria-label wins over the "×" glyph');
  assert.equal(fp.nameSource, 'aria-label', 'nameSource');
  assert.equal(fp.text, '×', 'the visible text is still recorded separately');
});

test('role + name: an input named by <label for=…>', async () => {
  const fp = await fingerprintOn('labels-before', 'input.x-expect-for');
  assert.equal(fp.role, 'textbox', 'type=email is a textbox');
  assert.equal(fp.name, 'Email address', 'name from the associated label');
  assert.equal(fp.nameSource, 'label', 'nameSource');
  assert.equal(fp.labels, ['Email address'], 'and the label text is recorded');
});

test('role + name: an input named by a wrapping <label>', async () => {
  const fp = await fingerprintOn('labels-before', 'input.x-expect-wrap');
  assert.equal(fp.role, 'textbox', 'type=tel is a textbox');
  assert.equal(fp.name, 'Phone number', 'name from the label it sits inside');
  assert.equal(fp.nameSource, 'label', 'nameSource');
  assert.equal(fp.labels, ['Phone number'], 'labels[]');
});

test('role + name: aria-labelledby joins its referenced elements', async () => {
  const fp = await fingerprintOn('labels-before', 'input.x-expect-labelledby');
  assert.equal(fp.name, 'Currency code', 'two ids, joined in order');
  assert.equal(fp.nameSource, 'aria-labelledby', 'nameSource');
});

test('role + name: a placeholder is a name of last resort', async () => {
  const fp = await fingerprintOn('labels-before', 'input.x-expect-placeholder');
  assert.equal(fp.name, 'Search customers', 'name from the placeholder');
  assert.equal(fp.nameSource, 'placeholder', 'nameSource');
  assert.equal(fp.attrs.placeholder, 'Search customers', 'and it is a stable attribute too');
});

test('role + name: an image is named by its alt text', async () => {
  const fp = await fingerprintOn('labels-before', 'img.x-expect-img');
  assert.equal(fp.role, 'img', 'role');
  assert.equal(fp.name, 'Company logo', 'name from alt');
  assert.equal(fp.nameSource, 'alt', 'nameSource');
});

test('role + name: a submit input takes its name from value', async () => {
  const fp = await fingerprintOn('labels-before', 'input.x-expect-submit');
  assert.equal(fp.role, 'button', 'input[type=submit] is a button');
  assert.equal(fp.name, 'Send message', 'name from value');
  assert.equal(fp.nameSource, 'value', 'nameSource');
});

test('role + name: a heading and a link', async () => {
  await open('labels-before');
  const heading = await fingerprint('h2#formHeading');
  assert.equal(heading.role, 'heading', 'h2 is a heading');
  assert.equal(heading.name, 'Contact details', 'heading name');

  const link = await fingerprint('a.x-expect-link');
  assert.equal(link.role, 'link', 'a[href] is a link');
  assert.equal(link.name, 'Contact support', 'link name');
  // The fixture is served from file://, so `new URL(...).pathname` keeps the drive letter. What
  // matters is that the origin is stripped and only a path is stored.
  assert.match(link.attrs.href, /^\/.*\/customers\/help$|^\/customers\/help$/, 'href is stored as a path, origin stripped');
  assert.excludes(link.attrs.href, 'file:', 'no scheme survives into the fingerprint');
});

test('attrs: a hand-written id is kept, every generated id is quarantined in volatile', async () => {
  await open('generated-ids-before');

  const hand = await fingerprint('input.x-expect');
  assert.equal(hand.attrs.id, 'customerName', 'the one hand-written id reaches attrs');
  assert.equal(hand.volatile.id, undefined, 'and is not in volatile');

  const generated = await fingerprint('input.x-expect-2');
  assert.equal(generated.attrs.id, undefined, 'id="mat-input-27" must NOT reach attrs');
  assert.ok(generated.volatile.id, 'it must be reported in volatile instead');
  assert.includes(generated.volatile.id, 'mat-input-27', 'volatile keeps the value');
  assert.includes(generated.volatile.id, 'counter', 'and the reason it was refused');

  for (const [sel, id] of [['select', ':r7:'], ['ul#ss-0-listbox', 'ss-0-listbox'], ['input[name=creditLimit]', 'input-938492'], ['button[type=submit]', 'mat-button-14']]) {
    const fp = await fingerprint(sel);
    assert.equal(fp.attrs.id, undefined, `${id} must not reach attrs`);
    assert.includes(fp.volatile.id || '', id, `${id} must be in volatile with a reason`);
  }
});

test('attrs: Angular view-encapsulation markers are never read at all', async () => {
  const fp = await fingerprintOn('generated-ids-before', 'input.x-expect');
  const seen = JSON.stringify({ attrs: fp.attrs, volatile: fp.volatile });
  assert.excludes(seen, '_ngcontent', '_ngcontent-* is build output, not identity or diagnostics');
});

test('attrs: class never becomes identity, but a hashed class is kept for diagnostics', async () => {
  const fp = await fingerprintOn('css-change-before', 'button.x-expect');
  assert.equal(fp.attrs.class, undefined, 'class is never an identifying attribute');
  assert.includes(fp.volatile.class, 'css-1a2b3c', 'the hashed class is reported as a diagnostic');
  assert.excludes(fp.volatile.class, 'btn', 'the hand-written classes are not worth reporting');
  assert.equal(fp.attrs.id, 'saveCustomer', 'the id still comes through');
});

test('siblings: sameRoleAndName counts 3 identical Save buttons, 1 for a unique one', async () => {
  const ambiguous = await fingerprintOn('ambiguous-before', 'button.x-expect');
  assert.equal(ambiguous.siblings.sameRoleAndName, 3, 'three indistinguishable Save buttons');
  assert.equal(ambiguous.siblings.sameText, 3, 'three elements with the same text');

  const unique = await fingerprintOn('text-change-before', 'button.x-expect');
  assert.equal(unique.siblings.sameRoleAndName, 1, 'only one "Save Customer" button');
});

test('siblings: the context-duplicates page has three Save buttons but distinct containers', async () => {
  const fp = await fingerprintOn('context-duplicates-before', 'section[aria-label="Customer Details"] button.x-expect');
  assert.equal(fp.siblings.sameRoleAndName, 3, 'role+name alone is not enough here');
  assert.equal(fp.context.ancestors[0].name, 'Customer Details', 'but the container tells them apart');
});

test('context.ancestors: each Save button reports its own aria-labelled region', async () => {
  await open('context-duplicates-before');
  for (const label of ['Customer Details', 'Address Details', 'Order Details']) {
    const fp = await fingerprint(`section[aria-label="${label}"] button`);
    const region = fp.context.ancestors.find((a) => a.role === 'region');
    assert.ok(region, `a region ancestor for ${label}`);
    assert.equal(region.name, label, `the region is named ${label}`);
    assert.equal(region.tag, 'section', 'and it is the section');
    assert.equal(fp.context.landmark, label, 'landmark agrees');
    assert.equal(fp.context.heading, label, 'the nearest heading agrees too');
  }
});

test('context.ancestors: nesting changes but the named container does not', async () => {
  const before = await fingerprintOn('nesting-change-before', 'button.x-expect');
  const after = await fingerprintOn('nesting-change-after', 'button.x-expect');
  const nameOf = (fp) => (fp.context.ancestors.find((a) => a.role === 'region') || {}).name;
  assert.equal(nameOf(before), 'Customer Details', 'before: div[role=region]');
  assert.equal(nameOf(after), 'Customer Details', 'after: <section aria-label>');
  assert.equal(before.name, after.name, 'and the accessible name is untouched');
  assert.notEqual(before.selectors.absoluteXPath, after.selectors.absoluteXPath, 'while the position moved');
});

test('selectors.semanticXPath is unique and really selects the recorded element', async () => {
  const cases = [
    ['text-change-before', 'button.x-expect'],
    ['id-text-change-before', 'button.x-expect'],
    ['css-change-before', 'button.x-expect'],
    ['nesting-change-before', 'button.x-expect'],
    ['context-duplicates-before', 'section[aria-label="Customer Details"] button.x-expect'],
    ['labels-before', 'input.x-expect-for'],
    ['generated-ids-before', 'input.x-expect'],
  ];
  for (const [fixture, selector] of cases) {
    await open(fixture);
    const fp = await fingerprint(selector);
    assert.ok(fp.selectors.semanticXPath, `${fixture}: a semantic XPath was produced`);
    const check = await page.evaluate(([xp, sel]) => {
      const r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return { count: r.snapshotLength, same: r.snapshotLength === 1 && r.snapshotItem(0) === document.querySelector(sel) };
    }, [fp.selectors.semanticXPath, selector]);
    assert.equal(check.count, 1, `${fixture}: ${fp.selectors.semanticXPath} must match exactly one element`);
    assert.equal(check.same, true, `${fixture}: and it must be the recorded element`);
  }
});

test('selectors: positionalCss and absoluteXPath are ALWAYS produced', async () => {
  const cases = [
    ['ambiguous-before', 'button.x-expect'],
    ['table-before', 'button.x-expect'],
    ['dynamic-before', 'canvas.x-expect-canvas'],
    ['generated-ids-before', 'select'],
  ];
  for (const [fixture, selector] of cases) {
    const fp = await fingerprintOn(fixture, selector);
    assert.ok(fp.selectors.positionalCss, `${fixture}: positionalCss`);
    assert.ok(fp.selectors.absoluteXPath, `${fixture}: absoluteXPath`);
    assert.match(fp.selectors.absoluteXPath, /^\/html/, `${fixture}: absoluteXPath starts at the root`);
    const found = await page.evaluate(([css, sel]) => {
      const hits = document.querySelectorAll(css);
      return hits.length === 1 && hits[0] === document.querySelector(sel);
    }, [fp.selectors.positionalCss, selector]);
    assert.equal(found, true, `${fixture}: positionalCss resolves to the recorded element today`);
  }
});

test('selectors: an ambiguous element gets NO semantic selector, only fallbacks', async () => {
  const fp = await fingerprintOn('ambiguous-before', 'button.x-expect');
  assert.equal(fp.selectors.semanticCss, null, 'nothing stable to build a CSS selector from');
  assert.equal(fp.selectors.semanticXPath, null, 'and nothing to build a meaningful XPath from');
  assert.ok(fp.selectors.positionalCss, 'only the positional fallback exists');
});

test('blindSpot: set for a canvas, null for a normal button', async () => {
  await open('dynamic-before');
  const canvas = await fingerprint('canvas.x-expect-canvas');
  assert.ok(canvas.blindSpot, 'a click on a canvas has no element behind it');
  assert.match(canvas.blindSpot, /canvas/i, 'and the reason says so');

  const button = await fingerprint('button.x-expect-static');
  assert.equal(button.blindSpot, null, 'an ordinary button is not a blind spot');
});

test('volatileName: a relative time inside an accessible name is flagged', async () => {
  await open('dynamic-before');
  const profile = await fingerprint('a.x-expect-profile');
  assert.equal(profile.name, "Dev's Profile Maheep Gupta 1h", 'the name as it stands today');
  assert.ok(profile.volatileName, 'and it is flagged as volatile');
  assert.match(profile.volatileName, /relative time/i, 'with the reason');

  const stable = await fingerprint('button.x-expect-static');
  assert.equal(stable.volatileName, null, '"Refresh" is not going anywhere');
});

test('state: visibility and enabled-ness are recorded, coordinates only as debug', async () => {
  const fp = await fingerprintOn('text-change-before', 'button.x-expect');
  assert.equal(fp.state.visible, true, 'visible');
  assert.equal(fp.state.enabled, true, 'enabled');
  assert.ok(fp.state.box, 'a box is kept for the failure report');
  const identity = JSON.stringify({ attrs: fp.attrs, selectors: fp.selectors, name: fp.name });
  assert.excludes(identity, String(fp.state.box.x), 'but no coordinate leaks into identity');
});

test('the capture listeners fire on a real click and hand back the element they hit', async () => {
  // A separate context, because `install` must be wired to a binding before the page loads.
  const captureContext = await browser.newContext();
  const captured = [];
  await captureContext.exposeFunction('__recSink', (payload) => { captured.push(payload); });
  await captureContext.addInitScript({ content: installSource('__recSink') });
  const capturePage = await captureContext.newPage();
  try {
    await capturePage.goto(urlFor('text-change-before'));
    await capturePage.click('button.x-expect');
    await capturePage.waitForFunction(() => document.querySelector('button.x-expect').__recUid != null);

    const clicks = captured.filter((c) => c.reason === 'click');
    assert.ok(clicks.length > 0, 'a click was captured');
    const fp = clicks[clicks.length - 1].fingerprint;
    assert.equal(fp.tag, 'button', 'the fingerprint is of the button');
    assert.equal(fp.name, 'Save Customer', 'with the right accessible name');
    assert.equal(fp.attrs['data-testid'], 'save-customer', 'and the right test id');

    const liveUid = await capturePage.evaluate(() => document.querySelector('button.x-expect').__recUid);
    assert.equal(fp.uid, liveUid, 'the captured uid is stamped on the element itself');
    assert.match(fp.uid, /^u\d+$/, 'and it looks like a capture id');

    const pointer = captured.filter((c) => c.reason === 'pointerdown');
    assert.ok(pointer.length > 0, 'pointerdown fires first, before any re-render can happen');
    assert.equal(pointer[pointer.length - 1].fingerprint.uid, fp.uid, 'and it is the same element');

    const exposed = await capturePage.evaluate(() => document.querySelector('button.x-expect').getAttribute('__recUid'));
    assert.equal(exposed, null, 'the uid is a JS property, never an attribute the page can see');
  } finally {
    await captureContext.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §B REPLAY — record on -before, resolve on -after
// ─────────────────────────────────────────────────────────────────────────────

test('replay text-change: a rewritten label and new classes do not break it', async () => {
  const r = await replay('text-change', 'button.x-expect');
  const won = firstResolution(r);
  assert.ok(won, `something should have resolved — ${summarise(r)}`);
  assert.equal(won.matches[0].mark, 'x-expect', 'and it must be the recorded button');
  assert.equal(won.strategy, 'testid', 'the explicit test contract wins, as it should');
  assert.equal(won.score, 100, 'at full score');

  const text = r.find((c) => c.strategy === 'text');
  assert.equal(text.matches.length, 0, 'while the text candidate correctly finds nothing');
});

test('replay id-text-change: the hand-written id survives the label change', async () => {
  const r = await replay('id-text-change', 'button.x-expect');
  const won = firstResolution(r);
  assert.ok(won, `something should have resolved — ${summarise(r)}`);
  assert.equal(won.matches[0].mark, 'x-expect', 'the recorded button');
  assert.equal(won.strategy, 'id', 'by its id, the only signal that did not change');
});

test('replay css-change: restyling is invisible to the engine', async () => {
  const r = await replay('css-change', 'button.x-expect');
  const won = firstResolution(r);
  assert.ok(won, `something should have resolved — ${summarise(r)}`);
  assert.equal(won.matches[0].mark, 'x-expect', 'the recorded button');
  assert.every(r.filter((c) => c.score >= 35), (c) => c.matches.length !== 1 || c.matches[0].mark === 'x-expect',
    'no meaningful candidate may resolve to anything else');
});

test('replay nesting-change: re-nesting is survived by meaning, not by position', async () => {
  const r = await replay('nesting-change', 'button.x-expect');
  const won = firstResolution(r);
  assert.ok(won, `something should have resolved — ${summarise(r)}`);
  assert.equal(won.matches[0].mark, 'x-expect', 'the recorded button');
  assert.equal(won.strategy, 'role', 'role + name is what carries a re-nesting');
  assert.equal(won.scoped, true, 'scoped to the container that kept its name');

  const positional = r.filter(isPositional);
  assert.ok(positional.length >= 3, 'all three positional fallbacks were offered');
  // Every fallback that describes a PATH is dead: the button moved. The one that survives is the
  // document-wide ordinal, and only because this fixture holds exactly one button — "button 1 of
  // 1" is still the same button. That is the case the resolver's identity check exists to sort
  // out, and it does: it compares the element it landed on, and here it is the recorded one.
  const rooted = positional.filter((c) => c.strategy === 'absoluteXPath'
    || (c.strategy === 'domIndex' && (c.params || {}).kind === 'path'));
  assert.equal(rooted.length, 2, 'the child-position chain and the absolute XPath');
  assert.every(rooted, (c) => c.matches.length === 0,
    'both are dead: they spell out a route from the root, and the route changed');

  // What survives is the point of having three fallbacks instead of one lump. The document-wide
  // ordinal ("button 1 of 1") and the relative XPath cut loose from the root (`//div/div/button`)
  // both still land — and they land on the RECORDED button, not on another one, which is what the
  // resolver's identity check is there to establish before anything is clicked.
  const survivors = positional.filter((c) => c.matches.length === 1);
  assert.ok(survivors.length >= 1, 'at least one fallback survives the re-nesting');
  assert.every(survivors, (c) => c.matches[0].mark === 'x-expect',
    'and every survivor is the recorded button, never a different one');
});

test('replay context-duplicates: a fourth identical section changes nothing', async () => {
  const r = await replay('context-duplicates', 'section[aria-label="Customer Details"] button.x-expect');
  const won = firstResolution(r);
  assert.ok(won, `something should have resolved — ${summarise(r)}`);
  assert.equal(won.matches[0].mark, 'x-expect', 'the Customer Details Save button, not one of the other three');
  assert.equal(won.scoped, true, 'it can only be trusted because it is scoped to its region');
  assert.equal(won.score, 90, 'role 85 + 5 for the container');
});

test('replay context-duplicates: NO candidate may ever resolve to a different Save button', async () => {
  const r = await replay('context-duplicates', 'section[aria-label="Customer Details"] button.x-expect');
  const wrong = r.filter((c) => c.score >= 11 && c.matches.length === 1 && c.matches[0].mark !== 'x-expect');
  assert.equal(wrong.map((c) => `${c.strategy}@${c.score}`), [], 'candidates that confidently pick the wrong button');
});

test('replay ambiguous: three identical buttons must fail safely, not be guessed at', async () => {
  const r = await replay('ambiguous', 'button.x-expect');
  const meaningful = r.filter((c) => c.score >= 11 && !isPositional(c));
  assert.every(meaningful, (c) => c.matches.length !== 1,
    'no meaningful strategy may claim to have found "the" Save button');
  assert.equal(firstResolution(r), null, `nothing above the positional floor resolves — ${summarise(r)}`);
  const role = r.find((c) => c.strategy === 'role');
  assert.equal(role.matches.length, 3, 'role + name honestly reports three matches');
});

test('replay ambiguous: the recorded fingerprint says up front that it is ambiguous', async () => {
  const fp = await fingerprintOn('ambiguous-before', 'button.x-expect');
  assert.equal(fp.siblings.sameRoleAndName, 3, 'the ambiguity is recorded, so the step can be flagged');
  const meaningful = candidatesFor(fp).filter((c) => c.score >= 11 && !isPositional(c));
  assert.every(meaningful, (c) => c.strategy === 'role' || c.strategy === 'text',
    'nothing stronger than a role or a bare text match can be offered');
  assert.every(meaningful, (c) => !c.scope,
    'and none of them can be scoped, because there is no container worth naming');
  assert.every(meaningful, (c) => c.score <= 85, 'none of them reaches test-id or id confidence');
});

test('replay removed: every candidate matches nothing, with a clear reason', async () => {
  const r = await replay('removed', 'button.x-expect');
  assert.every(r, (c) => c.matches.length === 0, 'the element is gone; nothing may match');
  assert.equal(firstResolution(r, 0), null, 'so there is no resolution at any score');
  const scoring = require('../src/identity/scoring');
  const verdict = scoring.finalScore(r[0], { matches: 0, correct: false });
  assert.match(verdict.rejected, /matched nothing/i, 'and scoring gives the reason a human can read');
});

test('replay replaced: every candidate that names the recorded element finds nothing', async () => {
  const r = await replay('replaced', 'button.x-expect');
  const selfIdentifying = r.filter((c) => /save-customer|Save Customer/.test(JSON.stringify(c.params)));
  assert.ok(selfIdentifying.length >= 3, 'there were several such candidates');
  assert.every(selfIdentifying, (c) => c.matches.length === 0,
    'Delete Customer is not Save Customer, and every candidate that says so agrees');
});

test('replay replaced: the resolver refuses the different element that took its place', async () => {
  // Some candidates name a CONTAINER and then say nothing about the element inside it:
  //   role  @78  { role: 'button' }  scoped to the "Customer Details" region
  //   css   @40  'section[aria-label="Customer Details"] button'   (browser-lib contextualCss,
  //                                                                 whose last leafTry is a bare tag)
  // On replaced-before.html that region held exactly one button, so both validated cleanly at
  // record time. On replaced-after.html they still match exactly one button — the Delete button.
  //
  // That is DELIBERATE, and it is not a bug in the candidate list. A locator that names only the
  // container is the one thing that survives a wholesale rename ("Save Customer" → "Save"), which
  // is the change this tool exists to tolerate — the very next test proves it does. So the
  // invariant "a different element in the same place must not be accepted" is not, and cannot be,
  // a property of candidates.js: a candidate is a QUESTION about the page, and the count coming
  // back as 1 is not an answer about identity.
  //
  // The invariant is owned one layer up, by resolver.js: a candidate matching exactly one element
  // is still not trusted until similarity.compare() has weighed that element's identity against
  // the recorded one. So this test asserts it there, through the real engine, and it asserts the
  // REASON as well as the refusal — a test that only checks "it failed" would still pass if the
  // engine failed for the wrong reason, or for no reason at all.
  await open('replaced-before');
  const target = await recordTarget('button.x-expect');
  assert.ok(target.candidates.length > 0, 'the recorded step really does carry candidates');

  await open('replaced-after');
  const err = await refusal(target);
  assert.equal(err.name, 'ResolutionError', 'the engine refuses by throwing, never by returning a guess');
  assert.ok(Array.isArray(err.attempts), 'and the failure carries the log of everything it tried');
  assert.ok(err.attempts.length > 0, 'which is not empty');

  // The proof is not that nothing was found. It is that something WAS found and was turned down.
  const turnedDown = err.attempts.filter((a) => a.matches === 1 && a.rejected);
  assert.ok(turnedDown.length > 0,
    `the container-scoped candidate must match the Delete button and be REJECTED, not miss it${summariseAttempts(err.attempts)}`);

  // …and turned down because its identity no longer matches. On this fixture the replacement also
  // carries a different test id, and that is the first fatal rule to fire, so the sentence names
  // the test ids; `differed` records that the accessible name changed with it. The next test but
  // one strips the test id away and shows the name rule refusing on its own.
  const why = turnedDown[0];
  assert.equal(why.similarity.fatal, true, 'the rejection is fatal — not a low score that a threshold happened to catch');
  assert.includes(why.similarity.differed, 'name',
    'and the log records the name change: the button that said "Save Customer" now says "Delete Customer"');
  assert.match(why.rejected, /changed from .*save-customer.* to .*delete-customer/i,
    'the rejection says in words which signal changed and what it changed to');
  assert.match(err.message, /not the one that was recorded/i, 'the top-level message says the same thing');
  assert.match(err.suggestion, /different one now|re-record/i, 'and tells the developer what to do about it');
});

test('replay replaced: with no test id and no id, the changed name alone is enough to refuse', async () => {
  // The backstop the test above leans on, isolated. Same shape — a region whose only button is
  // swapped for an unrelated one — but the buttons carry nothing but their label, so the only rule
  // that can fire is the last one in similarity.compare(): nothing contract-like anchors these two
  // elements, and the name changed to something unrelated. "Save Customer" → "Save Customer 2"
  // would be a rename; "Save Customer" → "Delete Customer" is a different button.
  await setPage(REGION_WITH_BUTTON('Save Customer'));
  const target = await recordTarget('button');

  await setPage(REGION_WITH_BUTTON('Delete Customer'));
  const err = await refusal(target, { timeoutMs: 500 });

  const turnedDown = err.attempts.filter((a) => a.matches === 1 && a.rejected);
  assert.ok(turnedDown.length > 0,
    `the container-scoped candidate must find the Delete button and refuse it${summariseAttempts(err.attempts)}`);
  assert.every(turnedDown, (a) => /name/i.test(a.rejected) && /Delete Customer/.test(a.rejected),
    'and every such refusal is explained by the name change, in words');
  assert.match(err.message, /"Save Customer".*"Delete Customer"/,
    `the failure names both the button recorded and the button found in its place${summariseAttempts(err.attempts)}`);
});

test('replay renamed: the same button under a shorter label still resolves, via its container', async () => {
  // The other half of the same design, and the reason the container-scoped candidate is generated
  // at all. Nothing here has a test id or an id — only a label, and the label is rewritten. Every
  // candidate that says "Save Customer" now matches nothing; the one that says "the button in
  // Customer Details" still matches, and this time similarity.compare() ALLOWS it, because "Save"
  // is contained in "Save Customer" and is therefore a rename, not a replacement.
  await setPage(REGION_WITH_BUTTON('Save Customer'));
  const target = await recordTarget('button');

  await setPage(REGION_WITH_BUTTON('Save'));
  const won = await identity.resolve(page, target, { timeoutMs: 500 });
  assert.equal((await won.locator.textContent()).trim(), 'Save', 'the renamed button, found');
  assert.ok(won.candidate.scope, 'and found by naming its container, which is the only thing that did not change');
  assert.equal(won.candidate.params.name, undefined, 'by a candidate that deliberately says nothing about the name');
  assert.equal(won.similarity.fatal, false, 'a rename is not fatal');
  assert.includes(won.similarity.matched, 'role', 'role, tag and container all still agree');
  assert.includes(won.similarity.differed, 'name', 'only the name moved');
});

test('replay replaced: every positional fallback lands on the WRONG element', async () => {
  // This is the trap the brief calls out, and splitting `positional` into three named strategies
  // does not make it go away — it makes it legible. All three still match exactly one element,
  // and it is the Delete button. Nothing that consumes these candidates may accept them on the
  // count alone; the identity check in resolver.js is what turns them down (the test below).
  const r = await replay('replaced', 'button.x-expect');
  const positional = r.filter(isPositional);
  assert.equal(positional.map((c) => c.strategy),
    ['domIndex', 'domIndex', 'relativeXPath', 'relativeXPath', 'absoluteXPath'],
    'all three fallbacks exist, separately named, in the order they are tried');
  // The semantic relative XPath names the old test id, so it correctly finds nothing. Every
  // fallback that describes a POSITION finds the replacement and reports it as a clean single
  // match — which is exactly why a count of 1 may never be treated as an identity.
  const byPosition = positional.filter((c) => c.strategy !== 'relativeXPath' || (c.params || {}).derivedFrom);
  assert.equal(byPosition.length, 4, 'four of the five fallbacks are index-shaped');
  assert.every(byPosition, (c) => c.matches.length === 1, 'and every one of them matches exactly one element');
  assert.every(byPosition, (c) => c.matches[0].mark === null && /Delete/.test(c.matches[0].text),
    'which is the Delete button — accepting it would delete a customer instead of saving one');
});

test('replay generated-ids: the hand-written id survives a full renumbering', async () => {
  const r = await replay('generated-ids', 'input.x-expect');
  const won = firstResolution(r);
  assert.ok(won, `something should have resolved — ${summarise(r)}`);
  assert.equal(won.matches[0].mark, 'x-expect', 'the customer-name input');
  assert.excludes(JSON.stringify(r.map((c) => c.params)), 'mat-input', 'no candidate was built on a generated id');
  assert.excludes(JSON.stringify(r.map((c) => c.params)), ':r7:', 'nor on a React useId');
});

test('replay generated-ids: a field with only a generated id falls back to its label', async () => {
  const r = await replay('generated-ids', 'input.x-expect-2');
  const won = firstResolution(r);
  assert.ok(won, `something should have resolved — ${summarise(r)}`);
  assert.equal(won.matches[0].mark, 'x-expect-2', 'the account-code input');
  assert.includes(['role', 'label', 'attr'], won.strategy, 'resolved by meaning, not by id');
  assert.every(r, (c) => c.strategy !== 'id', 'no id candidate was even offered');
});

test('replay labels: every naming style survives its markup being rewritten', async () => {
  for (const [selector, expectedName] of [
    ['input.x-expect-for', 'Email address'],
    ['input.x-expect-wrap', 'Phone number'],
    ['input.x-expect-labelledby', 'Currency code'],
    ['input.x-expect-placeholder', 'Search customers'],
    ['input.x-expect-submit', 'Send message'],
    ['img.x-expect-img', 'Company logo'],
    ['a.x-expect-link', 'Contact support'],
  ]) {
    const r = await replay('labels', selector);
    assert.equal(r.fingerprint.name, expectedName, `${selector}: recorded name`);
    const won = firstResolution(r);
    assert.ok(won, `${selector}: something should have resolved — ${summarise(r)}`);
    assert.equal(won.matches[0].mark, selector.split('.')[1], `${selector}: resolved to the right control`);
  }
});

test('replay dynamic: content that arrives late is waited for, not declared missing', async () => {
  // Recording also has to wait: the button does not exist when the page finishes loading.
  await open('dynamic-before');
  await page.waitForSelector('[data-testid="acknowledge-alert"]');
  const fp = await fingerprint('[data-testid="acknowledge-alert"]');
  assert.equal(fp.attrs['data-testid'], 'acknowledge-alert', 'recorded from the late-rendered button');

  const started = Date.now();
  await open('dynamic-after');
  await page.waitForSelector('[data-testid="acknowledge-alert"]');
  const waited = Date.now() - started;
  assert.ok(waited >= 300, `the button cannot exist before its 300ms timer (waited ${waited}ms)`);

  const matches = await page.evaluate((cand) => window.__match(cand), candidatesFor(fp)[0]);
  assert.equal(matches.length, 1, 'once waited for, the test id resolves');
  assert.equal(matches[0].mark, 'x-expect-late', 'to the acknowledge button');
});

test('replay dynamic: a name containing a relative time goes stale, the id does not', async () => {
  const r = await replay('dynamic', 'a.x-expect-profile');
  assert.match(r.fingerprint.volatileName, /relative time/i, 'the volatility was predicted at record time');

  const role = r.find((c) => c.strategy === 'role' && !c.scoped);
  assert.equal(role.matches.length, 0, '"…Maheep Gupta 1h" no longer exists — it says 3h now');
  assert.equal(role.score, 55, 'which is exactly why it was docked 30 points at record time');

  const won = firstResolution(r);
  assert.ok(won, `something should still have resolved — ${summarise(r)}`);
  assert.equal(won.matches[0].mark, 'x-expect-profile', 'the hand-written id carried it');
  assert.equal(won.strategy, 'id', 'by id');
});

test('replay table: the positional fallback silently edits the WRONG customer', async () => {
  // Recorded: Edit in the "Acme Corp" row. The after page moves Acme Corp to the bottom.
  const r = await replay('table', 'button.x-expect');
  const positional = r.filter(isPositional).filter((c) => c.matches.length === 1);
  assert.ok(positional.length >= 2, 'the index-based fallbacks still match exactly one button');
  assert.every(positional, (c) => c.matches[0].mark === null,
    'and it is not the recorded one — row 1 is Initech now');
});

test('[known bug] replay table: a candidate must be scoped to the ROW, not to the cell', async () => {
  const fp = await fingerprintOn('table-before', 'button.x-expect');
  const rowAncestor = fp.context.ancestors.find((a) => a.role === 'row');
  assert.ok(rowAncestor, 'the row is in context.ancestors');
  assert.includes(rowAncestor.name, 'Acme Corp', 'and it is named by its content');

  const scopedToRow = candidatesFor(fp).filter((c) => c.scope && c.scope.params && c.scope.params.role === 'row');
  assert.ok(scopedToRow.length > 0,
    'candidates.js keeps three scopes but only ever uses scopeCandidates()[0] — here the <td> named '
    + '"Edit Delete", which is in every row — so the row scope that would actually disambiguate is never used');
});

test('[known bug] replay table: the Edit button in the Acme Corp row must still resolve', async () => {
  const r = await replay('table', 'button.x-expect');
  const won = firstResolution(r);
  assert.ok(won, `resolution must follow the row content, not the row index — ${summarise(r)}`);
  assert.equal(won.matches[0].mark, 'x-expect', 'the Edit button in the Acme Corp row');
});

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  await boot();
  try {
    await run('fingerprint');
  } finally {
    await shutdown();
  }
})().catch((err) => {
  process.stdout.write(`fingerprint: harness crashed — ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
