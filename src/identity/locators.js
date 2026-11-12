/**
 * Element Identity Engine — turning a candidate descriptor into a real Playwright locator.
 *
 * The single place where a strategy becomes API calls. Record-time validation and replay both go
 * through here, so the locator that was proven unique when the test was made is byte-for-byte the
 * locator that runs a week later. If these two ever diverged, every validation result would be a
 * lie, which is why there is exactly one implementation.
 */
'use strict';

/**
 * @param {import('playwright').Page|import('playwright').Frame|import('playwright').Locator} root
 * @param {object} candidate  { strategy, params, scope? }
 * @returns {import('playwright').Locator}
 */
function buildLocator(root, candidate) {
  const base = candidate.scope ? buildLocator(root, candidate.scope) : root;
  const scoped = !!candidate.scope || isLocator(root);
  return build(base, candidate.strategy, candidate.params || {}, scoped);
}

function isLocator(x) {
  return !!x && typeof x.elementHandles === 'function' && typeof x.first === 'function';
}

function build(root, strategy, p, scoped) {
  switch (strategy) {
    case 'testid':
      // getByTestId honours the configured attribute name; when a candidate names a DIFFERENT
      // attribute (an app using data-qa alongside data-testid) fall back to an attribute selector.
      return p.attr && p.attr !== 'data-testid'
        ? root.locator(`[${p.attr}=${cssQuote(p.value)}]`)
        : root.getByTestId(p.value);

    case 'id':
      return root.locator(`#${cssEscapeId(p.value)}`);

    case 'role':
      return root.getByRole(p.role, compact({
        name: p.name,
        exact: p.name !== undefined ? p.exact !== false : undefined,
      }));

    case 'label':
      return root.getByLabel(p.text, compact({ exact: p.exact !== false }));

    case 'placeholder':
      return root.getByPlaceholder(p.text, compact({ exact: p.exact !== false }));

    case 'altText':
      return root.getByAltText(p.text, compact({ exact: p.exact !== false }));

    case 'title':
      return root.getByTitle(p.text, compact({ exact: p.exact !== false }));

    case 'attr': {
      const tag = p.tag || '';
      const pairs = p.pairs || [[p.name, p.value]];
      return root.locator(tag + pairs.map(([n, v]) => `[${n}=${cssQuote(v)}]`).join(''));
    }

    case 'text': {
      if (!p.tag) return root.getByText(p.text, compact({ exact: p.exact !== false }));
      // Exact text, restricted to a tag. `filter({hasText})` takes a regex, so anchor it.
      return p.exact === false
        ? root.locator(p.tag, { hasText: p.text })
        : root.locator(p.tag).filter({ hasText: exactRegExp(p.text) });
    }

    case 'css':
      return root.locator(p.value);

    case 'xpath':
    case 'positional':
      if (p.kind === 'css') return root.locator(p.value);
      // A chained xpath must be relative, or it escapes back to the whole document.
      return root.locator('xpath=' + (scoped ? relativeXPath(p.value) : p.value));

    // ── the positional band (CONTRACT.md §3). Three strategies, three shapes, one rule: what they
    // return is a POSITION, and the resolver may not act on it until similarity.compare() has
    // agreed the element standing there is still the recorded one.
    case 'domIndex':
      // 'ordinal' is the DOM index proper — the nth element of this tag in the document. 'path' is
      // the child-position chain, which says the same thing relative to each parent in turn.
      return p.kind === 'ordinal'
        ? root.locator(p.tag || '*').nth(p.index || 0)
        : root.locator(p.value);

    case 'relativeXPath':
      return root.locator('xpath=' + (scoped ? relativeXPath(p.value) : p.value));

    case 'absoluteXPath':
      // Deliberately absolute even when chained: an absolute path means the document root, and
      // silently re-rooting it at a container would make it quietly match something else.
      return root.locator('xpath=' + p.value);

    default:
      throw new Error(`Unknown locator strategy "${strategy}"`);
  }
}

/** `//form//button` → `.//form//button` when the locator is chained onto a container. */
function relativeXPath(xp) {
  const s = String(xp);
  if (s.startsWith('./') || s.startsWith('(')) return s;
  if (s.startsWith('//')) return '.' + s;
  if (s.startsWith('/')) return s; // an absolute path is deliberately absolute
  return s;
}

function exactRegExp(text) {
  return new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cssQuote(v) {
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function cssEscapeId(v) {
  return String(v).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

function compact(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** How the candidate reads as code — shown in the inspector and in failure reports. */
function describeCandidate(candidate) {
  const p = candidate.params || {};
  const inner = (() => {
    switch (candidate.strategy) {
      case 'testid': return p.attr && p.attr !== 'data-testid' ? `locator('[${p.attr}="${p.value}"]')` : `getByTestId(${q(p.value)})`;
      case 'id': return `locator('#${p.value}')`;
      case 'role': return p.name !== undefined
        ? `getByRole(${q(p.role)}, { name: ${q(p.name)}${p.exact === false ? '' : ', exact: true'} })`
        : `getByRole(${q(p.role)})`;
      case 'label': return `getByLabel(${q(p.text)})`;
      case 'placeholder': return `getByPlaceholder(${q(p.text)})`;
      case 'altText': return `getByAltText(${q(p.text)})`;
      case 'title': return `getByTitle(${q(p.text)})`;
      case 'attr': {
        const pairs = p.pairs || [[p.name, p.value]];
        return `locator('${p.tag || ''}${pairs.map(([n, v]) => `[${n}="${v}"]`).join('')}')`;
      }
      case 'text': return p.tag
        ? `locator(${q(p.tag)}).filter({ hasText: ${q(p.text)} })`
        : `getByText(${q(p.text)})`;
      case 'css': return `locator(${q(p.value)})`;
      case 'xpath': return `locator('xpath=${p.value}')`;
      case 'domIndex': return p.kind === 'ordinal'
        ? `locator(${q(p.tag || '*')}).nth(${p.index || 0})`
        : `locator(${q(p.value)})`;
      case 'relativeXPath': return `locator('xpath=${p.value}')`;
      case 'absoluteXPath': return `locator('xpath=${p.value}')`;
      case 'positional': return p.kind === 'css' ? `locator(${q(p.value)})` : `locator('xpath=${p.value}')`;
      default: return candidate.strategy;
    }
  })();
  return candidate.scope ? `${describeCandidate(candidate.scope)}.${inner}` : inner;
}

function q(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

module.exports = { buildLocator, describeCandidate };
