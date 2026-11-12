# Replayr — real-world validation

Date: 2026-11-12 · Status words: **VERIFIED** · **PARTIALLY VERIFIED** · **BLOCKED** · **NOT TESTED**

## Bottom line

**No real application, real Keycloak or human-driven recording has been validated.** The access
needed was not available on the validation machine:

| Prerequisite | Found |
|---|---|
| The OpKey UI Shell on `http://localhost:4201` (the default local target) | Not running (connection refused) |
| `credentials.local.env`, `custom-credentials.local.json`, `.auth/` sessions | None present |
| An explicitly authorised test account and test environment | None provided |
| `http://localhost:8080` | An unrelated nginx app (`/wd_discovery_2/`), not authorised as a test target, so it was **not touched** |
| The remote QA environment in `src/config.js` | Not authorised, so it was **not touched** |

Everything below that needed those prerequisites is reported **BLOCKED**, not passed. What *was*
done is the closest faithful substitute, and each item says exactly what it ran against.

## Results

| # | Scenario | What it ran against | Status |
|---|---|---|---|
| 1 | Record an actual workflow (human) | none | **BLOCKED**: needs a person, an app and an account. See the checklist below. |
| 1a | Record a workflow through the real Playwright recorder, input driven by code | local fixture app, headless Chromium (`tests/recording-lifecycle.test.js`) | VERIFIED |
| 1b | Record through the Replayr UI (real headed Chromium launched by the UI) | local fixture app (UX QA sweep) | PARTIALLY VERIFIED: start, live timeline, pause/resume, stop, review and save were exercised; the clicks inside the recording window were added through the API rather than by a person |
| 2 | Save the recording | local fixture | VERIFIED |
| 3 | Replay against localhost (recorded on a "production" instance, replayed on a "localhost" instance) | two instances of `tests/sample-app` on separate ports (`tests/replay.test.js` A) | VERIFIED: only the target was contacted |
| 4 | Verify assertions: the bug is fixed, so the run passes | sample app, fixed variant | VERIFIED |
| 5 | Failing assertion: the bug still reproduces | sample app, buggy variant | VERIFIED (*failed / assertion_failed*) |
| 6 | Inconclusive run (no assertion) | sample app | VERIFIED (*inconclusive / no_assertions*) |
| 7 | Cancellation | sample app, and the UI's Cancel button | VERIFIED (*cancelled*, remaining steps *not run*, browser gone) |
| 8 | Interruption: service stopped during a run | real server child process plus a slow fixture | VERIFIED: a graceful stop persists the run, and a hard kill is marked *error / interrupted* on the next start |
| 9 | Keycloak login: success, wrong password, expiry, MFA, missing credentials | **mock** Keycloak (`tests/fixtures/mock-keycloak.js`) | PARTIALLY VERIFIED (mock). Real Keycloak **BLOCKED**. |
| 10 | Ambiguous elements are never clicked | sample app, ambiguous variant | VERIFIED: refused, and the click did not happen |
| 11 | Changed markup is recovered when it is safe to | sample app, restructured variant | VERIFIED |
| 12 | Production confirmation and the HTTP 428 response | real server, sample-app environment of kind production | VERIFIED |
| 13 | Redirect to production during a localhost replay | Chromium plus local fixtures (`tests/safety.test.js`) | VERIFIED: the protected server received zero requests |
| 14 | Destructive actions against production | none | Deliberately **NOT run** |

## Unverified assumptions

These hold for the sample app and the mock. On a real application they are assumptions until the
checklist below is run.

- The real Keycloak login page still uses `#username`, `#password` and `#kc-login`, and shows errors
  in `#input-error` / `.kc-feedback-text`. A custom theme may differ.
- The real Angular app renders inside `app-root`, which the session check depends on.
- The identity engine's locator choices hold up on the real application's DOM, not just the
  fixtures and the sample app.
- Production and localhost data are similar enough for a recorded workflow to be meaningful on
  both. Replayr reports a cross-environment run but cannot check data parity.
- The guard proxy works on the developer's network. It does not support an upstream corporate
  proxy.

## Checklist to complete real-world validation

Use a **non-production** environment, or a production read-only flow, plus an account you are
authorised to use for testing.

1. Add the environments under **Applications & Environments**: the source (e.g. staging or
   production, with auth on) and **Localhost**.
2. Save the login on the Record screen. Confirm it is stored in the OS keyring:
   - Windows: `cmdkey /list` shows `Replayr:<origin>`.
   - `custom-credentials.local.json` holds no password.
3. Record a short, **non-destructive** workflow that shows a known bug. Run the
   [manual recording checklist](COMPATIBILITY_REPORT.md#manual-human-recording-checklist-blocked-for-automation-needs-a-person-and-a-real-window).
4. Add an assertion for the expected behaviour. Save.
5. Replay on Localhost **without** the fix. Expect *Failed · assertion failed*.
6. Apply the fix locally and replay. Expect *Passed*.
7. Remove the assertion and replay. Expect *Inconclusive*.
8. Replay and press **Cancel** mid-run. Expect *Cancelled*.
9. Stop the server mid-run, then start it again. Expect *Error · interrupted*.
10. Sign in with a wrong password. Expect a prompt *login-failed* that names the environment, with
    no retry.
11. Try to replay against the production environment. A confirmation must name it, and Cancel
    must leave nothing running.
12. Check the run evidence (`local-tests/runs/…`) for any credential or token, and check that the
    export contains none.

Record each outcome here, with the date, environment (never credentials) and tester.
