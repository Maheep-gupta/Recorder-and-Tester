# Element Identity Engine — module contract

> Read this before changing anything under `identity/`. It is the agreement every module in the
> folder is written against. The engine is deliberately independent of the recorder UI, the HTTP
> server and the storage layer: it takes a DOM element and produces a **target**, and later takes a
> target and produces **an element on a live page**.

```
 RECORD                                        REPLAY
 ──────                                        ──────
 DOM element                                   saved target
     │                                             │
     ▼                                             ▼
 browser-lib.js           (in page)           resolver.js        (node)
   extract identity signals                     for each candidate, best score first
     │                                             │  build locator  → locators.js
     ▼                                             │  count matches
 candidates.js            (node)                   │  verify fingerprint → similarity.js
   signals → ordered locator descriptors           ▼
     │                                          exactly one + verified → act
     ▼                                          otherwise → next candidate
 validate.js              (node)                   │
   run each against the live DOM                   ▼
   count matches, confirm same element          all failed → ResolutionError
     │                                             with the full attempt log
     ▼
 scoring.js               (pure)
   deterministic score + human reason
     │
     ▼
 target { fingerprint, candidates[], primary }
```

## 1. Fingerprint — `browser-lib.js`

Runs **inside the page**. `browser-lib.js` exports one function, `browserLibrary()`, whose entire
source is stringified into the page (`SOURCE`, `installSource(binding)`); no Node APIs, no imports,
must survive being stringified. Everything it returns is JSON-safe.

There is deliberately **one** browser file, not one per concern. Extraction and the stability
heuristics it depends on have to travel into the page together, and a second stringified module
would mean two copies of the same helpers and two chances for them to drift.

```js
/** @typedef {Object} Fingerprint */
{
  uid: 'u17',                    // per-page capture id; correlates a recorder action to this capture
                                 // stripped before the target is saved — it is a session handle only
  tag: 'button',                 // lowercase tagName
  role: 'button',                // computed ARIA role (explicit role attr wins, else implicit)
  name: 'Save Customer',         // computed accessible name, whitespace-collapsed, max 200 chars
  nameSource: 'contents',        // aria-labelledby | aria-label | label | value | alt | contents | title | placeholder
  roleNameSource: 'playwright',  // 'playwright' when Playwright's own role/name answered, else 'computed'
  roleNameDisagreed: false,      // true when our computation and Playwright's did not agree
  text: 'Save Customer',         // own visible text, collapsed, max 200 chars
  attrs: {                       // ONLY attributes worth identifying by; volatile ones are dropped here
    'data-testid': 'save-customer',
    id: 'saveCustomer',
    name: 'save',
    type: 'submit',
    href: '/customers',          // path only, origin stripped
  },
  volatile: {                    // attributes that were PRESENT but judged unstable, with the reason
    id: 'mat-input-27 · framework-generated id',
    class: 'css-1x7bqp · generated class names',
  },
  labels: ['Customer name'],     // text of <label> elements associated with this control
  context: {
    ancestors: [                 // nearest → outermost, max 6, only ones with semantic value
      { tag:'section', role:'region', name:'Customer Details', testid:null, testidAttr:null, id:null,        landmark:true,  depth:1 },
      { tag:'form',    role:'form',   name:'Customer Form',    testid:null, testidAttr:null, id:'custForm',  landmark:false, depth:3 },
    ],
    heading: 'Customer Details', // nearest preceding heading text within the containing section
    landmark: 'Customer Details',// name of the nearest ancestor whose role is a landmark
    list: null,                  // when inside a repeated list: { index, total, of } else null
  },
  siblings: {                    // how many elements on the page share this element's weak identity
    sameRoleAndName: 1,          // ← the number that decides whether role+name alone is enough
    sameText: 1,
    sameTag: 12,
    scanned: 340,                // how many elements the count actually looked at, capped at 1200
  },
  state: {
    visible: true,
    enabled: true,
    box: { x: 210, y: 640, w: 96, h: 32 },   // DIAGNOSTICS ONLY — never an identity signal
  },
  volatileName: null,            // reason string when the accessible name reads like a clock/date/counter
  volatileText: null,            // the same judgement applied to the element's own text
  blindSpot: null,               // reason string when this element cannot be identified at all
                                 // (a canvas, a diagram editor, an unnamed SVG node)
  domIndex: {                    // WHERE it sits, as numbers — a first-class field, not a selector
    tag: 'button',
    parentTag: 'div',
    childIndex: 1,               // 0-based, among the parent's element children
    childCount: 2,
    ofTypeIndex: 0,              // 0-based, among the parent's children of the SAME tag
    ofTypeCount: 1,
    documentIndex: 4,            // 0-based, among every element of that tag in the document
    documentCount: 9,
    depth: 3,                    // how many element ancestors it has
  },
  selectors: {
    semanticCss:   'button[data-testid="save-customer"]',
    contextualCss: 'form#custForm button[type="submit"]',
    positionalCss: 'div:nth-of-type(2) > button:nth-of-type(4)',
    semanticXPath: "//form[@id='custForm']//button[@type='submit']",
    absoluteXPath: '/html/body/…',
  },
  documentUrl: 'http://localhost:4201/profile/17',
}
```

