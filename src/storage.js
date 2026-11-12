/**
 * Replayr — storage.
 *
 * Tests are JSON files, one per test, in the launcher's `local-tests/` folder. Run evidence goes to
 * `local-tests/runs/<test-id>/<run-id>/` (result.json, screenshot, console log). No database: a
 * developer can read, diff, copy and hand-write everything here.
 *
 * Test file shape:
 *   { id, name, description, target: { app }, settings: { stepTimeoutMs? }, schemaVersion: 2,
 *     bug?: { expected, actual, severity }, createdAt, updatedAt,
 *     tags: [...], folder: null, favorite: false,
 *     steps: [...], lastRun: { runId, status, failedStep?, at, durationMs } }
 */
'use strict';

const fs = require('fs');
const { renameSyncRetry } = require('./fsutil');
const path = require('path');
const config = require('./config');
const steps = require('./steps');
const urlsafety = require('./urlsafety');
const targets = require('./targets');

const TESTS = config.testsDir;
const RUNS = path.join(TESTS, 'runs');
/** Deleted tests land here rather than being unlinked. See remove(). */
const TRASH = path.join(TESTS, '.trash');

function ensureDirs() {
  fs.mkdirSync(RUNS, { recursive: true });
}

/** "Customer Bug #123" → "customer-bug-123". */
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'test';
}

const testFile = (id) => path.join(TESTS, `${safeId(id)}.json`);

function safeId(id) {
  const s = String(id || '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) throw httpError(400, `Bad test id "${s}"`);
  return s;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSyncRetry(tmp, file);
}

// ────────────────────────────────────────────────────────────── tests

function list() {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(TESTS)) {
    if (!isTestFileName(f)) continue;
    try {
      const t = readJson(path.join(TESTS, f));
      out.push(summary(t));
    } catch (e) {
      out.push({ id: f.replace(/\.json$/, ''), name: f, broken: String(e.message) });
    }
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

function summary(t) {
  return {
    id: t.id, name: t.name, description: t.description || '', target: t.target,
    stepCount: (t.steps || []).length, createdAt: t.createdAt, updatedAt: t.updatedAt, lastRun: t.lastRun || null,
    tags: t.tags || [], folder: t.folder || null, favorite: !!t.favorite,
    bug: t.bug || null,
  };
}

const SEVERITIES = ['low', 'medium', 'high', 'critical'];

/**
 * Optional bug metadata: { expected, actual, severity }. Strings are trimmed and capped at 2000
 * characters; severity must be one of SEVERITIES. Nothing meaningful => null.
 */
function normaliseBug(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'bug must be an object');
  const text = (v, what) => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') throw httpError(400, `bug.${what} must be a string`);
    return v.trim().slice(0, 2000);
  };
  const bug = { expected: text(value.expected, 'expected'), actual: text(value.actual, 'actual') };
  if (value.severity !== undefined && value.severity !== null && value.severity !== '') {
    if (!SEVERITIES.includes(value.severity)) throw httpError(400, `bug.severity must be one of ${SEVERITIES.join(', ')}`);
    bug.severity = value.severity;
  }
  return bug.expected || bug.actual || bug.severity ? bug : null;
}

/** Tags are a tidy little set: trimmed, no blanks, no duplicates, at most 20 × 40 characters. */
function normaliseTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw httpError(400, 'tags must be an array of strings');
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw httpError(400, 'tags must be an array of strings');
    const tag = raw.trim().slice(0, 40);
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length === 20) break;
  }
  return out;
}

/** A folder is one plain label, or nothing at all. Blank means nothing. */
function normaliseFolder(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw httpError(400, 'folder must be a string or null');
  return value.trim().slice(0, 80) || null;
}

function load(id) {
  const file = testFile(id);
  if (RESERVED_IDS.has(String(id)) || !fs.existsSync(file)) throw httpError(404, `No test "${id}"`);
  return readJson(file);
}

/**
 * Files in the tests folder that are NOT tests: the environments store and the recorder's draft
 * (a dot-file). An id that would land on one of them is treated as taken, so a test named
 * "Environments" becomes `environments-2` instead of overwriting the store.
 */
