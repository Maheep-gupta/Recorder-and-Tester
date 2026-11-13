# Replayr — security audit

Date: 2026-11-12 · Scope: the working tree at the time of the audit (uncommitted) · No credential
value appears in this document, in test output or in logs.

Status words: **VERIFIED** (exercised by an automated test or direct observation) · **PARTIALLY
VERIFIED** · **BLOCKED** (missing infrastructure/credentials) · **NOT TESTED**. Priorities:
**P0** critical security/data-integrity · **P1** serious · **P2** improvement.

## 1. Threat model

Replayr is a **local, single-user developer tool**. It listens only on `127.0.0.1`. It drives a
real browser against applications the developer configures, including production.

Assets:
- application credentials
- login sessions (cookies and tokens)
- recorded tests, which may contain production page content
- run evidence
- the developer's network: a malicious imported test must not be able to use Replayr to reach
  internal services

Out of scope: malware already running as the same OS user. The OS keyring is readable by that
user's own processes on every platform.

## 2. Credential storage — VERIFIED on Windows

| Item | Implementation | Status |
|---|---|---|
| Logins typed in the UI | The password goes to the **OS keyring**. `custom-credentials.local.json` holds metadata only (`username`, `savedAt`, `store: 'keyring'`). | VERIFIED |
| Windows | **Credential Manager**, target `Replayr:<origin>`, through PowerShell and an advapi32 P/Invoke. The secret travels on **stdin, never argv**. | VERIFIED: a real round trip on this machine (set, get, update, delete, with non-ASCII characters and quotes in the value). No entries were left behind. |
| macOS | Keychain via `security -i`, with commands on stdin | NOT TESTED (code only) |
| Linux | Secret Service via `secret-tool`, with the secret on stdin. It detects a missing binary or no D-Bus session. | NOT TESTED (code only) |
| No keyring available | Saving is **refused** with HTTP 400, which explains the limitation and the explicit opt-in `REPLAYR_ALLOW_PLAINTEXT_CREDENTIALS=1`. **There is never a silent plaintext fallback.** | VERIFIED (simulated keyring outage) |
| Migration of old plaintext entries | Moved into the keyring on first access, and the password is removed from the file in one atomic rewrite. With no keyring, the file is left untouched and a warning is logged. | VERIFIED |
| Corrupt metadata file | Set aside as `*.corrupt-<stamp>`, never overwritten | VERIFIED |
| Write or permission failure | A clear error, with the keyring rolled back and no data lost | VERIFIED on Windows. POSIX branch NOT TESTED. |
| Session files `.auth/<env>.json` | **AES-256-GCM encrypted**, with the key in the keyring (`session-key`). A tampered file forces a re-login. With no keyring, the session is not saved. | VERIFIED (real crypto, simulated keyring) |
| `.auth/ui-shell.json` | **Encrypted by default (RC fix).** The plaintext exception existed for an external Playwright suite (`helpers/auth.setup.ts`) that shared the file. Since the restructure, `.auth/` is Replayr's own folder and no such suite exists in this repository, so the exception protected nothing. A legacy plaintext file is encrypted **in place** the first time it is read. A team that really shares the file can keep it plain with `REPLAYR_SHARE_UI_SHELL_SESSION=1`. | VERIFIED (`tests/rc.test.js`: default encrypted, opt-in plain, legacy migrated, no-keyring = untouched) |
| `credentials.local.env` (`OPKEY_*`) | User-managed and never rewritten silently. Keyring accounts `env:OPKEY_*` take precedence. A startup warning names the plaintext keys (never their values). **RC fix:** `node scripts/move-credentials-to-keyring.js` (dry run) / `--apply` moves each value into the keyring, reads it back to verify, then blanks it in the file. Nothing changes if any step fails or no keyring is available. | VERIFIED (`tests/rc.test.js`). The file stays plaintext until the user runs the script (**P2**). |
| File ACLs | `restrictFile`: POSIX `chmod 600`. On Windows, `icacls` removes inheritance and grants the current user only. | VERIFIED on Windows. POSIX NOT TESTED. |

### 2a. Remaining plaintext secrets: complete inventory (RC review)

