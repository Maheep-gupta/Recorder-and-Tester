/**
 * Unit tests for the pure half of the element-identity engine.
 *
 *   node tests/unit.test.js      (run from the repo root)
 *
 * Nothing here touches a browser. `browserLibrary()` is called directly in Node, which is exactly
 * what its doc comment promises is possible, and `candidates.js` / `scoring.js` are pure already.
 *
 * A handful of tests are marked [known bug]. They are deliberate, they fail, and every one of them
 * is listed in the report that accompanies this suite. They are not fixed here because the brief
 * for this work was to test these modules, not to edit them.
 */
'use strict';

const { test, assert, run } = require('./harness');
const { browserLibrary } = require('../src/identity/browser-lib');
const { candidatesFor, scopeCandidates } = require('../src/identity/candidates');
const scoring = require('../src/identity/scoring');

const lib = browserLibrary();
const { looksGenerated, looksVolatileText, attributeStability } = lib._internals;

// ─────────────────────────────────────────────────────────────────────────────
// 1. looksGenerated — the single decision that keeps `id="mat-input-27"` out of a test
// ─────────────────────────────────────────────────────────────────────────────

/** Every one of these is minted by a framework and renumbered on the next render. */
const GENERATED = [
  ['ss-0-listbox', 'per-instance counter (generated-ids fixture)'],
  ['ss-4-listbox', 'the same control after a re-render'],
  ['mat-input-27', 'Angular Material input (generated-ids fixture)'],
  ['mat-input-73', 'the same input, renumbered'],
  ['mat-button-14', 'Angular Material button'],
  ['cdk-describedby-message-3', 'Angular CDK a11y message (generated-ids fixture)'],
  ['cdk-describedby-message-9', 'the same message, renumbered'],
  ['input-938492', 'hand-rolled counter id (generated-ids fixture)'],
  ['input-551201', 'the same field, renumbered'],
  [':r7:', 'React useId (generated-ids fixture)'],
  [':r19:', 'React useId after a re-render'],
  ['_ngcontent-ng-c123456', 'Angular view-encapsulation marker (generated-ids fixture)'],
  ['_ngcontent-ng-c987654', 'the same marker, rebuilt'],
  ['css-1a2b3c', 'CSS-in-JS hashed class (css-change fixture)'],
  ['css-9z8y7x', 'the same class, rehashed'],
  ['550e8400-e29b-41d4-a716-446655440000', 'a GUID'],
  ['a1b2c3d4e5f6a7b8', 'a long hex string'],
  ['1234567890123', 'an epoch timestamp'],
  ['12345', 'digits only'],
  ['ng-tns-c123-4', 'Angular template instance'],
  ['react-select-2-input', 'react-select instance id'],
  ['emotion-1x2y3z', 'an emotion hash'],
  ['headlessui-menu-item-3', 'a headless UI instance'],
  ['field_1a2b3c4d', 'a generated node id'],
  ['tab-7-panel', 'a per-instance counter in the middle of a name'],
];

/** Every one of these was typed by a person and will be there tomorrow. */
const HAND_WRITTEN = [
  ['customerName', 'the one hand-written id in the generated-ids fixture'],
  ['saveCustomer', 'id-text-change fixture'],
  ['cancelCustomer', 'id-text-change fixture'],
  ['customerForm', 'generated-ids fixture form id'],
  ['save-customer', 'the data-testid used across the fixtures'],
  ['delete-customer', 'replaced fixture'],
  ['acknowledge-alert', 'dynamic fixture'],
  ['refreshDashboard', 'dynamic fixture'],
  ['profile-card', 'dynamic fixture'],
  ['sparkline', 'dynamic fixture canvas'],
  ['emailAddress', 'labels fixture'],
  ['phoneNumber', 'labels fixture'],
  ['lblCurrency', 'labels fixture'],
  ['late-panel', 'dynamic fixture'],
  ['app', 'nesting-change fixture'],
  ['btn', 'a short class-like word'],
  ['address_line_one', 'snake case with words, not hashes'],
  ['nav-primary', 'kebab case with words'],
];

