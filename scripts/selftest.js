/**
 * Design Studio Tester — self-test against the REAL local app.
 *
 * Proves the whole loop without a human: start a recording, drive the browser with synthetic mouse
 * and keyboard input so the recorder sees it exactly as it sees you, stop, check that the identity
 * engine actually produced validated locators, save the test, reload it, execute it in a fresh
 * browser and report PASS/FAIL.
 *
 *   node scripts/selftest.js            headless-ish, cleans up after itself
 *   node scripts/selftest.js --headed   watch it happen
 *   node scripts/selftest.js --keep     leave the saved test behind
 *
 * Exit codes:  0 pass · 1 the app or the recorder misbehaved · 2 the harness could not run at all
 *              (app down, login broken, browser refused to start)
 *
 * It records against the UI Shell: open a profile, type in the composer. Both are stable surfaces
 * that need no cleanup, and neither sends a chat turn.
 *
 * The fast, offline sibling of this file is `tests/e2e-fixture.test.js`, which proves the
 * identity engine against local HTML fixtures in a few seconds and needs nothing running. Run that
 * one first; this one is the proof that the same engine survives a real Angular application.
 */
'use strict';

const { Recording } = require('../src/recording');
const execution = require('../src/execution');
const storage = require('../src/storage');
const steps = require('../src/steps');
const config = require('../src/config');
const identity = require('../src/identity');

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');
const log = (l) => console.log(`  ${l}`);

/** Anything thrown as this means "could not even run the test" → exit 2, not a failure verdict. */
class HarnessError extends Error {}