Rules the extractor MUST follow:

- Never store coordinates as identity. `state.box` exists for the failure report and nothing else.
- `domIndex` IS stored, and it is not a contradiction of the rule above: an index is a fact about
  the document tree, reproducible on any machine at any zoom, while a coordinate is a fact about
  one rendering. It is still the weakest thing here, it is scored accordingly (§4), it is tried
  last (§8), and a match found through it is refused unless the identity check agrees (§8).
  The counts (`childCount`, `ofTypeCount`, `documentCount`) travel with the indexes so a failure
  report can say "button 3 of 4 is now button 3 of 9" instead of just "not found".
- Never store class names as an identity signal. They may appear in `volatile` for diagnostics.
- Collapse whitespace, trim, cap every string at 200 characters.
- An attribute goes into `attrs` only if `attributeStability()` says it is stable; otherwise into
  `volatile`, **with the reason**, because "we ignored your id" is only useful if it says why.
- The sibling scan is bounded (1200 elements). `siblings.scanned` records how far it actually got,
  so a count of 1 on a huge page can be read as "unique" rather than as "we gave up".
- There is **no `frame` field on the fingerprint**. Frame information belongs to the *action*, not
  to the element, and is attached to the step by `../recording.js`. Putting it here as well would
  mean two places could disagree about which frame a step runs in.

## 2. Stability heuristics — inside `browser-lib.js`, reachable as `browserLibrary()._internals`

```js
attributeStability(name, value) -> { stable: boolean, score: 0..1, reason: string }
looksGenerated(value)           -> string|null   // the REASON it looks generated, or null
looksVolatileText(text)         -> string|null   // the REASON it looks time-dependent, or null
```

The two `looks*` helpers return **a reason string, or `null`** — not a boolean. They are still
truthy and falsy in the right places, so a caller that only tests them keeps working, but the
reason is what reaches the step warnings and the inspector. "The text contains a relative time" is
something a developer can act on; `true` is not.

This is the only place that decides "is `id="mat-input-27"` trustworthy". Nothing else may hardcode
framework prefixes. `_internals` also exposes the role/name computation and the selector builders,
so Node-side tests can exercise them without a page.

## 3. Candidates — `candidates.js` (pure Node)

```js
candidatesFor(fingerprint) -> Candidate[]     // ordered by score descending, NOT yet validated
```

```js
/** @typedef {Object} Candidate */
{
  strategy: 'testid',            // see STRATEGIES below
  params: { value: 'save-customer', attr: 'data-testid' },  // strategy-specific, consumed by locators.js
  scope: null,                   // optional Candidate that must contain the match (context scoping)
  flags: { generatedValue: false },  // which scoring modifiers this candidate earns; input to scoring.js
  score: 100,                    // from scoring.js, before validation
  why: 'explicit test id, unique on the page',
  // filled in by validate.js:
  locator: undefined,            // describeCandidate() — the human-readable Playwright form
  matches: undefined,            // number of elements the locator matched (null when unproven)
  correct: undefined,            // true when one of the matches IS the recorded element
  verified: undefined,           // matches === 1 && correct === true
  rejected: undefined,           // reason string when unusable
  unproven: undefined,           // reason string when it could not be checked at all (see §5)
}
```

`flags` is part of the contract, not an implementation detail: it is how `candidates.js` tells
`scoring.js` *why* a candidate deserves a penalty, without `scoring.js` having to re-derive it from
the fingerprint. The recognised flags are exactly the modifier keys in §4.

