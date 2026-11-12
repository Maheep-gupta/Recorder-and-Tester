/**
 * Element Identity Engine — the public face.
 *
 * Two calls, one for each half of the tool's life:
 *
 *   buildTarget(page, fingerprint)   record time — signals in, a saved target out
 *   resolve(page, target)            replay time — a saved target in, one live element out
 *
 * Nothing above this file needs to know how a locator is chosen, and nothing below it needs to know
 * what a test or a step is. That separation is the point: the engine can be exercised with a
 * Chromium page and a fixture HTML file, with no server, no storage and no UI in sight.
 */
'use strict';

const { candidatesFor } = require('./candidates');
const { validateCandidates } = require('./validate');
const { describeCandidate } = require('./locators');
const { resolve, ResolutionError } = require('./resolver');
const { SOURCE, installSource, browserLibrary } = require('./browser-lib');

/** The strategies that find an element by WHERE it sits. See CONTRACT.md §3 and §8. */
const POSITIONAL_STRATEGIES = new Set(['domIndex', 'relativeXPath', 'absoluteXPath', 'positional']);

/**
 * Turn one captured element into the `target` that gets saved on a step.
 *
 * @param {import('playwright').Page|import('playwright').Frame} root  where the element lives
 * @param {object} fingerprint  produced in-page by browser-lib
 * @returns {Promise<object>} `{ fingerprint, candidates, primary }`
 */
async function buildTarget(root, fingerprint) {
  if (!fingerprint) return null;
  const raw = candidatesFor(fingerprint);
  const candidates = await validateCandidates(root, raw, fingerprint.uid);
  const primary = candidates.find((c) => c.verified) || candidates[0] || null;

  // The uid is a per-session capture handle, meaningless once the browser closes.
  const saved = { ...fingerprint };
  delete saved.uid;

  return {
    fingerprint: saved,
    candidates,
    primary: primary ? { strategy: primary.strategy, score: primary.score, locator: primary.locator || describeCandidate(primary) } : null,
  };
}

/**
 * A one-line summary for the step list and the inspector, computed rather than stored so it always
 * reflects the candidates actually present.
 */
function summarise(target) {
  if (!target || !target.candidates || !target.candidates.length) return null;
  const best = target.candidates.find((c) => c.verified) || target.candidates[0];
  const fallbacks = target.candidates.filter((c) => c !== best && !c.rejected).length;
  return {
    primary: best.locator || describeCandidate(best),
    strategy: best.strategy,
    score: best.score,
    verified: !!best.verified,
    unproven: best.unproven || null,
    fallbacks,
  };
}

/**
 * Everything a step's target says that a developer should be warned about. Kept here, next to the
 * heuristics that produced the signals, rather than in the UI.
 */
function warningsForTarget(target) {
  const w = [];
  if (!target) return w;
  const fp = target.fingerprint || {};
  const candidates = target.candidates || [];
  const best = candidates.find((c) => c.verified) || candidates[0];

  if (fp.blindSpot) {
    w.push(`This was recorded on ${fp.blindSpot}. Replay can click the same spot but cannot check it is the same thing.`);
  }
  if (!candidates.length) {
    w.push('No locator could be built for this element.');
  } else if (!best || !best.verified) {
    if (best && best.unproven) w.push(`The locator could not be proven unique: ${best.unproven}.`);
    else w.push('No locator matched exactly one element when this was recorded — replay may be ambiguous.');
  }
  if (best && POSITIONAL_STRATEGIES.has(best.strategy)) {
    w.push(`Only a positional locator was available (${best.strategy}). This step will break the moment the layout changes, and replay will refuse it outright if the element it lands on stops being distinguishable from its neighbours.`);
  }
  if (fp.volatileName) {
    w.push(`The accessible name contains ${fp.volatileName} — it will read differently later. Prefer a different locator or loosen the name.`);
  } else if (fp.volatileText && best && best.strategy === 'text') {
    w.push(`The text contains ${fp.volatileText} — this step will stop matching once it changes.`);
  }
  if ((fp.siblings || {}).sameRoleAndName > 1 && best && !best.scope) {
    w.push(`${fp.siblings.sameRoleAndName} elements on the page shared this identity; the locator relies on something else to tell them apart.`);
  }
  return w;
}

module.exports = {
  POSITIONAL_STRATEGIES,
  buildTarget,
  summarise,
  warningsForTarget,
  resolve,
  ResolutionError,
  candidatesFor,
  validateCandidates,
  describeCandidate,
  SOURCE,
  installSource,
  browserLibrary,
};
