# Bug Replay Recorder

Reproduce a painful bug **once** in a real browser, save it as a readable test, and replay it later
against whatever code is running on this machine right now.

```
Start Recording → browser opens → reproduce the bug → Stop → name it → Save
                                                                        ↓
                            change your code … later …  Execute → PASS / FAIL at step N
```

Local-only developer tool: a small Node.js service plus a plain HTML/CSS/JS page, with Playwright as
its only dependency. It drives an application running on this machine; it does not need to live
inside that application's repository.

## What is different since the rebuild

A recorded step used to be one selector. One selector is a single point of failure: rename the
button, restyle it, move it two `<div>`s deeper, and the step breaks even though nothing about the
application is wrong.

A step is now an **identity fingerprint plus a validated, scored set of ways to find the element
again**. The promise is:

- If the button's text, CSS classes or DOM nesting change, the step **still finds it**.
- If the element is genuinely gone, or genuinely a different element, the step **fails** — it never
  clicks something else that happens to be in the same place.
- When it fails, it tells you exactly which strategies were tried, what each one found, and why
  each was rejected.

The whole engine is in [`src/identity/`](src/identity/) and has [its own guide](src/identity/README.md).

---

## 60-second quick start

Requires Node.js 18 or newer.

```
npm install
npx playwright install chromium     # first time only: downloads the browser build
npm start                           # → http://127.0.0.1:4310
```

Open `http://127.0.0.1:4310` in your browser. The app you want to record (by default the UI Shell
at `http://localhost:4201`) must be up, because that is what gets driven.

Then:

1. **Record** → pick the app → **Start recording**. A Chromium window opens, already signed in.
2. Reproduce the bug. Steps appear in the list as you go, in plain English.
3. **Stop**, give it a name, **Save**.
4. Change your code. Come back, press **Execute**. You get PASS, or FAIL at step N with a
   screenshot, the URL, the console errors and the locator attempts log.

---

## The four screens

Views are driven by the URL hash, so reload and Back both work.

| Hash | Screen | What it does |
|---|---|---|
| `#/tests` | **Library** | Every saved test, its step count and last result. Search, filter by all / passed / failed / never run. Execute, Edit, open the last run, Delete. |
| `#/record` | **Recorder** | The live step list while you work, then the draft to name, tidy and save. |
| `#/test/:id` | **Test detail** | The saved steps, editable values, and the inspector. |
| `#/run/:testId/:runId` | **Run result** | Per-step outcome and timing; on a failure the error, URL, screenshot, console errors, failed requests and what the locator engine tried. `:runId` is `live` while a run is in flight. |

Besides recording and running, the service can **pause and resume** a recording (Playwright's
recorder keeps running underneath; we simply stop accepting what it reports, which is safer than
re-entering the memoised `_enableRecorder`), **duplicate** a test, **import** a whole test as JSON
(its id, dates and history are ignored — this machine mints its own), and **open a plain logged-in
browser** with no recorder attached, for when you just want to look at something.

### The inspector

Select any step, in the recorder or in a saved test, and the right-hand pane explains how it will
be found:

- **Element** — tag, role, accessible name, where the name came from, own text, the attributes that
  were kept, and how many elements shared this identity when it was recorded.
- **How it will be found** — the candidate list, best first, each with its score, the sentence
  explaining that score, and a green/amber/red badge saying what happened when it was run against
  the live page (`verified`, `3 matches`, `matched nothing`).
- **Context** — the breadcrumb of semantic containers the element sits in.
- **Signals we distrust** — every attribute that was **rejected**, with the reason
  (`id: mat-input-27 · a framework-generated id`), plus any blind spot.
- **Warnings** — the fragility hints, computed from the fingerprint, not guessed by the page.

---

## Where things live

| Path | What |
|---|---|
```
src/                  server-side code
  identity/           the element identity engine
ui/                   the browser page (static, served by src/server.js)
tests/                the offline engine test suite
scripts/selftest.js   end-to-end smoke test against a running app
local-tests/          your recorded tests and run evidence (git-ignored, created on first save)
.auth/                saved login sessions (git-ignored)
```