`STRATEGIES` (the union `locators.js` must handle):

| strategy      | params                                            |
|---------------|---------------------------------------------------|
| `testid`      | `{ value, attr? }`                                |
| `id`          | `{ value }`                                       |
| `role`        | `{ role, name?, exact? }`                         |
| `label`       | `{ text, exact? }`                                |
| `placeholder` | `{ text, exact? }`                                |
| `altText`     | `{ text, exact? }`                                |
| `title`       | `{ text, exact? }`                                |
| `attr`        | `{ name, value, tag? }` or `{ pairs: [[n,v]] }`   |
| `text`        | `{ text, tag?, exact? }`                          |
| `css`           | `{ value }`                                                     |
| `xpath`         | `{ value }`                                                     |
| `domIndex`      | `{ kind: 'path', value, tag, childIndex, ofTypeIndex, parentTag }` or `{ kind: 'ordinal', tag, index, of }` |
| `relativeXPath` | `{ value, derivedFrom? }`                                       |
| `absoluteXPath` | `{ value }`                                                     |
| `positional`    | `{ value, kind: 'css' or 'xpath' }` — LEGACY, read-only         |

Fifteen. The last four are **the positional band**: everything that finds an element by WHERE it
sits rather than by WHAT it is. They are separately named on purpose — one lump called
`positional` made a failure report say "the positional fallback found the wrong button" when the
only useful sentence is *which* fallback, and what it found.

- `domIndex` is emitted twice: `kind: 'path'` is the child-position chain
  (`body > div > button:nth-of-type(2)`), `kind: 'ordinal'` is the DOM index proper — the nth
  element of that tag in the document, built as `locator(tag).nth(index)`.
- `relativeXPath` is emitted up to twice: the *semantic* XPath the page confirmed unique at record
  time (`//button[normalize-space()='Save']`), and, when it differs, the absolute path cut loose
  from the document root (`//form/section/button[3]`, marked `derivedFrom: 'absoluteXPath'`).
  `relativeTail()` builds the second: it drops `html`/`body` and keeps the last three steps, and
  returns null when fewer than two steps remain, because `//button` is a shape, not a location.
- `absoluteXPath` is `/html/body/…`. It is never re-rooted onto a container, even when chained:
  quietly making it relative would make it match something else.
- `positional` is what the first two used to be called. Targets recorded before the split still
  carry it, so `locators.js` still builds it and `resolver.js` still orders it into the band
  (`kind: 'css'` beside `domIndex`, `kind: 'xpath'` beside `absoluteXPath`). Nothing emits it.

The semantic XPath is **not** emitted as `xpath` any more; it goes out as `relativeXPath`. The
`xpath` strategy stays in the union — hand-written targets use it — and keeps its score of 35.

Any candidate may carry `scope`, another Candidate that narrows the search to a container. That is
how "the Save button inside Customer Details" is expressed — never as a positional XPath.

## 4. Scoring — `scoring.js` (pure)

```js
baseScore(strategy)                              -> number
scoreCandidate(candidate, fingerprint)           -> { score, why }
finalScore(candidate, validation)                -> { score, verified, rejected? }
resolutionConfidence(candidateScore, similarity) -> number   // 0..100
```

`finalScore()` returns an **object**, not a number. The verdict and the score are one decision —
"matched the wrong element" means score 0 *and* `verified: false` *and* a reason — and returning
them separately is how a caller ends up storing a zero with no explanation attached to it.

`resolutionConfidence()` is the replay-time number: `0.6 × candidate score + 0.4 × similarity
score`, clamped to 0..100. It lives here rather than in the resolver so that every number this tool
shows a developer comes out of the one file.

The table is deliberately small and printable:

| band | score | strategies |
|------|-------|-----------|
| explicit test contract | 100 | `testid` |
| stable unique id       |  92 | `id` (only when `attributeStability` says stable) |
| accessibility identity |  85 | `role` + name |
| label relationship     |  82 | `label` |
| stable semantic attrs  |  74 | `attr` (name=, type=, href=, formcontrolname=, data-*) |
| placeholder/alt        |  68 | `placeholder`, `altText` |
| title                  |  66 | `title` — the weakest of the descriptive-text signals |
| unique text            |  55 | `text` |
| semantic css           |  40 | `css` built from stable attributes |
| semantic xpath         |  35 | `xpath` — hand-written targets only; emitted candidates use `relativeXPath` |
| DOM index              |  12 | `domIndex` — the child chain, and the nth element of that tag |
| relative xpath         |  10 | `relativeXPath` — semantic, or the absolute path cut loose from the root |
| legacy positional      |  10 | `positional` — targets recorded before the band was split |
| absolute xpath         |   6 | `absoluteXPath` — true until anyone touches the page above it |

A strategy not in the table scores 20.

The bottom four are the positional band. Their scores encode the order they are tried in — 12,
then 10, then 6 — and every one of them sits below every semantic strategy, so no fallback can
ever outrank a way of naming the element. The gap to `xpath` (35) is wide enough that no modifier
can close it.

Modifiers, applied in this order and each one documented in `why`:

- scoping to a semantic container: **+5** (it removes ambiguity). Deliberately small: a scoped
  role scores 90 and must stay BELOW a hand-written id at 92, or a modifier would leapfrog a whole
  band and the table above would stop meaning what it says.
- name/text matched a volatile-looking string: **−30**
- value looked generated: **−40**
- other elements shared this identity when it was recorded: **−25**
- a role with no accessible name to go with it: **−12**
- validation says `matches > 1`: **−100 × (matches − 1)**, floored at 0, and `verified = false`
- validation says `correct === false`: score **0**, `rejected` set
- validation says `matches === 0`: score **0**, `rejected` set

Nothing else may adjust a score. If a new signal is needed, it goes in this table.

## 5. Validation — `validate.js` (Node, needs a live page)

```js
validateCandidates(pageOrFrame, candidates, uid) -> Candidate[]   // fields filled, then PRUNED
```

For every candidate it builds the real Playwright locator and asks the page, in ONE round trip per
candidate, for the `__recUid` of every matching element:

```js
await locator.evaluateAll(els => els.map(e => e.__recUid ?? null))
```

- `matches` = array length.
- `correct` = the array contains the recorded `uid`.
- `verified` = `matches === 1 && correct`.
- `locator` = the human-readable form, added here so a saved test can be read without rebuilding it.

This is the authoritative check demanded by the brief: a locator that matches one element which is
**not** the recorded element is rejected outright, never merely down-ranked.

Two behaviours beyond filling the fields in, both load-bearing:

**It prunes.** At most 6 verified SEMANTIC candidates are kept, plus up to 5 verified positional
ones, plus enough failures to reach 10 — never fewer than 2 failures. The positional band has its
own allowance because pruning by score alone deleted it every time: five fallbacks scoring 12, 12,
10, 10 and 6 sort below every semantic candidate, so a page with six good ways of naming its
button saved none of the ways of finding it — and those are exactly the candidates that matter on
the day all six names have been rewritten. The failures are kept on purpose: when replay breaks a year later, "we tried
the test id and it matched nothing" is the sentence that tells a developer what changed. The caps
exist because the eleventh way of naming the same button adds file size and no safety.

**It can prove nothing at all.** A click that navigates, closes a dialog or re-renders a list takes
the element away before validation can run. If no candidate came back `correct` **and** the recorded
`uid` is no longer anywhere in the document, every candidate is returned with `matches: null`,
`correct: null`, `verified: false` and `unproven` set to the reason. That is not the same as
rejection and must never be flattened into it: rejected means "we checked, and it is wrong";
unproven means "we never got to check". A step whose candidates are all `rejected` is a bug worth
chasing; a step whose candidates are all `unproven` is just a navigation.

Results are sorted by score, ties broken by a fixed strategy order, so two runs of the recorder
against the same page produce byte-identical tests.

## 6. Locators — `locators.js`

```js
buildLocator(root, candidate) -> Locator    // root is a Page, Frame or Locator
describeCandidate(candidate)  -> string     // 'getByRole("button", { name: "Save Customer" })'
```

The single place that turns a descriptor into Playwright API calls. Used identically by validation
and by replay, so what was validated at record time is exactly what runs at replay time.

## 7. Similarity — `similarity.js` (pure)

