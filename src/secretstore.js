/**
 * Replayr - OS-native secret storage.
 *
 *   Windows  Credential Manager (advapi32 CredWrite/CredRead/CredDelete, via PowerShell Add-Type)
 *   macOS    Keychain             (`security -i`, commands on stdin)
 *   Linux    Secret Service       (`secret-tool`, secret on stdin)
 *
 * Rules this module keeps:
 *   - A secret is never on a process command line. It travels on stdin only.
 *   - There is NO silent fallback to plaintext. If the OS store is missing, setSecret() throws a
 *     400-style error that says why and how to opt in (REPLAYR_ALLOW_PLAINTEXT_CREDENTIALS=1, which
 *     is honoured by the callers that own a plaintext format, and always logs a loud warning).
 *   - Secrets are never logged and never appear in an error message.
 *
 * Everything is synchronous because the credential store in targets.js is.
 *
 * Test seam (tests ONLY): REPLAYR_SECRETSTORE=memory keeps secrets in this process (not persistent,
 * logged once); REPLAYR_SECRETSTORE=unavailable simulates a machine with no keyring.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SERVICE = 'Replayr';
const TIMEOUT_MS = 20_000;

const memory = new Map();
// Reads of the OS store cost ~1.5 s on Windows (PowerShell + Add-Type), so reads are cached for the
// life of the process and invalidated by every set/delete made through this module.
const readCache = new Map();
let warnedMemory = false;
const warned = new Set();

function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[replayr] WARNING: ${msg}`);
}

function seam() {
  const v = String(process.env.REPLAYR_SECRETSTORE || '').toLowerCase();
  return v === 'memory' || v === 'unavailable' ? v : '';
}

function backend() {
  const s = seam();
  if (s === 'memory') return 'memory';
  if (s === 'unavailable') return 'none';
  if (process.platform === 'win32') return 'credential-manager';
  if (process.platform === 'darwin') return 'keychain';
  if (process.platform === 'linux') return 'libsecret';
  return 'none';
}

function allowPlaintext() {
  return /^(1|true|yes|on)$/i.test(String(process.env.REPLAYR_ALLOW_PLAINTEXT_CREDENTIALS || ''));
}

function storeError(message, status = 400) {
  return Object.assign(new Error(message), { status, code: 'SECRET_STORE' });
}

function run(cmd, args, input) {
  return spawnSync(cmd, args, { input, encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

/* ── Windows: Credential Manager ───────────────────────────────────────── */

// The C# is compiled by Add-Type on every call (~0.4-1 s); a fresh process is the price of keeping
// the secret off the command line and needing no native module.
const PS_HEADER = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ReplayrCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL c, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, uint type, uint flags, out IntPtr p);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static string Write(string target, string secret) {
    byte[] b = Encoding.Unicode.GetBytes(secret);
    IntPtr m = Marshal.AllocHGlobal(b.Length == 0 ? 1 : b.Length);
    try {
      Marshal.Copy(b, 0, m, b.Length);
      CREDENTIAL c = new CREDENTIAL();
      c.Type = 1; c.TargetName = target; c.CredentialBlobSize = (uint)b.Length; c.CredentialBlob = m;
      c.Persist = 2; c.UserName = "replayr";
      if (!CredWriteW(ref c, 0)) return "err:" + Marshal.GetLastWin32Error();
      return "ok";
    } finally { Marshal.FreeHGlobal(m); }
  }
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) { int e = Marshal.GetLastWin32Error(); return e == 1168 ? null : "err:" + e; }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      if (b.Length > 0) Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return "v:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(Encoding.Unicode.GetString(b)));
    } finally { CredFree(p); }
  }
  public static string Delete(string target) {
    if (CredDeleteW(target, 1, 0)) return "ok";
    int e = Marshal.GetLastWin32Error();
    return e == 1168 ? "none" : "err:" + e;
  }
}
'@
$op = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:REPLAYR_NOOP))
`;

function psRun(op) {
  // The request (including the secret) is base64 JSON inside the SCRIPT on stdin - never argv/env.
  // ASCII-only JSON: stdin is decoded with the console code page, so non-ASCII is \uXXXX-escaped.
  const json = JSON.stringify(op).replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const script = PS_HEADER.replace('$env:REPLAYR_NOOP', `'${b64}'`) + `
