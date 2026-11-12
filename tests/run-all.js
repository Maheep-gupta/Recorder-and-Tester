/**
 * Runs the whole identity-engine suite.
 *
 *   node tests/run-all.js            (run from the repo root)
 *
 * Each test file is a child process, so a crash in the browser half cannot take the pure half with
 * it, and each file keeps its own exit code. The combined exit code is non-zero if either failed.
 *
 * Suggested package.json script (not added here — package.json is out of scope for this work):
 *   "test:identity":       "node tests/run-all.js"
 *   "test:identity:unit":  "node tests/unit.test.js"
 *   "test:identity:dom":   "node tests/fingerprint.test.js"
 *   "test:identity:pos":   "node tests/positional.test.js"
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const FILES = [
  { label: 'unit', file: 'unit.test.js', what: 'pure logic — stability, candidates, scoring' },
  { label: 'fingerprint', file: 'fingerprint.test.js', what: 'Chromium — extraction and replay against the fixtures' },
  { label: 'positional', file: 'positional.test.js', what: 'Chromium — the DOM-index / relative-XPath / absolute-XPath fallbacks' },
  { label: 'e2e', file: 'e2e-fixture.test.js', what: 'Chromium — record then replay, end to end, through the public API' },
];

/** Run one test file, echoing its output live, and read the summary line back out of it. */
function runFile(entry) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, entry.file)], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    const tap = (chunk) => {
      const s = chunk.toString();
      buffer += s;
      process.stdout.write(s);
    };
    child.stdout.on('data', tap);
    child.stderr.on('data', tap);

    child.on('close', (code) => {
      // Two summary shapes are accepted: the labelled one the harness prints
      // ("fingerprint: 45 passed, 0 failed, 45 total") and the bare one
      // ("11 passed, 0 failed, 11 total"), which e2e-fixture.test.js uses.
      const m = buffer.match(/^\s*(?:[\w-]+:\s+)?(\d+) passed,\s+(\d+) failed,\s+(\d+) total/m);
      resolve({
        ...entry,
        code: code == null ? 1 : code,
        ms: Date.now() - started,
        passed: m ? Number(m[1]) : 0,
        failed: m ? Number(m[2]) : 0,
        total: m ? Number(m[3]) : 0,
        parsed: !!m,
        knownBugs: (buffer.match(/^FAIL {2}\[known bug\]/gm) || []).length,
        names: (buffer.match(/^FAIL {2}.+$/gm) || []).map((l) => l.replace(/^FAIL {2}/, '')),
      });
    });

    child.on('error', (err) => {
      process.stdout.write(`could not start ${entry.file}: ${err.message}\n`);
      resolve({ ...entry, code: 1, ms: Date.now() - started, passed: 0, failed: 0, total: 0, parsed: false, knownBugs: 0, names: [] });
    });
  });
}

(async () => {
  const started = Date.now();
  const results = [];
  for (const entry of FILES) results.push(await runFile(entry));

  const total = results.reduce((a, r) => a + r.total, 0);
  const passed = results.reduce((a, r) => a + r.passed, 0);
  const failed = results.reduce((a, r) => a + r.failed, 0);
  const known = results.reduce((a, r) => a + r.knownBugs, 0);

  const line = '═'.repeat(66);
  process.stdout.write(`\n${line}\n  ELEMENT IDENTITY ENGINE — combined summary\n${line}\n`);
  for (const r of results) {
    const verdict = r.parsed ? `${String(r.passed).padStart(3)} passed  ${String(r.failed).padStart(2)} failed` : '  DID NOT REPORT A SUMMARY';
    process.stdout.write(`  ${r.label.padEnd(12)} ${verdict}   ${String(r.ms).padStart(5)}ms   ${r.what}\n`);
  }
  process.stdout.write(`${'─'.repeat(66)}\n`);
  process.stdout.write(`  TOTAL        ${String(passed).padStart(3)} passed  ${String(failed).padStart(2)} failed  of ${total}   ${Date.now() - started}ms\n`);
  if (known) process.stdout.write(`  of which ${known} are [known bug] tests — deliberate, and listed in the report\n`);
  if (failed) {
    process.stdout.write(`${'─'.repeat(66)}\n`);
    for (const r of results) for (const n of r.names) process.stdout.write(`  FAIL  ${r.label}: ${n}\n`);
  }
  process.stdout.write(`${line}\n`);

  process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
})();
