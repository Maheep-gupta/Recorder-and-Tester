/**
 * Design Studio Tester — execution.
 *
 * Replays a saved test in a BRAND-NEW browser context against whatever the app is serving right
 * now. Nothing from the recording is reused except the saved login. Each step goes through
 * Playwright's ordinary public API, which waits for the element to be attached, visible, stable and
 * enabled before acting. The only pauses in a run are the ones the test asks for: the implicit
 * wait for the data calls each step set off, and the `wait` / `waitForXhr` steps themselves.
 *
 * On the first failing step the run stops and keeps the evidence a developer needs: the error, the
 * URL, a full-page screenshot, console errors and failed requests since the run began, and the
 * duration of every step. All of it lands in `local-tests/runs/<test>/<run>/`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');
const auth = require('./auth');
const steps = require('./steps');
const storage = require('./storage');
const identity = require('./identity');

/**
 * @param test        a test as stored by storage.js
 * @param options     { headed, onProgress(progress), log(line) }
 * @returns result    also written to the run folder
 */
async function runTest(test, { app: appOverride, headed = config.headedRun, onProgress = () => {}, log = () => {} } = {}) {
  const recordedApp = (test.target && test.target.app) || config.defaultApp;
  const app = appOverride || recordedApp;
  const def = config.apps[app];
  if (!def) throw storage.httpError(400, `Unknown app "${app}"`);
  const baseUrl = def.baseUrl;
  // Replaying somewhere other than where it was recorded is a supported thing to do, but the
  // result must SAY so - a pass against QA1 is not evidence about the code on this machine, and
  // a failure may be nothing but different data. Never let a run look like it proved something
  // about an environment it never touched.
  const crossEnv = app !== recordedApp;
  const runId = storage.newRunId();
  const dir = storage.runDir(test.id, runId);
  const startedAt = new Date();
  const total = test.steps.length;

  const result = {
    id: runId,
    testId: test.id,
    testName: test.name,
    app,
    recordedApp,
    crossEnv,
    baseUrl,
    headed,
    status: 'running',        // running · passed · failed · blocked
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: 0,
    stepCount: total,
    steps: [],
    failedStep: null,
    error: null,
    url: null,
    screenshot: null,
    consoleErrors: [],
    networkErrors: [],
    notes: [],
  };
  const progress = (extra) => onProgress({ runId, testId: test.id, status: result.status, total, steps: result.steps, ...extra });

  // ── preflight: app answering? login valid?
  progress({ phase: 'preflight' });
  const ready = await waitForApp(baseUrl, config.appReadyTimeoutMs);
  if (!ready) return finish(result, 'blocked', `${def.label} is not answering at ${baseUrl}. Is the stack up (or ng serve still recompiling)?`, dir, log);
  const session = await auth.ensureSession(app, { log });
  if (!['valid', 'renewed', 'no-auth-needed'].includes(session.status)) {
    return finish(result, 'blocked', `Cannot run while logged out: ${session.message}`, dir, log);
  }
  if (session.status === 'renewed') result.notes.push('Login session was expired and has been renewed.');
  if (crossEnv) {
    const from = (config.apps[recordedApp] && config.apps[recordedApp].label) || recordedApp;
    result.notes.push(`Recorded against ${from}, replayed against ${def.label} (${baseUrl}). Steps follow {{baseUrl}}, but the two environments may not hold the same data.`);
    log(`run: cross-environment replay - recorded on ${recordedApp}, running on ${app}`);
  }

  // ── fresh browser
  const browser = await chromium.launch({ headless: !headed });
  const pages = [];
  try {
    const context = await browser.newContext({ ...auth.storageStateOption(app), viewport: config.viewport });

    // The identity engine has to be present at replay too: the resolver reads each candidate
    // element's identity back out of the page to prove it is the one that was recorded. Without
    // this, resolution would fall back to "it matched exactly one thing, good enough".
    //
    // `_exposeConsoleApi` is a private Playwright method, so it is called only if it is still
    // there: `context._exposeConsoleApi()` on a version that dropped it throws a TypeError
    // SYNCHRONOUSLY, which the trailing `.catch()` never sees, and the whole run dies before the
    // first step on a browser upgrade.
    if (typeof context._exposeConsoleApi === 'function') await context._exposeConsoleApi().catch(() => {});
    // If the library cannot be injected the resolver still works, but it can no longer read an
    // element's identity back to check it is the recorded one — it accepts on uniqueness alone.
    // That is a weaker guarantee than the report otherwise implies, so say so rather than
    // swallowing it.
    await context.addInitScript({ content: identity.SOURCE })
      .catch((e) => { result.notes.push(`The identity library could not be injected (${cleanError(e)}); elements were matched on uniqueness alone.`); });

    // Which of the app's own data calls are in the air right now, per page, and since when.
    // The timestamp is what lets a poll or an open stream be told apart from this step's work.
    const inflight = new WeakMap();

    const attach = (p) => {
      if (pages.includes(p)) return;
      pages.push(p);
      inflight.set(p, new Map());
      p.on('request', (r) => {
        const t = r.resourceType();
        if (t !== 'xhr' && t !== 'fetch') return;
        const m = inflight.get(p);
        if (m) m.set(r, Date.now());
      });
      const settled = (r) => { const m = inflight.get(p); if (m) m.delete(r); };
      p.on('requestfinished', settled);
      p.on('requestfailed', settled);
      p.on('console', (m) => {
        if (m.type() === 'error' && result.consoleErrors.length < 200) {
          result.consoleErrors.push({ at: new Date().toISOString(), step: result.steps.length + 1, text: m.text().slice(0, 1000) });
        }
      });
      p.on('requestfailed', (r) => {
        if (result.networkErrors.length < 200) result.networkErrors.push({ at: new Date().toISOString(), step: result.steps.length + 1, url: safeUrl(r.url()), error: (r.failure() || {}).errorText || 'failed' });
      });
      p.on('response', (r) => {
        if (r.status() >= 400 && result.networkErrors.length < 200) result.networkErrors.push({ at: new Date().toISOString(), step: result.steps.length + 1, url: safeUrl(r.url()), status: r.status() });
      });
    };
    context.on('page', attach);
    const first = await context.newPage();
    attach(first);

    // `acting` is the element the CURRENT step resolved, kept so a failure can be drawn on the
    // evidence screenshot. It is deliberately not on `entry`, which is serialised to JSON.
    const ctx = { context, pages, baseUrl, test, inflight, headed, acting: null };

    for (let i = 0; i < total; i++) {
      const step = test.steps[i];
      // `describe` quotes the value a step types; on a secret step that is a password on its
      // way into result.json. Same treatment as the errors below.
      const entry = { index: i + 1, id: step.id, type: step.type, text: redact(steps.describe(step), step), status: 'running', ms: 0, url: null };
      result.steps.push(entry);
      progress({ phase: 'step', current: i + 1 });
      ctx.acting = null;
      const t0 = Date.now();
      try {
        const outcome = await performStep(step, ctx, entry);
        entry.status = outcome && outcome.skipped ? 'skipped' : 'passed';
        if (outcome && outcome.note) entry.note = outcome.note;
        entry.ms = Date.now() - t0;
        entry.url = steps.templateUrl(currentUrl(pages, step), baseUrl);
      } catch (e) {
        entry.ms = Date.now() - t0;
        entry.status = 'failed';
        entry.error = redact(cleanError(e), step);
        entry.url = steps.templateUrl(currentUrl(pages, step), baseUrl);
        // A resolution failure carries the whole attempt log. This is the difference between
        // "Element not found" and a report that says which strategies were tried and what each
        // one saw — see identity/resolver.js.
        if (e && e.name === 'ResolutionError') {
          entry.resolution = {
            failed: true,
            attempts: e.attempts || [],
            recorded: summariseRecorded(e.recorded),
            suggestion: e.suggestion || null,
          };
        }
        result.failedStep = i + 1;
        result.error = entry.error;
        result.url = currentUrl(pages, step);
        const page = pageFor(ctx, step, false);
        if (page && !page.isClosed()) {
          // The step is already lost, so nothing here can change its outcome — and a screenshot
          // that says WHICH element the runner was aiming at is worth far more than one that
          // leaves you comparing the picture with the step list. Only possible when the element
          // was resolved; a resolution failure has nothing to point at, and says so in the report.
          // Same red outline as every other step — a failure is marked by being LEFT on screen
          // and by the word in its label, not by a second colour scheme.
          if (ctx.acting && ctx.acting.page === page) {
            await showHighlight(page, ctx.acting.locator, { index: i + 1, label: `${step.type} — failed here` });
          }
          const shot = `step-${i + 1}.png`;
          // A full-page shot of a real environment is a picture of real data, and it ends up
          // attached to a ticket. Playwright can paint over the fields that must never travel,
          // so it does — the failure is still legible, the password box is a grey rectangle.
          await page.screenshot({
            path: path.join(dir, shot),
            fullPage: true,
            timeout: 10_000,
            mask: [page.locator('input[type=password], [autocomplete*=password], [data-sensitive]')],
            maskColor: '#111827',
          }).then(() => { result.screenshot = shot; }).catch(() => {});
        }
        break;
      }
    }
    const failed = result.steps.some((s) => s.status === 'failed');
    if (!result.url) result.url = currentUrl(pages, null);
    return finish(result, failed ? 'failed' : 'passed', null, dir, log);
  } finally {
    await browser.close().catch(() => {});
  }
}