test('looksGenerated: flags every framework-minted value in the fixtures', () => {
  for (const [value, why] of GENERATED) {
    assert.ok(looksGenerated(value), `${JSON.stringify(value)} should be generated — ${why}`);
  }
});

test('looksGenerated: leaves hand-written names alone', () => {
  for (const [value, why] of HAND_WRITTEN) {
    assert.equal(looksGenerated(value), null, `${JSON.stringify(value)} should NOT be generated — ${why}`);
  }
});

test('[known bug] looksGenerated: CSS-module hashed class names are generated too', () => {
  // css-change-after.html restyles with CSS-module output. `css-9z8y7x` is caught by the
  // CSS-in-JS rule; the far more common `Component_part__hash` shape is caught by nothing.
  for (const v of ['Panel_root__9f21', 'Button_root__x9f2', 'Toolbar_actions__a1b2c']) {
    assert.ok(looksGenerated(v), `${JSON.stringify(v)} is CSS-module build output`);
  }
});

test('looksGenerated: gives a human reason, not just a boolean', () => {
  assert.match(looksGenerated('mat-input-27'), /counter/i, 'reason for mat-input-27');
  assert.match(looksGenerated(':r7:'), /react/i, 'reason for :r7:');
  assert.match(looksGenerated('_ngcontent-ng-c123456'), /angular/i, 'reason for the ng marker');
  assert.match(looksGenerated('550e8400-e29b-41d4-a716-446655440000'), /guid/i, 'reason for a GUID');
});

