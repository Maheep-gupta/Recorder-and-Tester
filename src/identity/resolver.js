/**
 * Element Identity Engine — replay resolution.
 *
 * Given a target recorded weeks ago, find the same logical element on the page as it is today, or
 * fail with an explanation a developer can act on in ten seconds.
 *
 * Two rules govern everything here, and both exist to prevent the worst possible outcome — a test
 * that quietly clicks the wrong thing:
 *
 *   1. A candidate that matches more than one element is never resolved by picking one. It is
 *      narrowed by CONTEXT, and if that still leaves a tie, this candidate is abandoned.
 *   2. A candidate that matches exactly one element is still not trusted until that element's
 *      identity is compared with what was recorded.
 *
 * Everything tried is remembered, in order, and travels with the failure. "Element not found" is
 * not an acceptable error message; "the test id matched nothing, role+name matched two, and both
 * were in the wrong section" is.
 */
'use strict';

const { buildLocator, describeCandidate } = require('./locators');
const { compare, verdict } = require('./similarity');
const { resolutionConfidence } = require('./scoring');
const { candidatesFor } = require('./candidates');

/** How long to let the page settle before deciding a candidate matched nothing. */
const ATTACH_WAIT_MS = 4000;
/** A winner among several must beat the runner-up by this much to be considered unambiguous. */
const CLEAR_MARGIN = 15;

/**
 * The positional band and the order it is tried in, AFTER every semantic strategy has failed.
 * 0 means "semantic" — tried first, on score. 1, 2, 3 are the fallbacks the user asked for, in the
 * order they asked for them: the DOM index, then a relative XPath, then the absolute one.
 */
const POSITIONAL_TIER = { domIndex: 1, relativeXPath: 2, absoluteXPath: 3 };

/** Which band a candidate belongs to. Legacy `positional` targets are placed by their kind. */
function positionalTier(c) {
  if (!c) return 0;
  if (c.strategy === 'positional') return c.params && c.params.kind === 'xpath' ? 3 : 1;
  return POSITIONAL_TIER[c.strategy] || 0;
}

/** Was this candidate found by WHERE the element sits rather than by WHAT it is? */
function isPositional(c) {
  return positionalTier(c) > 0;
}

class ResolutionError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ResolutionError';
    Object.assign(this, detail);
  }
}

/**
 * @param {import('playwright').Page|import('playwright').Frame} root
 * @param {object} target   `{ fingerprint, candidates }` as stored on the step
 * @param {object} options  `{ timeoutMs, log }`
 * @returns {Promise<{locator, candidate, confidence, similarity, attempts, warning}>}
 */