function finish(result, status, error, dir, log) {
  result.status = status;
  if (error) result.error = error;
  result.finishedAt = new Date().toISOString();
  result.durationMs = new Date(result.finishedAt) - new Date(result.startedAt);
  if (result.consoleErrors.length) {
    fs.writeFileSync(path.join(dir, 'console.log'), result.consoleErrors.map((c) => `[step ${c.step}] ${c.at} ${c.text}`).join('\n') + '\n');
  }
  storage.saveRun(result.testId, result);
  log(`run ${result.id}: ${status}${result.failedStep ? ` at step ${result.failedStep}` : ''} (${result.durationMs} ms)`);
  return result;
}

// ────────────────────────────────────────────────────────────── one step

async function performStep(step, ctx, entry) {
  const timeout = Number(step.timeoutMs || (ctx.test.settings && ctx.test.settings.stepTimeoutMs) || config.stepTimeoutMs);

  // A wait acts on the run, not on an element and not even on a tab, so it is answered before any
  // page is looked up: a fixed pause must still work after the last tab was closed.
  if (step.type === 'wait') {
    // A nonsense duration is clamped rather than obeyed, and the clamp is WRITTEN DOWN. Silently
    // turning `ms: "banana"` into a zero-length wait, or `ms: 1e12` into a full minute, leaves a
    // report saying the run waited what the step asked for when it did nothing of the kind.
    const asked = Number(step.ms);
    const ok = Number.isFinite(asked) && asked >= 0;
    const ms = ok ? Math.min(MAX_WAIT_MS, Math.round(asked)) : 0;
    if (entry) {
      entry.waitMs = ms;
      if (!ok) entry.note = `"${step.ms}" is not a length of time; waited 0 ms instead.`;
      else if (Math.round(asked) > MAX_WAIT_MS) entry.note = `Asked to wait ${Math.round(asked)} ms; capped at ${MAX_WAIT_MS} ms.`;
    }
    await sleep(ms);
    return;
  }

  if (step.type === 'openPage') {
    // The previous step opened a popup/tab; wait for it if it is not here yet.
    const want = step.page != null ? step.page : ctx.pages.length;
    if (!ctx.pages[want]) await ctx.context.waitForEvent('page', { timeout });
    const p = ctx.pages[want] || ctx.pages[ctx.pages.length - 1];
    await p.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
    return settle(p, step, ctx, entry);
  }

  const page = pageFor(ctx, step, true);

  switch (step.type) {
    case 'waitForXhr': {
      // RECORDER_XHR_WAIT_MS=0 silences the *implicit* wait after every step. A wait the author
      // put in the test on purpose is not implicit, so it falls back to the built-in default
      // rather than to nothing — turning the automatic behaviour off must not quietly delete a
      // step somebody wrote.
      const asked = Number(step.timeoutMs);
      // A timeout the step carries is honoured as written, zero included — that is the author
      // saying "look, but do not linger". Only a missing or nonsensical one falls back. It is
      // still capped: a stray `timeoutMs: 600000` is a typo, not a ten-minute instruction, and a
      // wait that never fails a step must not be able to hold the run open indefinitely either.
      const cap = Math.min(MAX_XHR_WAIT_MS, Number.isFinite(asked) && asked >= 0 ? asked
        : (config.xhrWaitMs > 0 ? config.xhrWaitMs : DEFAULT_XHR_WAIT_MS));
      if (entry && Number.isFinite(asked) && asked > MAX_XHR_WAIT_MS) entry.note = `Asked to wait up to ${Math.round(asked)} ms for the network; capped at ${MAX_XHR_WAIT_MS} ms.`;
      const { ms, settled: quiet, watched } = await waitForActionXhr(page, ctx, cap);
      // Unlike the implicit wait this one always reports, including a zero: the step exists to
      // say "we waited here", and a blank beside it reads as "it did not run".
      if (entry) entry.netWaitMs = ms;
      if (entry && !quiet) addNote(entry, `The app was still fetching data after ${ms} ms; carried on anyway.`);
      else if (entry && !watched && cap > 0) addNote(entry, 'Nothing was in flight.');
      return;
    }
    case 'navigate':
      await page.goto(steps.resolveUrl(step.url, ctx.baseUrl), { timeout: config.navigationTimeoutMs, waitUntil: 'load' });
      // `load` fires when the document is done, which for a single-page app is before it has
      // fetched anything it means to show. This is the step that most needs the wait.
      return settle(page, step, ctx, entry);
    case 'closePage':
      await page.close();
      return;
    case 'expectUrl':
      await page.waitForURL((u) => steps.samePath(u.toString(), steps.resolveUrl(step.url, ctx.baseUrl)), { timeout });
      return settle(page, step, ctx, entry);
    case 'press':
      // A key pressed with nothing focused was recorded without a target; replay it the same way.
      if (!steps.isIdentityTarget(step.target) && !steps.legacyTargetOf(step) && !step.selector && !step.fallbackSelector) {
        await page.keyboard.press(step.key);
        return settle(page, step, ctx, entry);
      }
      break;
    default:
      break;
  }

  // A step type nobody recognises must say so. Falling through to the resolver first reported it
  // as "Step "flibble" has no target", which sends a developer looking for a missing locator when
  // the real problem is a step this version of the runner cannot perform at all.
  if (!ELEMENT_STEPS.has(step.type)) throw new Error(`Unknown step type "${step.type}"`);

  const loc = await resolveTarget(page, step, timeout, entry);
  ctx.acting = { page, locator: loc };
  await flashTarget(page, loc, ctx, step, entry);

  switch (step.type) {
    case 'click':
      await loc.click({ timeout, button: step.button, modifiers: step.modifiers });
      break;
    case 'dblclick':
      await loc.dblclick({ timeout, button: step.button, modifiers: step.modifiers });
      break;
    case 'hover':
      await loc.hover({ timeout });
      break;
    case 'fill':
      await loc.fill(step.value, { timeout });
      break;
    case 'press':
      await loc.press(step.key, { timeout });
      break;
    case 'check':
      await loc.check({ timeout });
      break;
    case 'uncheck':
      await loc.uncheck({ timeout });
      break;
    case 'select':
      await loc.selectOption(step.values, { timeout });
      break;
    case 'upload': {
      const files = (step.files || []).filter((f) => fs.existsSync(f));
      if (!files.length) return { skipped: true, note: 'No file path recorded (browsers hide the path). Add one in the editor.' };
      await loc.setInputFiles(files, { timeout });
      break;
    }
    case 'expectVisible':
      await loc.first().waitFor({ state: 'visible', timeout });
      return;
    case 'expectText': {
      const needle = step.substring === false ? new RegExp(`^\\s*${escapeRegExp(step.text)}\\s*$`) : step.text;
      await loc.filter({ hasText: needle }).first().waitFor({ state: 'attached', timeout });
      return;
    }
    case 'expectValue':
      // The expected value is quoted back so the report says what went wrong — unless the step
      // is marked secret, in which case quoting it back is precisely how a password reaches a
      // result.json and then a shared ticket. A secret step gets the verdict without the value.
      await poll(async () => (await loc.inputValue()) === step.value, timeout,
        step.secret ? 'the value did not match what the step expected' : `value is not "${step.value}"`);
      return;
    case 'expectChecked':
      await poll(async () => (await loc.isChecked()) === (step.checked !== false), timeout, `not ${step.checked === false ? 'unticked' : 'ticked'}`);
      return;
    case 'expectSnapshot':
      return { skipped: true, note: 'Snapshot assertions are not replayed in this version.' };
    default:
      throw new Error(`Unknown step type "${step.type}"`);
  }
  return settle(page, step, ctx, entry);
}

