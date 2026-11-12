/**
 * The positional band: DOM index, relative XPath, absolute XPath.
 *
 *   node tests/positional.test.js      (run from the repo root)
 *
 * These are the fallbacks the engine reaches for when every way of NAMING the element has stopped
 * working — the text was rewritten, the label was reworded, the test id was never there. They are
 * tried in a fixed order after every semantic strategy (CONTRACT.md §8), and every one of them is
 * subject to the same rule as the strategies above it: finding one element is not the same as
 * finding the RIGHT element, so nothing is acted on until similarity.compare() has agreed the
 * thing standing in that position is still the thing that was recorded.
 *
 * Four groups, each ten or more tests:
 *
 *   §A  domIndex        — the recorded child / of-type / document index
 *   §B  relativeXPath   — an XPath anchored on something other than the document root
 *   §C  absoluteXPath   — /html/body/… , the last thing tried
 *   §D  ordering        — text first, positional last, and the identity check on both sides of it
 *
 * The fixtures are the `pos-*` pairs in `identity/__fixtures__`, one per way a page changes:
 *
 *   pos-moved         the element moved; its text did not          → meaning must win
 *   pos-renamed       the text changed; the position did not       → position must win, and verify
 *   pos-replaced      same position, genuinely different element   → must refuse
 *   pos-reordered     siblings shuffled                            → meaning must win
 *   pos-inserted      a node inserted above it, shifting indexes   → meaning must win
 *   pos-restructured  wrapped in new layers; absolute path dies    → relative XPath must win
 *   pos-deep          two identical deep chains                    → only the absolute path can tell them apart
 *   pos-twins         three indistinguishable buttons              → must refuse, whatever matched
 *
 * Every target element carries `type="submit"` and nothing else identifying. That is deliberate:
 * `type` counts towards the similarity score but is NOT allowed to anchor a match (CONTRACT.md
 * §7), so these pages are the hardest honest case — enough signal to recognise a renamed button,
 * never enough to vouch for a replaced one.
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { test, assert, run } = require('./harness');
const { SOURCE } = require('../src/identity/browser-lib');
const { candidatesFor, relativeTail } = require('../src/identity/candidates');
const { buildLocator, describeCandidate } = require('../src/identity/locators');
const scoring = require('../src/identity/scoring');
const identity = require('../src/identity');

const FIXTURES = path.join(__dirname, '..', 'src', 'identity', '__fixtures__');
const urlFor = (name) => pathToFileURL(path.join(FIXTURES, `${name}.html`)).href;

/** The strategies that find an element by WHERE it sits. CONTRACT.md §3. */
const POSITIONAL = new Set(['domIndex', 'relativeXPath', 'absoluteXPath', 'positional']);
const isPositional = (c) => POSITIONAL.has(c.strategy);

let browser;
let context;
let page;

async function boot() {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  await context.addInitScript({ content: SOURCE });
  page = await context.newPage();
}

async function shutdown() {
  if (browser) await browser.close();
}

async function open(fixture) {
  await page.goto(urlFor(fixture));
  return page;
}

/** The raw fingerprint of one element on the page that is open. */
function fingerprintOf(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('fixture selector matched nothing: ' + sel);
    return window.__opkeyRec.fingerprint(el);
  }, selector);
}

async function fingerprintOn(fixture, selector) {
  await open(fixture);
  return fingerprintOf(selector);
}

/** Record a step the way the recorder does: fingerprint, then validate every candidate. */
async function recordOn(fixture, selector) {
  await open(fixture);
  return identity.buildTarget(page, await fingerprintOf(selector));
}

/** Keep only the candidates that pass `pred`, so one strategy can be put on trial by itself. */
function only(target, pred) {
  const candidates = target.candidates.filter(pred);
  if (!candidates.length) throw new Error('the filter left no candidates — the test would silently re-derive them');
  return { ...target, candidates };
}

const positionalOnly = (target) => only(target, isPositional);
const strategyOnly = (target, name) => only(target, (c) => c.strategy === name);

