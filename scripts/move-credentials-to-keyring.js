#!/usr/bin/env node
/**
 * Replayr — move the plaintext OPKEY_* logins in credentials.local.env into the OS keyring.
 *
 *   node scripts/move-credentials-to-keyring.js           dry run: lists what would move (names only)
 *   node scripts/move-credentials-to-keyring.js --apply   moves them, verifies, then blanks them in the file
 *
 * Each value is stored under the keyring account `env:<NAME>` (service "Replayr"), which Replayr
 * already prefers over the file, so authentication keeps working without any other change. The value
 * is read from the file, never typed and never passed on a command line, and it is never printed.
 *
 * Safety:
 * - Nothing is changed in the file until EVERY value has been written to the keyring AND read back
 *   identical. Any failure leaves the file exactly as it was.
 * - The file is rewritten atomically: same lines and comments, the moved values emptied and a
 *   comment saying where they went. No plaintext backup is made (that would defeat the purpose).
 * - Without a working keyring the script stops and changes nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const secretstore = require('../src/secretstore');
const { renameSyncRetry } = require('../src/fsutil');

const NAME = /^OPKEY_[A-Z0-9_]+$/;

/** Parse the env file into line records, keeping everything needed to rewrite it faithfully. */
function parseLines(text) {
  return text.split(/\r?\n/).map((raw) => {
    const s = raw.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) return { raw };
    const i = raw.indexOf('=');
    const name = raw.slice(0, i).trim();
    let value = raw.slice(i + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
    return { raw, name, value };
  });
}

/**
 * Returns { file, candidates: [names], moved: [names], applied, message }. Throws on a keyring
 * failure (file untouched).
 */
function migrate({ file = config.credentialsPath, apply = false, now = new Date() } = {}) {
  if (!fs.existsSync(file)) return { file, candidates: [], moved: [], applied: false, message: `${path.basename(file)} does not exist: nothing to move.` };
  const text = fs.readFileSync(file, 'utf8');
  const lines = parseLines(text);
  const candidates = lines.filter((l) => l.name && NAME.test(l.name) && l.value).map((l) => l.name);
  if (!candidates.length) return { file, candidates, moved: [], applied: false, message: 'No plaintext OPKEY_* values found: nothing to move.' };
  if (!apply) {
    return { file, candidates, moved: [], applied: false, message: `Would move ${candidates.length} value(s) to the OS keyring: ${candidates.join(', ')}. Re-run with --apply.` };
  }

  const avail = secretstore.available();
  if (!avail.ok) throw new Error(`The OS keyring is not available (${avail.reason}). Nothing was changed.`);

  // 1. Write every value and read it back. Any mismatch aborts before the file is touched.
  for (const l of lines) {
    if (!l.name || !candidates.includes(l.name)) continue;
    secretstore.setSecret('env:' + l.name, l.value);
    if (secretstore.getSecret('env:' + l.name) !== l.value) {
      throw new Error(`The keyring did not return ${l.name} unchanged after saving it. Nothing was changed in ${path.basename(file)}.`);
    }
  }

  // 2. Rewrite the file with those values emptied.
  const stamp = now.toISOString().slice(0, 10);
  const out = [];
  for (const l of lines) {
    if (l.name && candidates.includes(l.name)) {
      out.push(`# ${l.name} moved to the OS keyring (Replayr, account env:${l.name}) on ${stamp}`);
      out.push(`${l.name}=`);
    } else {
      out.push(l.raw);
    }
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, out.join(eol), { encoding: 'utf8', mode: 0o600 });
  secretstore.restrictFile(tmp);
  renameSyncRetry(tmp, file);
  return { file, candidates, moved: candidates, applied: true, message: `Moved ${candidates.length} value(s) to the OS keyring: ${candidates.join(', ')}. ${path.basename(file)} no longer holds them.` };
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  try {
    const r = migrate({ apply });
    console.log(r.message);
    process.exitCode = 0;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

module.exports = { migrate, parseLines };
