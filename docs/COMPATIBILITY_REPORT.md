# Replayr — Playwright compatibility report

Date: 2026-11-12 · Machine: Windows 11, Node 24, Chromium (Playwright build) · Status words: VERIFIED · PARTIALLY VERIFIED · BLOCKED · NOT TESTED

## Supported versions

| | |
|---|---|
| Playwright (pinned exactly in `package.json` / `package-lock.json`) | **1.62.1** |
| Tested | 1.62.1 |
| Accepted range | 1.62.x. Recording refuses to start outside it, with an actionable error. |
| Node.js | ≥ 18 (developed and tested on 24) |
| Browsers | Chromium for replay. Recording also offers Firefox and WebKit, but those are **NOT TESTED**. |

**Do not upgrade Playwright without running the procedure below.** Replayr's recorder depends on
private Playwright APIs that can change in any minor release.

## Private API inventory

All private APIs live in `node_modules/playwright-core/lib/coreBundle.js`. Grep the names to
diff a new version. Every call now goes through **`src/pw-compat.js`**. No other file calls them
directly.

| API (BrowserContext) | Purpose | Required? | Used by |
|---|---|---|---|
| `_enableRecorder(params, sink)` | Playwright's codegen recorder in `recorderMode: 'api'`. It emits `actionAdded` / `actionUpdated` / `signalAdded`. | **Required.** Recording cannot work without it. | `recording.js` |
| `_disableRecorder()` | Turns the recorder off at stop. | Optional. The adapter degrades without it. | `recording.js` |
| `_exposeConsoleApi()` | Exposes `window.playwright` in every frame. The identity library uses it. | Optional. Without it, identity capture is weaker but still attaches. | `recording.js`, `execution.js` |

Action shape consumed by `steps.fromRecorderAction` (VERIFIED on 1.62.1):
`{ pageGuid, frame, action: { name, selector, signals, … }, startTime }`. The action names seen are
`openPage`, `navigate`, `click`, `fill`, `select`, `check` and `press`. The `ref` field is new in
1.62 and ignored.

## What the adapter does

- `checkCompat()` runs at server boot and checks the version, logged as
  `playwright 1.62.1: compatible`. A full feature check runs at **recording start**, before any
  login or navigation.
- A missing required API raises `IncompatiblePlaywrightError` (`code: PLAYWRIGHT_INCOMPATIBLE`):
  *"Replayr's recorder needs Playwright 1.62.x (tested: 1.62.1); installed X; run "npm ci" to
  restore the pinned version. Missing: …"*
- **Two fixes came out of this work:**
  - **P1:** a missing `_exposeConsoleApi` used to throw a TypeError that was swallowed, which
    silently disabled identity capture for a whole recording. It now degrades for that one API
    only.
  - **P2:** an action name the step model does not know is now logged once per name. It used to
    be dropped silently.

## Compatibility tests

| Suite | What it proves | Status |
|---|---|---|
| `tests/compat.test.js` (the **upgrade canary**) | The installed version is supported, every wrapped API exists, and the typed error works. A **real headless recording** through the private recorder captures click, fill, select, check, press and navigation, and converts them into Replayr steps. | VERIFIED |
| `tests/recording-lifecycle.test.js` | A **machine-driven real recording** (real recorder, input driven by Playwright). It checks: <br>• a password never appears in state, draft, saved test or any file<br>• pause and resume<br>• stop, save, discard and restart<br>• stop while starting<br>• the user closing the window<br>• 5 start/stop cycles leave no browser processes and no temp profiles | VERIFIED |
| Headed (windowed) recording | | NOT TESTED by automation (see the manual checklist) |
| Firefox / WebKit recording | | NOT TESTED |
| Popups / multi-tab / iframes while recording | | NOT TESTED |
| hover, uncheck, setInputFiles and assert* recorder actions | | NOT TESTED |

## How to validate a Playwright upgrade

1. Bump the pinned version in `package.json`, then run `npm install` to update the lockfile.
2. Run `node tests/compat.test.js`. It fails on any of these:
   - the version is not listed as tested
   - a private API is missing
   - action names or fields changed
   - the locator shape changed
   - the step conversion no longer produces the expected step types
3. Run `node tests/recording-lifecycle.test.js`, then `npm test`.
4. Diff the bundle regions for `_enableRecorder`, `ProgrammaticRecorderApp`,
   `JsonlLanguageGenerator` and `BrowserContextEnableRecorderParams`.
5. Only then add the version to `SUPPORTED.tested` in `src/pw-compat.js` (and widen `range` for a
   new minor version).
6. Run the manual checklist below once.

## Manual human-recording checklist (BLOCKED for automation: needs a person and a real window)

Run this before each release and after every Playwright upgrade, on a real, **non-production** app.

1. Start Replayr, choose the app, and press Record. A headed window opens. The in-page Replayr bar
   is visible, and the first "go to the app" step appears.
2. Click a button, type in a text field, pick a select option, tick a checkbox, and click a link
   that navigates. Each action shows as **one** step: six typed characters are one Fill.
3. Type into a password field. The step shows as redacted, with no value anywhere: not in the
   panel, the saved test or `.draft.json`.
4. Press Pause, click around (nothing is recorded), press Resume, then click (this is recorded).
   The bar's own buttons never appear as steps.
5. Open a link in a new tab or popup. The step is recorded with its page index, and actions in the
   popup are recorded too.
6. Press Stop and Save with a name. The test appears in the library with all its steps.
7. Start again, record two steps, then close the browser window. The recording ends as stopped,
   the steps are kept, and it can be saved.
8. Start, then press Stop at once while the window is still opening. No stray window is left.
9. Check Task Manager or `ps`. No orphaned chrome or chromium processes remain, and no
   `playwright_chromiumdev_profile-*` folders remain in the temp folder.
10. Replay the saved test against the same app and confirm it passes.
