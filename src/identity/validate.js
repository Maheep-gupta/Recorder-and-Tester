/**
 * Element Identity Engine — record-time validation.
 *
 * A locator is not good because it looks good. It is good because it was run against the very DOM
 * the user was standing on and came back with exactly one element, and that element was the one
 * they touched.
 *
 * That last clause is what makes this file worth having. Plenty of tools check uniqueness; a
 * selector that uniquely matches the WRONG element is the failure mode that produces a test which
 * passes while doing something else entirely. We can detect it here because at capture time we
 * stamped the real element with a uid, so we can ask each candidate's matches who they are.
 */
'use strict';

const { buildLocator, describeCandidate } = require('./locators');
const { finalScore } = require('./scoring');

/** Never spend longer than this proving one candidate; there are always others. */
const PER_CANDIDATE_TIMEOUT_MS = 1500;
/** Beyond this many verified candidates the rest add nothing but file size. */
const KEEP_VERIFIED = 6;
/**
 * The positional band is kept SEPARATELY from the six, and that is not a rounding-up of the cap.
 * Pruning by score alone deleted it every time: five fallbacks scoring 12, 12, 10, 10 and 6 sort
 * below every semantic candidate, so a page with six good ways of naming its button saved none of
 * the ways of finding it. They are the last resort — the only thing left when every name has been
 * rewritten — so they are exactly the candidates that must not be thrown away for being weak.
 * Five is the whole band: two DOM indexes, two relative XPaths, one absolute XPath.
 */
const KEEP_POSITIONAL = 5;
const KEEP_TOTAL = 10;

/** Strategies that find an element by WHERE it sits rather than by WHAT it is. CONTRACT.md §3. */
const POSITIONAL_STRATEGIES = new Set(['domIndex', 'relativeXPath', 'absoluteXPath', 'positional']);

/**
 * Run every candidate against the live page and record what happened.
 *
 * @param {import('playwright').Page|import('playwright').Frame} root
 * @param {Array} candidates  from candidatesFor()
 * @param {string} uid        the `__recUid` of the element that was actually interacted with
 * @returns {Promise<Array>}  the same candidates, each with matches/correct/verified/score/rejected
 */
async function validateCandidates(root, candidates, uid) {
  const out = [];
  for (const candidate of candidates) {
    const result = await runOne(root, candidate, uid);
    out.push(result);
  }

  // A click that navigates, closes a dialog or re-renders a list takes the element with it, and by
  // the time we get here there is nothing left to validate against. That is not evidence the
  // locators are bad — so rather than saving a step whose every candidate is marked "rejected",
  // detect the situation and save them unproven, with the reason attached.
  if (uid && !out.some((c) => c.correct) && !(await elementStillPresent(root, uid))) {
    return prune(candidates.map((c) => ({
      ...c,
      locator: describeCandidate(c),
      matches: null,
      correct: null,
      verified: false,
      unproven: 'the page changed before this locator could be checked',
      rejected: null,
    })).sort((a, b) => b.score - a.score || rank(a) - rank(b)));
  }

  out.sort((a, b) => b.score - a.score || rank(a) - rank(b));
  return prune(out);
}

/** Is the element the user touched still in this document at all? */
async function elementStillPresent(root, uid) {
  try {
    return await withTimeout(root.evaluate((wanted) => {
      const walk = (docRoot) => {
        const all = docRoot.querySelectorAll('*');
        for (const el of all) {
          if (el.__recUid === wanted) return true;
          if (el.shadowRoot && walk(el.shadowRoot)) return true;
        }
        return false;
      };
      return walk(document);
    }, uid), PER_CANDIDATE_TIMEOUT_MS);
  } catch (e) {
    return false;
  }
}

async function runOne(root, candidate, uid) {
  const c = { ...candidate, locator: describeCandidate(candidate) };
  let locator;
  try {
    locator = buildLocator(root, candidate);
  } catch (e) {
    return { ...c, matches: 0, correct: false, verified: false, score: 0, rejected: `could not be built: ${short(e)}` };
  }

  let uids;
  try {
    // One round trip answers both questions: how many matched, and were any of them the element
    // the user touched. `evaluateAll` never waits, which is what we want — the DOM is right here.
    uids = await withTimeout(locator.evaluateAll((els) => els.map((e) => e.__recUid || null)), PER_CANDIDATE_TIMEOUT_MS);
  } catch (e) {
    return { ...c, matches: 0, correct: false, verified: false, score: 0, rejected: `could not be evaluated: ${short(e)}` };
  }

  const matches = uids.length;
  const correct = uid ? uids.indexOf(uid) >= 0 : matches === 1;
  const folded = finalScore(candidate, { matches, correct });

  return {
    ...c,
    matches,
    correct,
    verified: !!folded.verified,
    score: folded.score,
    rejected: folded.rejected || null,
  };
}

/**
 * Keep the strongest verified candidates plus a couple of honest failures. Storing the rejects
 * matters: when replay fails later, "we tried the test id and it matched nothing" is the sentence
 * that tells a developer what changed.
 */
function prune(list) {
  const verified = list.filter((c) => c.verified && !POSITIONAL_STRATEGIES.has(c.strategy)).slice(0, KEEP_VERIFIED);
  const positional = list.filter((c) => c.verified && POSITIONAL_STRATEGIES.has(c.strategy)).slice(0, KEEP_POSITIONAL);
  const kept = verified.concat(positional);
  const rest = list.filter((c) => !c.verified).slice(0, Math.max(2, KEEP_TOTAL - kept.length));
  return kept.concat(rest);
}

/** Stable tie-break so two runs of the recorder produce byte-identical tests. */
const ORDER = ['testid', 'id', 'role', 'label', 'attr', 'placeholder', 'altText', 'title', 'text', 'css', 'xpath',
  'domIndex', 'relativeXPath', 'absoluteXPath', 'positional'];
function rank(c) {
  const i = ORDER.indexOf(c.strategy);
  return i < 0 ? ORDER.length : i;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

function short(e) {
  return String((e && e.message) || e).split('\n')[0].slice(0, 160);
}

module.exports = { validateCandidates, PER_CANDIDATE_TIMEOUT_MS };
