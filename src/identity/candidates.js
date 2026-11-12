/**
 * Element Identity Engine — candidate generation.
 *
 * Pure: a fingerprint in, an ordered list of locator descriptors out. No DOM, no Playwright, no
 * I/O — which is why it can be unit-tested against hand-written fingerprints.
 *
 * The job is NOT to find "the selector". It is to produce every *independent* way of naming this
 * element, so that when one of them stops being true tomorrow the others still are. Validation
 * (validate.js) then deletes the ones that do not actually work, and scoring.js ranks what is left.
 *
 * A note on scoping. When several elements on the page share an identity — three "Save" buttons —
 * the answer is never `nth(2)`. It is to name the container: *the Save button in Customer
 * Details*. Every strategy here can carry a `scope`, which is itself a candidate.
 */
'use strict';

const { scoreCandidate } = require('./scoring');

const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];

/** Roles whose name comes from their own text, so `getByRole` is the natural expression. */
const NAMED_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'switch', 'treeitem', 'heading', 'textbox', 'searchbox', 'combobox',
  'spinbutton', 'slider', 'listitem', 'cell', 'gridcell', 'columnheader', 'rowheader', 'row', 'dialog', 'tooltip']);

/**
 * @param {object} fp  a fingerprint from browser-lib
 * @returns {Array} candidates, best-first, each `{ strategy, params, scope?, flags, score, why }`
 */