const RESERVED_IDS = new Set(['environments']);
function isTestFileName(f) {
  if (!f.endsWith('.json') || f.startsWith('.')) return false;
  return !RESERVED_IDS.has(f.slice(0, -'.json'.length));
}
function exists(id) {
  return RESERVED_IDS.has(String(id)) || fs.existsSync(testFile(id));
}

/** Create from a draft. Picks a unique id from the name. */
/**
 * The `target.app` to store. A URL (bare or `url:`) is validated and canonicalised — one that
 * matches a configured app becomes that app's key. An unrecognised plain key is kept as-is, so a
 * test imported from a machine with other apps configured still saves; it fails at run time with
 * "Unknown app" instead.
 */
function targetKey(app) {
  let def;
  try { def = targets.resolve(app); } catch (e) { throw httpError(400, e.message); }
  return def ? def.key : String(app);
}

/**
 * A step marked `secret` never keeps its typed value on disk. Replay never types a secret value
 * (it fills ''), so the plaintext has no use — keeping it would only leak it into the JSON, an
 * export, or a backup. The recorder already blanks it; this is the second line of defence for
 * imports, hand-edits and API callers.
 */
function scrubSecrets(list) {
  return (list || []).map((s) => {
    if (!s || s.secret !== true) return s;
    const out = { ...s };
    if (out.value !== undefined) out.value = '';
    if (out.values !== undefined) out.values = [];
    return out;
  });
}

function create({ name, description, target, steps: draftSteps, settings, tags, folder, favorite, bug }) {
  ensureDirs();
  if (!name || !String(name).trim()) throw httpError(400, 'A test needs a name');
  const problems = steps.validateSteps(draftSteps);
  if (problems.length) throw httpError(400, problems.join('; '));
  let id = slugify(name);
  for (let n = 2; exists(id); n++) id = `${slugify(name)}-${n}`;
  const now = new Date().toISOString();
  const test = {
    id,
    name: String(name).trim(),
    description: description || '',
    target: { app: targetKey((target && target.app) || config.defaultApp) },
    settings: settings || {},
    tags: normaliseTags(tags),
    folder: normaliseFolder(folder),
    favorite: !!favorite,
    schemaVersion: 2,
    createdAt: now,
    updatedAt: now,
    steps: renumber(scrubSecrets(draftSteps)),
    lastRun: null,
  };
  const bugMeta = normaliseBug(bug);
  if (bugMeta) test.bug = bugMeta;
  writeJson(testFile(id), test);
  return test;
}

/** Replace name/description/steps/settings of an existing test. Id and history stay. */
function update(id, patch) {
  const test = load(id);
  if (patch.name !== undefined) {
    if (!String(patch.name).trim()) throw httpError(400, 'A test needs a name');
    test.name = String(patch.name).trim();
  }
  if (patch.description !== undefined) test.description = patch.description || '';
  if (patch.settings !== undefined) test.settings = patch.settings || {};
  if (patch.target && patch.target.app) test.target = { app: targetKey(patch.target.app) };
  if (patch.tags !== undefined) test.tags = normaliseTags(patch.tags);
  if (patch.folder !== undefined) test.folder = normaliseFolder(patch.folder);
  if (patch.favorite !== undefined) test.favorite = !!patch.favorite;
  if (patch.bug !== undefined) {
    const bugMeta = normaliseBug(patch.bug);
    if (bugMeta) test.bug = bugMeta; else delete test.bug;
  }
  if (patch.steps !== undefined) {
    const problems = steps.validateSteps(patch.steps);
    if (problems.length) throw httpError(400, problems.join('; '));
    test.steps = renumber(scrubSecrets(patch.steps));
  }
  test.schemaVersion = 2;
  test.updatedAt = new Date().toISOString();
  writeJson(testFile(id), test);
  return test;
}

/** Copy a test, steps and all. The copy starts with no history: it has never run. */
function duplicate(id) {
  const original = load(id);
  const name = `${original.name} (copy)`;
  let newId = slugify(name);
  for (let n = 2; exists(newId); n++) newId = `${slugify(name)}-${n}`;
  const now = new Date().toISOString();
  const copy = {
    ...original,
    id: newId,
    name,
    tags: original.tags || [],
    folder: original.folder || null,
    favorite: !!original.favorite,
    schemaVersion: 2,
    createdAt: now,
    updatedAt: now,
    steps: (original.steps || []).map((s) => ({ ...s })),
    lastRun: null,
  };
  writeJson(testFile(newId), copy);
  return copy;
}