```js
compare(recordedFingerprint, liveFingerprint) -> {
  score: 0..100,
  matched: ['tag', 'role', 'testid'],
  differed: ['text'],
  missing: ['label'],
  fatal: false,          // true when a signal changed that means "different element", not "changed element"
  reason: '…',
}
verdict(similarity, candidate) -> { accept, warn?, why }
```

Weights: `testid` 35 · `id` 25 · `role` 20 · `tag` 10 · accessible `name` 10 · container name 10 ·
`label` 8 · `semanticAttrs` 8 · `text` 5. Normalised to 100 over the signals present in BOTH
fingerprints.

`semanticAttrs` is compared as a **set**, not as a single value: the score it contributes is the
fraction of the recorded semantic attributes (`name`, `type`, `href`, `formcontrolname`, any
`data-*`) that survived. An element usually carries several, and losing one of four is not the same
event as losing all four.

Container name is likewise the whole ancestor chain, not just the nearest one: in a table the
nearest named ancestor is the cell, whose name is "Edit" in every row, so comparing only that
scored two different rows as identical.

`fatal` is true in four cases, each meaning "this is a different element, not a restyled one":

1. A test id present on both sides disagrees.
2. An id present on both sides disagrees and no test id vouches for the match.
3. Tag **and** role both changed.
4. Nothing contract-like anchors the match — no test id, no id, no *naming* attribute in common —
   **and** the accessible name changed to something unrelated.

Case 4 is the subtle one and it earns its place. With no anchor, the name is the only thing
identifying the element, so it has to carry the match. `nameRelated()` decides: one string
containing the other is a rename ("Save Customer" → "Save", allowed); a token overlap below 60% is
a different label ("Save Customer" → "Delete Customer", refused). Without this rule, a Save button
replaced by a Delete button in the same container resolves happily and the test clicks Delete.

The anchoring set is deliberately stricter than the scoring set: `type="submit"` counts towards
`semanticAttrs` but is **not** an anchor, because a Save button and a Delete button in the same form
both submit. Only attributes that NAME the element may vouch for a match.

A text-only difference is never fatal on its own: surviving it is the whole point.

Acceptance thresholds used by the resolver:

- `>= 70` → accept.
- `40..69` → accept only when the candidate that found it was `verified` at record time and scored
  `>= 85` (i.e. a strong contract like a test id), and record a warning on the step.
- `< 40`, or `fatal` at any score → reject this candidate and keep resolving.

## 8. Resolver — `resolver.js` (Node)

```js
resolve(pageOrFrame, target, { timeoutMs, log }) -> {
  locator,           // a Playwright Locator pinned to exactly one element
  candidate,         // the one that won
  confidence,        // 0..100, from resolutionConfidence()
  similarity,        // the compare() result, or null when it could not be read
  attempts: [...],   // EVERY candidate tried, in order: { order, band, strategy, locator, score,
                     // why, matches, similarity, rejected, accepted } — `band` is 'semantic' or
                     // 'positional', so the log shows at a glance that every way of NAMING the
                     // element was exhausted before any way of LOCATING it was tried
  warning,           // a sentence when the match was accepted with a caveat, else null
}
```

`warning` is part of the return, not an afterthought. A match accepted on the 40..69 similarity
band, or one that only became unique after re-scoping to its recorded container, succeeded *and*
deserves to be said out loud; the step run records it.

`log` is accepted in the options for symmetry with the rest of the tool and is currently **never
used**. Do not build anything on it: either wire it up or drop it, but do not assume it emits.

Failure throws `ResolutionError` carrying `attempts`, the recorded fingerprint and a suggestion. The
resolver **never** picks arbitrarily among multiple matches: if disambiguation by scope and
fingerprint still leaves more than one, it fails.

### Which candidates are tried, and in what order

The order is a safety property, not an optimisation. Before anything is tried, `usableCandidates()`
applies two rules:

1. A candidate that matched **nothing** at record time and was rejected for it is dropped. It was
   already proven not to work on the very page it was born on.

2. **Every semantic strategy is tried first, best score first. The positional band runs only after
   all of them have failed, and it runs in a fixed order: `domIndex`, then `relativeXPath`, then
   `absoluteXPath`.** This is an explicit tier, not a consequence of the scores: an ambiguous
   semantic candidate is floored to 0 by `finalScore()`, so sorting on score alone let a fallback
   scoring 12 jump ahead of a role+name candidate scoring 0 and resolve on the first attempt. The
   narrow-by-context-then-refuse path below was never reached — the arbitrary pick still happened,
   just inside an `nth-of-type` selector where nobody could see it.