// ────────────────────────────────────────────────────────────── watching a run

/**
 * Show, on the page, which element the step is about to act on.
 *
 * The identity engine exists because the element MOVES: it gets renamed, re-nested, re-ordered,
 * and the resolver's job is to find it anyway. The failure that costs a day is the one where it
 * finds a plausible WRONG element and the step passes. A box that lights up on the row you did
 * not mean turns that into a two-second catch, so a headed replay draws one before every action.
 *
 * The whole thing is built so it cannot possibly change what the step does:
 *   · `position: fixed` on an overlay appended to <html>, never near or inside the target, so no
 *     element moves by a pixel and no scroll position changes;
 *   · `pointer-events: none`, so it is not in the hit-testing path even while it is up;
 *   · and it is REMOVED before the action runs, so it is not on screen at the moment Playwright
 *     decides the element is visible, stable and hittable. The dwell is a flash beforehand, not
 *     an overlay during. Cost: `config.highlightMs` per element step, headed runs only.
 *   · every failure is swallowed. An element that vanished between resolution and highlight is
 *     the step's problem to report, not the decoration's to raise.
 */
const HIGHLIGHT_ID = '__opkeyReplayHighlight';

async function flashTarget(page, locator, ctx, step, entry) {
  if (!ctx.headed || !(config.highlightMs > 0)) return;
  const shown = await showHighlight(page, locator, { index: entry ? entry.index : 0, label: step.type });
  if (!shown) return;
  await sleep(config.highlightMs);
  await clearHighlight(page);
}

