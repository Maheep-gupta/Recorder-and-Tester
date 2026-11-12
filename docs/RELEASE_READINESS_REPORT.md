# Replayr — release readiness report

Date: 2026-11-12 · Version: 0.1.0 (working tree, uncommitted) · Platform validated: Windows 11, Node 24

## Release decision: **NOT APPROVED FOR RELEASE**

No P0 security or data-integrity issue is open: the two found during this audit are fixed and
tested. But **Replayr's defining workflow has not been proven against a real application.** Real
Keycloak login, a human-driven recording, and the macOS and Linux credential backends are all
**BLOCKED** or **NOT TESTED**:
- No authorised test environment, account or running application was available.
- Only a Windows machine was available.

Passing tests against a sample app and a mock identity provider are not proof of real-world
readiness. These are therefore P1 functional blockers.

**Path to "APPROVED WITH DOCUMENTED LIMITATIONS":**
1. Complete [REAL_WORLD_VALIDATION.md](REAL_WORLD_VALIDATION.md) (12 steps) on an authorised
   non-production environment.
2. Run the [manual recording checklist](COMPATIBILITY_REPORT.md#manual-human-recording-checklist-blocked-for-automation-needs-a-person-and-a-real-window).
3. Either run the credential suite on macOS and Linux, or declare Windows-only support for this
   release.

If those pass, the remaining items are documented limitations, not blockers.

## Test results

The final complete run is `npm test`, 12 suites, each in its own process. See the
[run summary](#final-test-run) below.

| Suite | Tests | Result | What it proves |
|---|---|---|---|
| unit | 43 | pass | Identity engine logic |
| targets | 18 | pass\* | Environments, kind inference, login metadata store, storage reserved names |
| fingerprint | 45 | pass | Element identity against fixture pages |
| positional | 46 | pass | Positional fallbacks refuse wrong elements |
| e2e | 11 | pass | Record, change the page, replay through the identity engine |
| replay | 13 | pass | Production → localhost against the sample app. Covers:<br>• bug present / fixed<br>• no assertion<br>• changed and ambiguous markup<br>• cancel<br>• redaction<br>• dialogs<br>• production guard<br>• API round trips |
| security | 16 | pass | OS keyring storage (a **real** Windows Credential Manager round trip), migration, no plaintext fallback, session encryption, ACLs |
| safety | 26 | pass | SSRF guard: redirects, metadata, private ranges, DNS classification, WebSockets, ports |
| auth | 15 | pass | Login automation against a **mock** Keycloak: success, wrong password, MFA, expiry, isolation |
| reliability | 10 | pass | Launch failure, crash, context loss, cancel, shutdown, hard kill, concurrency, orphans, profiles |
| compat | 6 | pass | Canary for the private Playwright recorder API |
| lifecycle | 10 | pass | **Machine-driven** real recordings: redaction, pause, stop, restart, cleanup |

\* The first complete run had **one failure** in `targets` (`snapshot and restore`). It was a real
intermittent Windows bug: the atomic rename over a file another process still briefly held failed
with `EPERM`, so a user saving a login would have hit random failures. It is fixed with a bounded
retry (`src/fsutil.js`) used by every atomic write. After the fix the suite passed 8 consecutive
standalone runs and the confirming full run.

UX regression, run separately with Playwright, not in `npm test`:
- all 7 screens, plus test detail and 5 report states
- 1440 / 1024 / 900 / 390 px, light and dark
- **zero console errors**
- keyboard, dialog focus, command palette and toasts verified
- 2 UI bugs fixed, 5 P2 items open

Supply chain: `npm audit` reports 0 vulnerabilities, there is one pinned direct dependency, and
the lockfile is consistent. See [SECURITY_AUDIT.md §9](SECURITY_AUDIT.md#9-supply-chain--verified).

## Verified vs. not

| Area | Status |
|---|---|
| Production → localhost replay, URL rewriting, target isolation | VERIFIED (sample app) |
| Truthful results (passed / failed / blocked / error / cancelled / inconclusive) | VERIFIED |
| Ambiguous elements never clicked | VERIFIED |
| Production confirmation (HTTP 428) | VERIFIED |
| SSRF: redirects, metadata, private networks, schemes, ports, DNS at connect time | VERIFIED (real DNS rebinding: PARTIALLY, stubbed resolver) |
| Credentials in the OS keyring, no plaintext fallback | VERIFIED on Windows. macOS and Linux NOT TESTED. |
| Secret redaction in recordings, storage, exports, URLs, console evidence | VERIFIED |
| Browser process reliability and cleanup | VERIFIED on Windows. POSIX signals NOT TESTED. |
| Private Playwright API isolated behind an adapter, with a canary test | VERIFIED |
| Keycloak login automation | PARTIALLY VERIFIED (mock). Real Keycloak **BLOCKED**. |
| Human-driven recording | **BLOCKED** (needs a person) |
| Real application replay | **BLOCKED** (no authorised application or account) |
| Firefox / WebKit, popups, iframes while recording | NOT TESTED |

## Issues by priority

### P0 — critical security / data integrity

All are fixed in this audit.

| Issue | Status |
|---|---|
| Redirect hops bypassed Playwright request routing. A localhost replay could be redirected onto production. | **Fixed**: guard proxy plus route guard on every replay, verified with zero requests reaching the protected server |
| No protection against cloud metadata endpoints (SSRF) | **Fixed**: blocked in replay, recording, the readiness probe, environment URLs and imports |

### P1 — serious functional / reliability

| Issue | Status |
|---|---|
| Real-world validation (real app, real Keycloak, human recording) not performed | **OPEN, release blocker**: BLOCKED by missing access |
| macOS Keychain and Linux Secret Service backends never executed | **OPEN, release blocker** unless the release is declared Windows-only |
| `.auth/ui-shell.json` session stays plaintext because an external suite shares it (ACL-restricted) | Open, documented |
| `credentials.local.env` stays plaintext unless its values are moved into the keyring. No prompt-based helper yet. | Open, documented |
| Intermittent `EPERM` on atomic saves (Windows) | **Fixed** |
| Wrong password or MFA took 60 s, reported a timeout, and invited lockout | **Fixed** |
| Cancel reported done while Chromium was still alive. Crashes went undetected. Shutdown lost run results. Launch races. | **Fixed** |
| A missing private Playwright API silently disabled identity capture. Upgrade failures were opaque. | **Fixed** |
| Plaintext passwords in the credential store | **Fixed** (OS keyring) |
| Tokens in recorded URL query strings | **Fixed** (masked on record and export) |
| Test Library stuck on a skeleton for a fresh install | **Fixed** |

### P2 — improvements (non-blocking)

- Guard proxy does not chain to an upstream corporate proxy.
- The local API has no authentication; same-user processes can drive it.
- Two typed URLs can collide on one session file name.
- Cold Windows keyring calls take about 1.5–2 s.
- Recordings contain production page text by design.
- UX polish:
  - one badge falls below contrast guidance (4.29:1)
  - Test Library truncation at 1024 px
  - a repeated "Cancelled" label
  - focus return after the `?` dialog
  - no offline banner
- Pre-existing in published history: a person's name in a README example, and an internal QA
  hostname in `src/config.js`.

## Git and release checklist

- [x] Backup of the pre-sprint work verified to exist (scratchpad `pre-sprint/`: `wip.diff`,
      `targets.js`, `targets.test.js`).
- [x] Change set reviewed: 19 modified, 1 deleted (`ui/app.js`, split into `ui/*.js` with no lines
      lost), 36 new files. Nothing committed or pushed.
- [x] No secrets, credentials, tokens or personal data in any changed or new file.
- [x] No generated artefacts. `local-tests/`, `.auth/`, `*.local.env` and `*.local.json` are
      git-ignored. Run evidence, browser-profile ledgers and drafts live in `local-tests/`.
- [x] One binary, intentionally vendored: `ui/fonts/inter-var-latin.woff2` (48 KB), with its OFL
      licence.
- [x] `npm audit` clean, Playwright pinned, lockfile consistent.
- [ ] Real-world validation ([REAL_WORLD_VALIDATION.md](REAL_WORLD_VALIDATION.md)).
- [ ] Manual human recording checklist.
- [ ] macOS / Linux keyring check, or a Windows-only declaration.
- [ ] Decide whether to scrub the pre-existing person's name and internal hostname. They are
      already in published history, so a scrub would need a history rewrite and is out of scope.
- [ ] Commit (awaiting approval), tag `v0.1.0` only after the blockers above are cleared.

## Final test run

This is the confirming complete run, after the `EPERM` fix, on Windows 11 with Node 24 and
headless Chromium:

```
unit 43 · targets 18 · fingerprint 45 · positional 46 · e2e 11 · replay 13 · security 16
safety 26 · auth 15 · reliability 10 · compat 6 · lifecycle 10
TOTAL 259 passed, 0 failed of 259   (248 s)
```

The previous complete run was 258/259; its one failure is the `EPERM` bug described above. No test
was skipped, weakened or retried to obtain this result. The bounded retry is in product code
(`src/fsutil.js`), not in the tests.
