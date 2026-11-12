/**
 * Element Identity Engine — end-to-end proof against local HTML fixtures.
 *
 * This is the file that proves the whole point of the tool: record an element on one page, change
 * the page the way real applications change, and show that the element is still found — or, when
 * it genuinely cannot be found, that the engine REFUSES rather than clicking something else.
 *
 * Everything here is self-contained. The fixtures are strings in this file, served with
 * `page.setContent`, so the test needs no server, no login, no network and no Angular app. It runs
 * anywhere Chromium runs, in a few seconds.
 *
 *   node tests/e2e-fixture.test.js            (run from the repo root)
 *   node tests/e2e-fixture.test.js --headed   watch it happen
 *
 * Exit code 0 when every scenario behaved as specified, 1 otherwise.
 *
 * There is no test framework in this repo, so the harness at the bottom of this file is the whole
 * apparatus: `test()` collects, `assert()` explains itself, one line of output per scenario.
 */
'use strict';

const { chromium } = require('playwright');
const identity = require('../src/identity');

const headed = process.argv.includes('--headed');

// ─────────────────────────────────────────────────────────────── tiny harness

const tests = [];
/** Collect a scenario. `fn` receives the shared page. */
function test(name, fn) {
  tests.push({ name, fn });
}

class AssertionError extends Error {}

/** The only assertion primitive. Everything else is a sentence built out of it. */
function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg || 'assertion failed');
}