async function showHighlight(page, locator, { index, label }) {
  if (!(config.highlightMs > 0)) return false;
  try {
    // Viewport coordinates, which is exactly what `position: fixed` wants — and reading the box
    // is also the cheapest possible check that the element is still on the page and rendered.
    const box = await locator.first().boundingBox({ timeout: 2000 });
    if (!box) return false;
    await page.evaluate(({ box: b, id, text }) => {
      const old = document.getElementById(id);
      if (old) old.remove();
      const marker = document.createElement('div');
      marker.id = id;
      marker.setAttribute('aria-hidden', 'true');
      // `outline` rather than `border`: an outline is painted outside the box and takes part in
      // no layout calculation at all, so even a box measured a pixel off cannot nudge anything.
      // One red line, nothing else — no fill, no glow, no shadow.
      marker.style.cssText = [
        'position:fixed', `left:${b.x}px`, `top:${b.y}px`,
        `width:${b.width}px`, `height:${b.height}px`,
        'outline:1px solid red', 'outline-offset:0', 'background:none', 'border:0',
        'box-shadow:none', 'pointer-events:none', 'z-index:2147483647', 'margin:0', 'padding:0',
      ].join(';');
      // The label is the useful half — "4 · click" on the row you did not mean is the catch.
      // It stays red too: one colour for the whole feature, as asked.
      const tag = document.createElement('div');
      tag.textContent = text;
      tag.style.cssText = [
        'position:absolute', 'left:0', b.y > 16 ? 'top:-15px' : `top:${b.height}px`,
        'font:11px/14px system-ui,-apple-system,Segoe UI,sans-serif', 'color:red',
        'background:none', 'white-space:nowrap', 'pointer-events:none',
      ].join(';');
      marker.appendChild(tag);
      document.documentElement.appendChild(marker);
    }, { box, id: HIGHLIGHT_ID, text: `${index} · ${label}` });
    return true;
  } catch {
    return false;   // gone, detached, or the page is closing. Never the run's problem.
  }
}