$o = $op | ConvertFrom-Json
$r = $null
switch ($o.op) {
  'set' { $r = [ReplayrCred]::Write($o.target, $o.secret) }
  'get' { $r = [ReplayrCred]::Read($o.target) }
  'del' { $r = [ReplayrCred]::Delete($o.target) }
}
@{ r = $r } | ConvertTo-Json -Compress
`;
  const res = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Expression ([Console]::In.ReadToEnd())'], script);
  if (res.error || res.status !== 0) {
    throw storeError('Windows Credential Manager could not be reached (PowerShell failed to run).', 503);
  }
  const line = String(res.stdout || '').trim().split(/\r?\n/).pop();
  try { return JSON.parse(line).r; } catch (e) {
    throw storeError('Windows Credential Manager returned an unreadable answer.', 503);
  }
}

/* ── macOS: Keychain ───────────────────────────────────────────────────── */

function secQuote(s) {
  // `security -i` parses a shell-like line: double-quote and escape backslash / quote.
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function macRun(cmdline) {
  return run('/usr/bin/security', ['-i'], cmdline + '\n');
}

/* ── Linux: Secret Service ─────────────────────────────────────────────── */

function linuxProbe() {
  const r = run('secret-tool', ['--version'], '');
  if (r.error && r.error.code === 'ENOENT') return 'secret-tool is not installed (install libsecret-tools)';
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return 'no D-Bus session bus (DBUS_SESSION_BUS_ADDRESS is unset)';
  return '';
}

/* ── Public API ────────────────────────────────────────────────────────── */

let availCache = null;

/** `{ ok, reason }`. Cached per process; the seam is re-read every call. */
function available() {
  const s = seam();
  if (s === 'memory') return { ok: true, reason: '' };
  if (s === 'unavailable') return { ok: false, reason: 'the OS credential store is unavailable (simulated)' };
  if (availCache) return availCache;
  let out;
  if (process.platform === 'win32') {
    out = { ok: true, reason: '' };
  } else if (process.platform === 'darwin') {
    out = fs.existsSync('/usr/bin/security') ? { ok: true, reason: '' } : { ok: false, reason: 'the macOS `security` tool is missing' };
  } else if (process.platform === 'linux') {
    const why = linuxProbe();
    out = why ? { ok: false, reason: why } : { ok: true, reason: '' };
  } else {
    out = { ok: false, reason: `no credential store support on ${process.platform}` };
  }
  availCache = out;
  return out;
}

function refusal(reason) {
  return storeError(
    `Replayr will not save a password: ${reason}. Passwords are only stored in the operating system credential store ` +
    '(Windows Credential Manager, macOS Keychain, or the Linux Secret Service). Fix the keyring, or explicitly opt in to ' +
    'an unprotected plaintext file by setting REPLAYR_ALLOW_PLAINTEXT_CREDENTIALS=1 (not recommended).'
  );
}

function checkAccount(account) {
  if (typeof account !== 'string' || !account || account.length > 500) throw storeError('Invalid credential account name');
}

function setSecret(account, secret) {
  checkAccount(account);
  if (typeof secret !== 'string' || !secret) throw storeError('A secret cannot be empty');
  const a = available();
  if (!a.ok) throw refusal(a.reason);
  const b = backend();
  readCache.delete(account);
  if (b === 'memory') {
    if (!warnedMemory) { warnedMemory = true; console.warn('[replayr] REPLAYR_SECRETSTORE=memory: secrets are NOT persistent (test mode)'); }
    memory.set(account, secret);
    return;
  }
  if (b === 'credential-manager') {
    const r = psRun({ op: 'set', target: `${SERVICE}:${account}`, secret });
    if (r !== 'ok') throw storeError(`Windows Credential Manager refused the save (${String(r).slice(0, 20)}).`, 503);
    return;
  }
  if (b === 'keychain') {
    const r = macRun(`add-generic-password -U -s ${secQuote(SERVICE)} -a ${secQuote(account)} -w ${secQuote(secret)}`);
    if (r.error || r.status !== 0) throw storeError('The macOS Keychain refused the save.', 503);
    return;
  }
  if (b === 'libsecret') {
    const r = run('secret-tool', ['store', `--label=${SERVICE} ${account}`, 'service', SERVICE, 'account', account], secret);
    if (r.error || r.status !== 0) throw storeError('The Secret Service refused the save (is the keyring unlocked?).', 503);
    return;
  }
  throw refusal('no credential store on this platform');
}

/** The secret, or null if there is none. Throws if the store itself fails. */
function getSecret(account) {
  checkAccount(account);
  const a = available();
  if (!a.ok) throw refusal(a.reason);
  const b = backend();
  if (b === 'memory') return memory.has(account) ? memory.get(account) : null;
  if (readCache.has(account)) return readCache.get(account);
  const v = readOs(b, account);
  readCache.set(account, v);
  return v;
}

function readOs(b, account) {
  if (b === 'credential-manager') {
    const r = psRun({ op: 'get', target: `${SERVICE}:${account}` });
    if (r == null) return null;
    if (typeof r === 'string' && r.startsWith('v:')) return Buffer.from(r.slice(2), 'base64').toString('utf8');
    throw storeError('Windows Credential Manager could not read the credential.', 503);
  }
  if (b === 'keychain') {
    const r = macRun(`find-generic-password -s ${secQuote(SERVICE)} -a ${secQuote(account)} -w`);
    if (r.status === 44) return null; // errSecItemNotFound
    if (r.error || r.status !== 0) {
      if (/could not be found/i.test(String(r.stderr || ''))) return null;
      throw storeError('The macOS Keychain could not be read.', 503);
    }
    return String(r.stdout).replace(/\r?\n$/, '');
  }
  if (b === 'libsecret') {
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', account], '');
    if (r.error) throw storeError('The Secret Service could not be read.', 503);
    if (r.status !== 0) return null; // lookup exits 1 when nothing matches
    return String(r.stdout).replace(/\r?\n$/, '');
  }
  return null;
}

/** true when something was removed. */
function deleteSecret(account) {
  checkAccount(account);
  const a = available();
  if (!a.ok) throw refusal(a.reason);
  const b = backend();
  readCache.delete(account);
  if (b === 'memory') return memory.delete(account);
  if (b === 'credential-manager') {
    const r = psRun({ op: 'del', target: `${SERVICE}:${account}` });
    if (r === 'ok') return true;
    if (r === 'none') return false;
    throw storeError('Windows Credential Manager could not delete the credential.', 503);
  }
  if (b === 'keychain') {
    const r = macRun(`delete-generic-password -s ${secQuote(SERVICE)} -a ${secQuote(account)}`);
    return !r.error && r.status === 0;
  }
  if (b === 'libsecret') {
    const had = getSecret(account) !== null;
    run('secret-tool', ['clear', 'service', SERVICE, 'account', account], '');
    return had;
  }
  return false;
}

/**
 * Tighten a file to the current user. POSIX: chmod 600. Windows: drop inherited ACEs and grant only
 * the current user (icacls; no secrets involved). Returns true when applied. Never throws: a file
 * that cannot be restricted is reported once, not fatal.
 */
function restrictFile(file) {
  try {
    if (process.platform === 'win32') {
      const who = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : os.userInfo().username;
      const r = run('icacls', [file, '/inheritance:r', '/grant:r', `${who}:F`], '');
      if (r.error || r.status !== 0) throw new Error('icacls failed');
      return true;
    }
    fs.chmodSync(file, 0o600);
    return true;
  } catch (e) {
    warnOnce('restrict:' + file, `could not restrict permissions on ${file}`);
    return false;
  }
}

function _resetForTests() { memory.clear(); readCache.clear(); availCache = null; warnedMemory = false; warned.clear(); }

module.exports = { backend, available, setSecret, getSecret, deleteSecret, restrictFile, allowPlaintext, SERVICE, _resetForTests };
