# Replayr — real-world validation procedure (release candidate 0.1.0)

**Status: NOT YET PERFORMED.** No real application, real Keycloak or human-driven recording has
been validated. Everything Replayr has been tested against so far is a local sample app, a mock
Keycloak, or the real Playwright recorder driven by code. This document is the exact procedure that
turns those into a real-world result.

Status words: **PASS** · **FAIL** · **BLOCKED** (could not be run) · **NOT RUN**. Never write PASS
for a step that was not actually performed.

---

## 0. Before you start

**You need:**

| | Value (fill in; never write a password here) |
|---|---|
| Authorised **source** environment, **non-production** (staging/QA). Production only for read-only steps, with written authorisation. | URL: |
| **Local** build of the same application | URL (e.g. `http://localhost:4201`): |
| Test account authorised for automated sign-in on the source environment. Not a personal or admin account. | Username only: |
| A **known, non-destructive bug** reproducible on the source environment, and a local branch where it is fixed | Bug id: |
| Tester, date, Windows version, `node -v`, Replayr commit | |

**Set up the evidence folder:**

```powershell
cd <path-to>\RecordAndTest
git log --oneline -1                      # record the commit
node -v
npm ci                                    # exact, locked dependencies
npx playwright install chromium
mkdir local-tests\validation-evidence     # inside local-tests/, which is git-ignored
npm test 2>&1 | Tee-Object local-tests\validation-evidence\00-npm-test.txt
```

**Expected:**
- the summary line reads `TOTAL 270 passed 0 failed of 270`;
- the server log, when started below, shows `playwright 1.62.1: compatible`.

**Evidence rules** for every step:
- Take a screenshot (`Win+Shift+S`) into `local-tests\validation-evidence\NN-*.png`.
- Copy the server-log lines you see.
- Never capture a password, a cookie or a token. Blur them if they appear on screen.
- If one appears in any Replayr file, log or report, that is itself a **FAIL**: stop and report it.

---

## 1. Start Replayr and add both environments

```powershell
npm start 2>&1 | Tee-Object local-tests\validation-evidence\server.log
```

1. Open `http://127.0.0.1:4310` and go to **Applications & Environments** → **Add environment**.
2. Add the source environment:
   - Application: `<your app>`
   - Key: `src-env`
   - Base URL: the source URL
   - Kind: **Staging** (or **Production** if it is production)
   - Login automation: on
3. Add the local environment:
   - Same application name
   - Key: `local`
   - Base URL: the local URL
   - Kind: **Local**
   - Login as required locally

**Expected:**
- Both rows appear grouped under the application.
- A production-kind row shows a red shield and **Protected**, and cannot be unprotected.
- The strip "Production → Local" appears when one environment of each kind exists.

**Evidence:** `01-environments.png`.

## 2. Save the login and prove it is in the OS keyring

1. On **Record Bug**, choose the application and `src-env`.
2. Open **Advanced** and enter the test account's username and password.
3. Start the recording, then discard it after the window opens. (Saving happens on start.)
4. Run:

   ```powershell
   cmdkey /list | Select-String "Replayr"
   Get-Content custom-credentials.local.json
   Select-String -Path custom-credentials.local.json -Pattern '<a few characters of the password>' -SimpleMatch
   ```

**Expected:**
- `cmdkey` lists `Replayr:<source origin>`.
- The JSON file shows the username and `"store": "keyring"`, and **no** password.
- `Select-String` finds nothing.

**Evidence:** `02-keyring.txt`. Paste the `cmdkey` line and the JSON only, never the password.

## 3. Record the bug by hand (the actual recorder interface)