async function clearHighlight(page) {
  try {
    await page.evaluate((id) => { const el = document.getElementById(id); if (el) el.remove(); }, HIGHLIGHT_ID);
  } catch { /* the page went away and took the overlay with it */ }
}

/**
 * Find the element this step acts on, on the page as it is RIGHT NOW.
 *
 * A step recorded by the identity engine goes through the resolver, which tries each saved
 * candidate strongest-first and verifies the element it finds still looks like the one recorded.
 * A step from an older test, or one whose identity capture failed, falls back to the single
 * selector Playwright chose at record time — the old behaviour, kept so no existing test breaks.
 */
async function resolveTarget(page, step, timeout, entry) {
  const root = await frameFor(page, step, timeout);

  if (steps.isIdentityTarget(step.target)) {
    const outcome = await identity.resolve(root, step.target, { timeoutMs: Math.min(timeout, config.stepTimeoutMs) });
    if (entry) {
      entry.resolution = {
        strategy: outcome.candidate.strategy,
        locator: outcome.candidate.locator || identity.describeCandidate(outcome.candidate),
        confidence: outcome.confidence,
        similarity: outcome.similarity ? {
          score: outcome.similarity.score,
          matched: outcome.similarity.matched,
          differed: outcome.similarity.differed,
        } : null,
        warning: outcome.warning || null,
        attempts: outcome.attempts,
      };
    }
    return outcome.locator;
  }

  if (entry) entry.resolution = { strategy: 'legacy', locator: step.selector || step.fallbackSelector || null, confidence: null, attempts: [] };
  return steps.locatorFor(root, step);
}