(async () => {
  console.log('Design Studio Tester — self-test');
  const baseUrl = config.apps['ui-shell'].baseUrl;
  console.log(`  app: ${baseUrl}   tests: ${storage.TESTS}`);

  // ── 0. is the app even there? A short fetch, so a stopped stack fails in seconds, not minutes.
  console.log('\n[0/5] checking the app is up');
  await requireApp(baseUrl);
  log(`${baseUrl} answered`);

  // ── 1. record
  console.log('\n[1/5] recording');
  const rec = new Recording();
  rec.on('change', (s) => { if (s.status === 'recording') process.stdout.write(`\r  steps: ${s.steps.length}   `); });
  await rec.start({ app: 'ui-shell', headed, log });
  if (!rec.state.captureReady) {
    throw new HarnessError('the identity engine did not attach to the recording browser — nothing this test asserts would mean anything');
  }

  const page = rec.context.pages()[0];
  await page.locator('app-root').waitFor({ timeout: 90_000 });

  // Click the first profile card the way a person would: a real mouse click at its centre.
  const profiles = page.getByRole('region', { name: 'Profiles' });
  await profiles.waitFor({ timeout: 120_000 });
  // The profile cards are the `button.card` elements in that region; the Refresh / New profile /
  // "Actions for …" buttons are not cards. Picking by class here is fine: this is the harness
  // driving the app, not a recorded step.
  const target = profiles.locator('button.card').first();
  await target.waitFor({ timeout: 120_000 });
  console.log(`\n  clicking profile: ${(await target.getAttribute('aria-label')) || (await target.innerText()).split('\n')[0]}`);
  await clickLikeAHuman(page, target);
  await page.waitForURL(/\/profile\//, { timeout: 60_000 });
  await page.waitForTimeout(3000);

  const composer = page.getByRole('textbox', { name: /Start a task in this profile/i });
  await composer.waitFor({ timeout: 60_000 });
  await composer.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await clickLikeAHuman(page, composer);
  await page.keyboard.type('recorder self-test', { delay: 30 });
  await page.waitForTimeout(1200);

  const draft = await rec.stop();
  console.log(`\n  recorded ${draft.steps.length} step(s):`);
  draft.steps.forEach((s, i) => console.log(`    ${i + 1}. ${s.text}${s.warnings.length ? `   [${s.warnings.join('; ')}]` : ''}`));

  // ── 2. what the recorder produced: the actions, and the locators behind them
  console.log('\n[2/5] checking the recording');

  const kinds = new Set(draft.steps.map((s) => s.type));
  assert(kinds.has('click'), 'no click was recorded');
  assert(kinds.has('fill'), 'no fill was recorded');
  const fill = draft.steps.find((s) => s.type === 'fill');
  assert(fill.value === 'recorder self-test', `typing collapsed wrong: "${fill.value}"`);
  assert(draft.steps.filter((s) => s.type === 'press').length === 0, 'typing leaked as key presses');
  log('actions: one click, one fill with the exact text, zero stray presses');

  // Every step that acts on an element should have come back with a real identity target. This is
  // the assertion that would have caught a silently disconnected identity engine.
  const acting = draft.steps.filter((s) => steps.needsTarget(s.type));
  assert(acting.length > 0, 'no step acted on an element');

  const withIdentity = acting.filter((s) => s.target && s.target.fingerprint);
  assert(withIdentity.length > 0,
    `no recorded step carries an identity fingerprint (identityStatus: ${acting.map((s) => s.identityStatus).join(', ')})`);
  log(`identity captured for ${withIdentity.length}/${acting.length} element step(s)`);

  for (const s of withIdentity) {
    const fp = s.target.fingerprint;
    const candidates = s.target.candidates || [];
    assert(candidates.length > 0, `step "${s.text}" saved a fingerprint but no locator candidates`);
    const verified = candidates.filter((c) => c.verified);
    const unproven = candidates.filter((c) => c.unproven);
    // A click that navigates takes its own element away before validation can run; the engine says
    // so explicitly rather than pretending. That is acceptable — silence is not.
    assert(verified.length > 0 || unproven.length > 0,
      `step "${s.text}" has ${candidates.length} candidate(s) and not one of them was verified`
      + ` (${candidates.map((c) => `${c.strategy}: ${c.rejected || 'no reason given'}`).join('; ')})`);
    assert(fp.tag, `step "${s.text}" has a fingerprint with no tag`);
  }
  const proven = withIdentity.filter((s) => (s.target.candidates || []).some((c) => c.verified));
  assert(proven.length > 0,
    'not a single step has a locator that was proven unique and correct against the live DOM'
    + ' — every one of them was recorded on an element that vanished before it could be checked');
  log(`${proven.length}/${withIdentity.length} step(s) have at least one verified locator`);

  // Print what the engine chose, so locator quality is visible rather than merely asserted.
  console.log('\n  what the engine chose for each step:');
  for (const [i, s] of draft.steps.entries()) {
    const line = describeLocator(s);
    console.log(`    ${String(i + 1).padStart(2)}. ${s.type.padEnd(11)} ${line}`);
    const warnings = identity.warningsForTarget(s.target);
    for (const w of warnings) console.log(`        ! ${w}`);
  }

  // ── 3. save, with an assertion appended so replay proves something happened
  console.log('\n[3/5] saving');
  const stepsToSave = draft.steps.map((s) => steps.stripDerived(s));
  // Replay should prove something happened, so assert on the value we typed. The assertion has to
  // aim at the same element the fill did — copy whatever targeting that step actually ended up
  // with, identity target or recorder selector, rather than assuming it has one particular field.
  const assertion = { type: 'expectValue', value: 'recorder self-test' };
  for (const field of ['target', 'legacy', 'selector', 'fallbackSelector', 'frame']) {
    if (fill[field] !== undefined) assertion[field] = fill[field];
  }
  const assertionProblems = steps.validateSteps([assertion]);
  assert(assertionProblems.length === 0,
    `the fill step carries nothing that can be replayed (${assertionProblems.join('; ')}) — `
    + `fields present: ${Object.keys(fill).join(', ')}`);
  stepsToSave.push(assertion);
  if (storage.exists('recorder-self-test')) storage.remove('recorder-self-test');
  const test = storage.create({
    name: 'Recorder self-test',
    description: 'Written by scripts/selftest.js — open a profile and type in the composer.',
    target: { app: 'ui-shell' },
    steps: stepsToSave,
  });
  console.log(`  saved ${storage.TESTS}\\${test.id}.json  (${test.steps.length} steps)`);
  assert(steps.validateSteps(test.steps).length === 0, `saved steps do not validate: ${steps.validateSteps(test.steps).join('; ')}`);
  const reloaded = storage.load(test.id);
  assert(JSON.stringify(reloaded.steps) === JSON.stringify(test.steps), 'reload changed the steps');
  // A target that does not survive JSON is a target that cannot be replayed tomorrow. Check that
  // per step, never by counting steps-with-a-target: the count legitimately goes UP between what
  // was recorded and what is on disk, because the `expectValue` assertion appended above copies
  // the fill step's target so it can aim at the same element. That inherited target is correct
  // and expected — do not re-introduce a count check here, it only ever produced a false failure.
  assert(reloaded.steps.length === stepsToSave.length,
    `${stepsToSave.length} step(s) were saved but ${reloaded.steps.length} came back off disk`);

  // `storage.create()` keeps step order and renumbers ids positionally, so the step saved from
  // draft index i comes back carrying the id `s${i + 1}`. Look each one up by that id rather than
  // trusting array position, so a reordering bug shows up here instead of passing quietly.
  const onDisk = new Map(reloaded.steps.map((s) => [s.id, s]));
  let survived = 0;
  let verifiedOnDisk = 0;
  for (const [i, before] of draft.steps.entries()) {
    if (!before.target || !before.target.fingerprint) continue;
    const id = `s${i + 1}`;
    const label = `step ${id} ("${before.text}")`;
    const after = onDisk.get(id);
    assert(after, `${label} had an identity target but no step with that id came back off disk`);
    assert(after.target && after.target.fingerprint,
      `${label} had an identity target before saving and none after the round trip`);
    assert(JSON.stringify(after.target.fingerprint) === JSON.stringify(before.target.fingerprint),
      `${label} came back off disk describing a different element than the one that was recorded`);

    // The fallbacks are the whole point of keeping a list: losing one silently narrows replay to a
    // single locator, which is exactly the failure the identity engine exists to prevent.
    const wasCandidates = before.target.candidates || [];
    const nowCandidates = after.target.candidates || [];
    assert(JSON.stringify(nowCandidates) === JSON.stringify(wasCandidates),
      `${label} saved ${wasCandidates.length} locator candidate(s) and ${nowCandidates.length} came`
      + ' back, or their contents changed — a candidate that does not survive JSON cannot be replayed');

    const wasVerified = wasCandidates.filter((c) => c.verified).length;
    const nowVerified = nowCandidates.filter((c) => c.verified).length;
    assert(nowVerified === wasVerified,
      `${label} had ${wasVerified} verified candidate(s) before saving and ${nowVerified} after`);
    survived++;
    verifiedOnDisk += nowVerified;
  }
  assert(survived === withIdentity.length,
    `${withIdentity.length} recorded step(s) carried an identity target but only ${survived} of them`
    + ' could be matched to a saved step — the ids on disk do not line up with what was recorded');
  // Verification is the whole value of the engine: it has to survive the write, not just the shape.
  assert(verifiedOnDisk > 0,
    'not one candidate on disk is still marked verified — the verified flag did not survive JSON');

  // The appended assertion step inherits the fill step's target on purpose. Prove it landed and
  // kept it, so the replay in phase 4 is really checking the field we typed into.
  const savedAssertion = onDisk.get(`s${draft.steps.length + 1}`);
  assert(savedAssertion && savedAssertion.type === 'expectValue' && savedAssertion.value === 'recorder self-test',
    'the appended expectValue assertion is not the last step on disk');
  log(`round-trip clean: ${survived} identity target(s) survived JSON with their candidates`
    + ` and ${verifiedOnDisk} verified locator(s) intact`);

  // ── 4. execute in a fresh browser
  console.log('\n[4/5] executing against the CURRENT app');
  const result = await execution.runTest(reloaded, {
    headed,
    log,
    onProgress: (p) => { if (p.current) process.stdout.write(`\r  step ${p.current}/${p.total}   `); },
  });
  console.log('');
  result.steps.forEach((s) => console.log(`    ${s.status === 'passed' ? 'OK  ' : s.status === 'skipped' ? 'skip' : 'FAIL'} ${s.index}. ${s.text}  (${s.ms} ms)`));
  if (result.status === 'blocked') throw new HarnessError(result.error || 'the run was blocked before it started');

  // A resolution failure carries the full attempt log. Print it: it is the whole reason the engine
  // exists, and a self-test that hides it is throwing away the evidence.
  for (const s of result.steps) {
    if (!s.resolution || !s.resolution.failed) continue;
    console.log(`\n  step ${s.index} could not be resolved. What was tried:`);
    for (const a of s.resolution.attempts) {
      console.log(`    ${a.strategy.padEnd(11)} ${String(a.matches === null ? '-' : a.matches).padStart(2)} match(es)  ${a.accepted ? 'ACCEPTED' : a.rejected || ''}`);
      console.log(`      ${a.locator}`);
    }
    if (s.resolution.suggestion) console.log(`    suggestion: ${s.resolution.suggestion}`);
  }

  // ── 5. verdict, and a table a human can scan in two seconds
  console.log('\n[5/5] verdict');
  if (result.status === 'passed') {
    console.log(`  PASSED  ${result.steps.length}/${result.stepCount} steps in ${(result.durationMs / 1000).toFixed(1)} s`);
  } else {
    console.log(`  ${result.status.toUpperCase()}  at step ${result.failedStep}`);
    console.log(`  error: ${(result.error || '').split('\n')[0]}`);
    console.log(`  url:   ${result.url}`);
    if (result.screenshot) console.log(`  shot:  ${storage.RUNS}\\${test.id}\\${result.id}\\${result.screenshot}`);
  }
  console.log(`  console errors during the run: ${result.consoleErrors.length}, failed requests: ${result.networkErrors.length}`);

  printLocatorTable(reloaded.steps);

  if (!keep) { storage.remove(test.id); console.log('\n  cleaned up the self-test test file (--keep to retain)'); }
  process.exit(result.status === 'passed' ? 0 : 1);
})().catch((e) => {
  if (e instanceof HarnessError) {
    console.error(`\nCANNOT RUN: ${e.message}`);
    process.exit(2);
  }
  if (e instanceof AssertionFailure) {
    console.error(`\nSELF-TEST FAILED: ${e.message}`);
    process.exit(1);
  }
  console.error('\nSELF-TEST ERROR:', (e && e.stack) || e);
  process.exit(2);
});

// ────────────────────────────────────────────────────────────────── reporting

/**
 * The whole point of the identity engine on one line per step: what it chose, how much it trusts
 * it, and how many other ways it kept in reserve.
 */
function describeLocator(step) {
  const summary = identity.summarise(step.target);
  if (!summary) {
    if (!steps.needsTarget(step.type)) return '(acts on the page, not an element)';
    return `NO IDENTITY — ${step.identityNote || 'falls back to ' + (step.selector || step.fallbackSelector || 'nothing')}`;
  }
  const mark = summary.verified ? 'verified' : summary.unproven ? `unproven (${summary.unproven})` : 'UNVERIFIED';
  return `${summary.strategy.padEnd(11)} ${String(summary.score).padStart(3)}  ${mark}, ${summary.fallbacks} fallback(s)\n        ${summary.primary}`;
}

/** A table small enough to paste into a bug report. */
function printLocatorTable(savedSteps) {
  console.log('\n  locator quality, step by step');
  console.log('  ┌──────┬─────────────┬─────────────┬───────┬───────────┐');
  console.log('  │ step │ action      │ strategy    │ score │ fallbacks │');
  console.log('  ├──────┼─────────────┼─────────────┼───────┼───────────┤');
  let scored = 0;
  let total = 0;
  for (const [i, s] of savedSteps.entries()) {
    const summary = identity.summarise(s.target);
    const strategy = summary ? summary.strategy : steps.needsTarget(s.type) ? '(none)' : '—';
    const score = summary && summary.score != null ? String(summary.score) : '—';
    const fallbacks = summary ? String(summary.fallbacks) : '—';
    if (summary && typeof summary.score === 'number') { scored += summary.score; total++; }
    console.log(`  │ ${String(i + 1).padStart(4)} │ ${s.type.padEnd(11)} │ ${strategy.padEnd(11)} │ ${score.padStart(5)} │ ${fallbacks.padStart(9)} │`);
  }
  console.log('  └──────┴─────────────┴─────────────┴───────┴───────────┘');
  if (total) console.log(`  mean locator score ${Math.round(scored / total)}/100 across ${total} element step(s)`);
}

// ───────────────────────────────────────────────────────────────── the basics

/**
 * Fail fast and clearly when the app is not running, instead of letting a 90-second element wait
 * time out inside the recorder.
 */
async function requireApp(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(baseUrl, { signal: controller.signal, redirect: 'manual' });
    // Any answer at all proves something is listening — a redirect to Keycloak included.
    if (res.status >= 500) throw new HarnessError(`${baseUrl} answered ${res.status}. The app is up but broken; fix it before recording against it.`);
  } catch (e) {
    if (e instanceof HarnessError) throw e;
    throw new HarnessError(
      `${baseUrl} is not answering (${e.name === 'AbortError' ? 'no response in 5s' : String(e.message || e).split('\n')[0]}).`
      + `\n            Start the stack (or ng serve) first, or point RECORDER_UI_SHELL_URL somewhere that is up.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** A real mouse click at the element's centre, so the recorder captures it as a user click. */
async function clickLikeAHuman(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

class AssertionFailure extends Error {}

function assert(cond, message) {
  if (!cond) throw new AssertionFailure(message);
}
