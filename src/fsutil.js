/**
 * Replayr — small filesystem helpers shared by every atomic write.
 *
 * On Windows a rename over a file fails with EPERM / EACCES / EBUSY for a moment whenever another
 * process still has the target open: the indexer, an antivirus scan, or our own `icacls` call that
 * just restricted the temp file. That made saves fail at random. The fix is the one graceful-fs
 * uses: retry a few times with a short backoff, then give up with the real error. A file that is
 * genuinely read-only still fails, just ~1 s later.
 */
'use strict';

const fs = require('fs');

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameSyncRetry(from, to, { attempts = 10 } = {}) {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (process.platform !== 'win32' || !TRANSIENT.has(e.code) || i >= attempts) throw e;
      sleepSync(Math.min(20 * i, 200));
    }
  }
}

module.exports = { renameSyncRetry };