/** When a step was recorded inside an iframe, act inside that frame rather than the top document. */
async function frameFor(page, step, timeout) {
  if (!step.frame) return page;
  const want = step.frame;
  const deadline = Date.now() + Math.min(timeout, 10_000);
  while (Date.now() < deadline) {
    const frames = page.frames();
    const byName = want.name ? frames.find((f) => f.name() === want.name) : null;
    const byUrl = want.url ? frames.find((f) => sameFrameUrl(f.url(), want.url)) : null;
    const found = byName || byUrl;
    if (found) return found;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`The iframe this step was recorded in did not appear (${want.name || want.url}).`);
}

function sameFrameUrl(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}

/** The identity of the element the step expected, trimmed down for the failure report. */
function summariseRecorded(fp) {
  if (!fp) return null;
  const attrs = fp.attrs || {};
  return {
    tag: fp.tag,
    role: fp.role,
    name: fp.name,
    text: fp.text,
    testId: attrs['data-testid'] || attrs['data-test-id'] || attrs['data-qa'] || attrs['data-test'] || null,
    id: attrs.id || null,
    container: ((fp.context || {}).ancestors || []).filter((a) => a.name).map((a) => a.name).slice(0, 2),
    blindSpot: fp.blindSpot || null,
  };
}

/** How often the wait re-reads the in-flight map. Small enough not to be felt, large enough not to spin. */
const XHR_POLL_MS = 25;

/**
 * Wait for THIS action's data calls to finish, or give up quietly.
 *
 * Not "wait for the network to go quiet". An app that polls every 300 ms never leaves a gap
 * longer than the quiet window, so a silence rule never settles and every step burns the full cap
 * — a 300 ms poller turns a twelve-step test into seventy seconds of waiting for nothing. What a
 * step is owed is only the work IT caused, so that is what is watched:
 *
 *   · on entry, snapshot what is already in the air — minus anything already older than
 *     `xhrStaleMs`, which is a poll or an open stream and was never this step's business;
 *   · keep adopting newly started requests, but ONLY during `xhrGraceMs` after entry. The grace
 *     window is what makes this terminate: a poll that starts after it is simply not ours. It is
 *     deliberately NOT re-armed when a watched request finishes — re-arming on completion is how
 *     a chain of polls keeps a step alive forever, which is the bug this replaces;
 *   · abandon a watched request that runs past `xhrStaleMs`, so one long-poll the action happened
 *     to kick off cannot hold the run;
 *   · settle as soon as nothing watched is still in flight AND the grace window has passed.
 *
 * Returns `{ ms, settled, watched }`. It never throws and never fails a step: if the app is still
 * fetching when the cap runs out we carry on and say so, because "the app was still loading" is a
 * useful thing to read next to a failure, not a reason to invent one.
 */