There used to be a third rule: **positional candidates were dropped entirely when the recorded
element was ambiguous.** It is gone, and what replaced it is stricter, not looser.

The old rule refused on a *prediction* — the element had twins when it was recorded, so a position
might land on the wrong one — which also threw away every case where the twins had since gone and
the position was the only thing that still worked. The engine now tries the fallbacks, as the
brief asks, and refuses on *evidence* from the live page instead. Three things stand between a
positional match and a click, and none of them may be removed:

- **`similarity.compare()` runs on every positional match, exactly as it does on a semantic one.**
  A fatal verdict — a test id or an id that disagrees, tag *and* role both changed, or an
  unanchored element whose accessible name became something unrelated — refuses it outright.
- **The 40–69 similarity band cannot rescue it.** `verdict()` forgives that band only for a
  candidate scoring >= 85; nothing in the positional band scores above 12. In practice a
  positional match needs >= 70% identity.
- **`positionalIdentityGate()`** asks the question similarity cannot: is the element it found
  distinguishable from its neighbours *today*? If the live fingerprint says other elements share
  its role+name or its text, position was the only thing telling them apart, and the match is
  refused with that sentence. When the element was ambiguous when RECORDED but is unique now, the
  match is allowed and carries a warning.

Two smaller rules fall out of the same principle. A positional candidate whose element's identity
cannot be READ (no identity library in the frame) is refused rather than accepted on uniqueness —
a semantic locator that matches one element at least *named* it, a position named nothing. And a
positional candidate matching more than one element is refused immediately, without ranking the
matches by similarity: the reason there are several is that they look alike.

A target saved with no candidates at all (hand-written, or written by an older recorder) has them
derived from its fingerprint on the fly.

Resolution order, per candidate — semantic strategies by score, then the positional band:

```
build locator → wait briefly for attachment → count
  0 matches  → next candidate
  1 match    → extract live fingerprint → compare → accept or next
  >1 matches → re-scope to the recorded container and re-count
                 1 → verify as above
                 else → rank all matches by similarity (at most 12 of them)
                          one clearly best (>= 70 and 15 points clear of second) → accept
                          otherwise → AMBIGUOUS, next candidate
```

The first candidate gets the full timeout so the page has a chance to finish rendering; every one
after it gets 250 ms, because if the DOM is ready for one it is ready for all.

For a candidate in the positional band the `>1 matches` branch is not taken at all: it is refused
on the spot. And the `1 match` branch continues into `positionalIdentityGate()` after
`compare()` has spoken.

### The failure report

`ResolutionError` carries `attempts` (the structured log), `tried` (one rendered line per attempt)
and `recorded`, and `tried` is also appended to `message`, so a bare console shows it:

```
Found an element for button "Approve Invoice", but it is not the one that was recorded: …
Tried 8 locator strategies, in order:
   1. semantic   role           getByRole("button", { name: "Approve Invoice" }) → 0 matches — matched nothing on the page
   …
   4. positional domIndex       locator("body > div > button") → 1 match [identity 0%, FATAL] — the name changed to "Delete Everything"
   5. positional domIndex       locator("button").nth(0) → 1 match [identity 0%, FATAL] — …
   6. positional relativeXPath  locator('xpath=//button[normalize-space()='Approve Invoice']') → 0 matches — matched nothing
   7. positional relativeXPath  locator('xpath=//div/button') → 1 match [identity 0%, FATAL] — …
   8. positional absoluteXPath  locator('xpath=/html/body/div/button') → 1 match [identity 0%, FATAL] — …
```

Every strategy attempted appears, in the order it was attempted, with what it matched, the
identity score it was checked against and why it was turned down.

## 9. What lives OUTSIDE this folder

- Deciding *when* to fingerprint (which DOM events) — `recording.js`.
- Which frame a step runs in — `recording.js` puts it on the step, not on the fingerprint.
- Turning a resolved locator into a click/fill — `execution.js`.
- Persisting targets, and recovering deleted tests — `storage.js`.
- Everything visual — `ui/`.

Keep it that way: the engine must stay testable with nothing but a Chromium page and a fixture HTML
file.