| Where | What | Plaintext? | Migration |
|---|---|---|---|
| OS keyring `Replayr:<origin>` | Typed logins | No (OS-protected) | n/a |
| OS keyring `Replayr:session-key` | AES key for session files | No (OS-protected) | n/a |
| `.auth/<env>.json` | Cookies and tokens per environment | No (AES-256-GCM) | Legacy plaintext files are encrypted in place on first read. |
| `.auth/ui-shell.json` | Cookies and tokens for the default app | **No** since the RC fix | The same in-place migration. `REPLAYR_SHARE_UI_SHELL_SESSION=1` keeps it plain (opt-in only). |
| `credentials.local.env` | `OPKEY_*` usernames and passwords for built-in apps | **Yes, until migrated** | `node scripts/move-credentials-to-keyring.js --apply`. Authentication keeps working, because keyring `env:*` accounts win over the file. |
| `custom-credentials.local.json` | Origins and usernames only | No passwords (since 0.1.0). Older files are migrated on first access. | Automatic |
| `*.corrupt-<stamp>` files | A copy of a file that could not be parsed; may contain **legacy plaintext passwords** | Possibly | Kept on purpose, to avoid data loss. The user should inspect and delete them (**P2**). |
| Opt-in `REPLAYR_ALLOW_PLAINTEXT_CREDENTIALS=1` | Credentials and sessions on a machine with no keyring | Yes, by explicit choice | Documented. A warning is logged on every use. |

Nothing else on disk holds a credential:
- Tests and exports never hold credentials, cookies or URL tokens.
- Run evidence is redacted.
- Logs print names, never values.

### 2b. Production login state never reaches localhost — VERIFIED

- Each environment key has its own session file.
- Replay loads **only the target environment's** state (`auth.storageStateOption(<target key>)`).
- An environment with login off loads none.
- **RC fix:** two typed URLs that sanitised to the same file name (`url:http://a.b` /
  `url:http://a_b`) could share one session file. Non-filename-safe keys now get a hash suffix.
  Typed-URL sessions saved by older builds are not reused under the new name, so the user signs
  in once more. That is deliberate: reusing them could pick up the other environment's session.
- **End-to-end proof** (`tests/rc.test.js`, real Chromium and real `runTest`):
  - A production environment has a saved session whose cookie is scoped to the very host the
    local app uses. Cookies ignore ports, so loading the wrong state *would* leak, and a control
    check shows it does.
  - Replaying the production-recorded test on localhost sent **no** production cookie, and
    production received **zero** requests.

## 3. Secret redaction — VERIFIED

- **Password-like fields** are redacted **before** a step is emitted. That covers password inputs,
  `autocomplete` password/OTP/card fields, and names such as `token`, `secret`, `cvv` and
  `api_key`.
  - If nothing is known about a field yet, its value is held back until the live element has been
    checked.
  - Select values are covered too.
  - Verified with real recordings: the value never appears in live state, the draft file, the
    saved test, or any file under the run's temp root.
- **Storage** strips secret step values again on save and on import.
- **Exports** never include them.
- **Credentials in URL query strings** (`access_token`, `token`, `password`, `sig`, the
  `X-Amz-*` signature fields, …) are masked at record time and in exports, including tests
  recorded earlier. Ordinary parameters such as `sortKey` and OAuth `code` are kept.
- **Console evidence** is redacted (Bearer tokens, JWTs, `key=value` credentials), and failure
  screenshots mask password fields.
- **By design, recordings of production contain page text** (element names and labels used to
  find elements again). Treat `local-tests/` and exported tests as sensitive. **P2**: documented,
  not a defect.

## 4. Production protection — VERIFIED

- A replay against a **protected** environment (every `production` environment, plus any you mark)
  is refused by the **server** with `428 confirm-protected` until it is confirmed. The UI names the
  environment.
- Typed URLs:
  - Loopback addresses are treated as `local`. That includes `localhost`, `*.localhost`, `127/8`,
    `::1`, IPv4-mapped forms and alternate spellings such as `0x7f.1` and `LOCALHOST.`.
  - **Everything else, private-network hosts included, is treated as `production`**, and so is
    protected. This is deliberately conservative: real production apps often live on private IPs.

