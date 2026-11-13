# Replayr 0.1.0 — release readiness report

Updated 2026-11-12 23:40 IST, by the release engineer, at the end of the autonomous validation phase.

## 1. Release candidate

| | |
|---|---|
| Version | 0.1.0 (`package.json`) |
| Branch | `release/replayr-0.1.0` (local only, never pushed, no upstream) |
| Last commit | `c3d6f71` — *Rebrand to Replayr; add environment-aware replay, security hardening and UI redesign* |
| Platform validated | Windows 11 Business 10.0.26300 x64 · Node v24.19.0 · Playwright 1.62.1 |

## 2. Working-tree state (uncommitted release-candidate changes, all preserved)

- **Modified (12):**
  - `README.md`
  - `docs/ENVIRONMENTS.md`, `docs/REAL_WORLD_VALIDATION.md`, `docs/RELEASE_READINESS_REPORT.md`,
    `docs/SECURITY_AUDIT.md`
  - `src/auth.js`, `src/config.js`, `src/recording.js`, `src/server.js`
  - `tests/auth.test.js`, `tests/recording-lifecycle.test.js`, `tests/run-all.js`

  A speculative change to `src/steps.js` was made and then fully reverted (`git diff src/steps.js`
  is empty).
- **New (2):** `scripts/move-credentials-to-keyring.js`, `tests/rc.test.js`.
- **Nothing staged.** Evidence lives in `local-tests/validation-evidence/`, which is git-ignored.
- The running server on 127.0.0.1:4310 (pid 17332, started 22:58) runs the current code. It was
  verified idle and **not** restarted.

## 3. Automated test results

| Run | Result |
|---|---|
| `npm test` (evidence `00-npm-test.txt`) | **269 / 270**. 1 failure, in `lifecycle`: *user closes the browser* found one extra step after the window was closed. |
| The previous complete run, on the same code | 270 / 270 |
| Re-investigation of the failure | Not reproduced in 4 full `lifecycle` runs under heavy CPU load or in 9 targeted probes. The suspected cause (a `closePage` action) was **disproved** and its fix reverted. The test now prints the exact steps if it recurs. **Open, intermittent (1 in 7 runs), root cause unknown.** |
| Live security checks against a real server process (`02-live-security.txt`) | **21 / 21** |
| Credential migration dry run (`03-credentials.txt`) | Nothing to migrate: no `credentials.local.env`, no `custom-credentials.local.json`, `.auth/` empty, 0 `.corrupt-*` files, 0 Replayr entries in Credential Manager. **No `--apply` was needed.** |
| Supply chain | `npm audit` reports 0 vulnerabilities. One pinned dependency. |

## 4. R1–R10 (manual recording)

| R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 |
|---|---|---|---|---|---|---|---|---|---|
| REQUIRES HUMAN | REQUIRES HUMAN | REQUIRES HUMAN | REQUIRES HUMAN | REQUIRES HUMAN | REQUIRES HUMAN | REQUIRES HUMAN | REQUIRES HUMAN | REQUIRES HUMAN | NOT RUN (automated, after R1–R9) |

None has been performed. Related automated tests pass, but they are **not** counted as R results.
See [REAL_WORLD_VALIDATION.md § Results](REAL_WORLD_VALIDATION.md).

## 5. Security findings

| Severity | Finding | Status |
|---|---|---|
| P0 | Redirect hops bypassed Playwright request routing, so a local replay could be redirected onto production | Fixed. Verified live: production received 0 requests. |
| P0 | Cloud metadata endpoints were reachable | Fixed. Verified live: blocked as an environment URL, on import, and in the page. |
| P1 | The local API is reachable by **other users on a shared machine** | Open. Documented limitation (single-user workstations). Token fix planned for 0.1.1. |
| P1 | macOS and Linux keyring backends were never executed | Open. Windows-first release. |
| P2 | Intermittent extra step after the recording window is closed (1 in 7 runs) | Open. Watched by R9. |
| P2 | No upstream corporate proxy support, recordings contain production page text, set-aside `.corrupt-*` files | Documented |
| — | Plaintext `ui-shell.json`, session-file collision, and recording browsers invisible to the orphan sweep | **Fixed** in the release candidate (`rc` suite) |

Full detail: [SECURITY_AUDIT.md](SECURITY_AUDIT.md).

## 6. Outstanding risks and platforms

- **Supported:** Windows 10/11 x64, single-user workstation.
- **Experimental:** macOS and Linux (a startup notice is printed).
- **Not supported:** headless Linux without a keyring, and shared multi-user hosts.
- **Biggest risk:** the identity engine and Keycloak automation have never met the real
  application. Theme selectors, real DOM and token lifetimes are unverified.

## 7. Required human actions

These are the only steps that genuinely need a person:

1. Provide, in chat:
   - the QA/staging URL and the local URL;
   - written authorisation to test that QA environment;
   - the test account **username only**;
   - the known bug, with the expected and actual text;
   - the local fix branch, and how to start the local app on it.
2. Enter the test account's password **in Replayr** (Record Bug → Advanced). Never in chat.
3. Perform the manual recording R1–R9 and add the assertion (validation steps 3–4).
4. During step 10, enter a deliberately wrong password in Replayr, then restore the correct one.

Everything else runs autonomously once 1–3 are done:
- steps 1, 5–9, 11 and 12;
- R10;
- the cookie and production-isolation checks against the real app.

## 8. Evidence

All evidence is in `local-tests/validation-evidence/` (git-ignored):

| File | Contents |
|---|---|
| `00-npm-test.txt` | Full test-suite output, with the commit, branch, Node version and timestamp |
| `02-live-security.txt` | The 21 live security checks |
| `03-credentials.txt` | Migration dry run and the credential-artifact inventory (names only) |

Procedure and results table: [REAL_WORLD_VALIDATION.md](REAL_WORLD_VALIDATION.md).

## 9. Final recommendation: **NOT APPROVED**

Replayr has not yet been validated against a real application:
- no QA environment, account or human tester has been provided;
- R1–R10 are not done;
- one intermittent automated failure is open (P2).

When steps 1–12 and R1–R10 pass, and the intermittent failure is either explained or shown not
to occur in R9, the recommendation can move to **APPROVED** for Windows single-user workstations,
with the documented limitations.
