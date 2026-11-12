/**
 * Element Identity Engine — the part that runs INSIDE the page.
 *
 * `browserLibrary()` is written as one self-contained function on purpose: it is stringified and
 * injected with `addInitScript`, so it may not close over anything from this module. Everything it
 * needs is declared inside it. The upside is that Node can also call it directly
 * (`browserLibrary()`) to unit-test the pure helpers with no browser at all — see
 * tests/stability.test.js.
 *
 * It answers exactly one question: **what makes this element identifiable?** It never chooses a
 * locator (candidates.js does that) and never talks to the recorder (recording.js does that).
 *
 * The two entry points it publishes on `window.__opkeyRec`:
 *   fingerprint(el)   → the identity record described in CONTRACT.md §1
 *   install(opts)     → capture-phase listeners that fingerprint an element the instant the user
 *                       touches it, before any framework re-render can destroy it
 */
'use strict';

function browserLibrary() {
  // ────────────────────────────────────────────────────────── tuning constants
  const MAX_TEXT = 200;
  const MAX_ANCESTORS = 6;
  const SCAN_CAP = 1200;              // never walk more than this many elements for a sibling count

  /** Attributes that are a deliberate contract between a developer and a test. Highest trust. */
  const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];

  /** Attributes worth identifying by when they look stable. Order matters: it is the report order. */
  const IDENTIFYING_ATTRS = [
    'id', 'name', 'type', 'href', 'value', 'placeholder', 'alt', 'title',
    'aria-label', 'role', 'for', 'formcontrolname',
  ];

  /**
   * `data-*` attributes are read generically rather than from a list, because every app invents its
   * own. What is filtered out is the *kind* of data attribute that describes STATE — those change
   * while the app runs and are the classic source of a locator that works once and never again.
   */
  const STATE_ATTR_WORDS = new Set([
    'status', 'state', 'tone', 'kind', 'severity', 'priority', 'band', 'trend', 'dir', 'mode',
    'attention', 'letter', 'cat', 'empty', 'inline', 'width', 'height', 'active', 'selected',
    'open', 'expanded', 'disabled', 'loading', 'index', 'count', 'placement', 'theme', 'size',
    'variant', 'color', 'colour', 'level', 'depth', 'order', 'position', 'visible', 'hidden',
    'checked', 'progress', 'phase', 'step', 'busy', 'dragging', 'hover', 'focus', 'error', 'valid',
  ]);

  /** Attribute NAMES that are build output and must never be read at all. */
  const IGNORED_ATTR_NAME = /^(_ngcontent|_nghost|_nguid|data-v-|data-svelte|data-reactroot|data-styled)/i;

  /**
   * Values that a framework generated and will renumber on the next render. Recognised generically:
   * we are matching SHAPES, not a list of libraries.
   */
  const GENERATED_SHAPES = [
    { re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, why: 'a GUID' },
    { re: /^[0-9a-f]{16,}$/i, why: 'a long hex string' },
    { re: /^\d+$/, why: 'only digits' },
    { re: /[-_:]\d{2,}$/, why: 'ends in a generated counter' },
    { re: /^(mat|cdk|ng|p|pn|mui|chakra|radix|headlessui|react|vue|ember|aria)[-_][a-z0-9-]*\d+/i, why: 'a framework-generated id' },
    { re: /^[a-z]+-[a-z]+-\d{3,}$/i, why: 'a framework-generated id' },
    { re: /^(css|sc|jss|emotion|styled)[-_][0-9a-z]{4,}$/i, why: 'a CSS-in-JS hash' },
    { re: /__[0-9a-z]{4,}$/i, why: 'a CSS-module hash suffix' },
    { re: /^_?ng(content|host)-/i, why: 'an Angular view-encapsulation marker' },
    { re: /\b[0-9a-f]{8}-[0-9a-f]{4}\b/i, why: 'contains a GUID fragment' },
    { re: /^:r[0-9a-z]+:$/i, why: 'a React useId value' },
    { re: /^\d{10,}$/, why: 'a timestamp' },
    // A short alphabetic prefix followed by an instance counter — the shape every component
    // library lands on for "unique id per instance" (ss-0-listbox, ms-2-opt-3, ls-4, tab-7-panel).
    // The counter is per page load, so the same control gets a different id on the next visit.
    { re: /^[a-z]{1,4}-\d+(?:-|$)/i, why: 'a per-instance counter minted at page load' },
    { re: /^[a-z]+_[0-9a-f]{8,}$/i, why: 'a generated node id' },
    { re: /\b\d{13}\b/, why: 'contains an epoch timestamp' },
  ];

  /** Text that changes with the clock. A locator built on one of these dies within the hour. */
  const VOLATILE_TEXT = [
    // Compact forms: 1h · 30m ago · 5d
    { re: /\b\d{1,3}\s*(?:s|m|h|d|w|mo|y)\s*(?:ago)?\b/i, why: 'a relative time' },
    // Written out: 3 days ago · 2 hours · 45 minutes ago. A separate rule because the compact one
    // needs a word boundary straight after the unit letter, which "days" does not provide.
    { re: /\b\d{1,3}\s*(?:sec|second|min|minute|hour|day|week|month|year)s?\b/i, why: 'a relative time' },
    { re: /\b(?:just\s+)?now\b/i, why: 'a relative time' },
    { re: /\b(?:yesterday|today|tomorrow)\b/i, why: 'a relative date' },
    { re: /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/i, why: 'a date' },
    { re: /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/, why: 'a date' },
    { re: /\b\d{2}:\d{2}\b/, why: 'a clock time' },
    // Before the long-number rule, or a GUID gets reported as "a long number".
    { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i, why: 'a GUID' },
    { re: /\b\d{6,}\b/, why: 'a long number' },
  ];

  /** tag (optionally with a type/attribute condition) → implicit ARIA role. */
  const IMPLICIT_ROLES = {
    a: (el) => (el.hasAttribute('href') ? 'link' : null),
    area: (el) => (el.hasAttribute('href') ? 'link' : null),
    article: () => 'article',
    aside: () => 'complementary',
    button: () => 'button',
    datalist: () => 'listbox',
    dd: () => 'definition',
    details: () => 'group',
    dialog: () => 'dialog',
    dt: () => 'term',
    fieldset: () => 'group',
    figure: () => 'figure',
    form: () => 'form',
    h1: () => 'heading', h2: () => 'heading', h3: () => 'heading', h4: () => 'heading', h5: () => 'heading', h6: () => 'heading',
    header: (el) => (inLandmarkScope(el) ? null : 'banner'),
    footer: (el) => (inLandmarkScope(el) ? null : 'contentinfo'),
    hr: () => 'separator',
    img: (el) => (el.getAttribute('alt') === '' ? 'presentation' : 'img'),
    input: (el) => inputRole(el),
    li: () => 'listitem',
    main: () => 'main',
    menu: () => 'list',
    meter: () => 'meter',
    nav: () => 'navigation',
    ol: () => 'list',
    optgroup: () => 'group',
    option: () => 'option',
    output: () => 'status',
    progress: () => 'progressbar',
    search: () => 'search',
    // A <section> is a 'region' ONLY when it has an accessible name — but asking
    // accessibleName() for it is mutual recursion: accessibleName → nameWithSource →
    // computeRole → back here → accessibleName. A bare <section> ancestor blew the stack,
    // fingerprint() threw, install() swallowed it, and the step was saved with no identity
    // at all — which silently dropped that step onto the raw-selector path where NOTHING
    // verifies the element. Every fixture used <section aria-label>, so 145 tests passed
    // over the top of it. Section takes its name from the author, never from its contents,
    // so read those three attributes directly and never call back into naming.
    section: (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
      || el.getAttribute('title') ? 'region' : null),
    select: (el) => (el.multiple || Number(el.size) > 1 ? 'listbox' : 'combobox'),
    summary: () => 'button',
    table: () => 'table',
    tbody: () => 'rowgroup',
    td: () => 'cell',
    textarea: () => 'textbox',
    tfoot: () => 'rowgroup',
    th: (el) => (el.scope === 'row' ? 'rowheader' : 'columnheader'),
    thead: () => 'rowgroup',
    tr: () => 'row',
    ul: () => 'list',
  };

  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox',
  };

  const LANDMARK_ROLES = new Set(['region', 'main', 'navigation', 'banner', 'complementary', 'contentinfo', 'form', 'search', 'dialog', 'article']);

  // ────────────────────────────────────────────────────────── small pure helpers

  function clean(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  }

  /** Does this attribute value look like something a framework minted? */
  function looksGenerated(value) {
    const v = String(value == null ? '' : value).trim();
    if (!v) return null;
    for (const s of GENERATED_SHAPES) if (s.re.test(v)) return s.why;
    // A single token carrying a long digit run among letters, e.g. "input-938492".
    if (/^[A-Za-z][A-Za-z-_]*\d{4,}$/.test(v)) return 'ends in a generated counter';
    return null;
  }

  /** Does this text carry a clock, a date or a counter that will read differently tomorrow? */
  function looksVolatileText(text) {
    const t = String(text == null ? '' : text);
    if (!t) return null;
    for (const s of VOLATILE_TEXT) if (s.re.test(t)) return s.why;
    return null;
  }

  /**
   * The single place that decides whether an attribute is worth building a locator on.
   * Returns `{ stable, score (0..1), reason }`. Nothing else may hardcode framework names.
   */
  function attributeStability(name, value) {
    const n = String(name || '').toLowerCase();
    const v = String(value == null ? '' : value);
    if (!v) return { stable: false, score: 0, reason: 'empty' };
    if (v.length > 120) return { stable: false, score: 0, reason: 'too long to be an identifier' };

    if (TEST_ID_ATTRS.indexOf(n) >= 0) return { stable: true, score: 1, reason: 'an explicit test id' };

    const generated = looksGenerated(v);
    if (generated) return { stable: false, score: 0.1, reason: generated };

    if (n === 'id') {
      // A hand-written id is one of the strongest signals there is; a generated one is a trap.
      const words = v.split(/[-_:.]/).filter(Boolean);
      const readable = words.length > 0 && words.every((w) => /^[A-Za-z][A-Za-z0-9]*$/.test(w));
      return readable
        ? { stable: true, score: 0.95, reason: 'a readable, hand-written id' }
        : { stable: false, score: 0.3, reason: 'an id that does not look hand-written' };
    }
    if (n === 'name' || n === 'formcontrolname' || n === 'for') return { stable: true, score: 0.9, reason: 'a form control name' };
    if (n === 'type' || n === 'role') return { stable: true, score: 0.5, reason: 'a semantic attribute' };
    if (n === 'href') return { stable: true, score: 0.7, reason: 'a link target' };
    if (n.indexOf('data-') === 0) {
      // "data-field-key" identifies; "data-status" describes how the thing currently looks.
      const words = n.slice(5).split('-');
      const stateWord = words.find((w) => STATE_ATTR_WORDS.has(w));
      if (stateWord) return { stable: false, score: 0.15, reason: `data-${stateWord} describes state, not identity` };
      return { stable: true, score: 0.8, reason: 'a semantic data attribute' };
    }
    if (n === 'aria-label') return { stable: true, score: 0.85, reason: 'an accessibility label' };
    if (n === 'placeholder' || n === 'alt' || n === 'title') return { stable: true, score: 0.6, reason: 'user-visible descriptive text' };
    if (n === 'value') return { stable: true, score: 0.4, reason: 'a control value' };
    return { stable: false, score: 0.2, reason: 'not a recognised identifying attribute' };
  }

  // ────────────────────────────────────────────────────────── roles and names

  function tagOf(el) {
    return (el.tagName || '').toLowerCase();
  }

  function inputRole(el) {
    const t = String(el.getAttribute('type') || 'text').toLowerCase();
    if (t === 'hidden') return null;
    if (INPUT_ROLES[t]) return INPUT_ROLES[t];
    if (t === 'text' && el.getAttribute('list')) return 'combobox';
    return 'textbox';
  }

  function inLandmarkScope(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const t = tagOf(p);
      if (t === 'article' || t === 'aside' || t === 'main' || t === 'nav' || t === 'section') return true;
    }
    return false;
  }

  /** Explicit `role` wins; otherwise the implicit role for the tag. Null when the tag has none. */
  function computeRole(el) {
    if (!el || el.nodeType !== 1) return null;
    const explicit = clean(el.getAttribute('role')).split(' ')[0];
    if (explicit) return explicit.toLowerCase();
    const fn = IMPLICIT_ROLES[tagOf(el)];
    const role = fn ? fn(el) : null;
    return role || null;
  }

  function isHidden(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute('hidden')) return true;
    const s = el.ownerDocument.defaultView.getComputedStyle(el);
    return !!s && (s.display === 'none' || s.visibility === 'hidden');
  }

  /** Visible text of a subtree, skipping anything hidden from the accessibility tree. */
  function subtreeText(el, depth) {
    if (!el || depth > 12) return '';
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        out += node.nodeValue;
      } else if (node.nodeType === 1) {
        if (isHidden(node)) continue;
        const label = node.getAttribute('aria-label');
        out += label ? ' ' + label + ' ' : ' ' + subtreeText(node, depth + 1) + ' ';
      }
    }
    return out;
  }

  /**
   * A pragmatic subset of the accessible-name computation, in the order the spec applies it.
   * It is deliberately not the full algorithm — it covers what real applications produce, and
   * Playwright's own (complete) implementation is what actually validates the locator later.
   */
  function accessibleName(el) {
    return nameWithSource(el).name;
  }

  function nameWithSource(el) {
    if (!el || el.nodeType !== 1) return { name: '', source: null };
    const tag = tagOf(el);

    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = [];
      for (const id of labelledby.split(/\s+/)) {
        const ref = el.ownerDocument.getElementById(id);
        if (ref) parts.push(subtreeText(ref, 0));
      }
      const name = clean(parts.join(' '));
      if (name) return { name, source: 'aria-labelledby' };
    }

    const ariaLabel = clean(el.getAttribute('aria-label'));
    if (ariaLabel) return { name: ariaLabel, source: 'aria-label' };

    // Native label association, for controls that support one.
    if (/^(input|select|textarea|meter|progress|output)$/.test(tag)) {
      const labels = nativeLabels(el);
      if (labels.length) {
        const name = clean(labels.map((l) => subtreeText(l, 0)).join(' '));
        if (name) return { name, source: 'label' };
      }
    }

    if (tag === 'input') {
      const type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') {
        const v = clean(el.getAttribute('value'));
        if (v) return { name: v, source: 'value' };
        return { name: type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '', source: 'value' };
      }
      if (type === 'image') {
        const alt = clean(el.getAttribute('alt'));
        if (alt) return { name: alt, source: 'alt' };
      }
    }
    if (tag === 'img' || tag === 'area') {
      const alt = clean(el.getAttribute('alt'));
      if (alt) return { name: alt, source: 'alt' };
    }
    if (tag === 'fieldset') {
      const legend = el.querySelector('legend');
      if (legend) return { name: clean(subtreeText(legend, 0)), source: 'contents' };
    }
    if (tag === 'table') {
      const cap = el.querySelector('caption');
      if (cap) return { name: clean(subtreeText(cap, 0)), source: 'contents' };
    }
    if (tag === 'figure') {
      const cap = el.querySelector('figcaption');
      if (cap) return { name: clean(subtreeText(cap, 0)), source: 'contents' };
    }

    // Elements whose name comes from what they contain.
    const role = computeRole(el);
    const fromContents = new Set(['button', 'link', 'heading', 'option', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'tab', 'treeitem', 'cell', 'gridcell', 'columnheader', 'rowheader', 'row',
      'switch', 'checkbox', 'radio', 'listitem', 'tooltip', 'status', 'region', 'dialog', 'alert']);
    if (role && fromContents.has(role)) {
      const name = clean(subtreeText(el, 0));
      if (name) return { name, source: 'contents' };
    }

    const title = clean(el.getAttribute('title'));
    if (title) return { name: title, source: 'title' };

    const placeholder = clean(el.getAttribute('placeholder'));
    if (placeholder) return { name: placeholder, source: 'placeholder' };

    // Last resort for containers we asked about explicitly (sections, groups).
    if (!role) return { name: '', source: null };
    const name = clean(subtreeText(el, 0));
    return name && name.length <= 60 ? { name, source: 'contents' } : { name: '', source: null };
  }

  function nativeLabels(el) {
    const out = [];
    if (el.labels && el.labels.length) return Array.prototype.slice.call(el.labels);
    const id = el.getAttribute('id');
    if (id) {
      const escaped = cssEscape(id);
      for (const l of el.ownerDocument.querySelectorAll('label[for="' + escaped + '"]')) out.push(l);
    }
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (tagOf(p) === 'label') { out.push(p); break; }
    }
    return out;
  }

  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\\]\[#.:>+~*^$|()\s]/g, '\\$&');
  }

  /** The element's OWN text: what it shows, without the text of nested interactive children. */
  function ownText(el) {
    return clean(subtreeText(el, 0));
  }

  // ────────────────────────────────────────────────────────── context

  /**
   * The semantic containers this element sits in, nearest first. This is what lets us say
   * "the Save button in Customer Details" instead of the fourth button on the page.
   */
  function ancestorContext(el) {
    const out = [];
    let depth = 0;
    for (let p = el.parentElement; p && out.length < MAX_ANCESTORS; p = p.parentElement) {
      depth++;
      const tag = tagOf(p);
      if (tag === 'body' || tag === 'html') break;
      const role = computeRole(p);
      const testid = firstTestId(p);
      const id = p.getAttribute('id');
      const idStable = id && attributeStability('id', id).stable;
      const name = role || testid ? clean(nameWithSource(p).name) : '';
      const landmark = role ? LANDMARK_ROLES.has(role) : false;
      const worth = !!testid || !!idStable || (!!role && (landmark || !!name)) || tag === 'form' ||
        tag === 'dialog' || tag === 'table' || tag === 'tr' || tag === 'nav' || tag === 'section';
      if (!worth) continue;
      out.push({
        tag,
        role: role || null,
        name: name || null,
        testid: testid ? testid.value : null,
        testidAttr: testid ? testid.attr : null,
        id: idStable ? id : null,
        landmark,
        depth,
      });
    }
    return out;
  }

  function firstTestId(el) {
    for (const attr of TEST_ID_ATTRS) {
      const value = el.getAttribute && el.getAttribute(attr);
      if (value && clean(value)) return { attr, value: clean(value) };
    }
    return null;
  }

  /** The nearest heading above this element inside its closest sectioning container. */
  function nearestHeading(el) {
    const scope = el.closest('section, article, form, dialog, [role="region"], [role="dialog"], [role="tabpanel"], main, body');
    if (!scope) return null;
    const headings = scope.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]');
    let best = null;
    for (const h of headings) {
      const pos = h.compareDocumentPosition(el);
      // heading comes before the element in document order
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
    }
    return best ? clean(subtreeText(best, 0)) || null : null;
  }

  /** When the element sits in a repeated structure, where in the repetition is it? Debug only. */
  function listPosition(el) {
    const item = el.closest('li, tr, [role="listitem"], [role="row"], [role="option"]');
    if (!item || !item.parentElement) return null;
    const kin = Array.prototype.filter.call(item.parentElement.children, (c) => c.tagName === item.tagName);
    const index = kin.indexOf(item);
    return index < 0 ? null : { index, total: kin.length, of: tagOf(item) };
  }

  // ────────────────────────────────────────────────────────── ambiguity counts

  /**
   * How many other elements on the page share this element's weak identity? This is the number
   * that decides whether "role + name" is enough on its own, and it is computed at RECORD time so
   * the saved test already knows the locator was unambiguous when it was made.
   */
  function ambiguity(el, role, name, text) {
    const doc = el.ownerDocument;
    let sameRoleAndName = 0;
    let sameText = 0;
    let sameTag = 0;
    const tag = tagOf(el);
    const wantName = (name || '').toLowerCase();
    const wantText = (text || '').toLowerCase();

    // Scan a bounded candidate set rather than the whole document: same tag, plus anything that
    // declares the role explicitly, plus the usual interactive tags when we are looking for one.
    const seen = new Set();
    const pools = [doc.getElementsByTagName(tag)];
    if (role) {
      pools.push(doc.querySelectorAll('[role="' + role + '"]'));
      if (role === 'button') pools.push(doc.querySelectorAll('button, input[type=button], input[type=submit], summary'));
      if (role === 'link') pools.push(doc.querySelectorAll('a[href]'));
      if (role === 'textbox') pools.push(doc.querySelectorAll('input, textarea'));
    }
    let scanned = 0;
    for (const pool of pools) {
      for (const other of pool) {
        if (scanned++ > SCAN_CAP) break;
        if (seen.has(other)) continue;
        seen.add(other);
        if (tagOf(other) === tag) sameTag++;
        if (isHidden(other)) continue;
        if (role && computeRole(other) === role) {
          const otherName = clean(nameWithSource(other).name).toLowerCase();
          if (otherName === wantName) sameRoleAndName++;
        }
        if (wantText && clean(subtreeText(other, 0)).toLowerCase() === wantText) sameText++;
      }
    }
    return { sameRoleAndName, sameText, sameTag, scanned: Math.min(scanned, SCAN_CAP) };
  }

  // ────────────────────────────────────────────────────────── selector shapes

  /** `button[data-testid="save"]` style predicate list from the stable attributes we kept. */
  function attrPredicateCss(tag, attrs) {
    let sel = tag;
    for (const k of Object.keys(attrs)) {
      if (attrs[k] == null) continue;
      sel += '[' + k + '="' + String(attrs[k]).replace(/"/g, '\\"') + '"]';
    }
    return sel;
  }

  /**
   * A CSS selector that is unique today AND made only of stable parts. Returns null rather than
   * inventing an nth-child chain — positional CSS is produced only by `positionalCss`.
   */
  function semanticCss(el, attrs) {
    const doc = el.ownerDocument;
    const tag = tagOf(el);
    const tries = [];
    const testid = firstTestId(el);
    if (testid) tries.push('[' + testid.attr + '="' + testid.value.replace(/"/g, '\\"') + '"]');
    if (attrs.id) tries.push('#' + cssEscape(attrs.id));
    for (const key of ['name', 'formcontrolname', 'data-field', 'data-key', 'data-id', 'aria-label', 'placeholder']) {
      if (attrs[key]) tries.push(attrPredicateCss(tag, { [key]: attrs[key] }));
    }
    if (attrs.name && attrs.type) tries.push(attrPredicateCss(tag, { name: attrs.name, type: attrs.type }));
    if (attrs.href) tries.push(attrPredicateCss(tag, { href: attrs.href }));
    for (const sel of tries) {
      try { if (doc.querySelectorAll(sel).length === 1) return sel; } catch (e) { /* invalid selector, skip */ }
    }
    return null;
  }

  /** Scoped CSS: a stable container, then a stable descendant shape. */
  function contextualCss(el, attrs, ancestors) {
    const doc = el.ownerDocument;
    const tag = tagOf(el);
    const leafTries = [];
    if (attrs.type) leafTries.push(attrPredicateCss(tag, { type: attrs.type }));
    if (attrs.name) leafTries.push(attrPredicateCss(tag, { name: attrs.name }));
    leafTries.push(tag);
    for (const a of ancestors) {
      let scope = null;
      if (a.testid) scope = '[' + a.testidAttr + '="' + a.testid.replace(/"/g, '\\"') + '"]';
      else if (a.id) scope = '#' + cssEscape(a.id);
      else if (a.name && a.role) scope = a.tag + '[aria-label="' + a.name.replace(/"/g, '\\"') + '"]';
      if (!scope) continue;
      for (const leaf of leafTries) {
        const sel = scope + ' ' + leaf;
        try { if (doc.querySelectorAll(sel).length === 1) return sel; } catch (e) { /* skip */ }
      }
    }
    return null;
  }

  /**
   * The element's DOM INDEX, as numbers rather than baked into a selector string.
   *
   * Three different questions get asked at replay time and only one of them is answerable from an
   * `nth-of-type` chain, so all three are recorded:
   *
   *   childIndex     where it sits among its parent's element children      (0-based)
   *   ofTypeIndex    where it sits among its parent's children OF THE SAME TAG (0-based)
   *   documentIndex  where it sits among every element of the same tag in the document (0-based)
   *
   * The counts travel with them (`childCount`, `ofTypeCount`, `documentCount`) because "button 3
   * of 4" ageing into "button 3 of 9" is exactly the kind of change a failure report should say
   * out loud. Position is never trusted on its own — see CONTRACT.md §8 — but it is the last thing
   * left when every name on the page has been rewritten, and it costs three integers to keep.
   */
  function domIndexOf(el) {
    const parent = el.parentElement;
    const kids = parent ? Array.prototype.slice.call(parent.children) : [];
    const kin = kids.filter((c) => c.tagName === el.tagName);
    let sameTagInDoc = [];
    try {
      sameTagInDoc = Array.prototype.slice.call(el.ownerDocument.getElementsByTagName(el.tagName));
    } catch (e) { sameTagInDoc = []; }
    let depth = 0;
    for (let n = el.parentElement; n && n.nodeType === 1; n = n.parentElement) depth++;
    return {
      tag: tagOf(el),
      parentTag: parent ? tagOf(parent) : null,
      childIndex: parent ? kids.indexOf(el) : 0,
      childCount: parent ? kids.length : 1,
      ofTypeIndex: parent ? kin.indexOf(el) : 0,
      ofTypeCount: parent ? kin.length : 1,
      documentIndex: sameTagInDoc.indexOf(el),
      documentCount: sameTagInDoc.length,
      depth,
    };
  }

  /** The last-resort selector. Positional, fragile, and scored accordingly. */
  function positionalCss(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && tagOf(n) !== 'html'; n = n.parentElement) {
      const tag = tagOf(n);
      const parent = n.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const kin = Array.prototype.filter.call(parent.children, (c) => c.tagName === n.tagName);
      parts.unshift(kin.length > 1 ? tag + ':nth-of-type(' + (kin.indexOf(n) + 1) + ')' : tag);
      if (parts.length > 8) break;
    }
    return parts.join(' > ');
  }

  function xpathLiteral(s) {
    if (s.indexOf("'") < 0) return "'" + s + "'";
    if (s.indexOf('"') < 0) return '"' + s + '"';
    return 'concat(' + s.split("'").map((p) => "'" + p + "'").join(", \"'\", ") + ')';
  }

  /**
   * XPath built from meaning, not from position — the only kind worth saving. Verified unique
   * against the live document before it is returned; null when no semantic XPath is unique.
   */
  function semanticXPath(el, attrs, ancestors, text) {
    const doc = el.ownerDocument;
    const tag = tagOf(el);
    const tries = [];
    const testid = firstTestId(el);
    if (testid) tries.push('//' + tag + '[@' + testid.attr + '=' + xpathLiteral(testid.value) + ']');
    if (attrs.id) tries.push('//' + tag + '[@id=' + xpathLiteral(attrs.id) + ']');
    if (attrs.name) tries.push('//' + tag + '[@name=' + xpathLiteral(attrs.name) + ']');
    if (attrs['aria-label']) tries.push('//' + tag + '[@aria-label=' + xpathLiteral(attrs['aria-label']) + ']');
    if (text && text.length <= 60) tries.push('//' + tag + '[normalize-space()=' + xpathLiteral(text) + ']');

    // Scoped by a semantic ancestor: //form[@id='x']//button[normalize-space()='Save']
    for (const a of ancestors) {
      let scope = null;
      if (a.testid) scope = '//' + a.tag + '[@' + a.testidAttr + '=' + xpathLiteral(a.testid) + ']';
      else if (a.id) scope = '//' + a.tag + '[@id=' + xpathLiteral(a.id) + ']';
      else if (a.name) scope = '//' + a.tag + '[@aria-label=' + xpathLiteral(a.name) + ']';
      if (!scope) continue;
      if (text && text.length <= 60) tries.push(scope + '//' + tag + '[normalize-space()=' + xpathLiteral(text) + ']');
      if (attrs.type) tries.push(scope + '//' + tag + '[@type=' + xpathLiteral(attrs.type) + ']');
      tries.push(scope + '//' + tag);
    }
    for (const xp of tries) {
      if (countXPath(doc, xp) === 1 && firstXPath(doc, xp) === el) return xp;
    }
    return null;
  }

  function absoluteXPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const tag = tagOf(n);
      const parent = n.parentElement;
      if (!parent) { parts.unshift('/' + tag); break; }
      const kin = Array.prototype.filter.call(parent.children, (c) => c.tagName === n.tagName);
      parts.unshift('/' + tag + (kin.length > 1 ? '[' + (kin.indexOf(n) + 1) + ']' : ''));
    }
    return parts.join('');
  }

  function countXPath(doc, xp) {
    try {
      const r = doc.evaluate(xp, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return r.snapshotLength;
    } catch (e) { return -1; }
  }

  function firstXPath(doc, xp) {
    try {
      const r = doc.evaluate(xp, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue;
    } catch (e) { return null; }
  }

  // ────────────────────────────────────────────────────────── the fingerprint

  /**
   * Surfaces where a DOM locator cannot describe what the user did. A click on a `<canvas>` is a
   * click at a coordinate inside a picture: there is no element behind the shape. Saying so on the
   * step is far more honest than recording a locator that will "pass" while doing nothing.
   */
  function blindSpot(el) {
    const tag = tagOf(el);
    if (tag === 'canvas') return 'a canvas — the click landed on a drawing, not on an element';
    if (el.closest && el.closest('.djs-container, .bjs-container')) return 'a diagram editor canvas';
    if (el.ownerSVGElement || tag === 'svg') {
      const owner = el.ownerSVGElement || el;
      if (!firstTestId(el) && !nameWithSource(el).name && !(owner.parentElement && nameWithSource(owner.parentElement).name)) {
        return 'inside an SVG with no accessible name';
      }
    }
    return null;
  }

  let uidSeq = 0;

  /** Stamp a JS property (never an attribute — the page's own CSS and code must not see us). */
  function uidFor(el) {
    if (!el.__recUid) {
      try {
        Object.defineProperty(el, '__recUid', { value: 'u' + (++uidSeq), enumerable: false, configurable: true });
      } catch (e) {
        el.__recUid = 'u' + (++uidSeq);
      }
    }
    return el.__recUid;
  }

  /**
   * Everything worth knowing about one element's identity. Cheap enough to run on every
   * interaction: one element, its ancestors, and one bounded sibling scan.
   */
  /**
   * Playwright installs `window.playwright.ariaSnapshot` in the main world when the recorder asks
   * it to. When it is there, its role and accessible name are the ones Playwright's own
   * `getByRole` will match against later — which makes them worth more than ours. We still compute
   * our own first, because the page may not have the helper, and because disagreeing with it is
   * worth knowing about.
   *
   * A snapshot of one element starts with a line like:  `- button "Save Customer": Save Customer`
   */
  function authoritativeRoleAndName(el) {
    try {
      if (!window.playwright || typeof window.playwright.ariaSnapshot !== 'function') return null;
      if (el.querySelectorAll && el.querySelectorAll('*').length > 200) return null;   // too big to be cheap
      const snap = window.playwright.ariaSnapshot(el, { mode: 'default' });
      if (!snap) return null;
      const first = String(snap).split('\n')[0];
      const m = first.match(/^\s*-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/);
      if (!m) return null;
      return { role: m[1] ? m[1].toLowerCase() : null, name: m[2] ? clean(m[2].replace(/\\"/g, '"')) : '' };
    } catch (e) {
      return null;
    }
  }

  function fingerprint(el) {
    if (!el || el.nodeType !== 1) return null;
    const tag = tagOf(el);
    let role = computeRole(el);
    const named = nameWithSource(el);
    const text = ownText(el);

    // Prefer Playwright's answer when we can get it, and remember when ours disagreed.
    let roleNameSource = 'computed';
    let roleNameDisagreed = false;
    const authoritative = authoritativeRoleAndName(el);
    if (authoritative && authoritative.role) {
      roleNameSource = 'playwright';
      roleNameDisagreed = authoritative.role !== role || (!!authoritative.name && authoritative.name !== named.name);
      role = authoritative.role;
      if (authoritative.name) named.name = authoritative.name;
    }

    // Is this field holding a credential? The Keycloak sign-in is never recorded (the login
    // happens before the recorder is attached), but a password, API key or one-time code typed
    // INSIDE the app is an ordinary fill as far as the recorder is concerned — and it would
    // otherwise be written to the test file, to the run report, and to the live step list in
    // plain text. Shape-based, because an app will not tell us which of its fields are secret.
    const SECRETY = /pass(word|wd|phrase)?|secret|api[-_ ]?key|\btoken\b|\botp\b|\bpin\b|cvv|credential/i;
    const _type = String(el.getAttribute('type') || '').toLowerCase();
    const _auto = String(el.getAttribute('autocomplete') || '').toLowerCase();
    const isSecret = _type === 'password'
      || _auto === 'current-password' || _auto === 'new-password' || _auto === 'one-time-code'
      || SECRETY.test([el.getAttribute('name'), el.getAttribute('id'),
                       el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' '));

    const attrs = {};
    const volatile = {};
    const testid = firstTestId(el);
    if (testid) attrs[testid.attr] = testid.value;

    // The named attributes we always look at, plus EVERY data-* the element carries. Reading
    // data-* generically is what lets the engine pick up an app's own conventions
    // (data-field-key, data-panel-id …) without anyone teaching it their names.
    const names = IDENTIFYING_ATTRS.slice();
    if (el.attributes) {
      for (const att of el.attributes) {
        const n = att.name.toLowerCase();
        if (IGNORED_ATTR_NAME.test(n)) continue;
        if (n.indexOf('data-') === 0 && TEST_ID_ATTRS.indexOf(n) < 0 && names.indexOf(n) < 0) names.push(n);
      }
    }
    for (const a of names) {
      if (a === 'value' && isSecret) continue;   // never fingerprint a credential
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      let value = clean(el.getAttribute(a));
      if (!value) continue;
      if (a === 'href') { try { value = new URL(value, el.ownerDocument.baseURI).pathname; } catch (e) { /* keep raw */ } }
      const verdict = attributeStability(a, value);
      if (verdict.stable) attrs[a] = value;
      else volatile[a] = value + ' · ' + verdict.reason;
    }
    // Class names are never identity, but a hashed class is worth showing in diagnostics.
    const cls = clean(el.getAttribute && el.getAttribute('class'));
    if (cls) {
      const hashed = cls.split(' ').filter((c) => looksGenerated(c));
      if (hashed.length) volatile.class = hashed.join(' ') + ' · generated class names';
    }

    const ancestors = ancestorContext(el);
    const labels = nativeLabels(el).map((l) => clean(subtreeText(l, 0))).filter(Boolean);
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0, x: 0, y: 0 };

    return {
      uid: uidFor(el),
      tag,
      role,
      name: named.name || null,
      nameSource: named.source,
      roleNameSource,
      roleNameDisagreed,
      text: text || null,
      attrs,
      volatile,
      labels,
      context: {
        ancestors,
        heading: nearestHeading(el),
        landmark: (ancestors.find((a) => a.landmark) || {}).name || null,
        list: listPosition(el),
      },
      siblings: ambiguity(el, role, named.name, text),
      state: {
        visible: rect.width > 0 && rect.height > 0 && !isHidden(el),
        enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
        // Kept for the failure report only. Never used to find an element. (Brief §9.)
        box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      },
      volatileName: looksVolatileText(named.name) || null,
      volatileText: looksVolatileText(text) || null,
      secret: isSecret,
      blindSpot: blindSpot(el),
      // A first-class DOM index, not only the nth-of-type chain baked into `selectors`. CONTRACT §1.
      domIndex: domIndexOf(el),
      selectors: {
        semanticCss: semanticCss(el, attrs),
        contextualCss: contextualCss(el, attrs, ancestors),
        positionalCss: positionalCss(el),
        semanticXPath: semanticXPath(el, attrs, ancestors, text),
        absoluteXPath: absoluteXPath(el),
      },
      // Origin + path ONLY. The full href would persist the Keycloak authorization code and
      // session_state into every test recorded just after a login, and any query-string token
      // besides. The resolver never reads this field; it exists to make a failure readable.
      documentUrl: (function () {
        try { const u = new URL(el.ownerDocument.location.href); return u.origin + u.pathname; }
        catch (e) { return null; }
      })(),
    };
  }

  /** Re-read the identity of an element found during replay, for the similarity comparison. */
  function fingerprintLive(el) {
    const fp = fingerprint(el);
    if (fp) delete fp.uid;
    return fp;
  }

  // ────────────────────────────────────────────────────────── capture

  /**
   * Fingerprint the element the user is touching, at the moment they touch it. Capture phase and
   * `pointerdown` on purpose: by the time a framework has handled the click the node may already
   * be detached, and then nothing can be learned about it.
   */
  function install(opts) {
    const options = opts || {};
    const sink = options.sink || function () {};
    if (window.__opkeyRecInstalled) return;
    window.__opkeyRecInstalled = true;

    const send = (reason, el) => {
      if (!el || el.nodeType !== 1) return;
      if (el === document.documentElement || el === document.body) return;
      let fp = null;
      // A crash in here used to vanish: the capture was dropped, the step reported "no identity
      // capture matched this action", and the reader was sent to look at correlation instead of
      // at the extractor. Report it so the step can say what actually happened.
      try {
        fp = fingerprint(el);
      } catch (e) {
        try { sink({ reason, at: Date.now(), fingerprint: null, error: String((e && e.message) || e).slice(0, 200) }); } catch (e2) { /* the sink is gone */ }
        return;
      }
      if (!fp) return;
      try { sink({ reason, at: Date.now(), fingerprint: fp }); } catch (e) { /* the sink is gone */ }
    };

    const target = (e) => {
      // composedPath() reaches through shadow roots, so a click on a custom element's inner
      // button is attributed to the button, not to the host.
      const path = e.composedPath ? e.composedPath() : null;
      return (path && path.length ? path[0] : e.target);
    };

    document.addEventListener('pointerdown', (e) => send('pointerdown', target(e)), true);
    document.addEventListener('click', (e) => send('click', target(e)), true);
    document.addEventListener('dblclick', (e) => send('dblclick', target(e)), true);
    document.addEventListener('change', (e) => send('change', target(e)), true);
    document.addEventListener('focusin', (e) => send('focus', target(e)), true);
    // One capture per field, not per keystroke: the first key into a focused element is enough.
    let lastKeyTarget = null;
    document.addEventListener('keydown', (e) => {
      const el = target(e);
      if (el === lastKeyTarget) return;
      lastKeyTarget = el;
      send('keydown', el);
    }, true);
    document.addEventListener('focusout', () => { lastKeyTarget = null; }, true);
  }

  return {
    fingerprint,
    fingerprintLive,
    install,
    // exported for unit tests and for reuse by the resolver
    _internals: {
      attributeStability, looksGenerated, looksVolatileText, computeRole, accessibleName,
      nameWithSource, ownText, ancestorContext, ambiguity, semanticXPath, absoluteXPath,
      semanticCss, contextualCss, positionalCss, domIndexOf, clean,
      TEST_ID_ATTRS, IDENTIFYING_ATTRS,
    },
  };
}

/**
 * The library as source, ready for `addInitScript`. Defining it on `window` means both our capture
 * listeners and any later `page.evaluate` share one implementation and one uid counter.
 */
const SOURCE = `
;(() => {
  if (window.__opkeyRec) return;
  window.__opkeyRec = (${browserLibrary.toString()})();
})();
`;

/** Source plus the capture install call, for the recording browser only. */
function installSource(bindingName) {
  return `${SOURCE}
;(() => {
  const send = (payload) => {
    const fn = window[${JSON.stringify(bindingName)}];
    if (typeof fn === 'function') fn(payload);
  };
  const start = () => window.__opkeyRec.install({ sink: send });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
`;
}

module.exports = { browserLibrary, SOURCE, installSource };
