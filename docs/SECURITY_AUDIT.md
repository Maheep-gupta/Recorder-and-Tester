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
| `.auth/ui-shell.json` | **Plaintext by design**: it is shared with an external Playwright suite. It is restricted to the current user by ACL. | Documented exception (**P1**) |
| `credentials.local.env` (`OPKEY_*`) | Never rewritten. Keyring accounts `env:OPKEY_*` take precedence. A startup warning names the plaintext keys (never their values). | VERIFIED (memory store). The file itself remains plaintext (**P1**). |
| File ACLs | `restrictFile`: POSIX `chmod 600`. On Windows, `icacls` removes inheritance and grants the current user only. | VERIFIED on Windows. POSIX NOT TESTED. |

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
| Two typed URLs differing only in characters the filename sanitiser maps to `_` can share one session file (`url:http://a.b` vs `url:http://a_b`) | Open (**P2**, low likelihood) |

## 7. Local server

- It binds to `127.0.0.1`. A Host-header allowlist blocks DNS rebinding, and requests with a
  cross-origin `Origin` header are rejected. There are no CORS headers.
- Run and test ids are validated by regex. Static files are served from a fixed whitelist, and no
  path traversal was found.
- Malformed JSON or a non-object body gets HTTP 400, as does a malformed `%` escape in the URL.
  The body size cap is 4 MB.
- **There is no authentication on the local API.** Any process running as the same user on this
  machine can drive it. That is accepted for a local single-user tool: **P2**, documented.

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

## 10. Open findings

| P | Finding |
|---|---|
| P1 | `.auth/ui-shell.json` stays plaintext, ACL-restricted, because an external suite shares it. |
| P1 | `credentials.local.env` stays plaintext unless the user moves its values into the keyring. There is no prompt-based helper yet. |
| P1 | macOS Keychain and Linux Secret Service backends have never run. |
| P2 | Cold Windows keyring calls take about 1.5–2 s. They are cached per process. |
| P2 | The guard proxy does not support an upstream corporate proxy. |
| P2 | The local API has no authentication (same-user processes can use it). |
| P2 | Two typed URLs can collide on one session file name. |
| P2 | Recordings contain production page text by design. |
| P2 | `.corrupt-*` files that were set aside may hold legacy plaintext passwords until the user deletes them. |
| P2 | The README contains a real person's name in an example, and `src/config.js` names an internal QA host. Both predate this work and are already in published history. |