test('looksGenerated: empty and null values are not "generated"', () => {
  assert.equal(looksGenerated(''), null, 'empty string');
  assert.equal(looksGenerated(null), null, 'null');
  assert.equal(looksGenerated(undefined), null, 'undefined');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. attributeStability — which attributes may become a locator
// ─────────────────────────────────────────────────────────────────────────────

test('attributeStability: every test-id attribute is the strongest possible signal', () => {
  for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-automation-id']) {
    const v = attributeStability(attr, 'save-customer');
    assert.equal(v.stable, true, `${attr} must be stable`);
    assert.equal(v.score, 1, `${attr} must score 1`);
    assert.match(v.reason, /test id/i, `${attr} reason`);
  }
});

test('attributeStability: a hand-written id is trusted, a generated one is not', () => {
  const good = attributeStability('id', 'customerName');
  assert.equal(good.stable, true, 'id="customerName" is stable');
  assert.equal(good.score, 0.95, 'hand-written id score');
  assert.match(good.reason, /hand-written/i, 'hand-written id reason');

  for (const bad of ['mat-input-27', 'ss-0-listbox', ':r7:', 'input-938492', 'cdk-describedby-message-3']) {
    const v = attributeStability('id', bad);
    assert.equal(v.stable, false, `id="${bad}" must be rejected`);
    assert.ok(v.score < 0.5, `id="${bad}" must score low, got ${v.score}`);
  }
});

test('attributeStability: name and formcontrolname identify a form control', () => {
  assert.equal(attributeStability('name', 'customerName').stable, true, 'name=');
  assert.equal(attributeStability('name', 'customerName').score, 0.9, 'name= score');
  assert.equal(attributeStability('formcontrolname', 'creditLimit').stable, true, 'formcontrolname=');
  assert.equal(attributeStability('for', 'customerName').stable, true, 'for=');
});

test('attributeStability: a data-* attribute that IDENTIFIES is kept', () => {
  for (const attr of ['data-field-key', 'data-panel-id', 'data-row-key', 'data-customer']) {
    const v = attributeStability(attr, 'cust.name');
    assert.equal(v.stable, true, `${attr} must be stable`);
    assert.equal(v.score, 0.8, `${attr} score`);
  }
});

test('attributeStability: a data-* attribute that describes STATE is rejected', () => {
  for (const attr of ['data-status', 'data-tone', 'data-state', 'data-active', 'data-selected', 'data-loading', 'data-index']) {
    const v = attributeStability(attr, 'active');
    assert.equal(v.stable, false, `${attr} must be rejected — it describes how the thing looks right now`);
    assert.match(v.reason, /state, not identity/i, `${attr} reason`);
  }
});

test('attributeStability: aria-label is an accessibility identity', () => {
  const v = attributeStability('aria-label', 'Customer Details');
  assert.equal(v.stable, true, 'aria-label is stable');
  assert.equal(v.score, 0.85, 'aria-label score');
});

test('attributeStability: class is NEVER an identifying attribute', () => {
  for (const value of ['btn primary', 'button-primary', 'Panel_root__9f21', 'css-1a2b3c', 'toolbar']) {
    assert.equal(attributeStability('class', value).stable, false, `class="${value}" must never be stable`);
  }
});

test('attributeStability: empty, overlong and unknown attributes are refused', () => {
  assert.equal(attributeStability('id', '').stable, false, 'empty value');
  assert.equal(attributeStability('id', 'a'.repeat(121)).stable, false, 'overlong value');
  assert.equal(attributeStability('style', 'color:red').stable, false, 'style=');
  assert.equal(attributeStability('onclick', 'save()').stable, false, 'onclick=');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. looksVolatileText — text that is wrong within the hour
// ─────────────────────────────────────────────────────────────────────────────

test('looksVolatileText: relative times in the compact form', () => {
  for (const t of ['1h', '5m ago', '30s', '2 h', '7d', '3w ago', '6mo', '2y ago', "Dev's Profile Maheep Gupta 1h"]) {
    assert.ok(looksVolatileText(t), `${JSON.stringify(t)} carries a relative time`);
  }
});

test('looksVolatileText: "now", "yesterday", "today", "tomorrow"', () => {
  for (const t of ['just now', 'Updated now', 'yesterday', 'Today', 'Tomorrow at the earliest']) {
    assert.ok(looksVolatileText(t), `${JSON.stringify(t)} is a relative date`);
  }
});

test('looksVolatileText: dates and clock times', () => {
  for (const t of ['Jan 5', 'Dec 12, 2024', 'Sept 3', '01/02/2024', '12/31/99', '3-4-2025', '14:30', 'Closes 09:00']) {
    assert.ok(looksVolatileText(t), `${JSON.stringify(t)} is a date or clock time`);
  }
});

test('looksVolatileText: GUIDs and long numbers', () => {
  assert.ok(looksVolatileText('550e8400-e29b-41d4-a716-446655440000'), 'a GUID');
  assert.ok(looksVolatileText('Ref 1234567'), 'a long number');
  assert.ok(looksVolatileText('Order 987654321'), 'a long order number');
});

test('looksVolatileText: ordinary application text is left alone', () => {
  for (const t of ['Save', 'Save Customer', 'Customer Details', 'Address Details', 'Order Details',
    'Acme Corp', 'Edit', 'Delete', 'Create customer', 'Contact support', 'Page 2 of 5', 'Order #4',
    'Credit limit', 'EMEA', 'Company logo']) {
    assert.equal(looksVolatileText(t), null, `${JSON.stringify(t)} is stable text`);
  }
});

test('[known bug] looksVolatileText: word-form relative times are relative times too', () => {
  for (const t of ['3 days ago', '2 hours ago', '5 minutes ago', 'updated 10 seconds ago', 'in 2 weeks']) {
    assert.ok(looksVolatileText(t), `${JSON.stringify(t)} carries a relative time and must be flagged`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. candidatesFor — hand-written fingerprints in, ordered locator descriptors out
// ─────────────────────────────────────────────────────────────────────────────

/** A well-identified button with NO scopeable ancestor: pure band ordering. */
function fpRich() {
  return {
    tag: 'button',
    role: 'button',
    name: 'Save Customer',
    nameSource: 'contents',
    text: 'Save Customer',
    attrs: { 'data-testid': 'save-customer', id: 'saveCustomer', name: 'save', type: 'submit' },
    volatile: { class: 'css-1a2b3c · generated class names' },
    labels: [],
    context: { ancestors: [], heading: 'Customer Details', landmark: null, list: null },
    siblings: { sameRoleAndName: 1, sameText: 1, sameTag: 4 },
    selectors: {
      semanticCss: '[data-testid="save-customer"]',
      contextualCss: null,
      positionalCss: 'body > section > button',
      semanticXPath: "//button[@data-testid='save-customer']",
      absoluteXPath: '/html/body/section/button',
    },
  };
}

/** The context-duplicates situation: three identical Save buttons in named regions. */
function fpAmbiguousInRegion() {
  return {
    tag: 'button',
    role: 'button',
    name: 'Save',
    nameSource: 'contents',
    text: 'Save',
    attrs: {},
    volatile: {},
    labels: [],
    context: {
      ancestors: [{ tag: 'section', role: 'region', name: 'Customer Details', testid: null, testidAttr: null, id: null, landmark: true, depth: 1 }],
      heading: 'Customer Details',
      landmark: 'Customer Details',
      list: null,
    },
    siblings: { sameRoleAndName: 3, sameText: 3, sameTag: 3 },
    selectors: {
      semanticCss: null,
      contextualCss: 'section[aria-label="Customer Details"] button',
      positionalCss: 'body > section:nth-of-type(1) > button',
      semanticXPath: "//section[@aria-label='Customer Details']//button[normalize-space()='Save']",
      absoluteXPath: '/html/body/section[1]/button',
    },
  };
}

/** An anonymous div: nothing stable exists, only the fallbacks should survive. */
function fpBare() {
  return {
    tag: 'div',
    role: null,
    name: null,
    nameSource: null,
    text: null,
    attrs: {},
    volatile: { id: 'mat-input-27 · ends in a generated counter' },
    labels: [],
    context: { ancestors: [], heading: null, landmark: null, list: null },
    siblings: { sameRoleAndName: 0, sameText: 0, sameTag: 22 },
    selectors: {
      semanticCss: null,
      contextualCss: null,
      positionalCss: 'body > div:nth-of-type(3) > div',
      semanticXPath: null,
      absoluteXPath: '/html/body/div[3]/div',
    },
  };
}

const strategiesOf = (list) => list.map((c) => c.strategy);

/** The strategies that find an element by WHERE it sits rather than by WHAT it is. CONTRACT §3. */
const POSITIONAL = new Set(['domIndex', 'relativeXPath', 'absoluteXPath', 'positional']);

test('candidatesFor: nothing in, nothing out', () => {
  assert.equal(candidatesFor(null), [], 'null fingerprint');
  assert.equal(candidatesFor(undefined), [], 'undefined fingerprint');
});

test('candidatesFor: bands come out in priority order — testid, id, role, text, css, then the positional band', () => {
  const list = candidatesFor(fpRich());
  const s = strategiesOf(list);
  assert.equal(s[0], 'testid', 'the explicit test contract must come first');
  assert.before(s, 'testid', 'id', 'testid before id');
  assert.before(s, 'id', 'role', 'id before role');
  assert.before(s, 'role', 'text', 'role before text');
  assert.before(s, 'text', 'css', 'text before css');
  assert.before(s, 'css', 'domIndex', 'every semantic strategy before the positional band');
  assert.before(s, 'domIndex', 'relativeXPath', 'DOM index before relative XPath');
  assert.before(s, 'relativeXPath', 'absoluteXPath', 'relative XPath before absolute XPath');
  assert.equal(s[s.length - 1], 'absoluteXPath', 'the absolute XPath is always dead last');
});

test('candidatesFor: scores are monotonically non-increasing', () => {
  for (const fp of [fpRich(), fpAmbiguousInRegion(), fpBare()]) {
    const list = candidatesFor(fp);
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1].score >= list[i].score,
        `candidate ${i} (${list[i].strategy}, ${list[i].score}) outranks the one before it (${list[i - 1].strategy}, ${list[i - 1].score})`);
    }
  }
});

test('candidatesFor: the band scores match the table in CONTRACT.md §4', () => {
  const list = candidatesFor(fpRich());
  const byStrategy = (s) => list.find((c) => c.strategy === s && !c.scope);
  assert.equal(byStrategy('testid').score, 100, 'testid = 100');
  assert.equal(byStrategy('id').score, 92, 'id = 92');
  assert.equal(byStrategy('role').score, 85, 'role + name = 85');
  assert.equal(byStrategy('attr').score, 74, 'attr = 74');
  assert.equal(byStrategy('text').score, 55, 'unique text = 55');
  assert.equal(byStrategy('css').score, 40, 'semantic css = 40');
  assert.equal(byStrategy('domIndex').score, 12, 'DOM index = 12');
  assert.equal(byStrategy('relativeXPath').score, 10, 'relative xpath = 10');
  assert.equal(byStrategy('absoluteXPath').score, 6, 'absolute xpath = 6');
});

test('candidatesFor: an ambiguous role+name produces a candidate scoped to its container', () => {
  const list = candidatesFor(fpAmbiguousInRegion());
  const scoped = list.filter((c) => c.scope);
  assert.ok(scoped.length > 0, 'at least one candidate must be scoped to the Customer Details region');
  const scopedRole = scoped.find((c) => c.strategy === 'role');
  assert.ok(scopedRole, 'the role candidate must be available in a scoped form');
  assert.equal(scopedRole.scope.strategy, 'role', 'the scope is the region');
  assert.equal(scopedRole.scope.params.name, 'Customer Details', 'the scope names the right region');
  assert.equal(scopedRole.params, { role: 'button', name: 'Save', exact: true }, 'scoped role params');
  assert.match(scopedRole.why, /scoped to a stable container/, 'the +8 is explained in `why`');
  assert.equal(scopedRole.score, 90, 'role 85 + scope 5');
});

test('candidatesFor: the scoped candidate outranks the unscoped one it disambiguates', () => {
  const list = candidatesFor(fpAmbiguousInRegion());
  const scoped = list.find((c) => c.strategy === 'role' && c.scope);
  const plain = list.find((c) => c.strategy === 'role' && !c.scope);
  assert.ok(scoped && plain, 'both forms exist');
  assert.ok(scoped.score > plain.score, `scoped (${scoped.score}) must beat unscoped (${plain.score})`);
  assert.ok(list.indexOf(scoped) < list.indexOf(plain), 'scoped comes first in the ordered list');
});

test('[known bug] candidatesFor: a modifier must not leapfrog a whole band', () => {
  // scoring.js promises "gaps wide enough that a modifier can never leapfrog a whole band", and
  // CONTRACT.md §4 puts `id` (92) above `role` (85). Scoped role is 85 + 5 = 90, which stays below it, so on any
  // page that has BOTH a named container and a hand-written id — css-change-before.html, for one —
  // the scoped role candidate is tried before the id.
  const fp = fpRich();
  fp.context.ancestors = [
    { tag: 'section', role: 'region', name: 'Customer Details', testid: null, testidAttr: null, id: null, landmark: true, depth: 1 },
  ];
  const s = strategiesOf(candidatesFor(fp));
  assert.before(s, 'id', 'role', 'a hand-written id (92) must be tried before any role candidate');
});

test('candidatesFor: with no stable signal at all, only the positional band remains', () => {
  const list = candidatesFor(fpBare());
  assert.equal(strategiesOf(list), ['domIndex', 'relativeXPath', 'absoluteXPath'],
    'the three fallbacks, in the order they are tried');
  assert.equal(list.map((c) => c.score), [12, 10, 6], 'and in the scores the contract gives them');
  assert.every(list, (c) => /DOM index|XPath/.test(c.why), 'each one says what it is');
});

test('candidatesFor: the positional band is offered even when strong signals exist', () => {
  const list = candidatesFor(fpRich());
  const band = list.filter((c) => POSITIONAL.has(c.strategy)).map((c) => c.strategy);
  assert.includes(band, 'domIndex', 'a DOM index is always offered');
  assert.includes(band, 'relativeXPath', 'so is a relative XPath');
  assert.includes(band, 'absoluteXPath', 'and so is an absolute one');
});

test('candidatesFor: no candidate is ever built from a class name', () => {
  const fp = fpRich();
  fp.volatile.class = 'btn primary marker-zqx css-1a2b3c · generated class names';
  const json = JSON.stringify(candidatesFor(fp));
  for (const cls of ['btn', 'primary', 'marker-zqx', 'css-1a2b3c']) {
    assert.excludes(json, cls, `the class "${cls}" must not appear in any candidate`);
  }
  // …and belt-and-braces: no candidate may carry a class-shaped css selector either.
  assert.every(candidatesFor(fp), (c) => !(c.params.value || '').includes('.'), 'no dotted CSS class selectors');
});

test('candidatesFor: a volatile accessible name is flagged and penalised', () => {
  const fp = fpRich();
  fp.name = "Dev's Profile Maheep Gupta 1h";
  fp.volatileName = 'a relative time';
  const role = candidatesFor(fp).find((c) => c.strategy === 'role' && !c.scope);
  assert.ok(role, 'a role candidate still exists');
  assert.equal(role.score, 55, 'role 85 − 30 for a name that changes with the clock');
  assert.match(role.why, /changes over time/, 'and it says so');
});

test('candidatesFor: identical descriptors are deduplicated', () => {
  const list = candidatesFor(fpRich());
  const keys = list.map((c) => JSON.stringify([c.strategy, c.params, c.scope && c.scope.params]));
  assert.equal(new Set(keys).size, keys.length, 'every candidate is distinct');
});

test('candidatesFor: labels become label candidates', () => {
  const fp = fpBare();
  fp.tag = 'input';
  fp.role = 'textbox';
  fp.name = 'Customer name';
  fp.nameSource = 'label';
  fp.labels = ['Customer name'];
  const label = candidatesFor(fp).find((c) => c.strategy === 'label');
  assert.ok(label, 'a label candidate is produced');
  assert.equal(label.params, { text: 'Customer name', exact: true }, 'label params');
  assert.equal(label.score, 82, 'label band = 82');
});

test('scopeCandidates: only containers that can themselves be named stably qualify', () => {
  const scopes = scopeCandidates([
    { tag: 'div', role: null, name: null, testid: null, id: null, depth: 1 },
    { tag: 'section', role: 'region', name: 'Customer Details', testid: null, id: null, depth: 2 },
    { tag: 'form', role: 'form', name: null, testid: null, id: 'customerForm', depth: 4 },
    { tag: 'div', role: null, name: null, testid: 'page-root', id: null, depth: 6 },
  ]);
  assert.equal(scopes.map((s) => s.strategy), ['role', 'id', 'testid'], 'the anonymous div is skipped');
  assert.equal(scopes[0].params.name, 'Customer Details', 'nearest usable container first');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. scoring — the numbers, and what validation does to them
// ─────────────────────────────────────────────────────────────────────────────

test('scoring: baseScore matches the printable table', () => {
  const expected = { testid: 100, id: 92, role: 85, label: 82, attr: 74, placeholder: 68, altText: 68, text: 55, css: 40, xpath: 35, domIndex: 12, relativeXPath: 10, absoluteXPath: 6, positional: 10 };
  for (const [strategy, score] of Object.entries(expected)) {
    assert.equal(scoring.baseScore(strategy), score, `baseScore("${strategy}")`);
  }
  assert.equal(scoring.baseScore('something-nobody-implemented'), 20, 'an unknown strategy gets a cautious 20');
});

test('scoring: title sits just below the placeholder/alt band', () => {
  assert.equal(scoring.baseScore('title'), 66, 'a title attribute is the weakest of the three descriptive-text signals');
});

test('scoring: exactly the modifiers CONTRACT.md §4 lists exist, and no others', () => {
  assert.equal(Object.keys(scoring.MODIFIERS).sort(), ['ambiguousAtRecord', 'generatedValue', 'scoped', 'volatileText', 'weakName'],
    'CONTRACT.md §4 says "Nothing else may adjust a score"');
});

test('scoring: every modifier carries the delta the contract states', () => {
  assert.equal(scoring.MODIFIERS.scoped.delta, 5, 'scoping to a semantic container is +5, deliberately too small to jump a band');
  assert.equal(scoring.MODIFIERS.ambiguousAtRecord.delta, -25, 'sharing an identity at record time is −25');
  assert.equal(scoring.MODIFIERS.weakName.delta, -12, 'a role with no accessible name is −12');
  assert.equal(scoring.MODIFIERS.volatileText.delta, -30, 'a volatile-looking name is −30');
  assert.equal(scoring.MODIFIERS.generatedValue.delta, -40, 'a generated-looking value is −40');
});

test('scoring: scoreCandidate applies modifiers in order and explains each one', () => {
  const fp = fpRich();
  const plain = scoring.scoreCandidate({ strategy: 'role', params: { role: 'button', name: 'Save' } }, fp);
  assert.equal(plain.score, 85, 'a bare role+name');
  assert.match(plain.why, /role "button" named "Save"/, 'the base clause');

  const scoped = scoring.scoreCandidate({ strategy: 'role', params: { role: 'button', name: 'Save' }, scope: { strategy: 'role' } }, fp);
  assert.equal(scoped.score, 90, '+5 for scoping');

  const volatile = scoring.scoreCandidate({ strategy: 'text', params: { text: '1h ago' }, flags: { volatileText: true } }, fp);
  assert.equal(volatile.score, 25, '55 − 30');

  const generated = scoring.scoreCandidate({ strategy: 'id', params: { value: 'mat-input-27' }, flags: { generatedValue: true } }, fp);
  assert.equal(generated.score, 52, '92 − 40');

  const both = scoring.scoreCandidate({ strategy: 'absoluteXPath', params: {}, flags: { volatileText: true, generatedValue: true } }, fp);
  assert.equal(both.score, 0, 'clamped at 0, never negative');
});

test('scoring: finalScore — a candidate that matches NOTHING scores 0 and is rejected', () => {
  const v = scoring.finalScore({ score: 100, why: 'x' }, { matches: 0, correct: false });
  assert.equal(v.score, 0, 'score');
  assert.equal(v.verified, false, 'not verified');
  assert.match(v.rejected, /matched nothing/i, 'and says why');
});

test('scoring: finalScore — a candidate that matches the WRONG element scores 0 and is rejected', () => {
  const v = scoring.finalScore({ score: 100, why: 'x' }, { matches: 1, correct: false });
  assert.equal(v.score, 0, 'a unique match on the wrong element is worth nothing');
  assert.equal(v.verified, false, 'not verified');
  assert.match(v.rejected, /none of them the one that was used/i, 'and says why');
});

test('scoring: finalScore — 3 matches is heavily penalised and never verified', () => {
  const v = scoring.finalScore({ score: 100, why: 'x' }, { matches: 3, correct: true });
  assert.equal(v.verified, false, 'ambiguity is never verified');
  assert.equal(v.score, 0, '100 − 100×(3−1), floored at 0');
  assert.match(v.rejected, /matched 3 elements/i, 'and says how many');

  const two = scoring.finalScore({ score: 100, why: 'x' }, { matches: 2, correct: true });
  assert.equal(two.score, 0, 'even two matches wipes out a perfect test id');
  assert.equal(two.verified, false, 'still not verified');
});

test('scoring: finalScore — exactly one correct match keeps the score and verifies', () => {
  for (const score of [100, 92, 85, 55, 10]) {
    const v = scoring.finalScore({ score, why: 'x' }, { matches: 1, correct: true });
    assert.equal(v.score, score, `score ${score} survives validation untouched`);
    assert.equal(v.verified, true, `score ${score} is verified`);
    assert.equal(v.rejected, undefined, 'nothing to reject');
  }
});

test('scoring: resolutionConfidence blends locator trust with how similar the element still is', () => {
  assert.equal(scoring.resolutionConfidence(100, 100), 100, 'perfect');
  assert.equal(scoring.resolutionConfidence(100, 0), 60, '0.6 × locator');
  assert.equal(scoring.resolutionConfidence(0, 100), 40, '0.4 × similarity');
  assert.equal(scoring.resolutionConfidence(85, 70), 79, '0.6×85 + 0.4×70');
});

run('unit');