/**
 * Save a whole test handed over as JSON — an export from another machine, or a hand-written file.
 * Anything identifying the original is dropped: the id, when it was made, how it last ran. The
 * steps go through the same validation as a freshly recorded draft, so a bad file is refused here
 * rather than at run time.
 */
function importTest(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw httpError(400, 'An import needs a test object');
  if (!obj.name || !String(obj.name).trim()) throw httpError(400, 'The imported test has no name');
  if (!Array.isArray(obj.steps)) throw httpError(400, 'The imported test has no "steps" array');
  // An imported test is untrusted: its absolute URLs must be ordinary web addresses, never a
  // cloud metadata service. (Non-http schemes are already refused by steps.validateSteps.)
  obj.steps.forEach((st, i) => {
    for (const field of ['url', 'at']) {
      const v = st && st[field];
      if (typeof v !== 'string' || !v || v.startsWith('{{baseUrl}}')) continue;
      let host = null;
      try { host = new URL(v).hostname; } catch (e) { continue; }   // validateSteps reports bad URLs
      if (urlsafety.classifyHost(host) === 'metadata') {
        throw httpError(400, `Step ${i + 1}: ${host} is a cloud metadata service address and cannot be imported`);
      }
    }
  });
  return create({
    name: obj.name,
    description: obj.description,
    target: obj.target,
    settings: obj.settings,
    steps: obj.steps,
    tags: obj.tags,
    folder: obj.folder,
    favorite: obj.favorite,
    bug: obj.bug,
  });
}

/**
 * The raw stored test for download. Anything a recorder marked `secret` loses its value, and no
 * credentials ever live in a test, so what is left is safe to hand to another machine.
 */
function exportable(id) {
  const test = load(id);
  const mask = (u) => (typeof u === 'string' ? steps.maskSecretQuery(u) : u);
  test.steps = (test.steps || []).map((s) => {
    if (!s) return s;
    // Tests recorded before URL masking existed may still carry a live token in a query string.
    let out = { ...s };
    if (out.url !== undefined) out.url = mask(out.url);
    if (out.at !== undefined) out.at = mask(out.at);
    if (out.secret === true) { const { value, values, ...rest } = out; out = rest; }
    return out;
  });
  return test;
}

/** How the whole shelf of tests stands. `running` is the server's to fill: only it knows. */
function stats() {
  const out = { total: 0, passed: 0, failed: 0, blocked: 0, neverRun: 0, running: 0 };
  for (const t of list()) {
    out.total++;
    const status = t.lastRun && t.lastRun.status;
    if (status === 'passed') out.passed++;
    else if (status === 'failed') out.failed++;
    else if (status === 'blocked') out.blocked++;
    else out.neverRun++;
  }
  return out;
}

/**
 * Delete a test — recoverably.
 *
 * A recorded test is fifteen minutes of a developer's afternoon that cannot be regenerated from
 * anything else on disk, so nothing here unlinks one outright. The JSON is moved into `.trash/`
 * with a timestamp; the run evidence, which is large and genuinely disposable, is removed.
 *
 * This exists because a test WAS lost during development, to a delete nobody could later account
 * for. One copy in a trash folder makes that unrecoverable-by-accident case impossible, and costs
 * a few kilobytes.
 */
function remove(id) {
  const file = testFile(id);
  // Deleting something that is not there is a mistake worth reporting, not a quiet success: the
  // page would otherwise show "deleted" for a stale row or a mistyped id and the developer would
  // believe it.
  if (RESERVED_IDS.has(String(id)) || !fs.existsSync(file)) throw httpError(404, `No test "${id}"`);
  fs.mkdirSync(TRASH, { recursive: true });
  const stamp = trashStamp(new Date());
  try {
    fs.renameSync(file, path.join(TRASH, `${safeId(id)}--${stamp}.json`));
  } catch (e) {
    // A rename can fail across devices or if the name is taken; a copy still preserves the test.
    fs.copyFileSync(file, path.join(TRASH, `${safeId(id)}--${stamp}.json`));
    fs.unlinkSync(file);
  }
  pruneTrash();
  fs.rmSync(path.join(RUNS, safeId(id)), { recursive: true, force: true });
}