## 5. SSRF and network guard — VERIFIED after a P0 fix

**P0 found and fixed:** Playwright's `context.route()` is **not called for redirect hops**
(verified on 1.62.1). A localhost page that 302-redirected to production reached production even
with a route guard in place.

**The fix** has two layers on every replay:
- a local **guard proxy** that enforces the policy on every connection the browser opens,
  including redirects and WebSockets, with **DNS checked inside the socket's own lookup**, so a
  public name that resolves to a private or metadata address is caught;
- a route guard that records and aborts what it can see early.

Service workers are blocked during replay so they cannot fetch around either layer.

| Destination | Replay policy | Status |
|---|---|---|
| Cloud metadata (`169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`, `100.100.100.200`, …) | Always blocked in every mode. It is also refused as an environment URL and in imported steps. | VERIFIED |
| A protected environment other than the target | Blocked, covering redirects, clicks, `fetch()` and links | VERIFIED (the protected server received **zero** requests) |
| Loopback or private destinations while the target is public | Blocked, so an imported test cannot pivot into the developer's LAN | VERIFIED (policy tests) |
| Other loopback ports while the target is local | Allowed, because local stacks run on several ports | VERIFIED |
| Non-http(s) schemes (`file:`, `javascript:`, `data:` …) | Refused | VERIFIED |
| Well-known non-HTTP service ports (22, 3306, 6379 …) other than the target's own | Blocked | VERIFIED |
| Readiness probe (`waitForApp`) | Never follows redirects, checks DNS at connect time, blocks metadata | VERIFIED |
| Recording | Metadata and non-web schemes are blocked. Nothing else is restricted, because a human is driving. | PARTIALLY VERIFIED (record-mode guard test; not exercised during a real headed recording) |
| DNS rebinding against hostile real DNS | Closed by the connect-time check | PARTIALLY VERIFIED (stubbed resolver; real DNS cannot be changed here) |
| Upstream corporate proxy | The guard proxy does not chain to an upstream proxy | NOT TESTED (**P2**: networks that require one will see replays fail) |

## 6. Environment and data isolation

| Check | Status |
|---|---|
| Production authentication is never transferred to localhost. Each environment has its own session file, and replay loads the **target** environment's session only. | VERIFIED (mock Keycloak: environment B never received A's app or SSO cookies) |
| Environment-specific credentials are used | VERIFIED (mock) |
| Exports carry no credentials, secret values or URL tokens | VERIFIED |
| Two typed URLs differing only in characters the filename sanitiser maps to `_` could share one session file (`url:http://a.b` vs `url:http://a_b`) | **Fixed (RC)**, regression-tested |
| A localhost replay of a production-recorded test sends no production cookie and makes no request to production | VERIFIED end to end (`tests/rc.test.js`) |

## 7. Local server

- It binds to `127.0.0.1`. A Host-header allowlist blocks DNS rebinding, and requests with a
  cross-origin `Origin` header are rejected. There are no CORS headers.
- Run and test ids are validated by regex. Static files are served from a fixed whitelist, and no
  path traversal was found.
- Malformed JSON or a non-object body gets HTTP 400, as does a malformed `%` escape in the URL.
  The body size cap is 4 MB.
- **There is no authentication on the local API.** See the threat model below.

### 7a. Local API threat model (RC review)

The API can do these things:
- start recordings and replays, including against protected environments once
  `confirmProtected: true` is sent;
- drive a browser that loads **your** encrypted sessions and keyring logins;
- read tests, which may contain production page text;
- delete and restore tests.

It never returns a password, a session or a cookie.

| Attacker | Can they reach it? | Result |
|---|---|---|
| A remote machine | No. It binds to `127.0.0.1` only. | Protected |
| A malicious website in your browser (CSRF) | It cannot make a state-changing request. Browsers send `Origin` on every cross-site POST, PUT or DELETE, and Replayr rejects any foreign `Origin`. Every GET route is read-only, and without CORS headers the page cannot read the response. | Protected (verified by code review of every route) |
| DNS rebinding (a site that re-points its name to 127.0.0.1) | The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, so a rebound name is rejected. | Protected |
| Malware running as **you** | Yes, but it can already read your keyring, your browser profile and this folder directly. | Out of scope: an API token would not change the outcome |
| **Another user on the same machine** (a shared Windows host or RDP server, a shared build agent) | **Yes.** Loopback is reachable by every local user. | **Not protected.** They could start a run that uses your sessions against an environment, including a confirmed production one, and read your tests. |