function assertEqual(actual, expected, what) {
  assert(actual === expected, `${what}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
}

/** Notes printed under a passing scenario so a human can eyeball locator quality. */
let notes = [];
function note(line) {
  notes.push(line);
}

// ─────────────────────────────────────────────────────────────── page helpers

/**
 * Put a fixture on screen with the identity library already present.
 *
 * `addInitScript` is installed once on the context; `setContent` starts a fresh document, so the
 * library is re-injected for every fixture and the uid counter restarts with it. The guard below
 * costs one round trip and removes any doubt about init-script timing.
 */
async function show(page, html) {
  await page.setContent(html, { waitUntil: 'load' });
  const present = await page.evaluate(() => !!window.__opkeyRec);
  if (!present) await page.addScriptTag({ content: identity.SOURCE });
}

/** Fingerprint one element, exactly as recording.js does when the user touches it. */
async function fingerprintOf(page, selector) {
  const fp = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? window.__opkeyRec.fingerprint(el) : null;
  }, selector);
  assert(fp, `fixture problem: nothing matched "${selector}" on the before page`);
  return fp;
}

/** RECORD: show the before page, fingerprint the element, build and validate its target. */
async function record(page, html, selector) {
  await show(page, html);
  const fingerprint = await fingerprintOf(page, selector);
  const target = await identity.buildTarget(page, fingerprint);
  assert(target, 'buildTarget returned nothing');
  assert(Array.isArray(target.candidates) && target.candidates.length, 'no locator candidates were produced at record time');
  return { fingerprint, target };
}

/** REPLAY: show the after page and ask the engine to find the same element again. */
async function replay(page, html, target, options) {
  await show(page, html);
  return identity.resolve(page, target, options || {});
}

/** What the recorder saved, printed so a failure shows which locator was trusted and why. */
function dumpCandidates(target) {
  note(`saved locators: ${target.candidates.map((c) => `${c.strategy}${c.scope ? `[in ${c.scope.strategy}]` : ''}=${c.score}${c.verified ? '✓' : ''}${c.rejected ? ` (${c.rejected})` : ''}`).join(' | ')}`);
}

/** Replay that is expected to fail. Returns the ResolutionError; fails the test if none is thrown. */
async function replayExpectingFailure(page, html, target, what, options) {
  await show(page, html);
  let result = null;
  try {
    result = await identity.resolve(page, target, options || {});
  } catch (err) {
    return err;
  }
  const chosen = result.candidate ? `${result.candidate.strategy} (${result.candidate.locator || ''})` : 'unknown';
  const found = await result.locator.evaluate((el) => el.outerHTML.slice(0, 160)).catch(() => '?');
  throw new AssertionError(
    `${what}\n        expected: ResolutionError — the engine must refuse to guess`
    + `\n        actual:   resolved via ${chosen} at ${result.confidence}% confidence`
    + `\n        it chose: ${found}`,
  );
}

/** Every successful resolution must report itself honestly, whatever strategy won. */
function assertWellFormed(result) {
  assert(typeof result.confidence === 'number', `confidence must be a number, got ${typeof result.confidence}`);
  assert(Number.isFinite(result.confidence), 'confidence must be finite');
  assert(result.confidence >= 0 && result.confidence <= 100, `confidence must be 0..100, got ${result.confidence}`);
  assert(Array.isArray(result.attempts), 'attempts must be an array');
  assert(result.attempts.length > 0, 'attempts must record at least the candidate that won');
  assert(result.locator, 'a resolution must carry a locator');
  assert(result.candidate && result.candidate.strategy, 'a resolution must say which candidate won');
  note(`won with ${result.candidate.strategy} · confidence ${result.confidence}%`
    + (result.similarity ? ` · similarity ${result.similarity.score}%` : '')
    + ` · ${result.attempts.length} attempt(s)`);
}

/** Every refusal must explain itself, or it is no better than "element not found". */
function assertGoodFailure(err, what) {
  assertEqual(err.name, 'ResolutionError', `${what}: wrong error type — ${err.stack ? err.stack.split('\n')[0] : err}`);
  assert(Array.isArray(err.attempts), `${what}: the error must carry an attempts array`);
  assert(err.attempts.length > 0, `${what}: the attempts array must not be empty`);
  note(`refused: ${String(err.message).slice(0, 120)}`);
  note(`tried ${err.attempts.length}: ${err.attempts.map((a) => `${a.strategy}→${a.matches === null ? 'n/a' : a.matches}`).join(', ')}`);
}

// ─────────────────────────────────────────────────────────────── the fixtures
//
// Deliberately small and hand-written. Each pair is one realistic way an application changes
// between the day a test was recorded and the day it runs.

const doc = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px system-ui;margin:16px} section{border:1px solid #ccc;padding:8px;margin:8px 0}
table{border-collapse:collapse} td,th{border:1px solid #ccc;padding:4px 8px}</style>
${body}`;

const FIXTURES = {
  // 1 — the text a designer changes; the contract a developer keeps
  testidBefore: doc('Customer', `
    <div class="toolbar"><button data-testid="save-customer" class="btn primary">Save Customer</button></div>`),
  testidAfter: doc('Customer', `
    <div class="toolbar-v2"><button data-testid="save-customer" class="button-primary">Save</button></div>`),

  // 2 — no test id, but a hand-written id survives the rename
  idBefore: doc('Customer', `<button id="saveCustomer" class="btn">Save Customer</button>`),
  idAfter: doc('Customer', `<button id="saveCustomer" class="btn-v2">Save</button>`),

  // 3 — a restyle and nothing else: every identity signal should still agree
  classesBefore: doc('Customer', `
    <section aria-label="Customer Details">
      <button id="saveCustomer" data-testid="save-customer" class="btn btn-primary btn-lg">Save Customer</button>
    </section>`),
  classesAfter: doc('Customer', `
    <section aria-label="Customer Details">
      <button id="saveCustomer" data-testid="save-customer" class="_a1b2c3 x-9 css-1qw2er">Save Customer</button>
    </section>`),

  // 4 — the layout is rebuilt around the button; the button itself is untouched
  nestingBefore: doc('Customer', `
    <section aria-label="Customer Details">
      <div class="row"><div class="col"><button class="btn">Save Customer</button></div></div>
    </section>`),
  nestingAfter: doc('Customer', `
    <section aria-label="Customer Details">
      <article class="card"><div class="actions"><button class="btn-2">Save Customer</button></div></article>
    </section>`),

  // 5 — three identical buttons; only the section they sit in tells them apart
  sectionsBefore: doc('Customer', `
    <section aria-label="Customer Details"><h2>Customer Details</h2><button>Save</button></section>
    <section aria-label="Address Details"><h2>Address Details</h2><button>Save</button></section>
    <section aria-label="Order Details"><h2>Order Details</h2><button>Save</button></section>`),
  sectionsAfter: doc('Customer', `
    <section aria-label="Customer Details"><h2>Customer Details</h2><button>Save</button></section>
    <section aria-label="Address Details"><h2>Address Details</h2><button>Save</button></section>
    <section aria-label="Billing Details"><h2>Billing Details</h2><button>Save</button></section>
    <section aria-label="Order Details"><h2>Order Details</h2><button>Save</button></section>`),

  // 6 — the honest dead end: nothing whatsoever distinguishes these three
  ambiguous: doc('Panel', `
    <div class="panel"><button>Save</button><button>Save</button><button>Save</button></div>`),

  // 7 — the element is simply gone
  removedBefore: doc('Toolbar', `
    <div id="toolbar"><button data-testid="save-customer" class="btn">Save Customer</button></div>`),
  removedAfter: doc('Toolbar', `
    <div id="toolbar"></div><p>The toolbar is empty now.</p>`),

  // 8 — a DIFFERENT button now occupies the same slot. The dangerous one.
  replacedBefore: doc('Toolbar', `
    <div id="toolbar"><button data-testid="save-customer" class="btn">Save Customer</button></div>`),
  replacedAfter: doc('Toolbar', `
    <div id="toolbar"><button data-testid="delete-customer" class="btn">Delete Customer</button></div>`),

  // 9 — framework-minted ids that are different on every page load
  generatedBefore: doc('Form', `
    <form id="customerForm">
      <p><label for="customerName">Customer name</label>
         <input id="customerName" name="customerName" type="text"></p>
      <p><label for="mat-input-27">Customer email</label>
         <input id="mat-input-27" name="email" type="text"></p>
      <p><label for="ss-0-listbox">Region</label>
         <select id="ss-0-listbox" name="region"><option>North</option><option>South</option></select></p>
      <p id="cdk-describedby-message-3">All fields are required.</p>
    </form>`),
  generatedAfter: doc('Form', `
    <form id="customerForm">
      <p><label for="customerName">Customer name</label>
         <input id="customerName" name="customerName" type="text"></p>
      <p><label for="mat-input-93">Customer email</label>
         <input id="mat-input-93" name="email" type="text"></p>
      <p><label for="ss-7-listbox">Region</label>
         <select id="ss-7-listbox" name="region"><option>North</option><option>South</option></select></p>
      <p id="cdk-describedby-message-11">All fields are required.</p>
    </form>`),

  // 10 — the row moves. Its content does not.
  tableBefore: doc('Customers', `
    <table>
      <caption>Customers</caption>
      <thead><tr><th>Company</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        <tr><td>Acme Corp</td><td>Active</td><td><button>Edit</button></td></tr>
        <tr><td>Globex</td><td>Active</td><td><button>Edit</button></td></tr>
        <tr><td>Initech</td><td>Pending</td><td><button>Edit</button></td></tr>
      </tbody>
    </table>`),
  tableAfter: doc('Customers', `
    <table>
      <caption>Customers</caption>
      <thead><tr><th>Company</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        <tr><td>Globex</td><td>Active</td><td><button>Edit</button></td></tr>
        <tr><td>Initech</td><td>Pending</td><td><button>Edit</button></td></tr>
        <tr><td>Acme Corp</td><td>Active</td><td><button>Edit</button></td></tr>
      </tbody>
    </table>`),

  // 11 — the button arrives after the page has loaded, as everything in a real app does
  asyncBefore: doc('Async', `
    <div id="host"><button data-testid="save-customer" class="btn">Save Customer</button></div>`),
  asyncAfter: doc('Async', `
    <div id="host"><p>Loading…</p></div>
    <script>
      setTimeout(function () {
        var host = document.getElementById('host');
        host.innerHTML = '';
        var b = document.createElement('button');
        b.setAttribute('data-testid', 'save-customer');
        b.className = 'btn';
        b.textContent = 'Save Customer';
        host.appendChild(b);
      }, 400);
    </script>`),
};

// ─────────────────────────────────────────────────────────────── the scenarios

test('1  text changed, test id stable → resolves by test id', async (page) => {
  const { target } = await record(page, FIXTURES.testidBefore, 'button');
  const result = await replay(page, FIXTURES.testidAfter, target);
  assertWellFormed(result);
  assertEqual(result.candidate.strategy, 'testid', 'the winning strategy must be the explicit test contract');
  assertEqual(await result.locator.textContent(), 'Save', 'it must have landed on the renamed button');
});

test('2  text changed, id stable → resolves', async (page) => {
  const { target } = await record(page, FIXTURES.idBefore, 'button');
  const result = await replay(page, FIXTURES.idAfter, target);
  assertWellFormed(result);
  assertEqual(await result.locator.getAttribute('id'), 'saveCustomer', 'it must have landed on #saveCustomer');
});

test('3  classes changed only → resolves with a high similarity score', async (page) => {
  const { target } = await record(page, FIXTURES.classesBefore, 'button');
  const result = await replay(page, FIXTURES.classesAfter, target);
  assertWellFormed(result);
  assert(result.similarity, 'a single match must be verified against the recorded identity');
  assert(result.similarity.score >= 70,
    `a pure restyle must not move the similarity score: expected >= 70, got ${result.similarity.score} (${result.similarity.reason})`);
  note(`matched signals: ${result.similarity.matched.join(', ') || 'none'}; differed: ${result.similarity.differed.join(', ') || 'none'}`);
});

test('4  DOM nesting changed → resolves', async (page) => {
  const { target } = await record(page, FIXTURES.nestingBefore, 'section[aria-label="Customer Details"] button');
  const result = await replay(page, FIXTURES.nestingAfter, target);
  assertWellFormed(result);
  assertEqual(
    await result.locator.evaluate((el) => el.parentElement.className),
    'actions',
    'it must have found the button in its rebuilt parent',
  );
});

test('5  duplicate buttons → resolves the one in the right container', async (page) => {
  const { fingerprint, target } = await record(page, FIXTURES.sectionsBefore, 'section[aria-label="Customer Details"] button');
  assertEqual(fingerprint.siblings.sameRoleAndName, 3, 'the recorder must notice the button was ambiguous at record time');

  const result = await replay(page, FIXTURES.sectionsAfter, target);
  assertWellFormed(result);
  const container = await result.locator.evaluate((el) => el.closest('section').getAttribute('aria-label'));
  assertEqual(container, 'Customer Details', 'it must have picked the Save button in Customer Details, not another section');
});

test('6  genuinely ambiguous → refuses to guess', async (page) => {
  const { fingerprint, target } = await record(page, FIXTURES.ambiguous, '.panel button:nth-of-type(1)');
  assertEqual(fingerprint.siblings.sameRoleAndName, 3, 'three identical buttons should be seen as three');
  assertEqual(fingerprint.context.ancestors.length, 0, 'the plain div must offer no container to scope to');
  dumpCandidates(target);

  const err = await replayExpectingFailure(page, FIXTURES.ambiguous, target,
    'three indistinguishable Save buttons must not be resolved'
    + '\n        (if this resolved via "positional", see BUG B: a nth-of-type fallback scores 10 while'
    + '\n         every ambiguity-rejected semantic candidate is floored to 0, so the fallback is tried'
    + '\n         FIRST and returns before the resolver\'s refuse-to-guess logic is ever reached)');
  assertGoodFailure(err, 'ambiguous');
});

test('7  element removed → refuses, with the attempts recorded', async (page) => {
  const { target } = await record(page, FIXTURES.removedBefore, 'button');
  // The first candidate is given the full attach budget; on a static fixture 1.5s is generous and
  // keeps the suite fast. Not a sleep: the resolver still waits, just not for four seconds.
  const err = await replayExpectingFailure(page, FIXTURES.removedAfter, target,
    'a deleted button must not be resolved', { timeoutMs: 1500 });
  assertGoodFailure(err, 'removed');
  assert(err.attempts.every((a) => a.matches === 0 || a.matches === null || a.rejected),
    'every attempt should record either zero matches or a reason for rejection');
});

test('8  a different element at the same position → refuses', async (page) => {
  const { target } = await record(page, FIXTURES.replacedBefore, 'button');
  const err = await replayExpectingFailure(page, FIXTURES.replacedAfter, target,
    'Delete Customer is not Save Customer, whatever position it occupies', { timeoutMs: 1500 });
  assertGoodFailure(err, 'replaced');
  const reachedSomething = err.attempts.filter((a) => a.matches === 1);
  assert(reachedSomething.length > 0,
    'a fallback SHOULD have reached the replacement button — the point is that it was then rejected');
  note(`fallbacks that reached the wrong element and were rejected: ${reachedSomething.map((a) => a.strategy).join(', ')}`);
});

test('9  generated ids are distrusted, and renumbering them changes nothing', async (page) => {
  await show(page, FIXTURES.generatedBefore);

  const handwritten = await fingerprintOf(page, '#customerName');
  const generated = await fingerprintOf(page, '#mat-input-27');
  const listbox = await fingerprintOf(page, '#ss-0-listbox');
  const message = await fingerprintOf(page, '#cdk-describedby-message-3');

  // the hand-written one is trusted
  assertEqual(handwritten.attrs.id, 'customerName', 'a readable id belongs in attrs');
  assert(!handwritten.volatile.id, 'a readable id must not be marked volatile');

  // every framework-minted one is not
  for (const [fp, value] of [[generated, 'mat-input-27'], [listbox, 'ss-0-listbox'], [message, 'cdk-describedby-message-3']]) {
    assert(!fp.attrs.id, `${value} must NOT appear in fingerprint.attrs (it did: ${fp.attrs.id})`);
    assert(fp.volatile.id && String(fp.volatile.id).includes(value),
      `${value} must appear in fingerprint.volatile with a reason (got ${JSON.stringify(fp.volatile.id)})`);
    note(`${value} → volatile: ${fp.volatile.id}`);
  }

  // …so nothing may offer to find it by id
  const rawCandidates = identity.candidatesFor(generated);
  assert(!rawCandidates.some((c) => c.strategy === 'id'),
    `candidatesFor() offered an id locator for a generated id: ${JSON.stringify(rawCandidates.filter((c) => c.strategy === 'id'))}`);

  const generatedTarget = await identity.buildTarget(page, generated);
  assert(!generatedTarget.candidates.some((c) => c.strategy === 'id'), 'the saved target must not contain an id candidate');
  const handwrittenTarget = await identity.buildTarget(page, handwritten);
  assert(handwrittenTarget.candidates.some((c) => c.strategy === 'id' && c.verified),
    'the hand-written id SHOULD be used — distrust must be selective, not blanket');
  note(`generated element locators: ${generatedTarget.candidates.map((c) => `${c.strategy}(${c.score})`).join(' ')}`);

  // renumber everything and prove the element is still found
  const gen = await replay(page, FIXTURES.generatedAfter, generatedTarget);
  assertWellFormed(gen);
  assertEqual(await gen.locator.getAttribute('name'), 'email', 'the renumbered email field must still be the one found');
  assertEqual(await gen.locator.getAttribute('id'), 'mat-input-93', 'and it must be the NEW id, proving nothing was pinned to the old one');

  const hand = await replay(page, FIXTURES.generatedAfter, handwrittenTarget);
  assertWellFormed(hand);
  assertEqual(await hand.locator.getAttribute('id'), 'customerName', 'the hand-written id must still resolve');
});

test('10 table row identified by content, not index', async (page) => {
  const { fingerprint, target } = await record(page, FIXTURES.tableBefore, 'tbody tr:nth-child(1) button');

  // The row IS captured with a distinguishing name. Everything needed to get this right is present
  // in the fingerprint; the failure below is in what candidates.js does with it.
  const row = fingerprint.context.ancestors.find((a) => a.tag === 'tr');
  assert(row, 'the row must be captured as an ancestor');
  assertEqual(row.name, 'Acme Corp Active Edit', 'the row must be named by its content');
  dumpCandidates(target);
  assert(target.candidates.some((c) => c.scope && c.scope.params && c.scope.params.role === 'row'),
    'BUG A: candidates.js only ever scopes to scopeCandidates()[0] — the nearest qualifying ancestor,'
    + '\n        here the <td> named "Edit", which matches three cells. The <tr> named "Acme Corp Active Edit"'
    + '\n        is computed by scopeCandidates() and then discarded, so no row-scoped candidate is ever saved.');

  const result = await replay(page, FIXTURES.tableAfter, target);
  assertWellFormed(result);
  const company = await result.locator.evaluate((el) => el.closest('tr').querySelector('td').textContent.trim());
  assertEqual(company, 'Acme Corp', 'the Edit button must follow the Acme Corp row to its new position');
});

test('11 async content → the resolver waits for it', async (page) => {
  const { target } = await record(page, FIXTURES.asyncBefore, 'button');
  const started = Date.now();
  const result = await replay(page, FIXTURES.asyncAfter, target);
  const waited = Date.now() - started;
  assertWellFormed(result);
  assertEqual(await result.locator.textContent(), 'Save Customer', 'it must have found the late-arriving button');
  assert(waited >= 300, `the button appears after 400ms, so resolution cannot have been instant (took ${waited}ms)`);
  note(`resolved after waiting ${waited}ms`);
});

// ─────────────────────────────────────────────────────────────── runner

(async () => {
  const started = Date.now();
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });

  // Exactly the wiring execution.js uses at replay time: Playwright's own role and accessible-name
  // implementation in the main world, and the identity library in every new document.
  await context._exposeConsoleApi().catch(() => {});
  await context.addInitScript({ content: identity.SOURCE });
  const page = await context.newPage();

  console.log(`\n── identity engine · end-to-end fixtures ─ ${tests.length} scenarios ────────────`);

  let passed = 0;
  const failures = [];
  for (const t of tests) {
    notes = [];
    const t0 = Date.now();
    try {
      await t.fn(page);
      passed++;
      console.log(`PASS  ${t.name}   (${Date.now() - t0}ms)`);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log(`FAIL  ${t.name}   (${Date.now() - t0}ms)`);
      console.log(`      ${String(err.message).replace(/\n/g, '\n      ')}`);
      if (!(err instanceof AssertionError) && err.stack) {
        console.log(`      ${err.stack.split('\n').slice(1, 4).join('\n      ')}`);
      }
    }
    for (const line of notes) console.log(`      · ${line}`);
  }

  await browser.close();

  const ms = Date.now() - started;
  console.log(`\n${passed} passed, ${failures.length} failed, ${tests.length} total  (${(ms / 1000).toFixed(1)}s)`);
  if (failures.length) {
    console.log(`failed:\n${failures.map((f) => `  - ${f.name}`).join('\n')}`);
    process.exit(1);
  }
  console.log('The engine survives renames, restyles, re-nesting and re-ordering — and refuses when it should.');
  process.exit(0);
})().catch((e) => {
  console.error('\nHARNESS ERROR:', (e && e.stack) || e);
  process.exit(2);
});