/** Resolve `target` against a fixture. Throws whatever the resolver throws. */
async function resolveOn(fixture, target, options) {
  await open(fixture);
  return identity.resolve(page, target, Object.assign({ timeoutMs: 500 }, options || {}));
}

/** Resolution must be REFUSED. Returns the ResolutionError; fails loudly if it resolved. */
async function refusalOn(fixture, target, options) {
  let won = null;
  try {
    won = await resolveOn(fixture, target, options);
  } catch (err) {
    if (err.name !== 'ResolutionError') throw err;
    return err;
  }
  const text = (await won.locator.textContent().catch(() => '?')).trim();
  assert.ok(false, `resolution had to be refused, but "${text}" was accepted via ${won.candidate.strategy}@${won.candidate.score}`);
  return null;
}

const strategiesOf = (list) => list.map((c) => c.strategy);
const marked = (locator) => locator.evaluate((el) => el.className.indexOf('x-expect') >= 0);
const logOf = (err) => (err.tried || []).join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// §A  domIndex — the element's position among its siblings and among its kind
// ─────────────────────────────────────────────────────────────────────────────

test('A1  domIndex is a first-class field on the fingerprint, not a selector string', async () => {
  const fp = await fingerprintOn('pos-renamed-before', 'button.x-expect');
  assert.ok(fp.domIndex, 'the fingerprint carries a domIndex object');
  for (const key of ['tag', 'parentTag', 'childIndex', 'childCount', 'ofTypeIndex', 'ofTypeCount',
    'documentIndex', 'documentCount', 'depth']) {
    assert.ok(fp.domIndex[key] !== undefined, `domIndex.${key} is recorded`);
  }
  assert.equal(fp.domIndex.tag, 'button', 'and it names the tag the indexes are counted over');
});

test('A2  childIndex counts the parent\'s element children, in order', async () => {
  const fp = await fingerprintOn('pos-renamed-before', 'button.x-expect');
  assert.equal(fp.domIndex.parentTag, 'div', 'the parent is the wrapper div');
  assert.equal(fp.domIndex.childIndex, 1, 'the span comes first, so the button is child 1');
  assert.equal(fp.domIndex.childCount, 2, 'out of two element children');
});

test('A3  ofTypeIndex counts only the siblings of the same tag', async () => {
  const fp = await fingerprintOn('pos-reordered-before', 'button.x-expect');
  assert.equal(fp.domIndex.ofTypeIndex, 0, 'the first of the three buttons');
  assert.equal(fp.domIndex.ofTypeCount, 3, 'and there are three of them');
  const renamed = await fingerprintOn('pos-renamed-before', 'button.x-expect');
  assert.equal(renamed.domIndex.ofTypeIndex, 0, 'a lone button is of-type 0');
  assert.equal(renamed.domIndex.ofTypeCount, 1, 'of one — even though it is child 1 of 2');
});

test('A4  documentIndex counts every element of that tag in the whole document', async () => {
  const fp = await fingerprintOn('pos-moved-before', 'button.x-expect');
  assert.equal(fp.domIndex.documentIndex, 0, 'the Approve button is the first button on the page');
  assert.equal(fp.domIndex.documentCount, 2, 'and the Help button is the second');
});

test('A5  a node inserted above the target shifts every index below it', async () => {
  const before = await fingerprintOn('pos-inserted-before', 'button.x-expect');
  const after = await fingerprintOn('pos-inserted-after', 'button.x-expect');
  assert.equal(before.domIndex.childIndex, 1, 'child 1 when it was recorded');
  assert.equal(after.domIndex.childIndex, 2, 'child 2 once a badge was inserted before it');
  assert.equal(before.domIndex.documentIndex, 0, 'the only button on the page, once');
  assert.equal(after.domIndex.documentIndex, 1, 'the second one now that a banner button exists');
  assert.notEqual(before.selectors.absoluteXPath, after.selectors.absoluteXPath,
    'and the absolute XPath moved with it');
});

