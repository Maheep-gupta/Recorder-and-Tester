# The element identity engine

> **Changed since this README was written — the positional band.** What used to be one strategy
> called `positional` is now three, separately named and separately scored: `domIndex` (12),
> `relativeXPath` (10) and `absoluteXPath` (6), tried in that order after every semantic strategy.
> The fingerprint now carries a first-class `domIndex` object as well. They are no longer dropped
> when the recorded element was ambiguous — they are tried, and refused unless the identity check
> agrees. `CONTRACT.md` §1, §3, §4, §5 and §8 are the current word wherever this file disagrees.

This folder answers one question twice.

At **record time**: *what makes the element the developer just touched identifiable?*
At **replay time**: *which element on the page in front of me now is that same element?*

Nothing here knows what a test, a step, a run or an HTTP route is. Give it a Chromium page and an
HTML file and it works. That is deliberate — see [§9 How to extend it](#9-how-to-extend-it).

- `CONTRACT.md` is the agreement between the modules. Read it before you change one.
- This file is the *why*. Read it before you read the code.
- Where the code and `CONTRACT.md` disagree, the code wins. They currently agree — see
  [§11](#11-the-code-and-contractmd-agree).

---

## 1. The problem with the obvious approach

The obvious thing to do is generate one selector and save it. Every recorder starts there. It
fails, and it fails in three different ways — all three have a fixture in `__fixtures__/`.

**Way one: the selector describes what changed.** `__fixtures__/text-change-before.html` has

```html
<button data-testid="save-customer" class="btn primary">Save Customer</button>
```

and after an ordinary afternoon of work (`text-change-after.html`) it is

```html
<button data-testid="save-customer" class="button-primary">Save</button>
```

Same button. Same job. But `//button[normalize-space()='Save Customer']` now matches nothing, and
so does `.btn.primary`. Nothing about the application broke; the test did.

**Way two: the selector describes where it was.** `nesting-change-before.html` wraps the button as
`div#app > div[role=region] > div.body > button`. The after page wraps the *same* button as
`section > article > div.body > div.row > button`. An absolute XPath — the fallback every recorder
reaches for — is now wrong by two levels.

**Way three, the dangerous one: the selector still matches, and matches the wrong thing.**
`replaced-before.html` has a Save button. In `replaced-after.html` a *Delete* button sits in
exactly the same DOM position. `/html/body/section/button` matches exactly one element. It is
unique. It is also Delete. A test built on it passes while deleting the customer.

That last case is why this engine exists and why it is shaped the way it is. **Uniqueness is not
correctness.** A locator is only trustworthy if you also check that the thing it found is the thing
you meant. So the engine records *many independent descriptions* of the element, plus enough of the
element's identity to recognise it later, and it would rather fail loudly than click something
plausible.

---

## 2. The model

```
 RECORD                                        │  REPLAY
 ──────                                        │  ──────
                                               │
 the DOM element the user touched              │  the target, loaded from the test JSON
        │                                      │        │
        │ browser-lib.js  (INSIDE the page)    │        │ resolver.js  (Node)
        ▼                                      │        ▼
   ┌──────────────┐                            │  take each candidate, best score first
   │ FINGERPRINT  │ role · accessible name     │  build it with locators.js, count matches
   │              │ attrs · context · text     │        │
   │              │ sibling counts             │        ├─ 0 matches → next candidate
   └──────┬───────┘                            │        │
          │ candidates.js  (pure)              │        ├─ 1 match   → read that element's LIVE
          ▼                                    │        │              fingerprint, compare it
   ┌──────────────┐                            │        │              (similarity.js),
   │ CANDIDATES   │ testid · id · role+name    │        │              accept or next candidate
   │  (unproven)  │ label · attr · text        │        │
   │              │ css · xpath · positional   │        └─ >1        → re-scope to the recorded
   └──────┬───────┘                            │                       container; still >1, rank
          │ validate.js  (needs a live page)   │                       by similarity; no clear
          ▼                                    │                       winner → refuse to guess
   ┌──────────────┐ how many did it match?     │        │
   │  VALIDATED   │ was one of them the        │        ▼
   │              │ element we stamped?        │  a Locator pinned to ONE element
   └──────┬───────┘                            │  …or ResolutionError carrying every
          │ scoring.js  (pure)                 │     attempt, in order, with the reason
          ▼                                    │
   ┌──────────────┐                            │
   │    TARGET    │ { fingerprint,             │
   │              │   candidates[], primary }  │
   └──────┬───────┘                            │
          │ index.js buildTarget()             │
          ▼                                    │
   saved on the step by ../storage.js          │
```

The words, once, so the rest of this file can use them:

| Term | What it is | Where it lives |
|---|---|---|
| **fingerprint** | everything worth knowing about one element's identity, as JSON | `browser-lib.js` → `fingerprint(el)` |
| **candidate** | one independent way of naming the element: `{ strategy, params, scope?, flags, score, why }` | `candidates.js` → `candidatesFor(fp)` |
| **validation** | what happened when that candidate was actually run against the page | `validate.js` → `validateCandidates()` |
| **target** | the fingerprint plus the validated candidate list — the thing that gets saved | `index.js` → `buildTarget()` |
| **similarity** | how much a found element still looks like the recorded one, 0–100 | `similarity.js` → `compare()` |
| **resolution** | picking one live element from a saved target, or failing with an explanation | `resolver.js` → `resolve()` |

`index.js` is the only file the rest of the recorder imports. The two calls that matter are
`buildTarget(root, fingerprint)` at record time and `resolve(root, target)` at replay time;
`summarise()` and `warningsForTarget()` feed the inspector, and `SOURCE` / `installSource()` are
the injectable page script (with and without the capture listeners). The lower-level pieces
(`candidatesFor`, `validateCandidates`, `describeCandidate`, `browserLibrary`) are re-exported for
the tests.

---

## 3. What a fingerprint contains

Produced by `fingerprint(el)` in `browser-lib.js`. Every field is JSON-safe, every string is
whitespace-collapsed and capped at 200 characters (`clean()`), and every field earns its place.

| Field | Example | Why it is there |
|---|---|---|
| `uid` | `"u17"` | A non-enumerable JS property (`__recUid`) stamped on the real element, so validation can ask "did you find *me*?". Stripped before the target is saved — it is meaningless once the browser closes. |
| `tag` | `"button"` | The cheapest sanity check. Half of the `fatal` test in `similarity.js`. |
| `role` | `"button"` | ARIA role: explicit `role=` wins, otherwise the implicit role for the tag (`IMPLICIT_ROLES`). Roles survive restyling and re-nesting, which class names and positions do not. |
| `name` | `"Save Customer"` | Computed accessible name. In an app with no test ids this plus the role *is* the identity. |
| `nameSource` | `"contents"` | Which rule produced the name — `aria-labelledby`, `aria-label`, `label`, `value`, `alt`, `contents`, `title`, `placeholder`. Tells `candidates.js` whether a separate `label` candidate would be a duplicate. |
| `roleNameSource` | `"playwright"` | `"computed"` when our own name/role calculation was used, `"playwright"` when `window.playwright.ariaSnapshot` disagreed and won. Playwright's answer is authoritative because Playwright's `getByRole` is what runs later. |
| `text` | `"Save Customer"` | The element's own visible text, skipping anything hidden from the accessibility tree. Useful, weak, and the first thing a developer edits. |
| `attrs` | `{ 'data-testid': 'save-customer', id: 'saveCustomer' }` | Only attributes `attributeStability()` judged stable. `href` is reduced to its path. |
| `volatile` | `{ id: 'mat-input-27 · a framework-generated id' }` | Attributes that were present and were **rejected**, with the reason. Diagnostics only — never used to find anything. This is the field that answers "why isn't it using the id?". |
| `labels` | `["Customer name"]` | Text of the `<label>` elements associated with the control, via `el.labels`, `label[for=…]` and an ancestor `<label>`. |
| `context.ancestors` | `[{tag:'section', role:'region', name:'Customer Details', testid:null, id:null, landmark:true, depth:2}]` | Up to 6 semantic containers, nearest first. This is what lets the engine say *"the Save button in Customer Details"* instead of *"the fourth button"*. Containers that cannot themselves be named stably are skipped. |
| `context.heading` | `"Customer Details"` | Nearest preceding heading inside the closest sectioning container. Human orientation in the failure report. |
| `context.landmark` | `"Customer Details"` | Accessible name of the nearest landmark ancestor. |
| `context.list` | `{ index: 2, total: 7, of: 'tr' }` | Position inside a repeated structure. **Debug only** — never used to build a locator; row 3 today is row 4 tomorrow. |
| `siblings.sameRoleAndName` | `3` | How many other visible elements share this role and name. The single number that decides whether role+name is enough on its own, or needs a container. |
| `siblings.sameText` / `sameTag` / `scanned` | `1` / `12` / `340` | Same idea for text and tag, plus how many elements the bounded scan actually looked at (`SCAN_CAP` is 1200). |
| `state.visible` / `state.enabled` | `true` | Recorded so the editor can warn "you recorded this while it was disabled". |
| `state.box` | `{x,y,w,h}` | **Failure reports only.** Coordinates are never identity. |
| `volatileName` | `"a relative time"` | Non-null when the accessible name contains a clock, a date, a long number or a GUID. Feeds a −30 score modifier and a warning. |
| `volatileText` | `"a date"` | The same test applied to the element's own text. |
| `blindSpot` | `"a canvas — the click landed on a drawing, not on an element"` | Non-null when no DOM locator can honestly describe what the user did. See [§10](#10-what-it-deliberately-does-not-do). |
| `selectors.semanticCss` | `"input[name=\"accountCode\"]"` | A CSS selector built **only** from stable attributes and confirmed unique against the live document. `null` rather than invent an `nth-child` chain. |
| `selectors.contextualCss` | `"#customerForm button[type=\"submit\"]"` | A stable container plus a stable leaf shape, again confirmed unique. |
| `selectors.semanticXPath` | `"//form[@id='customerForm']//button[normalize-space()='Save']"` | XPath built from *meaning*. Verified to match exactly one node **and** that node to be this element before it is kept. |
| `selectors.positionalCss` / `absoluteXPath` | `"div:nth-of-type(2) > button"` | The last resort. Always produced, always scored 10, never preferred. |
| `documentUrl` | `"http://localhost:4201/design"` | Which document this was captured in. |

Two rules the extractor never breaks: **class names are never an identity signal** (a hashed class
may appear in `volatile` for diagnostics, nothing more) and **coordinates are never an identity
signal**.

### How the capture happens

`install()` attaches **capture-phase** listeners for `pointerdown`, `click`, `dblclick`, `change`,
`focusin` and `keydown`. Capture phase and `pointerdown` on purpose: by the time a framework has
finished handling a click, the node is often already detached and nothing can be learned about it
any more. `keydown` fires once per focused field, not once per keystroke.

`e.composedPath()[0]` is used instead of `e.target`, so a click on a custom element's inner button
is attributed to the button and not to the shadow host.

---

## 4. Stable versus volatile

One function decides everything: `attributeStability(name, value)` in `browser-lib.js`. Nothing
else in the codebase is allowed to hardcode a framework name.

```js
attributeStability(name, value) -> { stable: boolean, score: 0..1, reason: string }
```

`stable: true` puts the attribute in `attrs`. `stable: false` puts it in `volatile` with the reason
attached, so the inspector can show *why* the id you were expecting is not being used.

### Names that are never read at all

```js
const IGNORED_ATTR_NAME =
  /^(_ngcontent|_nghost|_nguid|data-v-|data-svelte|data-reactroot|data-styled)/i;
```

These are build output. Angular stamps `_ngcontent-ng-c123456` on every element it renders and the
hash changes on **every rebuild** — `generated-ids-before.html` has `_ngcontent-ng-c123456`,
`generated-ids-after.html` has `_ngcontent-ng-c987654`, for the identical form. They are dropped
before the stability test even runs, and they never reach `volatile` either.

### Values that a framework minted (`looksGenerated`)

We match **shapes**, not a list of libraries, so an app nobody has heard of is handled too.

| Regex | Called | Real examples |
|---|---|---|
| `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` | a GUID | `550e8400-e29b-41d4-a716-446655440000` |
| `/^[0-9a-f]{16,}$/i` | a long hex string | `a1b2c3d4e5f6a7b8` |
| `/^\d+$/` | only digits | `12345` |
| `/[-_:]\d{2,}$/` | ends in a generated counter | `mat-input-27`, `mat-button-14` |
| `/^(mat\|cdk\|ng\|p\|pn\|mui\|chakra\|radix\|headlessui\|react\|vue\|ember\|aria)[-_][a-z0-9-]*\d+/i` | a framework-generated id | `cdk-describedby-message-3`, `ng-tns-c123-4`, `react-select-2-input` |
| `/^[a-z]+-[a-z]+-\d{3,}$/i` | a framework-generated id | `field-input-1024` |
| `/^(css\|sc\|jss\|emotion\|styled)[-_][0-9a-z]{4,}$/i` | a CSS-in-JS hash | `css-1a2b3c`, `emotion-1x2y3z` |
| `/__[0-9a-z]{4,}$/i` | a CSS-module hash suffix | `Button_icon__b3c1` |
| `/^_?ng(content\|host)-/i` | an Angular view-encapsulation marker | `_ngcontent-ng-c123456` |
| `/\b[0-9a-f]{8}-[0-9a-f]{4}\b/i` | contains a GUID fragment | `panel-550e8400-e29b` |
| `/^:r[0-9a-z]+:$/i` | a React `useId` value | `:r7:`, `:r19:` |
| `/^\d{10,}$/` | a timestamp | `1725790000` |
| `/^[a-z]{1,4}-\d+(?:-\|$)/i` | a per-instance counter minted at page load | `ss-0-listbox`, `tab-7-panel`, `ls-4` |
| `/^[a-z]+_[0-9a-f]{8,}$/i` | a generated node id | `field_1a2b3c4d` |
| `/\b\d{13}\b/` | contains an epoch timestamp | `row-1725790000123` |
| `/^[A-Za-z][A-Za-z-_]*\d{4,}$/` (inline) | ends in a generated counter | `input-938492` |

The `ss-0-listbox` shape is worth dwelling on, because it looks harmless. A short alphabetic
prefix followed by a counter is what nearly every component library lands on for "unique id per
instance". The counter is per *page load*. Reload the page and the same control is `ss-4-listbox`.
A locator built on it works for exactly as long as you keep the tab open.

`looksGenerated` returns the **reason string** (or `null`), not a boolean, so the reason can be
shown to a human. Treat it as truthy/falsy.

### The attribute rules

Listed strongest first. The only ordering that matters in the code is that the test-id check and
the `looksGenerated` check run before everything else.

| Test | Verdict | Score | Reason |
|---|---|---|---|
| empty value | reject | 0 | `empty` |
| value longer than 120 chars | reject | 0 | `too long to be an identifier` |
| name is one of `data-testid`, `data-test-id`, `data-test`, `data-qa`, `data-cy`, `data-automation-id` | **keep** | 1.0 | `an explicit test id` |
| `looksGenerated(value)` | reject | 0.1 | the shape's own reason |
| `id` made of readable words (`/^[A-Za-z][A-Za-z0-9]*$/` per `-_:.`-separated word) | **keep** | 0.95 | `a readable, hand-written id` |
| any other `id` | reject | 0.3 | `an id that does not look hand-written` |
| `name`, `formcontrolname`, `for` | **keep** | 0.9 | `a form control name` |
| `aria-label` | **keep** | 0.85 | `an accessibility label` |
| `data-*` whose name contains a state word | reject | 0.15 | `data-<word> describes state, not identity` |
| any other `data-*` | **keep** | 0.8 | `a semantic data attribute` |
| `href` | **keep** | 0.7 | `a link target` |
| `placeholder`, `alt`, `title` | **keep** | 0.6 | `user-visible descriptive text` |
| `type`, `role` | **keep** | 0.5 | `a semantic attribute` |
| `value` | **keep** | 0.4 | `a control value` |
| anything else (including `class`) | reject | 0.2 | `not a recognised identifying attribute` |

### The `data-*` rule: identity yes, state no

`data-*` attributes are read **generically** — every element's full attribute list is walked — so
the engine picks up an application's own conventions (`data-field-key`, `data-panel-id`) without
anyone teaching it their names. That generosity needs one guard, or it would happily build a
locator on the way something currently looks.

The name is split on `-` and each word is checked against `STATE_ATTR_WORDS`:

> status, state, tone, kind, severity, priority, band, trend, dir, mode, attention, letter, cat,
> empty, inline, width, height, active, selected, open, expanded, disabled, loading, index, count,
> placement, theme, size, variant, color, colour, level, depth, order, position, visible, hidden,
> checked, progress, phase, step, busy, dragging, hover, focus, error, valid

So:

- `data-field-key="customerName"` → **kept**. It names *which* thing this is. It is still
  `customerName` when the row turns red.
- `data-status="overdue"` → **rejected**, reason `data-status describes state, not identity`. It
  names *how the thing currently is*. Build a locator on it and the step works until someone pays
  the invoice.
- `data-column-width="120"` → rejected on `width`.
- `data-panel-id="summary"` → kept.

The rule is blunt, and it over-rejects: `data-row-index="4"` is thrown out on `index` even in an
app where it is the row's permanent key. That is the right direction to be wrong in. A rejected
attribute costs you one candidate out of ten; an accepted state attribute costs you a test that
fails once someone pays the invoice.

### Text that changes with the clock (`looksVolatileText`)

Tested in this order — the GUID rule sits before the long-number rule, or a GUID would be reported
as "a long number".

| Regex | Called | Example |
|---|---|---|
| `/\b\d{1,3}\s*(?:s\|m\|h\|d\|w\|mo\|y)\s*(?:ago)?\b/i` | a relative time | `Dev's Profile Maheep Gupta 1h`, `30m ago` |
| `/\b\d{1,3}\s*(?:sec\|second\|min\|minute\|hour\|day\|week\|month\|year)s?\b/i` | a relative time | `3 days ago` — a separate rule because the compact one needs a word boundary straight after the unit letter, which `days` does not give it |
| `/\b(?:just\s+)?now\b/i` | a relative time | `Updated just now` |
| `/\b(?:yesterday\|today\|tomorrow)\b/i` | a relative date | `Modified yesterday` |
| `/\b(?:Jan\|Feb\|…\|Dec)[a-z]*\.?\s+\d{1,2}\b/i` | a date | `Aug 25` |
| `/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/` | a date | `25/08/2026` |
| `/\b\d{2}:\d{2}\b/` | a clock time | `14:02` |
| `/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i` | a GUID | a raw id leaking into a label |
| `/\b\d{6,}\b/` | a long number | `1725790000` |

A name that trips this becomes `fingerprint.volatileName`, which costs the candidate 30 points and
raises a warning in the editor. `__fixtures__/dynamic-before.html` carries the real one from the
Shell: `aria-label="Dev's Profile Maheep Gupta 1h"`. That locator is correct for under an hour.

---

## 5. The candidate list and the scoring table

`candidatesFor(fingerprint)` in `candidates.js` is pure — a fingerprint in, an ordered list of
locator descriptors out. No DOM, no Playwright, no I/O, which is why it can be unit-tested against
hand-written fingerprints.

Its job is **not** to find "the selector". It is to produce every *independent* way of naming this
element, so that when one of them stops being true tomorrow the others still are. It emits, in
this order:

| # | Group | Emits |
|---|---|---|
| 1 | an explicit test contract | the first `data-testid`-family attribute present |
| 2 | a hand-written id | `attrs.id` (generated ones never got into `attrs`) |
| 3 | accessibility identity | `role` + exact name; the same scoped to **each** usable container, not just the nearest; a non-exact name variant when the name is ≥4 chars and not volatile; and role-alone inside the two nearest containers |
| 4 | the visible label | up to 2 `labels[]`, or the name when `nameSource === 'label'` |
| 5 | stable semantic attributes | every kept `data-*`, `name`, `name`+`type`, `formcontrolname`, `href` (for `<a>`), `aria-label` when it was not already the name |
| 6 | descriptive text | `placeholder`, `alt`, `title` |
| 7 | own text | `text` when ≤80 chars, scoped when other elements share it |
| 8 | selectors the page confirmed unique | `semanticCss`, `contextualCss`, `semanticXPath` |
| 9 | last resort | `positionalCss`, `absoluteXPath` — always present, never preferred |

Identical descriptors are deduplicated, and the list comes back sorted by score, highest first.

### Scoping instead of `nth()`

When three elements share an identity — `__fixtures__/context-duplicates-before.html` has three
byte-identical `<button>Save</button>`, one per region — the answer is **never** `nth(1)`. It is to
name the container: *the Save button in Customer Details*. Every candidate may carry a `scope`,
which is itself a candidate. Scoping to `div:nth-child(3)` would just move the fragility one level
up, so `scopeCandidates()` only offers containers that can themselves be named stably: a test id, a
hand-written id, or a role with a name.

Two refinements are worth knowing about, both from `candidates.js`:

- **All three containers, not just the nearest.** In a table the nearest nameable ancestor is the
  *cell*, which is identical in every row, while the *row* carries the text that tells them apart.
  So a scoped candidate is emitted for each usable container. Validation deletes the ones that turn
  out not to be unique, which makes offering all three free.
- **A container whose name is just this element's text is not a container.** `usefulScopeName()`
  rejects an ancestor name that equals, or barely exceeds, the element's own name or text —
  scoping "Save" to a wrapper called "Save" narrows nothing.

There is also a deliberately blunt candidate: **role + container, with no name at all** ("the
button in Customer Details"). It carries the `weakName` penalty, and it is the only thing that
survives a wholesale rename — `Save Customer` becoming `Save`, which is precisely the change this
tool exists to tolerate. It is also the one candidate that could match a *replacement* element in
the same container, which is why the fourth `fatal` rule in `similarity.js` exists. The two go
together; do not remove one without the other.

### The base table (`scoring.js`)

| Score | Strategy | Why it sits there |
|---:|---|---|
| 100 | `testid` | an explicit contract between a developer and a test |
| 92 | `id` | only reachable when `attributeStability` judged the id hand-written |
| 85 | `role` | accessibility identity: survives restyling and re-nesting |
| 82 | `label` | the visible label of a form control |
| 74 | `attr` | `name=`, `type=`, `href=`, `formcontrolname=`, `data-*` |
| 68 | `placeholder` | |
| 68 | `altText` | |
| 66 | `title` | |
| 55 | `text` | meaningful, and the first thing a developer changes |
| 40 | `css` | built from stable attributes only |
| 35 | `xpath` | built from meaning, not position |
| 10 | `positional` | absolute XPath / `nth-of-type` chains: last resort, always |
| 20 | *(anything unrecognised)* | `baseScore()`'s default |

The gaps between bands are deliberately wider than any modifier, so a modifier can never leapfrog
a whole band.

### The modifiers

Applied in this exact order, each appending a clause to the candidate's `why`, final score clamped
to 0–100:

| Flag | Delta | Clause in `why` |
|---|---:|---|
| `scope` present | **+5** | scoped to a stable container |
| `volatileText` | **−30** | the text looks like it changes over time |
| `generatedValue` | **−40** | the value looks framework-generated |
| `ambiguousAtRecord` | **−25** | other elements shared this identity when it was recorded |
| `weakName` | **−12** | no accessible name to go with the role |

`+5` for scoping looks stingy and is not. A scoped role scores 85 + 5 = 90, which must stay
**below** a hand-written id at 92. If a modifier could carry a candidate over a band boundary, the
priority table would stop meaning what it says.

Then validation folds in what actually happened (`finalScore`):

| Validation result | Score | `verified` | `rejected` |
|---|---:|---|---|
| `matches === 0` | 0 | false | `matched nothing on the page it was recorded on` |
| `correct === false` | 0 | false | `matched N element(s), none of them the one that was used` |
| `matches > 1` | `score − 100 × (matches − 1)`, floored at 0 | false | `matched N elements — ambiguous` |
| `matches === 1 && correct` | unchanged | **true** | — |

Note what the middle two rows do. A locator that matches exactly one element which is **not** the
recorded element is not down-ranked, it is **destroyed** — score 0, with a sentence saying so. And
two matches wipes out even a perfect test id, because ambiguity is not something you accept at a
lower confidence; it is something you fix with a container.

### "Unique is not the same as stable"

This is the sentence the whole file is built around. `/html/body/div[2]/button[4]` matches exactly
one element and is still nearly worthless. `scoring.js` scores how much a locator's **meaning** can
be trusted tomorrow; `validate.js` separately checks whether it works **today**. Both must be true.
Neither substitutes for the other.

---

## 6. Validation, and the `__recUid` trick

`validateCandidates(root, candidates, uid)` in `validate.js` runs every candidate against the very
DOM the user was standing on, at the moment they were standing on it.

Plenty of tools check uniqueness. A selector that uniquely matches the **wrong** element is the
failure mode that produces a test which passes while doing something else entirely — the
`replaced` fixture again. We can detect it here only because, at capture time,
`browser-lib.js` stamped the real element:

```js
Object.defineProperty(el, '__recUid', { value: 'u17', enumerable: false, configurable: true });
```

A JS property, never an attribute — the page's own CSS and code must not be able to see us, and an
attribute would change the DOM we are trying to measure.

So each candidate is asked one question, in one round trip:

```js
const uids = await locator.evaluateAll((els) => els.map((e) => e.__recUid || null));
```

- `matches` = `uids.length` — **how many?**
- `correct` = `uids` contains the recorded uid — **is one of them the element the user touched?**
- `verified` = `matches === 1 && correct`

`evaluateAll` never waits, which is exactly what we want here: the DOM is right in front of us, and
a candidate that needs waiting at record time is a candidate that is wrong. Each one is given
`PER_CANDIDATE_TIMEOUT_MS` (1500 ms) and no more — there are always others.

### The "page moved on" fallback

A click that navigates, closes a dialog or re-renders a list takes the element with it. By the time
validation runs there may be nothing left to validate against, and every candidate would come back
`matched nothing`. That is not evidence the locators are bad.

So before saving a step whose every candidate is marked rejected, `elementStillPresent(root, uid)`
walks the document (and open shadow roots) looking for the uid. If the element really is gone, the
candidates are saved **unproven** instead of rejected:

```js
{ matches: null, correct: null, verified: false,
  unproven: 'the page changed before this locator could be checked', rejected: null }
```

The editor then shows "the locator could not be proven unique" rather than a wall of red, and the
resolver still has something to work with.

### Pruning

`prune()` keeps at most `KEEP_VERIFIED` (6) verified candidates plus enough failures to reach
`KEEP_TOTAL` (10), minimum 2. Keeping the honest failures matters: when replay fails six months
later, *"we tried the test id and it matched nothing"* is the sentence that tells a developer what
changed. Ties are broken by a fixed strategy order so two runs of the recorder produce
byte-identical test files.

---

## 7. Resolution

`resolve(root, target, { timeoutMs })` in `resolver.js`. Two rules govern all of it, and both exist
to prevent a test that quietly clicks the wrong thing:

1. A candidate that matches more than one element is **never** resolved by picking one. It is
   narrowed by context, and if that still leaves a tie, the candidate is abandoned.
2. A candidate that matches exactly one element is **still** not trusted until that element's
   identity is compared with what was recorded.

Candidates are tried strongest score first. Ones that were already proven useless at record time
(`matches === 0` and rejected) are skipped. A target with no candidates at all — a hand-written
step, or one from an older recorder — has candidates derived from its fingerprint on the fly.

```
for each candidate, best score first:

    build the locator (locators.js)                 ── cannot build? → next candidate
        │
        ▼
    wait for the first match to attach, then count
    (the FIRST candidate gets the whole budget — `options.timeoutMs`, which ../execution.js
     sets from the step timeout, 30 s by default; ATTACH_WAIT_MS = 4000 when nothing is
     passed — because the page may still be rendering. Everyone after it gets 250 ms: if the
     DOM is ready for one candidate, it is ready for all of them.)
        │
        ├── 0 matches ──────→ rejected: "matched nothing on the page" → next candidate
        │
        ├── 1 match ────────→ read the element's LIVE fingerprint with the same extractor
        │                     (window.__opkeyRec.fingerprintLive)
        │                     compare() → verdict()
        │                        accept → DONE
        │                        reject → record why → next candidate
        │
        └── >1 matches ─────→ narrowByContext(): for each recorded ancestor that can be named
                              stably (testid → id → role+name), rebuild the candidate scoped to
                              it and count again
                                  exactly 1 → verify as above → accept or next candidate
                                  otherwise
                                      ↓
                              rankMatches(): fingerprint up to 12 of the matches and score each
                              against the recorded identity
                                  best ≥ 70 AND at least 15 points clear of the runner-up
                                      → accept locator.nth(best)
                                  otherwise
                                      → "matched N elements and none stood out
                                         (best X%, next Y%) — refusing to guess"

all candidates exhausted → throw ResolutionError with the full attempts log
```

### Similarity, and what counts as "the same element"

`compare(recorded, live)` in `similarity.js` scores the overlap. Only signals present in **both**
fingerprints count, and the result is normalised over the weights that actually applied — an
element with no test id is not punished for not having one.

| Signal | Weight |
|---|---:|
| `testid` | 35 |
| `id` | 25 |
| `role` | 20 |
| `tag` | 10 |
| accessible `name` | 10 |
| container name | 10 |
| `label` | 8 |
| semantic attrs (as a set: how many of the recorded ones survived) | 8 |
| `text` | **5** |

Text is worth five points out of a hundred-and-thirty-one. That is the design, not an oversight:
**text is the signal most likely to change and least likely to mean the element changed.** A button
renamed from "Save Customer" to "Save" is the same button. A button whose test id changed from
`save-customer` to `delete-customer` is not.

### `fatal`

Some differences are not a matter of degree. `fatal: true` forces the score to 0 and makes the
verdict reject outright, no matter what else matched:

| Condition | Reported as |
|---|---|
| both fingerprints have a test id and they differ | *the test id changed from "save-customer" to "delete-customer" — that is a different element, not a restyled one* |
| both have an id, they differ, and the test ids did not match | *the id changed from … to …* |
| the tag **and** the role both changed, and the test ids did not match | *both the tag and the role changed (button/button → a/link)* |
| **nothing anchors the match** — no matching test id, no matching id, no matching semantic attribute — **and** the accessible name changed to something unrelated | *nothing but the name identified this element, and it changed from "Save Customer" to "Delete Customer"* |
| one of the two fingerprints is missing entirely | *no fingerprint to compare* |

The first three are the `replaced` fixture: position says "found it", and `fatal` says an
application that labels these two things differently is telling you they are different things.

The fourth is the subtle one, and it is what makes the nameless "the button in Customer Details"
candidate safe to offer. With no contract-like anchor, the accessible name is the only thing
carrying the match, so it has to hold. `nameRelated()` decides: one string containing the other is
a rename (`Save Customer` → `Save`, allowed); a shared-token overlap below 60% is a different label
(`Save Customer` → `Delete Customer`, refused). Without this rule, a Save button replaced by a
Delete button inside the same section resolves happily and the test clicks Delete.

A text-only difference — `fingerprint.text`, not the accessible name — is **never** fatal on its
own. Surviving that is the entire point of the engine.

### The thresholds (`verdict`)

| Similarity | Outcome |
|---|---|
| `fatal` | reject, with the fatal reason |
| **≥ 70** | accept |
| **40–69** | accept **only** when the candidate that found it scored ≥ 85 *and* was `verified` at record time — that is, a real contract like a test id — and flag a warning on the step |
| **< 40** | reject: *"only N% of the recorded identity still matches"* — try the next candidate |

Two escape hatches, both deliberate and both loud. If the recorded target has no fingerprint at all
(a hand-written step), uniqueness is accepted on its own. If the identity library is not present in
the frame — it could not be injected — the resolver says so in the reason and accepts on uniqueness
alone rather than failing a step for a reason the developer cannot act on.

### Confidence

The number shown next to a resolved step:

```js
resolutionConfidence(candidateScore, similarityScore) = 0.6 × candidateScore + 0.4 × similarityScore
```

How much the locator was trusted, tempered by how much the element still looks like the one that
was recorded. `resolutionConfidence(85, 70) === 79`.

---

## 8. How to debug a failing step

Every resolution keeps an **attempts log**: every candidate tried, in order, with what it saw. On
failure it travels inside the `ResolutionError`, `execution.js` copies it onto the run result, and
the page renders it as *"What the locator engine tried"* — a table of strategy, locator, matches
and outcome. On disk it is in
`local-tests/runs/<test>/<run>/result.json` under `steps[].resolution.attempts`.

One attempt looks like this:

| Field | Meaning |
|---|---|
| `strategy` | `testid`, `role`, `text`, `positional`, … |
| `locator` | the real Playwright call, e.g. `getByRole("button", { name: "Save Customer", exact: true })` |
| `score` | what the candidate was worth at record time |
| `why` | the sentence explaining that score |
| `matches` | how many elements it found now (`null` = never got that far) |
| `narrowedTo` | how many were left after scoping to the recorded container |
| `similarity` | the `compare()` result for the element it found |
| `ranking` | when several matched: each match's index, similarity and name |
| `rejected` | the reason this candidate was abandoned |
| `accepted` | `true` on the one that won |

Read it top to bottom and the failure classifies itself:

| What the log shows | What actually happened | What to do |
|---|---|---|
| Every attempt `matches: 0` | The element is not on the page. Usually the app never reached the state the test expects — an earlier step half-worked. | Look at the screenshot and the URL of the failing step first, not at the locator. |
| Strong attempts `matches: 0`, weak ones `matches: 1` but rejected on similarity | The element was rebuilt with a different identity. | Compare "What was recorded" with the live page; re-record if the change was intentional. |
| `matches: N`, then `narrowedTo: N`, then *refusing to guess* | The page grew a second element with the same identity, and the recorded container no longer separates them. | Give the element or its container a `data-testid` or an `aria-label`. This is the message `suggest()` prints. |
| One attempt `matches: 1` with `similarity.fatal` | Something else is in that position now. | Do not loosen the locator. Check whether the app is doing the right thing. |
| The winning attempt is `positional` | Nothing better existed when it was recorded. It survives only while the layout is identical. | Fix it at the source: the element needs a stable identifier. |
| The step has a `blindSpot` | A canvas, or an SVG with no accessible name. | Assert on something outside the drawing. |

The engine also fails **before** the run, in the editor: `warningsForTarget()` in `index.js` is
what produces "Only a positional locator was available", "The accessible name contains a relative
time", "3 elements on the page shared this identity", and the blind-spot warning. Those show in the
inspector at record time, which is far cheaper than finding out in a run.

---

## 9. How to extend it

Run the tests before and after, from the repo root:

```
node tests/run-all.js            unit + fingerprint, one child process each
node tests/unit.test.js          pure logic only, no browser, about a second
node tests/fingerprint.test.js   Chromium against __fixtures__/*.html
node tests/e2e-fixture.test.js   record → change the page → resolve or refuse
```

`e2e-fixture.test.js` is the one that proves the point of the engine, it is offline, and it takes
seconds. Run it on every change. `../../scripts/selftest.js` is the slow proof against the real Angular app.

### Add a new strategy

Four files, in this order:

1. **`candidates.js`** — emit it from `candidatesFor()`, in the group where it belongs, with the
   right `flags`. If it needs a container, pass `{ scope: bestScope }`.
2. **`scoring.js`** — add the strategy to the `BASE` table. If you do not, `baseScore()` gives it
   20 and it will lose to everything.
3. **`locators.js`** — add a `case` to `build()` returning a real Playwright locator, **and** a
   `case` to `describeCandidate()` returning how it reads as code. Both, always: the description is
   what a developer sees in the failure report.
4. **`validate.js`** — add the strategy name to the `ORDER` array, so the tie-break stays
   deterministic and two recordings of the same flow produce identical files.

Then a test in `tests/unit.test.js` asserting the new candidate appears, in the right band, for a
hand-written fingerprint. If the strategy needs a live DOM, add a before/after pair to
`identity/__fixtures__/`.

### Add a stability heuristic

Everything lives in `browser-lib.js`, inside `browserLibrary()`:

- a new generated **value** shape → push `{ re, why }` onto `GENERATED_SHAPES`. Give it a `why` a
  human would accept, because it is shown verbatim in `volatile`.
- a new state word for the `data-*` rule → add it to `STATE_ATTR_WORDS`.
- a whole attribute **name** that must never be read → extend `IGNORED_ATTR_NAME`.
- a new kind of clock-driven text → push onto `VOLATILE_TEXT`.
- a new attribute with its own verdict → add a branch to `attributeStability`, keeping the order
  (test ids first, then generated, then the specific names).

Never hardcode a framework prefix anywhere else. `attributeStability` is the only place that gets
to have an opinion about `mat-input-27`, and the unit tests assert exactly that.

Note that `browserLibrary()` is stringified and injected with `addInitScript`, so it may **not**
close over anything from the module: no `require`, no outer constants. Everything it needs is
declared inside it. The upside is that Node can call `browserLibrary()` directly to unit-test the
pure helpers with no browser at all, which is what `tests/unit.test.js` does via `lib._internals`.

### Change a weight

- **Locator trust** → the `BASE` table in `scoring.js`. Keep the bands far apart.
- **A modifier** → the `MODIFIERS` table in `scoring.js`. Add the flag in `candidates.js` and the
  key to the `applied` list in `scoreCandidate()`, or it will be silently ignored.
- **Sameness** → the `WEIGHTS` table in `similarity.js`. Raising `text` is the tempting mistake;
  it is low on purpose.
- **Accept/reject thresholds** → `verdict()` in `similarity.js`, in one place, next to the weights
  that feed it.
- **How long to wait / how clear a winner must be** → `ATTACH_WAIT_MS` (4000) and `CLEAR_MARGIN`
  (15) at the top of `resolver.js`.
- **How many candidates to keep** → `KEEP_VERIFIED` / `KEEP_TOTAL` in `validate.js`.

---

## 10. What it deliberately does not do

**No AI, no model, no network.** Every decision is a regex, a table or an arithmetic comparison.
The same fingerprint always produces the same candidates in the same order with the same scores.
That is what makes a failure debuggable and a test file diffable.

**No coordinates as identity.** `state.box` is captured and appears in failure reports. It is never
used to find anything. A locator that means "wherever the button was on my screen" is not a test.

**No self-healing.** When the engine resolves a step through a weaker candidate than the one it
recorded, it says so in the attempts log and moves on. It does not rewrite the saved test. A tool
that quietly edits your regression tests to make them pass has stopped being a regression test.

**No cross-origin sandboxed iframes.** The identity library is injected with
`context.addInitScript`, which does not reach a frame the browser will not let us script. Steps
recorded there fall back to the recorder's own selector, and the resolver's
`liveFingerprint()` returns `null` — you get uniqueness-only matching, and the reason says so.

**No canvas or WebGL element identity.** This is what `fingerprint.blindSpot` is for. A click on a
`<canvas>` is a click at a coordinate inside a picture; there is no element behind the shape, and
no locator can honestly describe it. `blindSpot()` flags three cases:

| Detected | Message |
|---|---|
| `<canvas>` | *a canvas — the click landed on a drawing, not on an element* |
| an ancestor matching `.djs-container, .bjs-container` | *a diagram editor canvas* (bpmn-js / diagram-js) |
| inside an `<svg>` with no test id and no accessible name on it or its parent | *inside an SVG with no accessible name* |

GoJS diagrams and ECharts charts both render to `<canvas>`, so they land in the first row. The step
is still recorded and still replays — Playwright will click the same spot — but the warning says
plainly that replay *cannot check it is the same thing*, and `suggest()` repeats it on failure.
Assert on something outside the drawing.

**No closed shadow roots.** `composedPath()` reaches through **open** shadow roots, so a click on a
custom element's inner button is correctly attributed to the button; `elementStillPresent()` walks
open shadow roots too. A closed root is invisible to page script by design, and no amount of
cleverness here changes that.

**No opinions about *when* to fingerprint** (that is `../recording.js`), **what to do with the
resolved locator** (`../execution.js`), **how to store a target** (`../storage.js`) or **how any of
it looks** (`../../ui/`). Keep it that way: the engine has to stay testable with nothing but a
Chromium page and a fixture HTML file.

---

## 11. The code and `CONTRACT.md` agree

This section used to carry an inventory of twelve places where the contract described a folder
that no longer existed — separate `fingerprint.browser.js` and `stability.js` files, an
eleven-strategy table, a `finalScore()` that returned a number. The contract has been rewritten
against the code and those twelve are gone.

`CONTRACT.md` now also documents two rules that were only ever in the source: the resolver sorts
positional candidates last and drops them outright when the recorded element was ambiguous (§8),
and validation prunes the candidate list and can mark every candidate `unproven` (§5).

Nothing is knowingly left divergent. Two things are described in the contract as facts about the
code rather than as intentions, and should be read that way:

- **`resolve()`'s `log` option is accepted and never used.** The contract says so plainly instead
  of quietly dropping it from the signature, because deleting it from the docs would leave the
  next reader to rediscover it in the parameter list and assume it works.
- **`storage.js`'s trash** is not documented here at all. Recovering a deleted test is not an
  identity concern, so it lives in [`../../README.md`](../../README.md) under "Where things live".

The code stays the truth. If you change behaviour under `identity/`, change `CONTRACT.md` in the
same commit rather than starting this list again.