| Path | What |
|---|---|
| `src/server.js` | the local HTTP service, bound to `127.0.0.1`; owns one recording and one run |
| `src/config.js` | ports, app base URLs, timeouts, where tests go |
| `src/auth.js` | reuses and renews the saved Keycloak session |
| `src/recording.js` | owns the recording browser, correlates actions to elements, builds the draft |
| `src/execution.js` | fresh context, replay, failure evidence |
| `src/steps.js` | the step model: recorded action → step → plain English → Playwright locator |
| `src/storage.js` | test JSON files and run folders |
| `src/identity/` | **the element identity engine** — see [src/identity/README.md](src/identity/README.md) |
| `src/identity/CONTRACT.md` | the agreement between the engine's modules |
| `src/identity/__fixtures__/` | before/after HTML pairs: text change, nesting change, generated ids, duplicates, replaced element, canvas |
| `ui/index.html` | the main page: plain HTML/CSS/JS, no build step, no external requests |
| `ui/recorder.html` | the standalone recorder panel |
| `scripts/selftest.js` | records and replays a real flow against the running Shell — the end-to-end smoke test |
| `tests/run-all.js` | runs the engine suite, one child process per file |
| `tests/unit.test.js` | the pure half: stability, candidates, scoring. No browser |
| `tests/fingerprint.test.js` | Chromium: extraction and matching against the fixture pages |
| `tests/positional.test.js` | Chromium: the DOM-index / relative-XPath / absolute-XPath fallbacks |
| `tests/e2e-fixture.test.js` | Chromium: record, change the page, prove the element is still found — or refused |
| `tests/harness.js` | a small test runner (no framework is installed) |
| `local-tests/*.json` | your tests |
| `local-tests/.trash/*.json` | deleted tests, kept so a delete is never final — see below |
| `local-tests/runs/<test>/<run>/` | `result.json`, `step-N.png`, `console.log` |
| `recorder.local.env` | optional config overrides, git-ignored |
| `credentials.local.env` | `OPKEY_USERNAME` / `OPKEY_PASSWORD`, git-ignored |
| `.auth/ui-shell.json` | the saved Keycloak session, git-ignored |

Every path above is relative to the repository root.

### Deleting a test does not delete it

