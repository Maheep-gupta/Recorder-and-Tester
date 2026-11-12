/**
 * A test harness in eighty lines.
 *
 * There is no test framework installed in this repo and the identity engine does not need one:
 * it needs a `test()` that collects, an `assert` that explains itself, one line of output per
 * test and a non-zero exit code when anything is wrong. That is all this file is.
 *
 * Usage:
 *   const { test, assert, run } = require('./harness');
 *   test('two plus two', () => assert.equal(2 + 2, 4, 'arithmetic'));
 *   run('unit');            // async; exits the process itself
 */
'use strict';

const tests = [];

/** Collect a test. `fn` may be async. */
function test(name, fn) {
  tests.push({ name, fn });
}

class AssertionError extends Error {}

function show(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return 'undefined';
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 300 ? s.slice(0, 300) + '…' : s;
  } catch (e) {
    return String(v);
  }
}

function fail(what, expected, actual) {
  throw new AssertionError(`${what}\n      expected: ${show(expected)}\n      actual:   ${show(actual)}`);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const assert = {
  ok(value, what) {
    if (!value) fail(what || 'expected a truthy value', 'truthy', value);
  },
  notOk(value, what) {
    if (value) fail(what || 'expected a falsy value', 'falsy', value);
  },
  equal(actual, expected, what) {
    if (!deepEqual(actual, expected)) fail(what || 'values differ', expected, actual);
  },
  notEqual(actual, expected, what) {
    if (deepEqual(actual, expected)) fail(what || 'values should differ', `not ${show(expected)}`, actual);
  },
  /** Substring / array-membership. */
  includes(haystack, needle, what) {
    const has = Array.isArray(haystack) ? haystack.some((h) => deepEqual(h, needle)) : String(haystack).includes(needle);
    if (!has) fail(what || 'value not found', `something containing ${show(needle)}`, haystack);
  },
  excludes(haystack, needle, what) {
    const has = Array.isArray(haystack) ? haystack.some((h) => deepEqual(h, needle)) : String(haystack).includes(needle);
    if (has) fail(what || 'value should be absent', `nothing containing ${show(needle)}`, haystack);
  },
  match(value, re, what) {
    if (!re.test(String(value))) fail(what || 'pattern did not match', String(re), value);
  },
  /** Every element of `list` satisfies `pred`; reports the first that does not. */
  every(list, pred, what) {
    const bad = list.find((x) => !pred(x));
    if (bad !== undefined) fail(what || 'not every item satisfied the predicate', 'all items to pass', bad);
  },
  /** Ascending index of `a` is before `b` in `list`. */
  before(list, a, b, what) {
    const ia = list.indexOf(a);
    const ib = list.indexOf(b);
    if (ia < 0) fail(what || 'ordering', `${show(a)} to be present`, list);
    if (ib < 0) fail(what || 'ordering', `${show(b)} to be present`, list);
    if (!(ia < ib)) fail(what || 'ordering', `${show(a)} before ${show(b)}`, list);
  },
};

/** Runs every collected test in order. Never throws; exits the process with 0 or 1. */
async function run(label) {
  const started = Date.now();
  let passed = 0;
  const failures = [];
  process.stdout.write(`\n── ${label} ─ ${tests.length} tests ${'─'.repeat(Math.max(0, 50 - label.length))}\n`);
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      process.stdout.write(`PASS  ${t.name}\n`);
    } catch (err) {
      failures.push({ name: t.name, err });
      process.stdout.write(`FAIL  ${t.name}\n      ${String(err.message).replace(/\n/g, '\n')}\n`);
      if (!(err instanceof AssertionError) && err.stack) {
        process.stdout.write(`      ${err.stack.split('\n').slice(1, 3).join('\n      ')}\n`);
      }
    }
  }
  const ms = Date.now() - started;
  process.stdout.write(`\n${label}: ${passed} passed, ${failures.length} failed, ${tests.length} total (${ms}ms)\n`);
  if (failures.length) {
    process.stdout.write(`failed: ${failures.map((f) => f.name).join(', ')}\n`);
  }
  process.exitCode = failures.length ? 1 : 0;
  return failures.length === 0;
}

module.exports = { test, assert, run, AssertionError, deepEqual };
