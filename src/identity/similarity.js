/**
 * Element Identity Engine — is this the same element?
 *
 * A locator finding exactly one element is not proof it found the RIGHT one. This module compares
 * the identity recorded months ago with the identity of whatever was just found, and answers with
 * a number and a list of what agreed and what did not.
 *
 * The design rule that shapes every weight below: **text is the signal most likely to change and
 * least likely to mean the element changed.** A button renamed from "Save Customer" to "Save" is
 * the same button. A button whose test id changed from `save-customer` to `delete-customer` is
 * not. So text is worth little and contract-like signals are worth a lot.
 */
'use strict';

/**
 * Weight per signal. Only signals present in BOTH fingerprints count, and the result is normalised
 * over the weights that actually applied — so an element with no test id is not punished for it.
 */
const WEIGHTS = {
  testid: 35,
  id: 25,
  role: 20,
  tag: 10,
  name: 10,
  containerName: 10,
  label: 8,
  semanticAttrs: 8,
  text: 5,
};

const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];

function testIdOf(fp) {
  const attrs = (fp && fp.attrs) || {};
  for (const a of TEST_ID_ATTRS) if (attrs[a]) return attrs[a];
  return null;
}

/**
 * The names of the containers this element sits in, nearest first.
 *
 * Deliberately a LIST rather than just the nearest one. In a table the nearest named ancestor is
 * the cell, whose name is "Edit" in every single row — so comparing only that made the Edit button
 * of the Acme Corp row and the Edit button of the Globex row score 100% identical. The row is the
 * ancestor that tells them apart, and it is two levels up.
 */
function containerNamesOf(fp) {
  const ancestors = (fp && fp.context && fp.context.ancestors) || [];
  return ancestors.map((a) => a.name).filter(Boolean).slice(0, 3);
}

function containerNameOf(fp) {
  return containerNamesOf(fp)[0] || null;
}

/** How much of the recorded container chain is still around the element we just found? */
function containerOverlap(recorded, live) {
  const a = containerNamesOf(recorded).map(norm);
  const b = new Set(containerNamesOf(live).map(norm));
  if (!a.length || !b.size) return null;
  let shared = 0;
  for (const n of a) if (b.has(n)) shared++;
  return shared / a.length;
}

function semanticAttrsOf(fp) {
  const attrs = (fp && fp.attrs) || {};
  const out = {};
  for (const k of Object.keys(attrs)) {
    if (k === 'id' || TEST_ID_ATTRS.indexOf(k) >= 0) continue;
    if (k === 'name' || k === 'type' || k === 'href' || k === 'formcontrolname' || k.indexOf('data-') === 0) out[k] = attrs[k];
  }
  return out;
}

/**
 * The attributes strong enough to vouch that two elements are the same thing even when everything
 * visible about them changed. `type="submit"` is NOT one of them: a Save button and a Delete button
 * in the same form both submit, so treating it as an anchor would let a Delete button inherit a
 * Save button's identity. Only attributes that NAME the element qualify.
 */
function identityAttrsOf(fp) {
  const attrs = (fp && fp.attrs) || {};
  const out = {};
  for (const k of Object.keys(attrs)) {
    if (k === 'id' || TEST_ID_ATTRS.indexOf(k) >= 0) continue;
    if (k === 'name' || k === 'formcontrolname' || k === 'href' || k.indexOf('data-') === 0) out[k] = attrs[k];
  }
  return out;
}

function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * @param {object} recorded  the fingerprint saved with the test
 * @param {object} live      the fingerprint of the element just resolved
 * @returns {{score:number, matched:string[], differed:string[], missing:string[], fatal:boolean, reason:string}}
 */