A recorded test is fifteen minutes of your afternoon and cannot be regenerated from anything else
on disk, so `storage.remove()` never unlinks one. The JSON is **moved into
`local-tests/.trash/`** under `<id>--<timestamp>.json`, and the last 50 deletions are
kept; older ones are pruned. The run evidence under `runs\<test>\` *is* deleted outright — it is
large, and it can always be produced again by running the test.

This exists because a test was genuinely lost during development, to a delete nobody could later
account for. A copy in a trash folder costs a few kilobytes and makes that unrecoverable-by-accident
case impossible.

Two helpers go with it:

- `storage.listTrash()` — what is recoverable, newest first, as `{ file, name, deletedAt }`.
- `storage.restoreFromTrash(file)` — puts one back. It is re-created through the normal `create()`
  path, so it is re-validated on the way in and its id is re-minted if something has since taken
  the old one. The trash copy is removed once the restore succeeds.

The trash is a safety net, not a feature of the library screen: nothing in the UI lists it. To
recover a test, call the helper or copy the JSON back out of `.trash\` by hand.

---

## How recording works

Two independent sources of truth are combined, because neither is sufficient alone.

**1. Playwright's own recorder** — the engine behind `playwright codegen` — tells us *what the user
did*, at the right altitude. Six keystrokes arrive as one `fill`. A mouse-down and mouse-up arrive
as one `click`. Navigations, popups, new tabs, downloads and native dialogs arrive as *signals* and
are remembered on the step they followed. Getting all of that for free is why it is still here.

**2. Our identity capture** (`src/identity/browser-lib.js`, injected into every frame with
`addInitScript`) tells us *which element* they did it to — in full, at the instant they touched it,
before any re-render can take the node away. It listens in the **capture phase** on `pointerdown`,
`click`, `dblclick`, `change`, `focusin` and `keydown`.

`recording.js` then has to decide which capture a recorded action belongs to. The reliable way is
to ask the page: resolve Playwright's own selector and read back the `__recUid` we stamped on the
element. When that fails — almost always because the click navigated and the element no longer
exists — it falls back to the most recent *compatible* capture on that page within 8 seconds
(a `fill` may correlate to a `keydown`, `focus`, `change`, `pointerdown` or `click`, never to a
`dblclick`). Which route was used is recorded on the step as `resolvedBy`.

The identity work is asynchronous and serialised, so the step appears in the list instantly and its
locators fill in a moment later (`identityStatus`: `resolving` → `ok`). Stopping the recording
waits up to 8 seconds for that work to finish, or the last step of a recording would be saved
without its locators.

Noise is dropped on purpose: the first blank page, clicks on the page body, printable keys typed
into nothing, and the whole Keycloak round trip.

If the identity engine cannot attach at all, recording still works — the steps just fall back to
Playwright's single chosen selector, and the editor says so.

---

## How replay works

`execution.js` opens a **brand-new browser context** against whatever the app is serving right now.
Nothing from the recording is reused except the saved login.

Before the first step: wait up to 30 s for the app to answer (an `ng serve` may be recompiling —
the run reports `blocked`, not `failed`, if it never does), then make sure the Keycloak session is
valid.

For each step:

1. Find the element. A step with an identity target goes to `identity/resolve()`, which tries each
   saved candidate strongest-first, verifies that the element it found still looks like the one
   recorded, and refuses to guess between several. A step from an older test, or one whose identity
   capture failed, uses the single recorded selector — the old behaviour, kept so no existing test
   breaks.
2. Act, through Playwright's ordinary public API, which waits for the element to be attached,
   visible, stable and enabled.
3. Record the outcome, the duration, the URL, and how the element was found (strategy, locator,
   confidence, similarity, and the full attempts log).

On the first failing step the run stops and keeps the evidence: the error, the URL, a full-page
screenshot, console errors and failed requests since the run began, and the timing of every step.

### Waiting, and why there are no sleeps

Every action goes through Playwright's locators, which wait. A step that recorded a navigation also
waits for the page to load. Nothing calls `sleep`. For a slow agent round trip, raise one test's
budget with `settings.stepTimeoutMs`, or add an `expectVisible` step that waits for the answer
before the next click.

---

## A test file

Readable, diffable and hand-editable. `{{baseUrl}}` is resolved at run time, so a test is never
pinned to a port or to a day's code.

```json
{
  "id": "customer-save-bug",
  "name": "Customer Bug #123",
  "description": "",
  "target": { "app": "ui-shell" },
  "settings": { "stepTimeoutMs": 60000 },
  "tags": [], "folder": null, "favorite": false,
  "createdAt": "2026-09-09T10:11:12.000Z",
  "updatedAt": "2026-09-09T10:11:12.000Z",
  "steps": [
    { "id": "s1", "type": "navigate", "url": "{{baseUrl}}/design" },

    { "id": "s2", "type": "click", "at": "{{baseUrl}}/design",
      "identityStatus": "ok",
      "resolvedBy": "matched by element identity",
      "target": {
        "fingerprint": { "tag": "button", "role": "button", "name": "New Design Set", "…": "…" },
        "candidates": [
          { "strategy": "role",
            "params": { "role": "button", "name": "New Design Set", "exact": true },
            "score": 85, "why": "role \"button\" named \"New Design Set\"",
            "locator": "getByRole(\"button\", { name: \"New Design Set\", exact: true })",
            "matches": 1, "correct": true, "verified": true, "rejected": null }
        ],
        "primary": { "strategy": "role", "score": 85, "locator": "getByRole(\"button\", …)" }
      },
      "legacy": { "by": "role", "role": "button", "name": "New Design Set" },
      "fallbackSelector": "internal:role=button[name=\"New Design Set\"i]" },

    { "id": "s3", "type": "fill",
      "target": { "by": "label", "text": "Design set name" },
      "value": "Test Customer" },

    { "id": "s4", "type": "expectVisible",
      "target": { "by": "text", "text": "Design set created" } }
  ],
  "lastRun": null
}
```

Two target shapes exist and both keep working:

- **Identity target** — `target.fingerprint` + `target.candidates[]`, written by the engine. Replay
  goes through the resolver and `fallbackSelector` is ignored.
- **Legacy target** — a flat `{ by, … }` descriptor, from tests recorded before the rebuild or
  written by hand. Replay builds a locator through Playwright's public `getBy*` API — **unless** a
  `selector` or `fallbackSelector` is present, which wins verbatim. So if you hand-edit a legacy
  target, **delete the selector line too**, or your edit will not be what runs.

To add a test by hand, drop a file like this into `local-tests/` — no recording needed. `tags`
(≤20, ≤40 chars each), `folder` (one label) and `favorite` are validated on save and are there for
organising a growing library.

### Step types

`navigate` · `click` · `dblclick` · `hover` · `fill` · `press` · `check` · `uncheck` · `select` ·
`upload` · `openPage` · `closePage` · `expectVisible` · `expectText` · `expectValue` ·
`expectChecked` · `expectUrl` · `expectSnapshot` *(recorded, skipped at replay)*

### Locator strategies, most stable first

`testid` (100) → `id` (92) → `role` + accessible name (85) → `label` (82) → `attr` (74) →
`placeholder` / `altText` (68) → `title` (66) → `text` (55) → semantic `css` (40) → semantic
`xpath` (35) → `positional` (10)

The Shell has ~650 `aria-label` attributes and almost no test ids, so recorded steps are mostly
role-and-name — stable, and readable in English. The full scoring table and what each number means
is in [src/identity/README.md §5](src/identity/README.md#5-the-candidate-list-and-the-scoring-table).

---

## Where run evidence lives

```
local-tests/
  customer-save-bug.json
  runs/
    customer-save-bug/
      2026-09-09_10-42-07/
        result.json      status, per-step timings, resolution attempts, console + network errors
        step-9.png       full-page screenshot at the failing step
        console.log      console errors, one per line, tagged with the step number