async function waitForActionXhr(page, ctx, capMs) {
  const map = ctx.inflight && ctx.inflight.get(page);
  if (!map || !(capMs > 0)) return { ms: 0, settled: true, watched: 0 };
  const graceMs = Math.max(0, Number(config.xhrGraceMs) || 0);
  const staleMs = Math.max(1000, Number(config.xhrStaleMs) || 15_000);
  const t0 = Date.now();
  const deadline = t0 + capMs;
  const graceUntil = t0 + graceMs;

  // Anything already this old is a poll or an open stream, and no step is ever going to wait for
  // it again. Strike it off the page's map rather than merely skipping it: skipping left every
  // one of them to be re-examined on every 25 ms tick of every later step, and on a long run
  // against an app with a websocket-ish fetch or a dead service being retried, the map only ever
  // grew. Nothing that is dropped here could have been waited for anyway.
  for (const [req, startedAt] of map) if (t0 - startedAt >= staleMs) map.delete(req);

  // request → the moment it started. Only these are waited for; everything else the page is
  // doing belongs to somebody other than this step.
  const watched = new Map();
  for (const [req, startedAt] of map) if (t0 - startedAt < staleMs) watched.set(req, startedAt);

  let seen = watched.size;
  for (;;) {
    const now = Date.now();
    if (now < graceUntil) {
      for (const [req, startedAt] of map) {
        if (watched.has(req) || now - startedAt >= staleMs) continue;
        watched.set(req, startedAt);
        seen++;
      }
    }
    let pending = 0;
    for (const [req, startedAt] of watched) {
      if (!map.has(req)) continue;                                        // finished: the listener removed it
      // A long-poll, not our work. Off the page's map too, for the reason given above.
      if (now - startedAt >= staleMs) { watched.delete(req); map.delete(req); continue; }
      pending++;
    }
    if (pending === 0 && now >= graceUntil) return { ms: now - t0, settled: true, watched: seen };
    // Out of time. `settled` must mean "was the app still fetching", not "did the grace window
    // elapse" — a step given a cap shorter than the grace (waitForXhr with an explicit
    // timeoutMs: 200) would otherwise be reported as still loading when nothing was in flight,
    // and a run must never state something that is not true about the app.
    if (now >= deadline) return { ms: now - t0, settled: pending === 0, watched: seen, pending };
    await new Promise((r) => setTimeout(r, XHR_POLL_MS));
  }
}

/** The cap for one implicit settle: the step's own override, then the test's, then the machine default. */
function xhrCapFor(step, ctx) {
  if (step.xhrWaitMs != null) return Number(step.xhrWaitMs);
  const fromTest = ctx.test.settings && ctx.test.settings.xhrWaitMs;
  if (fromTest != null) return Number(fromTest);
  return Number(config.xhrWaitMs);
}

/**
 * Let the page catch up after an action: reach `load` if the step navigated, then wait for the
 * app's own xhr/fetch to go quiet. Returns undefined so the caller's `return settle(...)` keeps
 * meaning "no special outcome"; what it learned is stamped on `entry`.
 */
async function settle(page, step, ctx, entry) {
  if (step.after && step.after.includes('navigation')) {
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
  }
  const asked = xhrCapFor(step, ctx);
  if (!Number.isFinite(asked) || asked <= 0) return;
  const cap = Math.min(MAX_XHR_WAIT_MS, asked);
  const { ms, settled: quiet } = await waitForActionXhr(page, ctx, cap);
  if (!entry) return;
  if (ms > 0) entry.netWaitMs = ms;
  if (!quiet) addNote(entry, `The app was still fetching data after ${ms} ms; carried on anyway.`);
}