**Assessment.**
- **Typical developer laptop, one interactive user:** the current protections are adequate, and
  an extra API token adds friction without reducing risk.
- **Shared multi-user host:** the gap is real. The standard fix is a per-launch secret: `npm start`
  prints a one-time URL (as Jupyter does), the server sets an `HttpOnly; SameSite=Strict` cookie,
  and every `/api` call requires it. Other local users never see your terminal.
- A token embedded in the page would not help, because any local user can fetch the page.

**Recommendation for 0.1.0:**
- Support **single-user workstations only**, and document "do not run Replayr on a shared
  multi-user host" as a release limitation (**P1, documented**).
- Implement the launch-token cookie in 0.1.1. It touches the UI start-up, the recorder popup, the
  in-page bar link and the server-based tests, so it was not added during release-candidate
  stabilisation without approval.

## 8. Authentication automation — PARTIALLY VERIFIED (mock), real Keycloak BLOCKED

Tested against a faithful mock Keycloak (`tests/fixtures/mock-keycloak.js`):
- a successful login
- a saved session being reused
- an expired session with automatic re-login, and silent re-authentication when the identity
  provider's session is still alive
- a wrong password
- missing credentials
- an **MFA page**, where Replayr fails clearly and **never attempts a bypass**
- environment isolation, and replay that reports *blocked/auth_failed* on bad credentials

**P1 found and fixed:** a wrong password or an MFA page used to wait 60 s and report only a timeout.
Repeated slow retries could also feed account lockout. Both cases are now detected immediately,
with a clear message, and login is **not retried**.

BLOCKED: real Keycloak tenants, theme selector drift, required-action pages, lockout policy, real
MFA or WebAuthn, cross-domain SSO, and real token lifetimes.

## 9. Supply chain — VERIFIED

- `npm audit` reports **0 vulnerabilities**.
- The only direct dependency is `playwright@1.62.1`, pinned exactly. It depends only on
  `playwright-core@1.62.1`.
- `fsevents` is an optional, macOS-only dependency (Playwright's file watcher). It is the only
  package with an install script and is not installed on Windows or Linux.
- Every package resolves from `registry.npmjs.org` with sha512 integrity.
- `npm ci --dry-run` is consistent with the lockfile.
- One asset was vendored once from jsDelivr: the Inter font (`ui/fonts/`, SIL OFL licence
  included). The running app makes no external requests.

## 10. Open findings (after the release-candidate fixes)

| P | Finding | Release handling |
|---|---|---|
| P1 | The local API is reachable by **other users on the same machine** (multi-user hosts). | Documented limitation: single-user workstations only. Launch-token cookie planned for 0.1.1. |
| P1 | macOS Keychain and Linux Secret Service backends have never run. | Windows-first release: macOS and Linux are marked experimental, with a warning at startup. |
| P2 | `credentials.local.env` stays plaintext until the user runs `scripts/move-credentials-to-keyring.js --apply`. | A startup warning names the keys and the script. |
| P2 | Cold Windows keyring calls take about 1.5–2 s. They are cached per process. | Accepted |
| P2 | The guard proxy does not support an upstream corporate proxy. | Documented |
| P2 | Recordings contain production page text by design. | Documented: treat `local-tests/` and exports as sensitive. |
| P2 | `.corrupt-*` files that were set aside may hold legacy plaintext passwords. | Documented: inspect, then delete. |
| P2 | The README contains a real person's name in an example, and `src/config.js` names an internal QA host. Both predate this work and are in published history. | Owner decision |

Closed in the release candidate:
- `ui-shell.json` plaintext
- the session-file name collision
- recording browsers invisible to the orphan sweep (they now carry the owner marker)
- the missing migration helper for `credentials.local.env`