```

Run ids are the ISO start time with `:` and `.` replaced. Deleting a test deletes its runs. The
outcome is also stamped back onto the test as `lastRun`, so the library can show
"Last run: FAIL at step 9".

---

## Login

Both recording and replay load the saved session, `.auth/ui-shell.json` (one file per app under
`.auth/`), so you start signed in and no login ever ends up inside a test.

When the Keycloak session is missing or has expired (it lasts about a day) the tool logs in again in
a throwaway headless browser using `credentials.local.env`, and rewrites the state file. The run
notes say "Login session was expired and has been renewed."

**What is persisted:** cookies and local storage for the app origin, in `.auth/<app>.json`.
**What is never persisted:** no password, no token, no header and no credential is ever written
into a test file, a run folder or a screenshot filename. `credentials.local.env` is git-ignored and
is only read to perform a login.

`ensureSession()` reports one of `no-auth-needed`, `valid`, `renewed`, `missing-credentials`,
`login-failed`, `app-unreachable`. Anything but the first three blocks the recording or the run,
deliberately.

---

## Configuration

Values are read from `recorder.local.env` in the repo root (`KEY=VALUE` lines, `#` comments, optional
quotes) and from real environment variables. **Real environment variables win.**

| Variable | Default | What it does |
|---|---|---|
| `RECORDER_PORT` | `4310` | port the service binds to on `127.0.0.1` |
| `RECORDER_UI_SHELL_URL` | `http://localhost:4201` | base URL of the `ui-shell` app (login required) |
| `RECORDER_CONCIERGE_URL` | `http://localhost:8080` | base URL of the `concierge` app (no login) |
| `RECORDER_QA1_URL` | the shared QA1 Studio URL | base URL of the remote `qa1` app (login required) |
| `RECORDER_TESTS_DIR` | `local-tests/` in the repo root | where test JSON and `runs/` go |
| `RECORDER_HEADLESS_RUN` | unset → runs are **headed** | set to `1`/`true`/`yes`/`on` to replay without a visible browser |

`OPKEY_USERNAME` and `OPKEY_PASSWORD` come from `credentials.local.env` (or the real environment)
and are used only to renew an expired Keycloak session. `OPKEY_<APP>_USERNAME` /
`OPKEY_<APP>_PASSWORD` (for example `OPKEY_QA1_USERNAME`) take precedence for that one app.

The port can also be given on the command line:

```
node src/server.js --port 4311
```

Not overridable by environment — change `src/config.js` if you really need to:

| Setting | Value | Note |
|---|---|---|
| `host` | `127.0.0.1` | on purpose: nothing off this machine may drive the browser |
| `testIdAttribute` | `data-testid` | what Playwright's `getByTestId` matches |
| `viewport` | 1400 × 900 | replay always; recording uses the real maximised window when headed |
| `stepTimeoutMs` | 30 000 | per-step; a test may override with `settings.stepTimeoutMs` |
| `navigationTimeoutMs` | 60 000 | |
| `appReadyTimeoutMs` | 30 000 | how long a run waits for the app before reporting `blocked` |
| `headedRecording` | `true` | recording is always visible; you are driving it |

Adding an app means adding an entry to `config.apps` in `src/config.js`: a label, a base URL and
whether it needs a login. A test stores only the key (`target.app`), so it follows whatever is
running locally today.

---

## Running the tests

There is no test framework installed and the engine does not need one. `tests/harness.js` is the
whole apparatus: `test()` collects, `assert` explains itself, one line of output per test, non-zero
exit code if anything failed. Run everything from the repo root.

| Command | Needs | What it proves |
|---|---|---|
| `npm test` (`node tests/run-all.js`) | nothing but Chromium | all four suites below, each in its own child process so a browser crash cannot take the pure half with it |
| `npm run test:unit` (`node tests/unit.test.js`) | nothing | the pure logic: stability heuristics, candidate generation, scoring. About a second |
| `npm run test:dom` (`node tests/fingerprint.test.js`) | Chromium | extraction and matching against the static `src/identity/__fixtures__/*.html` pages, with `browser-lib.js` injected exactly the way the recorder injects it |
| `node tests/positional.test.js` | Chromium | the positional fallbacks: DOM index, relative XPath, absolute XPath — and that they refuse when the element was replaced |
| `node tests/e2e-fixture.test.js` | Chromium | **the point of the tool**: record an element, change the page the way real applications change, show the element is still found — or that the engine refuses rather than clicking something else. Fixtures are strings in the file, so no server, no login, no network. `--headed` to watch |
| `npm run selftest` (`node scripts/selftest.js`) | the running Shell | the whole loop against the real Angular app: record, check the identity engine produced validated locators, save, reload, replay in a fresh browser. `--headed` to watch, `--keep` to leave the saved test behind. Exit 0 pass, 1 the recorder or app misbehaved, 2 the harness could not run at all |

Run `e2e-fixture.test.js` first when you change the engine — it is fast and offline. `selftest.js`
is the proof that the same engine survives a real application; it opens a profile and types in the
composer, both stable surfaces that need no cleanup and neither of which sends a chat turn.

The `src/identity/__fixtures__/*-before.html` / `*-after.html` pairs are the DOM-change scenarios:
text change, nesting change, generated ids, duplicate buttons in different containers, ambiguous
buttons in no container, a replaced element, a removed element, late-rendering content, tables and
labels. Each file's comment says what the engine must and must not do with it.