/** A `wait` step is a blunt instrument; a bad value must not be able to hang a whole run. */
const MAX_WAIT_MS = 60_000;
/** What an explicit `waitForXhr` waits when nothing anywhere says otherwise. */
const DEFAULT_XHR_WAIT_MS = 6000;
/** The same protection for a network wait, wherever the cap came from — step, test or config. */
const MAX_XHR_WAIT_MS = 60_000;

/**
 * Step types this runner performs by finding an element first. Anything outside this set and the
 * switches above it is a step the runner does not know, and is reported as exactly that.
 */
const ELEMENT_STEPS = new Set([
  'click', 'dblclick', 'hover', 'fill', 'press', 'check', 'uncheck', 'select', 'upload',
  'expectVisible', 'expectText', 'expectValue', 'expectChecked', 'expectSnapshot',
]);

/** Notes accumulate: a capped wait and a busy network are two separate things to know. */
function addNote(entry, text) {
  if (!entry) return;
  entry.note = entry.note ? `${entry.note} ${text}` : text;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pageFor(ctx, step, strict) {
  const idx = step.page || 0;
  const open = ctx.pages.filter((p) => !p.isClosed());
  const page = ctx.pages[idx] && !ctx.pages[idx].isClosed() ? ctx.pages[idx] : open[open.length - 1];
  if (!page && strict) throw new Error(`Tab ${idx + 1} is not open`);
  return page || null;
}

function currentUrl(pages, step) {
  const open = pages.filter((p) => !p.isClosed());
  const p = (step && pages[step.page || 0] && !pages[step.page || 0].isClosed()) ? pages[step.page || 0] : open[open.length - 1];
  try { return p ? p.url() : ''; } catch { return ''; }
}

async function poll(check, timeout, failText) {
  const end = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < end) {
    try { if (await check()) return; } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timeout ${timeout}ms: ${failText}${lastErr ? ` (${cleanError(lastErr)})` : ''}`);
}

async function waitForApp(baseUrl, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const res = await fetch(baseUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (res.status > 0) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A request URL, safe to write into run evidence.
 *
 * Query strings routinely carry tokens, signatures and session ids, and every failed or 4xx/5xx
 * request goes into `result.json`, which is exactly the file somebody attaches to a ticket. The
 * path is the diagnostic; the query almost never is. Dropping it silently would be dishonest
 * about what was requested, so a `?…` says a query was there and was withheld.
 */
function safeUrl(u) {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname + (x.search ? '?…' : '')).slice(0, 500);
  } catch {
    return String(u).split('?')[0].slice(0, 500);
  }
}

/**
 * Values a step types or asserts, when the step is marked `secret` — a password, a one-time code,
 * an API key. These are the strings that must not reach a run report.
 *
 * The test file itself still holds them; that is storage's business. What is stopped here is the
 * second copy, in the run evidence, which is the copy that gets shared.
 */
function secretsOf(step) {
  if (!step || !step.secret) return [];
  const out = [];
  if (typeof step.value === 'string' && step.value) out.push(step.value);
  if (typeof step.text === 'string' && step.text) out.push(step.text);
  for (const v of (step.values || [])) if (typeof v === 'string' && v) out.push(v);
  return out;
}

/**
 * Strike a secret step's literals out of anything bound for the report.
 *
 * Belt and braces on top of the messages this file writes itself: Playwright quotes what it was
 * given straight back in its own errors (`filter({ hasText: '…' })`), so the value can arrive in
 * an error nobody here composed.
 */
function redact(text, step) {
  let s = String(text == null ? '' : text);
  for (const secret of secretsOf(step)) s = s.split(secret).join('••••••');
  return s;
}

/** Playwright errors carry ANSI colour and a long call log; keep the human part. */
function cleanError(e) {
  const raw = String((e && e.message) || e).replace(/\[[0-9;]*m/g, '');
  const lines = raw.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const cut = lines.findIndex((l) => /^Call log:/i.test(l));
  const keep = cut > 0 ? lines.slice(0, cut) : lines.slice(0, 6);
  const waiting = lines.find((l) => /waiting for/i.test(l));
  if (waiting && !keep.includes(waiting)) keep.push(waiting.trim());
  return keep.join('\n').slice(0, 1500);
}

module.exports = { runTest };