test('A6  candidates: two domIndex candidates are emitted, the path first, both scoring 12', async () => {
  const fp = await fingerprintOn('pos-renamed-before', 'button.x-expect');
  const di = candidatesFor(fp).filter((c) => c.strategy === 'domIndex');
  assert.equal(di.length, 2, 'the child-position chain and the document ordinal');
  assert.equal(di.map((c) => c.params.kind), ['path', 'ordinal'], 'the local one is tried first');
  assert.every(di, (c) => c.score === 12, 'both score 12 — the top of the positional band');
  assert.equal(di[1].params.index, fp.domIndex.documentIndex, 'the ordinal carries the recorded index');
  assert.equal(di[0].params.childIndex, fp.domIndex.childIndex, 'the path carries the recorded child index');
});

test('A7  locators: the ordinal becomes locator(tag).nth(index), the path becomes CSS', async () => {
  const fp = await fingerprintOn('pos-reordered-before', 'button.x-expect');
  const di = candidatesFor(fp).filter((c) => c.strategy === 'domIndex');
  assert.equal(describeCandidate(di[1]), 'locator("button").nth(0)', 'the ordinal reads as an nth()');
  assert.match(describeCandidate(di[0]), /^locator\(".*button/, 'the path reads as a CSS chain');
  const live = buildLocator(page, di[1]);
  assert.equal(await live.count(), 1, 'and the ordinal locator really pins one element');
});

test('A8  the text changed but the position did not: domIndex resolves it', async () => {
  const target = await recordOn('pos-renamed-before', 'button.x-expect');
  const won = await resolveOn('pos-renamed-after', target);
  assert.equal(won.candidate.strategy, 'domIndex', 'the DOM index is what found it');
  assert.equal((await won.locator.textContent()).trim(), 'Approve', 'the renamed button');
  assert.equal(await marked(won.locator), true, 'and it is the element that was recorded');
});

test('A9  …and it is only accepted because the identity check agreed', async () => {
  const target = await recordOn('pos-renamed-before', 'button.x-expect');
  const won = await resolveOn('pos-renamed-after', target);
  assert.ok(won.similarity, 'a positional match must carry the similarity it was verified with');
  assert.ok(won.similarity.score >= 70, `and that score must clear the bar — got ${won.similarity.score}`);
  assert.equal(won.similarity.fatal, false, 'a shortened label is a rename, not a replacement');
  assert.includes(won.similarity.differed, 'name', 'the log records what changed');
  assert.includes(won.similarity.matched, 'role', 'and what did not');
});

test('A10 domIndex found exactly one element, at 100% identity, and was still refused', async () => {
  // Three indistinguishable buttons. The recorded index matches one element and it looks EXACTLY
  // like the recording — because so do the other two. This is the case the old code covered by
  // deleting positional candidates outright; it is now covered by refusing them on the evidence.
  const target = await recordOn('pos-twins-before', 'button.x-expect');
  const err = await refusalOn('pos-twins-after', positionalOnly(target));
  const di = err.attempts.filter((a) => a.strategy === 'domIndex');
  assert.equal(di.length, 2, 'both DOM-index candidates were tried');
  assert.every(di, (a) => a.matches === 1, 'each matched exactly one element');
  assert.every(di, (a) => a.similarity.score === 100, 'each looked identical to the recording');
  assert.every(di, (a) => /share its identity/.test(a.rejected), 'and each was refused anyway');
});

test('A11 the document ordinal landing on a different element is refused, not clicked', async () => {
  // pos-inserted-after grows a "Dismiss" button in a banner, so button #0 is no longer the target.
  const target = await recordOn('pos-inserted-before', 'button.x-expect');
  const ordinal = only(target, (c) => c.strategy === 'domIndex' && c.params.kind === 'ordinal');
  const err = await refusalOn('pos-inserted-after', ordinal);
  const a = err.attempts[0];
  assert.equal(a.matches, 1, 'the recorded index still points at something');
  assert.ok(a.similarity, 'which was compared with the recording');
  assert.equal(a.similarity.fatal, true, 'and it is a different button — Dismiss, not Approve Invoice');
  assert.match(logOf(err), /domIndex/, 'the failure log names the strategy that was tried');
});

test('A12 a different element in the same slot is refused however the index is expressed', async () => {
  const target = await recordOn('pos-renamed-before', 'button.x-expect');
  const err = await refusalOn('pos-replaced-after', positionalOnly(target));
  const di = err.attempts.filter((a) => a.strategy === 'domIndex');
  assert.equal(di.length, 2, 'both DOM-index candidates ran');
  assert.every(di, (a) => a.matches === 1 && a.similarity.fatal,
    'both found the Delete Everything button and both called it fatal');
  assert.match(err.message, /Delete Everything/, 'and the failure says what it found instead');
});

// ─────────────────────────────────────────────────────────────────────────────
// §B  relativeXPath — an XPath anchored on something other than the document root
// ─────────────────────────────────────────────────────────────────────────────

test('B1  two relative XPaths are emitted: the semantic one and the one cut loose from the root', async () => {
  const fp = await fingerprintOn('pos-renamed-before', 'button.x-expect');
  const rel = candidatesFor(fp).filter((c) => c.strategy === 'relativeXPath');
  assert.equal(rel.length, 2, 'the semantic XPath and the derived tail');
  assert.equal(rel[0].params.value, fp.selectors.semanticXPath, 'the semantic one comes first');
  assert.equal(rel[1].params.derivedFrom, 'absoluteXPath', 'the second says where it came from');
  assert.every(rel, (c) => c.score === 10, 'both score 10');
});

test('B2  relativeTail strips the document root and keeps the last three steps', () => {
  assert.equal(relativeTail('/html/body/div[2]/form/section/button[3]'), '//form/section/button[3]',
    'html and body are exactly the anchor being cut away');
  assert.equal(relativeTail('/html/body/div[3]/div'), '//div[3]/div', 'a short path keeps what it has');
});

test('B3  relativeTail refuses to produce a shape with no location in it', () => {
  assert.equal(relativeTail('/html/body/button'), null, 'one step left is just "//button" — not a location');
  assert.equal(relativeTail(''), null, 'nothing in, nothing out');
  assert.equal(relativeTail(null), null, 'null in, nothing out');
  assert.equal(relativeTail('//button[@id="x"]'), null, 'it only ever cuts an ABSOLUTE path down');
});

test('B4  the relative XPath is scored below every semantic strategy', () => {
  assert.equal(scoring.baseScore('relativeXPath'), 10, 'relativeXPath = 10');
  for (const semantic of ['testid', 'id', 'role', 'label', 'attr', 'placeholder', 'altText', 'title', 'text', 'css', 'xpath']) {
    assert.ok(scoring.baseScore(semantic) > 10, `${semantic} outranks a relative XPath`);
  }
});

test('B5  …and below the DOM index, which is tried before it', () => {
  assert.ok(scoring.baseScore('domIndex') > scoring.baseScore('relativeXPath'), 'domIndex 12 > relativeXPath 10');
  assert.ok(scoring.baseScore('relativeXPath') > scoring.baseScore('absoluteXPath'), 'relativeXPath 10 > absoluteXPath 6');
});

test('B6  the document was restructured: the absolute path died and the relative one carried it', async () => {
  const target = await recordOn('pos-restructured-before', 'button.x-expect');
  const won = await resolveOn('pos-restructured-after', target);
  assert.equal(won.candidate.strategy, 'relativeXPath', 'a relative XPath is what found it');
  assert.equal(await marked(won.locator), true, 'and it found the recorded button');
  assert.ok(won.similarity.score >= 70, 'verified against the recording, as every match must be');
});

test('B7  the one that survived is the tail cut loose from the root, not the semantic one', async () => {
  const target = await recordOn('pos-restructured-before', 'button.x-expect');
  const won = await resolveOn('pos-restructured-after', target);
  assert.equal(won.candidate.params.derivedFrom, 'absoluteXPath', 'the derived tail');
  assert.match(won.candidate.params.value, /^\/\//, 'which is relative, by construction');
  const semantic = won.attempts.find((a) => a.strategy === 'relativeXPath' && /normalize-space/.test(a.locator));
  assert.equal(semantic.matches, 0, 'the text-based XPath matched nothing — the button was renamed');
});

test('B8  the DOM index was tried first, found the wrong button, and was turned down', async () => {
  const target = await recordOn('pos-restructured-before', 'button.x-expect');
  const won = await resolveOn('pos-restructured-after', target);
  const ordinal = won.attempts.find((a) => a.strategy === 'domIndex' && /nth\(/.test(a.locator));
  assert.equal(ordinal.matches, 1, 'the recorded ordinal still pointed at a button');
  assert.equal(ordinal.similarity.fatal, true, 'the Print button in the new header — a different element');
  assert.before(strategiesOf(won.attempts), 'domIndex', 'relativeXPath', 'and it was tried BEFORE the XPath');
});

test('B9  a semantic XPath survives the element moving, because it is made of meaning', async () => {
  const target = await recordOn('pos-moved-before', 'button.x-expect');
  const won = await resolveOn('pos-moved-after', positionalOnly(target));
  assert.equal(won.candidate.strategy, 'relativeXPath', 'the XPath built from the text');
  assert.match(won.candidate.params.value, /normalize-space/, 'which is what makes it survive a move');
  assert.equal(await marked(won.locator), true, 'and it is still the recorded button');
  assert.equal(won.similarity.score, 100, 'nothing about the element changed — only where it sits');
});

test('B10 a relative XPath that lands on a different element is refused like any other', async () => {
  const target = await recordOn('pos-renamed-before', 'button.x-expect');
  const err = await refusalOn('pos-replaced-after', strategyOnly(target, 'relativeXPath'));
  const found = err.attempts.filter((a) => a.matches === 1);
  assert.ok(found.length > 0, 'one of the two relative XPaths did find an element');
  assert.every(found, (a) => a.similarity.fatal, 'and every one of them was fatal');
  assert.every(found, (a) => /changed from "Approve Invoice" to "Delete Everything"/.test(a.rejected),
    'with the reason spelled out in words');
});

test('B11 an ambiguous relative XPath is refused rather than resolved by picking one', async () => {
  const target = await recordOn('pos-deep-before', 'button.x-expect');
  const err = await refusalOn('pos-deep-after', strategyOnly(target, 'relativeXPath'));
  const many = err.attempts.find((a) => a.matches > 1);
  assert.ok(many, 'the tail //div/div/button matches both deep chains');
  assert.match(many.rejected, /position that matches more than one element identifies nothing/,
    'and a position that matches several is not a location at all');
});

// ─────────────────────────────────────────────────────────────────────────────
// §C  absoluteXPath — /html/body/… , the very last thing tried
// ─────────────────────────────────────────────────────────────────────────────

test('C1  an absolute XPath is recorded for every element, rooted at /html', async () => {
  for (const fixture of ['pos-moved-before', 'pos-renamed-before', 'pos-deep-before', 'pos-twins-before']) {
    const fp = await fingerprintOn(fixture, 'button.x-expect');
    assert.match(fp.selectors.absoluteXPath, /^\/html\//, `${fixture}: starts at the document root`);
  }
});

test('C2  it is emitted as its own strategy, scoring 6 — the bottom of the table', async () => {
  const fp = await fingerprintOn('pos-renamed-before', 'button.x-expect');
  const abs = candidatesFor(fp).filter((c) => c.strategy === 'absoluteXPath');
  assert.equal(abs.length, 1, 'exactly one');
  assert.equal(abs[0].score, 6, 'scoring 6');
  assert.equal(abs[0].params.value, fp.selectors.absoluteXPath, 'and carrying the recorded path');
  assert.equal(Math.min(...candidatesFor(fp).map((c) => c.score)), 6, 'nothing scores lower');
});

test('C3  it is always the last candidate in the list', async () => {
  for (const fixture of ['pos-moved-before', 'pos-renamed-before', 'pos-reordered-before', 'pos-inserted-before']) {
    const list = candidatesFor(await fingerprintOn(fixture, 'button.x-expect'));
    assert.equal(list[list.length - 1].strategy, 'absoluteXPath', `${fixture}: dead last`);
  }
});

test('C4  two identical deep chains: only the absolute path can tell them apart', async () => {
  const target = await recordOn('pos-deep-before', 'button.x-expect');
  const won = await resolveOn('pos-deep-after', target);
  assert.equal(won.candidate.strategy, 'absoluteXPath', 'the absolute XPath is what resolved it');
  assert.equal(await marked(won.locator), true, 'and it found the recorded button, not its twin');
  assert.match(won.candidate.params.value, /div\[1\]/, 'because it is indexed from the root');
});

test('C5  …and it is still verified before it is acted on', async () => {
  const target = await recordOn('pos-deep-before', 'button.x-expect');
  const won = await resolveOn('pos-deep-after', target);
  assert.ok(won.similarity, 'the winning absolute match carries a similarity result');
  assert.ok(won.similarity.score >= 70, `which cleared the bar — got ${won.similarity.score}`);
  assert.equal(won.similarity.fatal, false, 'and was not fatal');
  assert.ok(won.confidence > 0, 'confidence is reported, and it is honest about the weak locator');
  assert.ok(won.confidence < 60, `a score-6 locator can never report high confidence — got ${won.confidence}`);
});

test('C6  the cheaper fallbacks were tried first and each said why it failed', async () => {
  const target = await recordOn('pos-deep-before', 'button.x-expect');
  const won = await resolveOn('pos-deep-after', target);
  const order = strategiesOf(won.attempts);
  assert.before(order, 'domIndex', 'relativeXPath', 'DOM index before relative XPath');
  assert.before(order, 'relativeXPath', 'absoluteXPath', 'relative XPath before absolute XPath');
  assert.every(won.attempts.filter((a) => !a.accepted), (a) => !!a.rejected || a.matches === 0,
    'and every one that did not win recorded a reason');
});

test('C7  the child-position chain was already rejected AT RECORD TIME as ambiguous', async () => {
  // positionalCss stops after eight levels, so on a nine-deep page it is no longer anchored and
  // matches both chains. validate.js catches that on the page it was born on.
  const target = await recordOn('pos-deep-before', 'button.x-expect');
  const chain = target.candidates.find((c) => c.strategy === 'domIndex' && c.params.kind === 'path');
  assert.ok(chain, 'the chain candidate is still saved, so the failure report can mention it');
  assert.equal(chain.verified, false, 'but it was never verified');
  assert.match(chain.rejected, /ambiguous|2 element/, 'because it matched more than one element');
});

test('C8  when the page is restructured above it, the absolute path matches nothing and says so', async () => {
  const target = await recordOn('pos-restructured-before', 'button.x-expect');
  const err = await refusalOn('pos-restructured-after', strategyOnly(target, 'absoluteXPath'));
  assert.equal(err.attempts[0].strategy, 'absoluteXPath', 'the only strategy tried');
  assert.equal(err.attempts[0].matches, 0, 'matched nothing');
  assert.match(err.attempts[0].rejected, /matched nothing/, 'and the log says exactly that');
});

test('C9  a different element at the recorded absolute path is refused', async () => {
  const target = await recordOn('pos-renamed-before', 'button.x-expect');
  const err = await refusalOn('pos-replaced-after', strategyOnly(target, 'absoluteXPath'));
  const a = err.attempts[0];
  assert.equal(a.matches, 1, 'the path still leads somewhere');
  assert.equal(a.similarity.fatal, true, 'and what is standing there is a different button');
  assert.match(a.rejected, /Delete Everything/, 'named in the rejection');
});

test('C10 an absolute path that finds an indistinguishable element is refused too', async () => {
  const target = await recordOn('pos-twins-before', 'button.x-expect');
  const err = await refusalOn('pos-twins-after', strategyOnly(target, 'absoluteXPath'));
  const a = err.attempts[0];
  assert.equal(a.matches, 1, 'exactly one element sits at that path');
  assert.equal(a.similarity.score, 100, 'and it is a perfect identity match');
  assert.match(a.rejected, /3 elements on this page share its identity/,
    'which is precisely the problem: so are its two neighbours');
});

test('C11 an absolute path is never re-rooted onto a container', () => {
  const candidate = { strategy: 'absoluteXPath', params: { value: '/html/body/div/button' } };
  const scoped = { ...candidate, scope: { strategy: 'id', params: { value: 'wrap' } } };
  assert.equal(describeCandidate(scoped), "locator('#wrap').locator('xpath=/html/body/div/button')",
    'it stays absolute: quietly making it relative would make it match something else');
  assert.ok(buildLocator(page, candidate), 'and it builds against a page without complaint');
});

// ─────────────────────────────────────────────────────────────────────────────
// §D  ordering — text first, positional last
// ─────────────────────────────────────────────────────────────────────────────

test('D1  candidates: every semantic strategy comes before every positional one', async () => {
  for (const fixture of ['pos-moved-before', 'pos-renamed-before', 'pos-reordered-before', 'pos-deep-before']) {
    const list = candidatesFor(await fingerprintOn(fixture, 'button.x-expect'));
    const firstPositional = list.findIndex(isPositional);
    const lastSemantic = list.map(isPositional).lastIndexOf(false);
    assert.ok(firstPositional > lastSemantic, `${fixture}: the two bands do not interleave`);
  }
});

test('D2  candidates: inside the band the order is domIndex → relativeXPath → absoluteXPath', async () => {
  const list = candidatesFor(await fingerprintOn('pos-renamed-before', 'button.x-expect'));
  const band = strategiesOf(list.filter(isPositional));
  assert.equal(band, ['domIndex', 'domIndex', 'relativeXPath', 'relativeXPath', 'absoluteXPath'],
    'exactly the order the user asked for');
});

test('D3  scores: the whole band sits below the weakest semantic strategy', () => {
  const weakestSemantic = Math.min(...['testid', 'id', 'role', 'label', 'attr', 'placeholder', 'altText', 'title', 'text', 'css', 'xpath']
    .map(scoring.baseScore));
  for (const s of ['domIndex', 'relativeXPath', 'absoluteXPath']) {
    assert.ok(scoring.baseScore(s) < weakestSemantic, `${s} (${scoring.baseScore(s)}) < ${weakestSemantic}`);
  }
});

test('D4  the element moved but its text did not: text wins, position is not consulted', async () => {
  const target = await recordOn('pos-moved-before', 'button.x-expect');
  const won = await resolveOn('pos-moved-after', target);
  assert.equal(won.candidate.band, undefined, 'candidates do not carry a band — the attempts do');
  assert.notOk(isPositional(won.candidate), `a semantic strategy must win — got ${won.candidate.strategy}`);
  assert.equal(await marked(won.locator), true, 'and it is the recorded button');
  assert.every(won.attempts, (a) => a.band === 'semantic', 'the positional band was never even reached');
});

test('D5  siblings reordered: meaning still wins, and it wins on the right element', async () => {
  const target = await recordOn('pos-reordered-before', 'button.x-expect');
  const won = await resolveOn('pos-reordered-after', target);
  assert.notOk(isPositional(won.candidate), 'a semantic strategy resolved it');
  assert.equal((await won.locator.textContent()).trim(), 'Approve Invoice', 'the button that was recorded');
  assert.equal(await marked(won.locator), true, 'which is now third, not first');
});

test('D6  siblings reordered: the DOM index would have clicked "Hold Invoice"', async () => {
  // The proof that the ordering rule is doing work, not just passing by luck.
  const target = await recordOn('pos-reordered-before', 'button.x-expect');
  const err = await refusalOn('pos-reordered-after',
    only(target, (c) => c.strategy === 'domIndex' && c.params.kind === 'ordinal'));
  const a = err.attempts[0];
  assert.equal(a.matches, 1, 'button #0 still exists');
  assert.equal(a.similarity.fatal, true, 'but it is Hold Invoice now, and that is a different button');
  assert.match(err.message, /Hold Invoice/, 'the failure names what it found in that position');
});

test('D7  a node inserted above the target: every index shifted, and text carried the step', async () => {
  const target = await recordOn('pos-inserted-before', 'button.x-expect');
  const won = await resolveOn('pos-inserted-after', target);
  assert.notOk(isPositional(won.candidate), 'text and role are unaffected by an insertion');
  assert.equal(await marked(won.locator), true, 'and the recorded button is the one found');
});

test('D8  the attempts log is ordered: all semantic attempts, then all positional ones', async () => {
  const target = await recordOn('pos-renamed-before', 'button.x-expect');
  const won = await resolveOn('pos-renamed-after', target);
  const bands = won.attempts.map((a) => a.band);
  assert.equal(bands.indexOf('semantic'), 0, 'the log starts in the semantic band');
  assert.equal(bands.lastIndexOf('semantic') < bands.indexOf('positional'), true, 'and never returns to it');
  assert.equal(won.attempts.map((a) => a.order), won.attempts.map((_, i) => i + 1), 'each attempt is numbered');
});

test('D9  an ambiguous semantic candidate is floored to 0 and STILL comes before the band', async () => {
  // The bug the tier exists for: role+name scores 0 here, a DOM index scores 12, and sorting on
  // score alone would have run the DOM index first and resolved before the refusal was reached.
  const target = await recordOn('pos-twins-before', 'button.x-expect');
  const err = await refusalOn('pos-twins-after', target);
  const bands = err.attempts.map((a) => a.band);
  assert.equal(bands[0], 'semantic', 'the zero-scoring role candidate is tried first');
  assert.equal(err.attempts[0].score, 0, 'and it really does score zero');
  assert.ok(bands.indexOf('positional') > bands.lastIndexOf('semantic'), 'the band still runs last');
});

test('D10 the failure lists every strategy attempted, in order, with a reason for each', async () => {
  const target = await recordOn('pos-renamed-before', 'button.x-expect');
  const err = await refusalOn('pos-replaced-after', target);
  assert.equal(err.tried.length, err.attempts.length, 'one line per attempt');
  assert.every(err.tried, (line) => /—/.test(line), 'each line ends in a reason');
  assert.every(err.tried, (line) => /semantic|positional/.test(line), 'and says which band it was in');
  for (const strategy of ['role', 'text', 'domIndex', 'relativeXPath', 'absoluteXPath']) {
    assert.includes(logOf(err), strategy, `the log names ${strategy}`);
  }
});

test('D11 …and the same log is on the message, so a console with no debugger still shows it', async () => {
  const target = await recordOn('pos-renamed-before', 'button.x-expect');
  const err = await refusalOn('pos-replaced-after', target);
  assert.includes(err.message, 'Tried 8 locator strategies, in order:', 'the count and the promise');
  assert.includes(err.message, 'domIndex', 'the DOM index appears in the message itself');
  assert.includes(err.message, 'absoluteXPath', 'so does the absolute XPath');
  assert.match(err.suggestion, /not the same element|stable identifier|re-record/,
    'and the suggestion is about the element, not about the selector');
});

test('D12 a legacy "positional" candidate is still ordered into the band, not ahead of it', async () => {
  // Targets recorded before the band was split into three carry one strategy called `positional`.
  // They must keep working, and they must keep coming last.
  const target = await recordOn('pos-renamed-before', 'button.x-expect');
  const fp = target.fingerprint;
  const legacy = {
    ...target,
    candidates: [
      target.candidates.find((c) => c.strategy === 'role'),
      { strategy: 'positional', params: { value: fp.selectors.positionalCss, kind: 'css' }, score: 10, verified: true },
      { strategy: 'positional', params: { value: fp.selectors.absoluteXPath, kind: 'xpath' }, score: 10, verified: true },
    ],
  };
  const won = await resolveOn('pos-renamed-after', legacy);
  assert.equal(won.candidate.strategy, 'positional', 'the legacy fallback resolved it');
  assert.equal(won.attempts[0].band, 'semantic', 'after the semantic candidate was tried first');
  assert.equal(won.attempts[1].band, 'positional', 'and the legacy candidate is treated as positional');
  assert.ok(won.similarity.score >= 70, 'and it was verified exactly like the new strategies are');
});

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  await boot();
  try {
    await run('positional');
  } finally {
    await shutdown();
  }
})().catch((err) => {
  process.stdout.write(`positional: harness crashed — ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