function candidatesFor(fp) {
  if (!fp) return [];
  const out = [];
  const attrs = fp.attrs || {};
  const sib = fp.siblings || {};
  const ancestors = (fp.context && fp.context.ancestors) || [];

  // Ambiguity at record time is a property of the ELEMENT, and it is what decides whether a
  // strategy needs a container to be trustworthy.
  const roleNameAmbiguous = (sib.sameRoleAndName || 0) > 1;
  const textAmbiguous = (sib.sameText || 0) > 1;
  const scopes = scopeCandidates(ancestors, fp);
  const bestScope = scopes[0] || null;

  const add = (strategy, params, opts) => {
    const o = opts || {};
    const c = { strategy, params, scope: o.scope || null, flags: o.flags || {} };
    const scored = scoreCandidate(c, fp);
    c.score = scored.score;
    c.why = scored.why;
    out.push(c);
    return c;
  };

  // ── 1. an explicit test contract, if the app has one
  for (const a of TEST_ID_ATTRS) {
    if (attrs[a]) {
      add('testid', { value: attrs[a], attr: a }, { flags: { generatedValue: false } });
      break;
    }
  }

  // ── 2. a hand-written id (browser-lib already refused to put a generated one in `attrs`)
  if (attrs.id) add('id', { value: attrs.id });

  // ── 3. accessibility identity. The workhorse in an app with no test ids.
  if (fp.role && NAMED_ROLES.has(fp.role) && fp.name) {
    const flags = { volatileText: !!fp.volatileName };
    add('role', { role: fp.role, name: fp.name, exact: true }, { flags });
    // The same identity, pinned to its container — one candidate per usable container, not just
    // the nearest. The nearest is often useless: in a table, the nearest nameable ancestor is the
    // cell, which is identical in every row, while the ROW carries the text that tells them apart.
    // Validation deletes the ones that turn out not to be unique, so offering all three is free.
    for (const scope of scopes) add('role', { role: fp.role, name: fp.name, exact: true }, { scope, flags });
    // A looser name match survives "Save Customer" becoming "Save … Customer".
    if (fp.name.length >= 4 && !fp.volatileName) {
      add('role', { role: fp.role, name: fp.name, exact: false }, { scope: roleNameAmbiguous ? bestScope : null, flags: { weakName: false } });
    }
    // "The button in Customer Details", with no name at all. This is the candidate that survives a
    // wholesale rename — "Save Customer" becoming "Save" — which is precisely the change this tool
    // exists to tolerate. It is only worth having when the container makes it unambiguous, so it
    // carries the weak-name penalty and validation will discard it if the container holds two.
    //
    // NOTE ON SAFETY: this candidate names a container and then says nothing about what is inside
    // it, so if the container's only button is REPLACED by a different button it will match that
    // one. It is kept because it is the only thing that survives a wholesale rename, and it is made
    // safe at replay: similarity.compare() refuses a match where nothing contract-like anchors the
    // two elements and the accessible name changed to something unrelated. Do not remove that rule.
    for (const scope of scopes.slice(0, 2)) {
      add('role', { role: fp.role }, { scope, flags: { weakName: true } });
    }
  } else if (fp.role && !fp.name) {
    // A role with no name is only usable inside a container.
    if (bestScope) add('role', { role: fp.role }, { scope: bestScope, flags: { weakName: true } });
  }

  // ── 4. the visible label of a form control
  for (const label of (fp.labels || []).slice(0, 2)) {
    add('label', { text: label, exact: true }, { flags: { volatileText: !!looksTimey(label) } });
  }
  if (!(fp.labels || []).length && fp.nameSource === 'label' && fp.name) {
    add('label', { text: fp.name, exact: true }, {});
  }

  // ── 5. stable semantic attributes, strongest first
  const semanticAttrs = Object.keys(attrs).filter((k) => k.indexOf('data-') === 0 && TEST_ID_ATTRS.indexOf(k) < 0);
  for (const k of semanticAttrs) {
    add('attr', { name: k, value: attrs[k] }, { flags: {} });
  }
  if (attrs.name) {
    add('attr', { name: 'name', value: attrs.name });
    if (attrs.type) add('attr', { pairs: [['name', attrs.name], ['type', attrs.type]] });
  }
  if (attrs.formcontrolname) add('attr', { name: 'formcontrolname', value: attrs.formcontrolname });
  if (attrs.href && fp.tag === 'a') {
    add('attr', { name: 'href', value: attrs.href, tag: 'a' }, { scope: sib.sameTag > 1 ? bestScope : null });
  }
  if (attrs['aria-label'] && fp.nameSource !== 'aria-label') {
    add('attr', { name: 'aria-label', value: attrs['aria-label'] });
  }

  // ── 6. descriptive text the user can see
  if (attrs.placeholder) add('placeholder', { text: attrs.placeholder, exact: true });
  if (attrs.alt) add('altText', { text: attrs.alt, exact: true });
  if (attrs.title) add('title', { text: attrs.title, exact: true });

  // ── 7. the element's own text
  if (fp.text && fp.text.length <= 80) {
    const flags = { volatileText: !!fp.volatileText, ambiguousAtRecord: textAmbiguous };
    add('text', { text: fp.text, tag: fp.tag, exact: true }, { scope: textAmbiguous ? bestScope : null, flags });
  }

  // ── 8. selectors the page itself confirmed unique while we were standing on the element
  const sel = fp.selectors || {};
  if (sel.semanticCss) add('css', { value: sel.semanticCss });
  if (sel.contextualCss && sel.contextualCss !== sel.semanticCss) add('css', { value: sel.contextualCss });
  // NOTE: the semantic XPath is NOT emitted here. It goes out below as `relativeXPath`, in the
  // positional band, because an XPath is a path however much meaning is written into it — and the
  // user asked for the XPath fallbacks to be named and tried as a group, after everything else.

  // ── 9. the fallbacks of last resort: WHERE the element sits, when nothing about WHAT it is
  //      still holds. Three separately named strategies, never one lump called "positional",
  //      because the first question asked about a failed replay is *which* of them was tried and
  //      what it found. They are always offered and never preferred: the resolver runs them after
  //      every semantic strategy and refuses whatever they find unless similarity.compare() agrees
  //      it is still the same element (CONTRACT.md §8).
  //
  //      Order: domIndex → relativeXPath → absoluteXPath. Cheapest and most local first; the
  //      absolute path, which any change anywhere above the element invalidates, dead last.
  const di = fp.domIndex || null;
  if (sel.positionalCss) {
    add('domIndex', {
      kind: 'path',
      value: sel.positionalCss,
      tag: fp.tag,
      childIndex: di ? di.childIndex : null,
      ofTypeIndex: di ? di.ofTypeIndex : null,
      parentTag: di ? di.parentTag : null,
    });
  }
  if (di && typeof di.documentIndex === 'number' && di.documentIndex >= 0) {
    add('domIndex', { kind: 'ordinal', tag: di.tag || fp.tag, index: di.documentIndex, of: di.documentCount });
  }
  // The relative XPath the page itself confirmed unique while we were standing on the element.
  if (sel.semanticXPath) add('relativeXPath', { value: sel.semanticXPath });
  // …and, when that one is built from something the app may rewrite (or does not exist at all), a
  // relative path made by cutting the absolute one loose from the document root. `//form/button[2]`
  // survives everything above the form being restructured, which is the single most common reason
  // an absolute XPath dies.
  const tail = relativeTail(sel.absoluteXPath);
  if (tail && tail !== sel.semanticXPath) add('relativeXPath', { value: tail, derivedFrom: 'absoluteXPath' });
  if (sel.absoluteXPath) add('absoluteXPath', { value: sel.absoluteXPath });

  return dedupe(out).sort((a, b) => b.score - a.score);
}