function compare(recorded, live) {
  if (!recorded || !live) {
    return { score: 0, matched: [], differed: [], missing: [], fatal: true, reason: 'no fingerprint to compare' };
  }

  const matched = [];
  const differed = [];
  const missing = [];
  let earned = 0;
  let possible = 0;

  const judge = (key, a, b, equalFn) => {
    const has = a != null && a !== '' && b != null && b !== '';
    if (!has) { if (a != null && a !== '') missing.push(key); return null; }
    possible += WEIGHTS[key];
    const same = equalFn ? equalFn(a, b) : norm(a) === norm(b);
    if (same) { earned += WEIGHTS[key]; matched.push(key); } else { differed.push(key); }
    return same;
  };

  const testidSame = judge('testid', testIdOf(recorded), testIdOf(live));
  const idSame = judge('id', recorded.attrs && recorded.attrs.id, live.attrs && live.attrs.id);
  const roleSame = judge('role', recorded.role, live.role);
  const tagSame = judge('tag', recorded.tag, live.tag);
  const nameSame = judge('name', recorded.name, live.name);
  // The whole container chain, not just the nearest, so two rows of a table are distinguishable.
  const overlap = containerOverlap(recorded, live);
  if (overlap !== null) {
    possible += WEIGHTS.containerName;
    earned += WEIGHTS.containerName * overlap;
    (overlap === 1 ? matched : differed).push('containerName');
  }
  judge('label', (recorded.labels || [])[0], (live.labels || [])[0]);
  judge('text', recorded.text, live.text);

  // Semantic attributes are compared as a set: how many of the recorded ones survived.
  const recAttrs = semanticAttrsOf(recorded);
  const liveAttrs = semanticAttrsOf(live);
  const recKeys = Object.keys(recAttrs);
  let anySemanticAttrMatched = false;
  if (recKeys.length && Object.keys(liveAttrs).length) {
    possible += WEIGHTS.semanticAttrs;
    const kept = recKeys.filter((k) => norm(liveAttrs[k]) === norm(recAttrs[k]));
    earned += WEIGHTS.semanticAttrs * (kept.length / recKeys.length);
    (kept.length === recKeys.length ? matched : differed).push('semanticAttrs');
  }
  // Anchoring uses the stricter set: only attributes that NAME the element, never `type`.
  const recIdent = identityAttrsOf(recorded);
  const liveIdent = identityAttrsOf(live);
  anySemanticAttrMatched = Object.keys(recIdent).some((k) => liveIdent[k] != null && norm(liveIdent[k]) === norm(recIdent[k]));

  const score = possible === 0 ? 0 : Math.round((earned / possible) * 100);

  // ── the fatal test: "changed" versus "a different element"
  //
  // A test id or a hand-written id that exists in both places and disagrees is decisive: the app
  // deliberately labels these two things differently. Everything else is a matter of degree.
  let fatal = false;
  let reason = '';
  if (testidSame === false) {
    fatal = true;
    reason = `the test id changed from "${testIdOf(recorded)}" to "${testIdOf(live)}" — that is a different element, not a restyled one`;
  } else if (idSame === false && testidSame !== true) {
    fatal = true;
    reason = `the id changed from "${recorded.attrs.id}" to "${live.attrs.id}"`;
  } else if (roleSame === false && tagSame === false && testidSame !== true) {
    fatal = true;
    reason = `both the tag and the role changed (${recorded.tag}/${recorded.role} → ${live.tag}/${live.role})`;
  } else if (!anchored(testidSame, idSame, anySemanticAttrMatched) && nameSame === false && !nameRelated(recorded.name, live.name)) {
    // Nothing contract-like ties these two together — no test id, no id, no semantic attribute.
    // All that is left is what the element SAYS, and it now says something unrelated. A button
    // that read "Save Customer" and now reads "Delete Customer" in the same place is a different
    // button, and clicking it would be the worst thing this tool could do.
    fatal = true;
    reason = `nothing but the name identified this element, and it changed from "${recorded.name}" to "${live.name}"`;
  }

  if (!reason) {
    reason = differed.length
      ? `${matched.length} signal(s) matched, ${differed.join(', ')} changed`
      : `all ${matched.length} comparable signal(s) matched`;
  }

  return { score: fatal ? 0 : score, matched, differed, missing, fatal, reason };
}

/** Is there a contract-like signal holding these two together, rather than just appearance? */
function anchored(testidSame, idSame, semanticAttrMatched) {
  return testidSame === true || idSame === true || semanticAttrMatched === true;
}

/**
 * Is the new name a plausible edit of the old one, or a different label entirely?
 *
 *   "Save Customer" → "Save"             related (one contains the other) — a rename, allow it
 *   "Save Customer" → "Save the record"  related (most of the smaller side survives)
 *   "Save Customer" → "Delete Customer"  NOT related — the verb changed, and the verb is the meaning
 */
function nameRelated(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const ax = new Set(x.split(/\W+/).filter(Boolean));
  const by = new Set(y.split(/\W+/).filter(Boolean));
  if (!ax.size || !by.size) return false;
  let shared = 0;
  for (const t of ax) if (by.has(t)) shared++;
  return shared / Math.min(ax.size, by.size) >= 0.6;
}

/**
 * The gate the resolver applies. Kept here so the thresholds live next to the scoring that feeds
 * them, and so a test can assert them directly.
 *
 *   >= 70            accept
 *   40..69           accept only behind a strong, record-time-verified locator (a real contract)
 *   < 40  or fatal   reject and keep looking
 */
function verdict(similarity, candidate) {
  if (similarity.fatal) return { accept: false, why: similarity.reason };
  if (similarity.score >= 70) return { accept: true, why: similarity.reason };
  if (similarity.score >= 40 && candidate && candidate.score >= 85 && candidate.verified) {
    return { accept: true, warn: true, why: `${similarity.reason} — accepted because ${candidate.why}` };
  }
  return { accept: false, why: `only ${similarity.score}% of the recorded identity still matches (${similarity.reason})` };
}

module.exports = { compare, verdict, WEIGHTS };
