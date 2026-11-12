/**
 * Design Studio Tester — storage.
 *
 * Tests are JSON files, one per test, in the launcher's `local-tests/` folder. Run evidence goes to
 * `local-tests/runs/<test-id>/<run-id>/` (result.json, screenshot, console log). No database: a
 * developer can read, diff, copy and hand-write everything here.
 *
 * Test file shape:
 *   { id, name, description, target: { app }, settings: { stepTimeoutMs? }, createdAt, updatedAt,
 *     tags: [...], folder: null, favorite: false,
 *     steps: [...], lastRun: { runId, status, failedStep?, at, durationMs } }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const steps = require('./steps');

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
  fs.renameSync(tmp, file);
}

// ────────────────────────────────────────────────────────────── tests

function list() {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(TESTS)) {
    if (!f.endsWith('.json')) continue;
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
  };
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
  if (!fs.existsSync(file)) throw httpError(404, `No test "${id}"`);
  return readJson(file);
}

function exists(id) {
  return fs.existsSync(testFile(id));
}

/** Create from a draft. Picks a unique id from the name. */
function create({ name, description, target, steps: draftSteps, settings, tags, folder, favorite }) {
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
    target: { app: (target && target.app) || config.defaultApp },
    settings: settings || {},
    tags: normaliseTags(tags),
    folder: normaliseFolder(folder),
    favorite: !!favorite,
    createdAt: now,
    updatedAt: now,
    steps: renumber(draftSteps),
    lastRun: null,
  };
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
  if (patch.target && patch.target.app) test.target = { app: patch.target.app };
  if (patch.tags !== undefined) test.tags = normaliseTags(patch.tags);
  if (patch.folder !== undefined) test.folder = normaliseFolder(patch.folder);
  if (patch.favorite !== undefined) test.favorite = !!patch.favorite;
  if (patch.steps !== undefined) {
    const problems = steps.validateSteps(patch.steps);
    if (problems.length) throw httpError(400, problems.join('; '));
    test.steps = renumber(patch.steps);
  }
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
  return create({
    name: obj.name,
    description: obj.description,
    target: obj.target,
    settings: obj.settings,
    steps: obj.steps,
    tags: obj.tags,
    folder: obj.folder,
    favorite: obj.favorite,
  });
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
  if (!fs.existsSync(file)) throw httpError(404, `No test "${id}"`);
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
    tags: test.tags, folder: test.folder, favorite: test.favorite,
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

function saveRun(testId, result) {
  writeJson(path.join(runDir(testId, result.id), 'result.json'), result);
  // Stamp the test with the outcome so the list can show "Last run: FAIL at step 9".
  if (exists(testId)) {
    const test = load(testId);
    test.lastRun = {
      runId: result.id, status: result.status, failedStep: result.failedStep || null,
      at: result.finishedAt, durationMs: result.durationMs,
    };
    writeJson(testFile(testId), test);
  }
  pruneRuns(testId);
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
  list, load, exists, create, update, remove, duplicate, importTest, stats,
  newRunId, runDir, saveRun, pruneRuns, listRuns, allRuns, loadRun, runFile,
  httpError,
};