async function resolve(root, target, options = {}) {
  const timeoutMs = options.timeoutMs || ATTACH_WAIT_MS;
  const recorded = target && target.fingerprint;
  const attempts = [];

  const candidates = usableCandidates(target);
  if (!candidates.length) {
    throw new ResolutionError('This step has no locator candidates saved for it.', {
      attempts, recorded, suggestion: 'Re-record this step: it was saved by an older version of the recorder.',
    });
  }

  // The first candidate is given the full timeout so the page has a chance to finish rendering.
  // The rest are cheap: if the DOM is ready for one, it is ready for all.
  let budget = timeoutMs;

  // If the first semantic candidate matches nothing, the wait budget is SHARED by the whole
  // semantic band rather than spent on that one candidate: keep re-counting every semantic
  // candidate until one of them matches or the budget is gone. Only then does the loop below
  // fall through to the later candidates and the positional band.
  const semantic = candidates.filter((c) => !isPositional(c));
  if (semantic.length && !isPositional(candidates[0])) {
    const locators = [];
    for (const c of semantic) { try { locators.push(buildLocator(root, c)); } catch (e) { /* reported in the loop */ } }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let any = false;
      for (const l of locators) {
        try { if (await l.count() > 0) { any = true; break; } } catch (e) { /* page busy: count again */ }
      }
      if (any || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    budget = 250;
  }

  for (const candidate of candidates) {
    const attempt = {
      order: attempts.length + 1,
      strategy: candidate.strategy,
      // 'semantic' or 'positional' — so the failure report shows at a glance that every way of
      // NAMING the element was exhausted before any way of LOCATING it was tried.
      band: isPositional(candidate) ? 'positional' : 'semantic',
      locator: candidate.locator || describeCandidate(candidate),
      score: candidate.score,
      why: candidate.why,
      matches: null,
      similarity: null,
      rejected: null,
      accepted: false,
    };
    attempts.push(attempt);

    let locator;
    try {
      locator = buildLocator(root, candidate);
    } catch (e) {
      attempt.rejected = `could not be built: ${short(e)}`;
      continue;
    }

    // Give the DOM a moment to produce at least one match, then stop waiting.
    const count = await countWithWait(locator, budget);
    budget = 250;
    attempt.matches = count;

    if (count === 0) {
      attempt.rejected = 'matched nothing on the page';
      continue;
    }

    if (count === 1) {
      const checked = await verifyOne(locator, recorded, candidate);
      attempt.similarity = checked.similarity;
      if (checked.accept) {
        attempt.accepted = true;
        return finish(locator, candidate, checked, attempts);
      }
      attempt.rejected = checked.why;
      continue;
    }

    // ── more than one match: narrow by context, never by index
    const narrowed = await narrowByContext(root, candidate, recorded, locator);
    attempt.narrowedTo = narrowed.count;
    if (narrowed.locator) {
      const checked = await verifyOne(narrowed.locator, recorded, candidate);
      attempt.similarity = checked.similarity;
      attempt.rejected = checked.accept ? null : checked.why;
      if (checked.accept) {
        attempt.accepted = true;
        attempt.note = narrowed.note;
        return finish(narrowed.locator, candidate, checked, attempts, narrowed.note);
      }
      continue;
    }

    // ── still several: rank them by how much each looks like what was recorded
    const ranked = await rankMatches(locator, recorded, count);
    attempt.ranking = ranked.map((r) => ({ index: r.index, similarity: r.similarity.score, name: r.live && r.live.name }));
    const best = ranked[0];
    const second = ranked[1];
    if (isPositional(candidate)) {
      // Several elements answered to a POSITION. Picking the most similar of them would be exactly
      // the arbitrary pick this engine refuses to make, and similarity cannot break the tie: the
      // reason there are several is that they look alike.
      attempt.rejected = `matched ${count} elements by position — a position that matches more than one element identifies nothing`;
      continue;
    }
    if (best && best.similarity.score >= 70 && (!second || best.similarity.score - second.similarity.score >= CLEAR_MARGIN)) {
      const chosen = locator.nth(best.index);
      attempt.accepted = true;
      attempt.note = `${count} elements matched; one was a clearly better match for the recorded identity`;
      return finish(chosen, candidate, { accept: true, similarity: best.similarity, why: attempt.note }, attempts, attempt.note);
    }
    attempt.rejected = best
      ? `matched ${count} elements and none stood out (best ${best.similarity.score}%, next ${second ? second.similarity.score : 0}%) — refusing to guess`
      : `matched ${count} elements — refusing to guess`;
  }

  const tried = attemptLog(attempts);
  const NL = String.fromCharCode(10);
  throw new ResolutionError(describeFailure(recorded, attempts) + NL
    + "Tried " + attempts.length + " locator strategies, in order:" + NL + tried.join(NL), {
    attempts,
    tried,
    recorded,
    suggestion: suggest(attempts, recorded),
  });
}

function finish(locator, candidate, checked, attempts, note) {
  return {
    locator,
    candidate,
    similarity: checked.similarity,
    confidence: resolutionConfidence(candidate.score || 0, checked.similarity ? checked.similarity.score : 0),
    attempts,
    warning: checked.warn ? checked.why : (note || null),
  };
}

/**
 * Only candidates that were sound when the test was made are worth replaying, and the ORDER they
 * are tried in is a safety property, not an optimisation.
 *
 *  1. A candidate that matched NOTHING at record time and was rejected for it is dropped. It was
 *     already proven not to work on the very page it was born on.
 *
 *  2. Every semantic strategy is tried first, best score first. Only when all of them have failed
 *     does the positional band run, and it runs in a fixed order: `domIndex`, then
 *     `relativeXPath`, then `absoluteXPath`. Sorting on score alone is not enough to guarantee
 *     this: an ambiguous semantic candidate is floored to 0 by `finalScore`, so a fallback
 *     scoring 12 would jump ahead of it and resolve before the resolver's refuse-to-guess logic
 *     was ever reached. Hence the explicit tier.
 *
 * What is NOT done here any more: positional candidates used to be DELETED outright when the
 * recorded element was ambiguous. They are now tried — the user asked for the fallbacks to be
 * tried — but the safety they were protecting has not been given up, it has been moved to where
 * it belongs. A positional match is never acted on until similarity.compare() has confirmed the
 * element found is still the recorded one, and `positionalIdentityGate()` refuses it outright
 * when the element it landed on is indistinguishable from its neighbours TODAY, which is the case
 * the old deletion existed to cover. Refusing to guess is still the feature; it is simply refused
 * on evidence from the live page rather than assumed from the recording.
 */
function usableCandidates(target) {
  const list = (target && target.candidates) || [];
  const usable = list.filter((c) => c && c.strategy && !(c.matches === 0 && c.rejected));

  if (usable.length) {
    return usable.slice().sort((a, b) => {
      const ta = positionalTier(a);
      const tb = positionalTier(b);
      if (ta !== tb) return ta - tb;
      return (b.score || 0) - (a.score || 0);
    });
  }
  // A target saved without candidates (hand-written, or an older test): derive them on the fly.
  const derived = target && target.fingerprint ? candidatesFor(target.fingerprint) : [];
  return derived.slice().sort((a, b) => {
    const ta = positionalTier(a);
    const tb = positionalTier(b);
    if (ta !== tb) return ta - tb;
    return (b.score || 0) - (a.score || 0);
  });
}

/** Did other elements on the recorded page share this element's identity? */
function recordedAmbiguous(fp) {
  const sib = (fp && fp.siblings) || {};
  return (sib.sameRoleAndName || 0) > 1 || (sib.sameText || 0) > 1;
}

async function countWithWait(locator, timeoutMs) {
  try {
    await locator.first().waitFor({ state: 'attached', timeout: timeoutMs });
  } catch (e) {
    // Not attached in time. It may still match zero — count() below reports the truth.
  }
  try {
    return await locator.count();
  } catch (e) {
    return 0;
  }
}

/** Read the identity of a matched element using the same extractor that recorded it. */
async function liveFingerprint(locator) {
  try {
    return await locator.evaluate((el) => (window.__opkeyRec ? window.__opkeyRec.fingerprintLive(el) : null));
  } catch (e) {
    return null;
  }
}

async function verifyOne(locator, recorded, candidate) {
  if (!recorded) return { accept: true, similarity: null, why: 'no recorded fingerprint to compare against' };
  const live = await liveFingerprint(locator);
  if (!live) {
    // The identity library is not present in this frame. Uniqueness is all a semantic locator
    // needs — it named the element, and exactly one element answered to that name.
    //
    // A POSITIONAL locator named nothing. All it did was walk to a place, so "one element is
    // there" says nothing whatsoever about which element it is, and without a live fingerprint
    // there is no way to find out. That is a refusal, not a caveat.
    if (isPositional(candidate)) {
      return {
        accept: false,
        similarity: null,
        why: 'found by position, but the element identity could not be read, so it could not be checked against the recording — refusing to act on a position alone',
      };
    }
    return { accept: true, similarity: null, why: 'could not read the element identity — accepted on uniqueness alone' };
  }
  const similarity = compare(recorded, live);
  const v = verdict(similarity, candidate);
  if (!v.accept) return { accept: false, warn: v.warn, why: v.why, similarity, live };

  // The identity check above is what makes trying the positional band safe, and it is not
  // relaxed for it: a fatal verdict (a test id or an id that disagrees, tag AND role changed, or
  // an unanchored element whose name became something unrelated) has already refused by here, and
  // the 40–69 similarity band cannot rescue a positional candidate either — verdict() only
  // forgives that band for a candidate scoring >= 85, and nothing positional scores above 12.
  if (isPositional(candidate)) {
    const gate = positionalIdentityGate(recorded, live);
    if (!gate.accept) return { accept: false, why: gate.why, similarity, live };
    if (gate.warn) return { accept: true, warn: true, why: `${v.why} — ${gate.why}`, similarity, live };
  }
  return { accept: v.accept, warn: v.warn, why: v.why, similarity, live };
}

/**
 * The last gate in front of a positional match, and the one that keeps the original promise:
 * **never silently click the wrong element.**
 *
 * similarity.compare() answers "does the thing standing here still look like what I recorded?".
 * On a page where three buttons are identical, it answers YES for all three — so on its own it
 * cannot stop a shifted index from landing on the wrong twin. This gate asks the second question:
 * *is the element it found distinguishable from its neighbours at all, right now?* If the live
 * page says other elements share its role+name or its text, then position was the only thing
 * telling them apart, position is the one signal this engine does not trust, and the honest
 * answer is to fail with an explanation.
 *
 * When the element was ambiguous when RECORDED but is unique today, the match is allowed and
 * carries a warning: it is verifiable now, but the recording it is being checked against was not.
 */
function positionalIdentityGate(recorded, live) {
  const liveSib = (live && live.siblings) || {};
  const twins = Math.max(liveSib.sameRoleAndName || 0, liveSib.sameText || 0);
  if (twins > 1) {
    return {
      accept: false,
      why: `found by position, but ${twins} elements on this page share its identity — position is the only thing telling them apart, and that is not something this engine will guess at`,
    };
  }
  if (recordedAmbiguous(recorded)) {
    const sib = (recorded && recorded.siblings) || {};
    const then = Math.max(sib.sameRoleAndName || 0, sib.sameText || 0);
    return {
      accept: true,
      warn: true,
      why: `resolved by position: ${then} elements shared this identity when it was recorded, and only one does now`,
    };
  }
  return { accept: true };
}

/**
 * Ambiguity is resolved with the element's SURROUNDINGS, which is exactly how a person would do it:
 * "the Save button — no, the one in Customer Details".
 */
async function narrowByContext(root, candidate, recorded, wideLocator) {
  const ancestors = (recorded && recorded.context && recorded.context.ancestors) || [];
  for (const a of ancestors) {
    const scope = scopeFor(a);
    if (!scope) continue;
    let scoped;
    try {
      scoped = buildLocator(root, { ...candidate, scope });
    } catch (e) {
      continue;
    }
    let count = 0;
    try { count = await scoped.count(); } catch (e) { continue; }
    if (count === 1) {
      return { locator: scoped, count, note: `narrowed to ${describeCandidate(scope)} — the container it was recorded in` };
    }
  }
  return { locator: null, count: null };
}

function scopeFor(a) {
  if (a.testid) return { strategy: 'testid', params: { value: a.testid, attr: a.testidAttr || 'data-testid' } };
  if (a.id) return { strategy: 'id', params: { value: a.id } };
  if (a.role && a.name) return { strategy: 'role', params: { role: a.role, name: a.name, exact: true } };
  return null;
}

/** Compare every match against the recorded identity. Bounded: a page with 50 matches is a bug. */
async function rankMatches(locator, recorded, count) {
  const out = [];
  const limit = Math.min(count, 12);
  for (let i = 0; i < limit; i++) {
    const live = await liveFingerprint(locator.nth(i));
    out.push({ index: i, live, similarity: live ? compare(recorded, live) : { score: 0, matched: [], differed: [], fatal: true, reason: 'unreadable' } });
  }
  return out.sort((a, b) => b.similarity.score - a.similarity.score);
}

// ────────────────────────────────────────────────────────────── failure reporting

/**
 * Every strategy that was tried, in the order it was tried, and what became of it — one line each.
 *
 * This is the whole point of keeping the attempt log: "element not found" is not a bug report.
 * The band is printed alongside the name so the sequence reads as what it is — every way of
 * NAMING the element first, then domIndex, relativeXPath and absoluteXPath as the last resort —
 * and a match that was FOUND and then turned down is spelled out as such, because that sentence
 * ("the absolute XPath found a button and it was a different button") is the one that ends the
 * investigation.
 */
function attemptLog(attempts) {
  return attempts.map((a) => {
    const n = String(a.order || 0).padStart(2, ' ');
    const found = a.matches === null ? 'not reached' : `${a.matches} match${a.matches === 1 ? '' : 'es'}`;
    const outcome = a.accepted ? 'ACCEPTED' : (a.rejected || (a.matches === 0 ? 'matched nothing' : 'no verdict recorded'));
    const sim = a.similarity ? ` [identity ${a.similarity.score}%${a.similarity.fatal ? ', FATAL' : ''}]` : '';
    return `  ${n}. ${String(a.band || 'semantic').padEnd(10)} ${String(a.strategy).padEnd(14)} ${a.locator} → ${found}${sim} — ${outcome}`;
  });
}

function describeFailure(recorded, attempts) {
  const what = recorded
    ? `${recorded.role || recorded.tag}${recorded.name ? ` "${recorded.name}"` : ''}`
    : 'the recorded element';
  const zero = attempts.filter((a) => a.matches === 0).length;
  const many = attempts.filter((a) => a.matches > 1);
  const wrong = attempts.filter((a) => a.matches === 1 && a.rejected);

  if (many.length && !wrong.length && zero < attempts.length) {
    return `Could not uniquely identify ${what}: ${many[0].matches} elements matched and none was clearly the recorded one.`;
  }
  if (wrong.length) {
    return `Found an element for ${what}, but it is not the one that was recorded: ${wrong[0].rejected}`;
  }
  return `Could not find ${what}. ${attempts.length} locator strategies were tried and none matched.`;
}

function suggest(attempts, recorded) {
  const many = attempts.find((a) => a.matches > 1);
  if (many) return 'Give the element or its container a stable identifier (a data-testid or an aria-label), or record the step again now that the page has more content.';
  const wrong = attempts.find((a) => a.matches === 1 && a.rejected && /test id changed|id changed/.test(a.rejected || ''));
  if (wrong) return 'The element at this position is a different one now. If the change was intentional, re-record this step.';
  const positionalRefused = attempts.find((a) => a.band === 'positional' && a.matches === 1 && a.rejected);
  if (positionalRefused) return `The fallbacks found an element where this one used to be, but it is not the same element (${positionalRefused.strategy}: ${positionalRefused.rejected}). Give it a stable identifier, or re-record the step.`;
  if (recorded && recorded.blindSpot) return `This step was recorded on ${recorded.blindSpot}, which cannot be located reliably. Consider asserting on something else.`;
  return 'The element is gone from the page. Check the app reached the state the test expects, then re-record this step if the UI genuinely changed.';
}

function short(e) {
  return String((e && e.message) || e).split('\n')[0].slice(0, 160);
}

module.exports = { resolve, ResolutionError, ATTACH_WAIT_MS, POSITIONAL_TIER, positionalTier, isPositional };