A test named `[known bug]` documents a gap between the code and `identity/CONTRACT.md` that was
open when it was written. The contract has since been reconciled with the code and these tests are
green; see [src/identity/README.md §11](src/identity/README.md#11-the-code-and-contractmd-agree).

---

## Safety notes

The service binds to `127.0.0.1` and rejects any request carrying a cross-origin `Origin` header,
so no other machine and no other web page can drive your browser. One recording and one run at a
time; each refuses with `409` while the other is active. The browser is closed on stop, on run end,
on `SIGINT`/`SIGTERM` and on an uncaught exception.

Runs hit the real backend, so a test that creates a design set really creates one every time. That
is the price of a true regression check; the run's step list records what it did.

---

## Troubleshooting

### The recorder will not start

- **"Cannot record while logged out"** — deliberate. Recording is refused unless a valid Keycloak
  session already exists, because otherwise the login would land inside your test. Fix the session
  first: check `credentials.local.env`, then try again so `.auth/ui-shell.json` is regenerated.
- **"A recording is already in progress" / "A test is running"** — one at a time. Stop the other
  one; if a browser was killed by hand, press Stop once to reset the state.
- **"identity capture unavailable"** in the console — recording continues, but every step falls
  back to Playwright's single selector. Usually a Playwright version change; see below.

### A replay fails for the wrong reason

- **A name with a clock in it.** `Dev's Profile Maheep Gupta 1h` matches for exactly one hour. The
  engine flags any accessible name containing a relative time, a date, a clock time, a long number
  or a GUID fragment (`fingerprint.volatileName`), costs that candidate 30 points, and warns in the
  inspector. Prefer another locator, or get the name changed.
- **Two matches.** The engine refuses to pick. Give the element or its container a `data-testid` or
  an `aria-label` — naming the container is the fix, `nth()` is not.
- **A canvas.** GoJS diagrams, bpmn-js editors and ECharts charts all draw themselves onto a
  `<canvas>`. There is no element behind the shape, so a click there is a coordinate. Those steps
  are flagged as blind spots and hold only while the layout is identical. Assert on something
  outside the drawing.
- **CDK overlays.** Angular CDK renders dropdown panels, menus and dialogs into an overlay
  container at the end of `<body>`, **not** inside the trigger's DOM subtree. A dropdown panel is
  therefore not a descendant of the button that opened it, and scoping the option to the button's
  section will find nothing. Scope to the overlay's own `role="listbox"` / `role="dialog"` instead,
  or leave the option unscoped.
- **Angular rebuild attributes.** `_ngcontent-ng-c123456` changes on every rebuild. The engine
  never reads it — it is in the never-read list, not even in `volatile` — so if you see one in a
  hand-written selector, that is your bug.
- **Generated ids.** `mat-input-27`, `ss-0-listbox`, `:r7:`, `cdk-describedby-message-3` and
  friends are minted per page load. They are rejected with a reason, which is shown in the
  inspector under "Signals we distrust". This is why a step is using role+name when you expected it
  to use the id.
- **The Shell was recompiling.** A run waits up to 30 s for the app and reports `blocked` with a
  message, rather than failing.

### Reading a failure

Open the run and read **"What the locator engine tried"** — every strategy, its locator, how many
elements it matched and why it was rejected, in order. `src/identity/README.md §8` has a table that
maps what the log shows to what actually happened. The same data is in
`local-tests/runs/<test>/<run>/result.json` under `steps[].resolution`.

### Playwright internals

`recording.js` uses `context._enableRecorder()`, `context._disableRecorder()` and
`context._exposeConsoleApi()`. All three are **internal** APIs — the underscore is Playwright's own
warning, and `BrowserContext.enableRecorder` is marked `internal: true` in its protocol.
`package.json` pins `playwright` to exactly **1.62.1**; keep it pinned and read the diff before
upgrading.

Two behaviours worth knowing:

- **`_enableRecorder` is memoised per context.** Internally it is
  `Recorder.forContext(context, params)`, which caches the recorder promise on the context object,
  so the `params` of a second call are silently ignored — only the client-side event sink is
  replaced. Call it **once** per context, with the params you want, which is what `recording.js`
  does.
- **`_exposeConsoleApi()` is what puts `window.playwright` in the page's main world.** The identity
  extractor uses `window.playwright.ariaSnapshot(el)` to get Playwright's *own* role and accessible
  name, because Playwright's `getByRole` is what will run later, so its opinion beats ours. Both
  recording and replay call it. Without it the extractor falls back to its own computation and
  records `roleNameSource: "computed"`.

**If the internal recorder API ever breaks**, in order of preference: pin `playwright-core` to the
last working version; or check whether the event sink names (`actionAdded`, `actionUpdated`,
`signalAdded`) or the `{ mode, recorderMode: 'api', language: 'jsonl' }` params were renamed and
adjust `src/recording.js`; or, as a last resort, drive recording from our own capture stream — the
`src/identity/browser-lib.js` listeners already report every `pointerdown`, `click`, `dblclick`,
`change`, `focusin` and `keydown` with a full fingerprint. What would have to be rebuilt is the
*action semantics* Playwright gives us for free: merging keystrokes into one `fill`, telling a
click from a double-click, and the navigation/popup/dialog signals. The identity engine itself does
not depend on any Playwright internal.

### Nothing at all happens

The page holds a server-sent-events connection to `/api/events`, and a banner appears in the header
the moment it drops (it retries with a backoff). If it stays down the service died — look at the
terminal where you ran `npm start`. `uncaughtException` shuts the service down on purpose rather
than leaving an orphaned browser behind.