/** `2026-09-11T14-32-05` — an ISO timestamp with the colons taken out, so it can be a filename. */
function trashStamp(date) {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * The deletion time out of a trash filename, as a real ISO string.
 *
 * The filename is `<test-id>--<stamp>.json`, and a test id may itself contain `--` (`aa--bb` is a
 * legal id), so the stamp is taken from the END rather than from `split('--')[1]`. The stamp has
 * `-` where a time has `:`, which `Date.parse` cannot read, so it is put back — otherwise the page
 * renders "Invalid Date" against every recoverable test.
 */
function trashDeletedAt(file) {
  const stamp = String(file).replace(/\.json$/, '').split('--').pop();
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(stamp || '');
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * Keep the 50 most recently deleted tests. Beyond that they are noise.
 *
 * Sorting the filenames sorts by TEST ID first, because that is what a trash filename starts with
 * — so a plain `.sort()` prunes whatever is alphabetically first, which has nothing to do with age.
 * A test deleted a minute ago was being thrown away to keep one deleted last year. The deletion
 * stamp is the only thing that may decide this, and anything without a readable stamp is treated
 * as oldest rather than being silently favoured.
 */
function pruneTrash() {
  try {
    const files = fs.readdirSync(TRASH)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, at: trashDeletedAt(f) || '' }))
      .sort((a, b) => a.at.localeCompare(b.at) || a.f.localeCompare(b.f));
    for (const { f } of files.slice(0, Math.max(0, files.length - 50))) {
      fs.unlinkSync(path.join(TRASH, f));
    }
  } catch (e) { /* the trash is a convenience, never a hard failure */ }
}

/** What is recoverable, newest first. */
function listTrash() {
  if (!fs.existsSync(TRASH)) return [];
  return fs.readdirSync(TRASH)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      let name = f;
      try { name = readJson(path.join(TRASH, f)).name || f; } catch (e) { /* keep the filename */ }
      return { file: f, name, deletedAt: trashDeletedAt(f) };
    })
    .sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')) || String(b.file).localeCompare(String(a.file)));
}

/** Put a deleted test back. Its id is re-minted if something has since taken it. */
function restoreFromTrash(file) {
  if (!/^[\w.-]+\.json$/.test(String(file))) throw httpError(400, 'Bad file name');
  const src = path.join(TRASH, file);
  if (!fs.existsSync(src)) throw httpError(404, `Nothing in the trash called "${file}"`);
  const test = readJson(src);
  const restored = create({
    name: test.name, description: test.description, target: test.target,
    settings: test.settings, steps: test.steps,
    tags: test.tags, folder: test.folder, favorite: test.favorite, bug: test.bug,
  });
  fs.unlinkSync(src);
  return restored;
}

/** Give every step a stable id (`s1`, `s2`, …) — new steps from the editor arrive without one. */
function renumber(list) {
  return list.map((s, i) => ({ ...s, id: `s${i + 1}` }));
}

// ────────────────────────────────────────────────────────────── runs

function newRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function runDir(testId, runId) {
  const dir = path.join(RUNS, safeId(testId), safeRunId(runId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeRunId(runId) {
  const s = String(runId || '');
  if (!/^[0-9A-Za-z_-]+$/.test(s)) throw httpError(400, `Bad run id "${s}"`);
  return s;
}

/** What a test's `lastRun` stamp says about a finished run. */
function lastRunStamp(result) {
  const stamp = {
    runId: result.id, status: result.status, failedStep: result.failedStep || null,
    at: result.finishedAt, durationMs: result.durationMs,
  };
  if (result.reason) stamp.reason = result.reason;
  if (result.summary) stamp.summary = result.summary;
  const app = (result.target && result.target.key) || result.app;
  if (app) stamp.app = app;
  return stamp;
}

/**
 * Record that a run has begun: result.json with status 'running', WITHOUT touching the test's
 * lastRun (the previous outcome stays visible until this run actually finishes).
 */
function writeRunStart(testId, runId, result) {
  writeJson(path.join(runDir(testId, runId), 'result.json'), { ...result, id: result.id || runId, status: 'running' });
}

function saveRun(testId, result) {
  writeJson(path.join(runDir(testId, result.id), 'result.json'), result);
  // Stamp the test with the outcome so the list can show "Last run: FAIL at step 9".
  if (exists(testId)) {
    const test = load(testId);
    test.lastRun = lastRunStamp(result);
    writeJson(testFile(testId), test);
  }
  pruneRuns(testId);
}

/**
 * Called once at boot. A result.json still saying 'running' belongs to a process that died, so it
 * becomes error/interrupted (finishedAt = the file's mtime) and, if the test's lastRun pointed at
 * it, that stamp follows. Returns how many runs were fixed.
 */
function sweepInterruptedRuns() {
  let fixed = 0;
  if (!fs.existsSync(RUNS)) return 0;
  for (const testId of fs.readdirSync(RUNS)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(testId)) continue;
    const dir = path.join(RUNS, testId);
    let runIds;
    try { runIds = fs.readdirSync(dir); } catch (e) { continue; }
    for (const runId of runIds) {
      if (!/^[0-9A-Za-z_-]+$/.test(runId)) continue;
      const file = path.join(dir, runId, 'result.json');
      try {
        if (!fs.existsSync(file)) continue;
        const result = readJson(file);
        if (!result || result.status !== 'running') continue;
        result.status = 'error';
        result.reason = 'interrupted';
        result.summary = 'The service stopped while this run was in progress.';
        result.finishedAt = fs.statSync(file).mtime.toISOString();
        if (result.startedAt && !Number.isFinite(result.durationMs)) {
          const d = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
          if (Number.isFinite(d) && d >= 0) result.durationMs = d;
        }
        writeJson(file, result);
        if (exists(testId)) {
          const test = load(testId);
          if (test.lastRun && test.lastRun.runId === (result.id || runId)) {
            test.lastRun = lastRunStamp({ ...result, id: result.id || runId });
            writeJson(testFile(testId), test);
          }
        }
        fixed++;
      } catch (e) { /* one unreadable run must not stop the sweep */ }
    }
  }
  return fixed;
}

/**
 * Keep the `keep` most recent runs of one test and delete the rest, folders and all.
 *
 * Deleting a test already takes its runs with it, but a test that is KEPT and run every day
 * accumulated for ever, and every failing run leaves a full-page PNG behind. That is disk, and —
 * because those screenshots are pictures of real application data — it is also a growing pile of
 * something nobody meant to keep. A run id is an ISO timestamp with the punctuation swapped, so
 * it sorts lexicographically by age and no file needs to be read to know which are oldest.
 *
 * Pruning is housekeeping: a failure here must never take down the run that has just been saved.
 */
function pruneRuns(testId, keep = 20) {
  try {
    const dir = path.join(RUNS, safeId(testId));
    if (!fs.existsSync(dir)) return;
    const runs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[0-9A-Za-z_-]+$/.test(d.name))
      .map((d) => d.name)
      .sort();
    for (const runId of runs.slice(0, Math.max(0, runs.length - Math.max(1, keep)))) {
      fs.rmSync(path.join(dir, runId), { recursive: true, force: true });
    }
  } catch (e) { /* run history is a convenience, never a hard failure */ }
}

function listRuns(testId) {
  const dir = path.join(RUNS, safeId(testId));
  if (!fs.existsSync(dir)) return [];
  // One half-written result.json must not take the whole history down with it — a run killed
  // mid-write is exactly when a developer most wants to see the rest of the list.
  return fs.readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'result.json')))
    .map((d) => {
      try {
        const r = readJson(path.join(dir, d, 'result.json'));
        return { id: r.id, status: r.status, failedStep: r.failedStep || null, startedAt: r.startedAt, durationMs: r.durationMs, stepsPassed: (r.steps || []).filter((s) => s.status === 'passed').length, stepCount: r.stepCount };
      } catch (e) {
        return { id: d, status: 'unknown', failedStep: null, startedAt: null, durationMs: null, stepsPassed: null, stepCount: null, broken: String(e.message) };
      }
    })
    .sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

