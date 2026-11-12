/**
 * Element Identity Engine — scoring.
 *
 * Pure, deterministic, and deliberately small enough to print on one page. Every number a locator
 * carries comes from here, and every number is accompanied by a sentence explaining it, because a
 * score a developer cannot argue with is a score they cannot debug.
 *
 * The one rule that matters: **unique is not the same as stable**. `/html/body/div[2]/button[4]`
 * matches exactly one element and is still nearly worthless. Uniqueness is checked separately by
 * validate.js; this file scores how much the locator's MEANING can be trusted tomorrow.
 */
'use strict';

/**
 * Base trust per strategy. The ordering is the brief's locator priority, turned into numbers with
 * gaps wide enough that a modifier can never leapfrog a whole band.
 */
const BASE = {
  testid: 100,      // an explicit contract between the developer and the test
  id: 92,           // only reachable when stability.js judged the id hand-written
  role: 85,         // accessibility identity: survives restyling and re-nesting
  label: 82,        // the visible label of a form control
  attr: 74,         // name=, type=, href=, data-*
  placeholder: 68,
  altText: 68,
  title: 66,   // one below placeholder/alt: a title is the weakest of the three
  text: 55,         // meaningful, but the first thing a developer changes
  css: 40,          // built from stable attributes only
  xpath: 35,        // built from meaning, not position

  // ── the positional band. Everything below this line finds an element by WHERE IT SITS, and a
  // position is not an identity: a match found by any of these is only ever accepted after
  // similarity.compare() has agreed it is still the same element (CONTRACT.md §8).
  // The three are separately named so a failure report can say which of them was tried and why
  // each was turned down. Their scores encode the order: DOM index, then relative XPath, then
  // absolute XPath — and all of them below every semantic strategy.
  domIndex: 12,     // the recorded child / of-type / document index, tried as numbers
  relativeXPath: 10,// an XPath anchored on something nameable, not on the document root
  absoluteXPath: 6, // /html/body/div[2]/… — true until anyone touches the page above it
  positional: 10,   // LEGACY: targets recorded before the three above were split out
};

/** Applied in this exact order; each one appends a clause to `why`. */
const MODIFIERS = {
  // +5, not more: a scoped role (85+5=90) must stay BELOW a hand-written id (92), or a modifier
  // would leapfrog a whole band and the priority table would stop meaning what it says.
  scoped: { delta: +5, why: 'scoped to a stable container' },
  volatileText: { delta: -30, why: 'the text looks like it changes over time' },
  generatedValue: { delta: -40, why: 'the value looks framework-generated' },
  ambiguousAtRecord: { delta: -25, why: 'other elements shared this identity when it was recorded' },
  weakName: { delta: -12, why: 'no accessible name to go with the role' },
};

function baseScore(strategy) {
  return BASE[strategy] == null ? 20 : BASE[strategy];
}

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Score a candidate before it has been run against the DOM.
 * @param {object} candidate  { strategy, params, scope?, flags? }
 * @param {object} fingerprint
 * @returns {{score:number, why:string}}
 */
function scoreCandidate(candidate, fingerprint) {
  const flags = candidate.flags || {};
  let score = baseScore(candidate.strategy);
  const clauses = [describeBase(candidate, fingerprint)];

  const applied = [];
  if (candidate.scope) applied.push('scoped');
  if (flags.volatileText) applied.push('volatileText');
  if (flags.generatedValue) applied.push('generatedValue');
  if (flags.ambiguousAtRecord) applied.push('ambiguousAtRecord');
  if (flags.weakName) applied.push('weakName');

  for (const key of applied) {
    const m = MODIFIERS[key];
    score += m.delta;
    clauses.push(m.why);
  }
  return { score: clamp(score), why: clauses.filter(Boolean).join('; ') };
}

function describeBase(candidate, fingerprint) {
  const p = candidate.params || {};
  switch (candidate.strategy) {
    case 'testid': return `explicit test id "${p.value}"`;
    case 'id': return `hand-written id "${p.value}"`;
    case 'role': return p.name ? `role "${p.role}" named "${p.name}"` : `role "${p.role}"`;
    case 'label': return `the field labelled "${p.text}"`;
    case 'attr': return p.pairs
      ? `attributes ${p.pairs.map(([k, v]) => `${k}="${v}"`).join(' + ')}`
      : `attribute ${p.name}="${p.value}"`;
    case 'placeholder': return `placeholder "${p.text}"`;
    case 'altText': return `image alt text "${p.text}"`;
    case 'title': return `title "${p.text}"`;
    case 'text': return `the text "${p.text}"`;
    case 'css': return `CSS built from stable attributes`;
    case 'xpath': return `XPath built from meaning`;
    case 'domIndex': return p.kind === 'ordinal'
      ? `DOM index — <${p.tag}> number ${(p.index || 0) + 1} of ${p.of} in the document`
      : `DOM index — the child position chain ${p.value}`;
    case 'relativeXPath': return `relative XPath ${p.value}`;
    case 'absoluteXPath': return `absolute XPath from the document root — nothing more stable existed`;
    case 'positional': return `position in the DOM — nothing more stable existed`;
    default: return candidate.strategy;
  }
}

/**
 * Fold the result of running the locator into the score. This is where uniqueness finally counts,
 * and where a locator that finds the WRONG element is destroyed rather than demoted.
 *
 * @param {object} candidate    already carries `score` and `why` from scoreCandidate
 * @param {object} validation   { matches:number, correct:boolean }
 */
function finalScore(candidate, validation) {
  const { matches, correct } = validation;
  if (matches === 0) {
    return { score: 0, rejected: 'matched nothing on the page it was recorded on', verified: false };
  }
  if (correct === false) {
    return { score: 0, rejected: `matched ${matches} element(s), none of them the one that was used`, verified: false };
  }
  if (matches > 1) {
    const penalty = 100 * (matches - 1);
    return {
      score: clamp(candidate.score - penalty),
      rejected: matches > 1 ? `matched ${matches} elements — ambiguous` : undefined,
      verified: false,
    };
  }
  return { score: candidate.score, verified: true };
}

/**
 * The confidence a resolved element is reported with at replay time: how much the locator was
 * trusted, tempered by how much the element still looks like the one that was recorded.
 */
function resolutionConfidence(candidateScore, similarityScore) {
  return clamp(0.6 * candidateScore + 0.4 * similarityScore);
}

module.exports = { BASE, MODIFIERS, baseScore, scoreCandidate, finalScore, resolutionConfidence };