Follow [§ Manual recording procedure](#manual-recording-procedure-human-driven) below, steps R1–R10.
This step is only valid if a person performs it through Replayr's UI and the real browser window.

**Expected:** every R-check passes.

**Evidence:** `03-*.png` as listed in the procedure.

## 4. Add an assertion for the expected behaviour and save

1. In **Review**, select the step whose element shows the result.
2. Choose **Add assertion → Expect text** with the *correct* (expected) text. The "no assertion"
   warning disappears.
3. Fill **Expected** and **Actual** behaviour and **Severity**, then **Save**.

**Expected:**
- The test detail shows **Recorded on `src-env`** → **Run on** with `local` preselected.
- The Overview tab lists the assertion.

**Evidence:** `04-test-detail.png`, plus `Get-Content local-tests\<id>.json`.

**Check the saved file:**

```powershell
Select-String -Path local-tests\<id>.json -Pattern 'password|token=|Bearer|<the account password>' -SimpleMatch
```

**Expected:** nothing found, except the redacted field marker (`"secret": true`).

## 5. Replay on localhost WITHOUT the fix → the bug still reproduces

1. Run the local app on a branch that still has the bug.
2. On the test, choose **Run on: local** and press **Run**.

**Expected:**
- No production confirmation appears, because the target is local.
- The verdict is **Failed · assertion failed** ("the bug still reproduces").
- The failed step shows a screenshot, the expected vs actual text, and the locator diagnostics.
- The report's target is `local`, and the cross-environment marker reads "recorded on src-env".

**Evidence:** `05-failed.png`, plus `local-tests\runs\<id>\<run>\result.json`.

## 6. Replay on localhost WITH the fix → verified

Switch the local app to the fixed branch and run again.

**Expected:** **Passed · assertions passed**. The summary says the expected behaviour was verified.

**Evidence:** `06-passed.png`.

## 7. Inconclusive run

1. **Duplicate** the test.
2. In the copy, delete the assertion step and save.
3. Run it on `local`.

**Expected:** **Inconclusive · no assertion**: "Steps completed … the fix is not verified". It is
never shown as Passed.

**Evidence:** `07-inconclusive.png`.

## 8. Cancellation

Run the test on `local` and press **Cancel run** within the first few steps.

**Expected:**
- **Cancelled**, with the remaining steps marked *not run*.
- About 5 seconds later, no `chrome.exe` started by this run remains:

  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object CommandLine -like '*--replayr-owner*' | Measure-Object
  ```

  Expected count: 0.

**Evidence:** `08-cancelled.png`, plus the command output.

## 9. Interruption (service stopped mid-run)

1. Start a run on `local`.
2. While it runs, press `Ctrl+C` in the `npm start` window.
3. Run `npm start` again and open the test's history.

**Expected:**
- The run is **Cancelled** (graceful stop) or **Error · interrupted** (hard stop). It is never
  stuck "running".
- The `--replayr-owner` process count is 0.

**Evidence:** `09-interrupted.png`, plus the server-log lines.

## 10. Keycloak: wrong password and expired session

1. On the Setup form, save a **wrong** password for `src-env`.
2. Run the test against `src-env`. If `src-env` is production, cancel at the confirmation and use
   a staging environment instead.
3. Restore the correct password.
4. In the server log, delete only that environment's session file, `.auth\src-env.json`.
5. Run again.

**Expected:**
- Wrong password: **Blocked · could not sign in**, within a few seconds (not ~60 s). The message
  says the saved username or password was rejected. Exactly **one** login attempt appears in
  Keycloak's admin events, so there was no retry loop.
- After deleting the session: Replayr signs in again and the run proceeds.
  `Get-Content .auth\src-env.json` shows `"format":"replayr-enc-v1"` (encrypted), not cookies.
- If the account has MFA: **Blocked**, and the message names the second factor. Replayr must
  never fill an OTP.

**Evidence:** `10-keycloak.png`, plus a redacted log excerpt.

## 11. Production confirmation (no destructive action)

On a test whose source is a **production**-kind environment, choose **Run on: production**.

**Expected:**
- A confirmation names the environment and its URL.
- **Cancel** closes it and nothing runs. The server log shows no run start.
- Do **not** confirm unless the workflow is read-only and you are authorised.

**Evidence:** `11-confirm.png`.

## 12. Evidence and export hygiene

```powershell
Select-String -Path local-tests\runs\**\* -Pattern '<a few characters of the password>' -SimpleMatch
Invoke-WebRequest http://127.0.0.1:4310/api/tests/<id>/export -OutFile local-tests\validation-evidence\12-export.json
Select-String -Path local-tests\validation-evidence\12-export.json -Pattern 'access_token=|Bearer |<password chars>' -SimpleMatch
```

**Expected:**
- No match in run evidence or the export.
- Query tokens in URLs appear as `REDACTED`.

**Evidence:** `12-hygiene.txt`.

---

## Results — run of 2026-11-12 (release engineer, autonomous phase)

Only what was **actually executed** is marked PASS. Nothing here counts as real-world validation
yet: no authorised QA environment, test account or human tester has been provided.

| Step | Result | Evidence | Notes |
|---|---|---|---|
| 0 Prerequisites, `npm test` | **PARTIAL** | `00-npm-test.txt` | `npm test` gave 269/270. The one failure is in `lifecycle` (*user closes the browser*): one extra step appeared after the close. It did not reproduce in 4 loaded re-runs of that suite or 9 targeted probes; see the release report. The QA URL, account, bug and fix branch are **not yet provided**. |
| 1 Environments | **BLOCKED** | — | Needs the QA and local URLs |
| 2 Keyring | **BLOCKED** | `03-credentials.txt` | No credentials are saved yet. The migration dry run reports nothing to move, and there are 0 Replayr entries in Credential Manager. |
| 3 Manual recording (R1–R10) | **REQUIRES HUMAN** | — | See the R table below |
| 4 Assertion + save | **REQUIRES HUMAN** | — | Follows step 3 |
| 5 Bug reproduces (Failed) | **BLOCKED** | — | Needs the recording and the local bug branch. It can be run autonomously afterwards. |
| 6 Fix verified (Passed) | **BLOCKED** | — | Needs the local fix branch. It can be run autonomously afterwards. |
| 7 Inconclusive | **BLOCKED** | — | It can be run autonomously after step 4 |
| 8 Cancel | **BLOCKED** | — | It can be run autonomously after step 4 |
| 9 Interruption | **BLOCKED** | — | It can be run autonomously after step 4 |
| 10 Keycloak | **BLOCKED** | — | Needs the human to enter the test account in Replayr. Wrong-password and MFA behaviour are verified against the mock only (`auth` suite). |
| 11 Production confirmation | **PASS (local fixtures)** / BLOCKED (real app) | `02-live-security.txt` | Through a real server: 428 `confirm-protected`, and nothing ran |
| 12 Hygiene | **BLOCKED** | — | Needs a real recording. Export and redaction are verified on fixtures (`replay` G0–G2). |

**Live security checks through a real Replayr server** (`02-live-security.txt`, isolated port and
temp data, local fixtures only): **21/21 PASS**. They cover:
- the cross-site `Origin` check, the DNS-rebinding `Host` check, and the null-body 400;
- metadata refused as an environment URL and on import, and `file:` refused;
- production protected automatically, with 428 without confirmation, and 409 for cancel with no
  run;
- a local replay where **production received 0 requests** while the 302 redirect hop, the page's
  `fetch()` and the cloud-metadata `<img>` were each blocked and recorded without query strings.

### R1–R10

| R | Can it be automated? | Result | Related automated evidence (does NOT count as the R check) |
|---|---|---|---|
| R1 Start from the wizard | No: needs a person in the real UI | **REQUIRES HUMAN** | The UX sweep started a headed recording through the UI |
| R2 Click/type/select/tick/navigate captured | No: human input on real markup | **REQUIRES HUMAN** | `compat`, `lifecycle`: machine-driven capture works |
| R3 Password redacted | No | **REQUIRES HUMAN** | `lifecycle`: a password never reaches state, the draft or files |
| R4 Pause / Resume, including the in-page bar | No | **REQUIRES HUMAN** | `lifecycle` pause/resume (API) |
| R5 Popup / new tab | No | **REQUIRES HUMAN** | Not covered by any automated test |
| R6 Inspector stays on the selected step | No | **REQUIRES HUMAN** | Not covered by any automated test |
| R7 Compact panel | No | **REQUIRES HUMAN** | The UX sweep rendered compact mode |
| R8 Stop → Review | No | **REQUIRES HUMAN** | `lifecycle` stop (API) |
| R9 Close-window and stop-while-starting | No | **REQUIRES HUMAN** | `lifecycle`. The intermittent extra step on close is exactly what R9 should watch for. |
| R10 Clean-up check | **Yes**, once R1–R9 are done | **NOT RUN** | The release engineer runs the two commands after the human session |

---|---|---|---|
| 0 Prerequisites, `npm test` | | | |
| 1 Environments | | | |
| 2 Keyring | | | |
| 3 Manual recording (R1–R10) | | | |
| 4 Assertion + save | | | |
| 5 Bug reproduces (Failed) | | | |
| 6 Fix verified (Passed) | | | |
| 7 Inconclusive | | | |
| 8 Cancel | | | |
| 9 Interruption | | | |
| 10 Keycloak | | | |
| 11 Production confirmation | | | |
| 12 Hygiene | | | |

---

## Manual recording procedure (human-driven)

**What makes this valid:**
- A person drives everything.
- Recording starts from Replayr's **Record Bug** screen, never from a script, `node -e`, the API,
  or the test suite.
- The person interacts with the real **headed** Chromium window that Replayr opens, using a mouse
  and keyboard.

The automated suites already cover the code paths. This procedure covers what they cannot:
- the real recorder UI and in-page bar;
- human timing and input;
- real application markup.

Keep the Replayr page and the `/recorder` panel visible next to the browser window.

**R1. Start from the wizard.** On **Record Bug**, pick the application and `src-env`. Optionally
fill bug details, then press **Start recording on src-env**.
- Expected: a Chromium window opens on the source URL.
- Expected: the live workspace shows **Recording**, the environment badge, and the current page
  title and URL.
- Expected: for a production-kind source, a red "Recording on PRODUCTION" warning is shown.
- Evidence: `03-R1.png`.

**R2. Click, type, select, tick, navigate.** In the Chromium window, do each of these by hand:
- click a button;
- type a word into a text field;
- choose an option in a dropdown;
- tick a checkbox;
- click a link that changes page.

Expected:
- Each action appears **immediately** in the timeline as one plain sentence: *Clicked "…"*,
  *Filled "…"*, *Selected "…"*, *Checked …*, *Navigated to …*.
- Typing six characters is **one** Fill step.
- The current URL in the live card follows the navigation.

**R3. Password field.** Type into a password field.
- Expected: the step shows a lock and "value not stored".
- Expected: nowhere in the timeline, inspector or `/recorder` panel is the value visible.

**R4. Pause / Resume.**
- Press **Pause** in Replayr, then click around in the browser. Expected: no new steps.
- Press **Resume**, then click. Expected: the step is recorded.
- Use the in-page bar's Pause/Resume as well. Expected: the bar's own buttons never become steps.

**R5. Popup or new tab** (if the app has one). Open it and act in it.
- Expected: the actions are recorded with their page.

**R6. Inspect.** Select an older step during recording.
- Expected: the inspector stays on it while new actions arrive.
- Expected: the inspector shows element, role, name, locator candidates and a confidence badge.

**R7. Compact panel.**
- Press **Open compact panel**. Expected: `/recorder` opens.
- Toggle compact mode. Expected: status, timer, step count and controls remain usable.

**R8. Stop → Review.** Press **Stop**.
- Expected: the Review screen lists every step.
- Expected: warnings are amber, errors are red, and the "no assertion" nudge is shown.
- Evidence: `03-R8.png`.

**R9. Close-window case.**
- Start a second recording, do two actions, then close the Chromium window with its **X**.
- Expected: the recording ends as **stopped**, with both steps kept and saveable.
- Then start again and press **Stop** while the window is still opening. Expected: no stray
  window, and Replayr returns to idle.

**R10. Clean-up check.** After R8–R9:

```powershell
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object CommandLine -like '*--replayr-owner*' | Measure-Object
Get-ChildItem $env:TEMP -Directory -Filter 'playwright_chromiumdev_profile-*' | Where-Object LastWriteTime -gt (Get-Date).AddMinutes(-30)
```

Expected: a count of 0, and no recent profile folders left behind.

Record R1–R10 as PASS or FAIL in the step 3 row. Any FAIL in R2, R3 or R10 is a release blocker.