/**
 * Every test's runs on one list, newest first — what the page shows as "recent activity".
 *
 * A run id is a timestamp, so the folder names alone sort newest-first: the whole tree is sorted
 * BEFORE anything is opened, and only the `limit` newest runs ever cost a `result.json` read. When
 * a result file is missing or unreadable the owning test's own `lastRun` stamp can still describe
 * its newest run, so that one is answered without a read at all.
 */
function allRuns(limit = 50) {
  ensureDirs();
  const cap = Math.max(1, Math.trunc(Number(limit) || 50));

  const names = new Map();
  const stepCounts = new Map();
  const stamps = new Map();
  for (const t of list()) {
    names.set(t.id, t.name);
    stepCounts.set(t.id, t.stepCount);
    if (t.lastRun && t.lastRun.runId) stamps.set(t.id, t.lastRun);
  }

  const pointers = [];
  if (fs.existsSync(RUNS)) {
    for (const testId of fs.readdirSync(RUNS)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(testId)) continue;
      const dir = path.join(RUNS, testId);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const runId of fs.readdirSync(dir)) {
        if (!/^[0-9A-Za-z_-]+$/.test(runId)) continue;
        pointers.push({ testId, runId });
      }
    }
  }
  pointers.sort((a, b) => String(b.runId).localeCompare(String(a.runId)));

  const runs = [];
  for (const p of pointers) {
    if (runs.length >= cap) break;
    let entry = null;
    const file = path.join(RUNS, p.testId, p.runId, 'result.json');
    if (fs.existsSync(file)) {
      try {
        const r = readJson(file);
        entry = { id: r.id, status: r.status, failedStep: r.failedStep || null, startedAt: r.startedAt, durationMs: r.durationMs, stepsPassed: (r.steps || []).filter((s) => s.status === 'passed').length, stepCount: r.stepCount };
      } catch { /* half-written or hand-mangled: fall back to the stamp below */ }
    }
    const stamp = stamps.get(p.testId);
    if (!entry && stamp && stamp.runId === p.runId) {
      entry = { id: stamp.runId, status: stamp.status, failedStep: stamp.failedStep || null, startedAt: stamp.at, durationMs: stamp.durationMs, stepsPassed: null, stepCount: stepCounts.has(p.testId) ? stepCounts.get(p.testId) : null };
    }
    if (!entry) continue;   // evidence folder with nothing in it
    runs.push({ ...entry, testId: p.testId, testName: names.has(p.testId) ? names.get(p.testId) : p.testId });
  }
  return { runs };
}

function loadRun(testId, runId) {
  const file = path.join(RUNS, safeId(testId), safeRunId(runId), 'result.json');
  if (!fs.existsSync(file)) throw httpError(404, `No run "${runId}" for "${testId}"`);
  return readJson(file);
}

/**
 * Absolute path of an evidence file in a run folder, refusing anything that escapes it.
 *
 * The character class alone is not the guard it looks like: `.` and `..` are both made entirely of
 * permitted characters, and `..` resolves to the run folder's PARENT — every other run of the same
 * test. The name is therefore checked for those two outright, and the resolved path is then
 * confirmed to still sit inside the run folder before it is handed back.
 */
function runFile(testId, runId, name) {
  const n = String(name);
  if (!/^[\w.-]+$/.test(n) || n === '.' || n === '..') throw httpError(400, 'Bad file name');
  const dir = path.join(RUNS, safeId(testId), safeRunId(runId));
  const file = path.join(dir, n);
  if (path.relative(dir, file).startsWith('..')) throw httpError(400, 'Bad file name');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(404, 'No such file');
  return file;
}

module.exports = {
  TRASH, listTrash, restoreFromTrash,
  TESTS, RUNS, ensureDirs, slugify,
  exportable, writeRunStart, sweepInterruptedRuns,
  list, load, exists, create, update, remove, duplicate, importTest, stats,
  newRunId, runDir, saveRun, pruneRuns, listRuns, allRuns, loadRun, runFile,
  httpError,
};