/**
 * Cut an absolute XPath loose from the document root: `/html/body/div[2]/form/button[3]` becomes
 * `//form/button[3]`. The last three steps are kept — enough shape to mean something, short enough
 * to survive the page being re-laid-out above it. Returns null when there is nothing to cut.
 */
function relativeTail(absolute) {
  const raw = String(absolute || '');
  if (!raw || raw[0] !== '/') return null;
  let steps = raw.split('/').filter(Boolean);
  // `html` and `body` anchor the path to the document root, which is the thing being cut loose.
  while (steps.length && /^(html|body)([d+])?$/.test(steps[0])) steps = steps.slice(1);
  if (steps.length < 2) return null;    // one step left is just `//div` — a shape, not a location
  return '//' + steps.slice(-3).join('/');
}

/**
 * The containers worth scoping to, nearest first. A container only qualifies if IT can be named
 * stably — scoping to `div:nth-child(3)` would just move the fragility one level up.
 */
function scopeCandidates(ancestors, fp) {
  const out = [];
  for (const a of ancestors) {
    if (a.testid) out.push({ strategy: 'testid', params: { value: a.testid, attr: a.testidAttr || 'data-testid' }, label: containerLabel(a) });
    else if (a.id) out.push({ strategy: 'id', params: { value: a.id }, label: containerLabel(a) });
    else if (a.role && a.name && usefulScopeName(a.name, fp)) out.push({ strategy: 'role', params: { role: a.role, name: a.name, exact: true }, label: containerLabel(a) });
    else continue;
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * A container is only worth scoping to if its name says something the element does not already say.
 * A `<td>` wrapping one button has the accessible name "Edit" — the button's own text — so scoping
 * to it adds nothing and, worse, looks unique when it is repeated in every row of a table.
 */
function usefulScopeName(name, fp) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  const own = String((fp && (fp.name || fp.text)) || '').trim().toLowerCase();
  if (!own) return true;
  if (n === own) return false;
  // The container's whole name is just this element's text plus its siblings' text.
  return !(n.length <= own.length + 12 && n.indexOf(own) >= 0);
}

function containerLabel(a) {
  if (a.name) return `${a.role || a.tag} "${a.name}"`;
  if (a.testid) return `[${a.testid}]`;
  if (a.id) return `#${a.id}`;
  return a.tag;
}

function looksTimey(text) {
  return /\b\d{1,3}\s*(?:s|m|h|d|w|mo|y)\s*(?:ago)?\b|\b\d{2}:\d{2}\b|\b\d{6,}\b/i.test(String(text || ''));
}

/** Two candidates that would build the same locator are one candidate. */
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const key = JSON.stringify([c.strategy, c.params, c.scope && [c.scope.strategy, c.scope.params]]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

module.exports = { candidatesFor, scopeCandidates, relativeTail, TEST_ID_ATTRS };
