# Design system

Replayr is a local developer tool: record a bug on production, replay it on localhost, verify the fix. The UI is a dense, quiet workbench. This document is the reference for tokens and shared components. The source of truth is `ui/app.css` (sections 1 and 13) and the icon sprite in `ui/index.html`.

Rules: no build step, no external requests (Inter and icons are vendored), screens use the shared classes and tokens and do not restyle them locally.

## Principles

Distilled from the general approach of Linear, Raycast, Vercel Geist, Sentry, the Playwright Trace Viewer and the Chrome DevTools Recorder (written from general knowledge of those products, not copied from them).

1. **Density with hierarchy.** 13px base text, 32px controls, 8px table rows. Hierarchy comes from weight, colour step and spacing, not from size jumps or decoration.
2. **Layered neutral surfaces, not shadows.** canvas, surface, surface-2 (panels, table headers), surface-3 (chips, counts). A 1px border separates layers. Shadows exist only for overlays (menus, modals, toasts).
3. **One accent, used sparingly.** Violet marks the primary action, the current location and focus. Cyan is a secondary data hue. Everything else is neutral until it carries meaning.
4. **Status is shape + text + colour.** Never colour alone. Pills have a dot whose shape varies (round, square, diamond, hollow), environments have an icon and a label.
5. **Danger is loud only where it matters.** Production is the one environment with a red border, red banner and shield icon. A user must always know which environment they are targeting.
6. **Master/detail with an inspector.** Lists and tables on the left, a persistent inspector pane on the right (Playwright Trace Viewer, DevTools). Keep the user in place instead of navigating away.
7. **Sticky headers, tabular numbers, monospace for machine text.** Durations, URLs, selectors and ids are mono or tabular so columns align and scanning is quick.
8. **Keyboard first.** Every control has a visible focus ring (`--ring`), shortcuts are shown as `.kbd`, the command palette reaches everything.
9. **Empty, loading and error states are designed.** An empty state teaches the next step with one action. Loading uses skeletons that match the final layout. Errors are inline, next to the field, with an icon.
10. **Calm motion.** 120 to 180ms, ease-out, opacity and a few pixels of translate. `prefers-reduced-motion` removes it.

## Theming

Light is the `:root` default. Dark is defined twice, identically: inside `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` (first launch, no stored choice) and in `:root[data-theme="dark"]` (explicit choice). `core.js` persists `tf.theme` in localStorage and sets `data-theme` on `<html>`. When you change a dark value, change both blocks.

## Tokens

### Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #F6F7F9 | #101318 | canvas |
| `--surface` | #FFFFFF | #181D25 | cards, sidebar, topbar, inputs |
| `--surface-2` | #F1F3F6 | #1C222B | panels, table header, hover |
| `--surface-3` | #E6E9EE | #262E3A | counts, pressed, skeleton |
| `--border` / `--border-strong` | #E2E5EA / #CBD0D8 | #262D38 / #38414F | dividers / control borders |
| `--text` | #14171C | #F3F4F8 | body |
| `--text-muted` | #4A5160 | #9CA3AF | secondary text |
| `--text-subtle` | #5F6776 | #929AA8 | captions, labels, placeholders |
| `--accent` / `--accent-hover` | #5B46D6 / #4B38BE | #8B7DF5 / #A095F8 | primary action, links, focus |
| `--accent-soft` | 9% accent | 8% accent | selected row, active chip |
| `--accent-fg` | #FFFFFF | #0B0D12 | text on a solid accent fill |
| `--accent-2` | #0B7285 | #59C9DF | cyan secondary |
| `--success` | #0D7344 | #43C995 | passed, local |
| `--danger` | #B4232C | #F16D78 | failed, production, destructive |
| `--warning` | #8A5A00 | #E9B765 | blocked, staging |
| `--info` | #0B6B80 | #59C9DF | running, development |
| `--neutral` | #4A5160 | #9CA3AF | cancelled, inconclusive |

Each semantic colour `X` also has `--X-bg` (tinted fill) and `--X-line` (tinted border): success, danger, warning, info and neutral (neutral has `--neutral-bg` and `--neutral-line`). `--on-danger` is the text colour on a solid danger fill.

Environment tokens: `--env-production`, `--env-staging`, `--env-development`, `--env-local`, each with `-bg`. They alias danger, warning, info and success.

Dark accent is lighter than a typical electric violet (#7665EF) on purpose: that value gives only 4.1:1 as text on dark surfaces. Solid accent fills in dark use dark text (`--accent-fg`).

Other: `--ring` is a ready-made box-shadow (`box-shadow: var(--ring)`), `--hover-wash`, `--scrim`/`--overlay`, `--focus`.

### Contrast (WCAG 2.x, computed with `relative luminance`, 4.5:1 is AA for body text)

| Pair | Light | Dark |
|---|---|---|
| text on canvas / surface | 16.8 / 18.0 | 16.9 / 15.4 |
| muted on canvas / surface-2 / surface-3 | 7.4 / 7.2 / 6.5 | 7.3 / 6.3 / 5.4 |
| subtle on canvas / surface-2 / surface-3 | 5.3 / 5.1 / 4.7 | 6.6 / 5.6 / 4.8 |
| accent text on surface / on accent-soft | 6.4 / 5.6 | 5.1 / 4.6 |
| primary button text on accent / hover | 6.4 / 8.1 | 5.9 / 7.5 |
| success text on surface / own tint | 5.9 / 5.2 | 8.1 / 6.5 |
| danger text on surface / own tint | 6.5 / 5.8 | 5.8 / 4.9 |
| warning text on surface / own tint | 5.9 / 5.2 | 9.2 / 7.3 |
| info text on surface / own tint | 6.1 / 5.5 | 8.7 / 7.0 |
| neutral text on surface / own tint | 8.0 / 7.1 | 6.7 / 5.5 |
| danger button text on danger | 6.5 | 6.6 |

All body-text pairs are 4.5:1 or better in both themes. Borders and the focus ring are non-text UI and need 3:1; the ring is a solid accent.

### Type

`--font-sans`: Inter (variable, latin, vendored at `/ui/fonts/inter-var-latin.woff2`, SIL OFL 1.1, licence in `ui/fonts/LICENSE-Inter.txt`), then the system UI stack. `--font-mono`: ui-monospace, SFMono-Regular, Cascadia Code, Consolas.
Scale: `--fs-xs` 11, `--fs-sm` 12, `--fs-base` 13, `--fs-md` 14, `--fs-lg` 16, `--fs-xl` 20. Legacy aliases (`--fs-body`, `--fs-body-sm`, `--fs-caption`, `--fs-label`, `--fs-title`, ...) point at the same scale. Weights 400/500/600.

### Spacing, radius, size, shadow, motion

- Spacing `--sp-1..--sp-8`: 4, 8, 12, 16, 20, 24, 32, 40 (also `--sp-10` 40, `--sp-12` 48).
- Radius: `--r-sm` 4, `--r-md` 6, `--r-lg` 8, `--r-xl` 12, `--r-pill`. Controls use `--r-md`, cards and panels `--r-lg`.
- Controls: `--ctl-h` 32, `--ctl-h-sm` 26, `--ctl-h-lg` 36. Below 900px the touch sizes grow to 40+.
- Shadows `--shadow-sm|md|lg`: overlays only. Cards are flat.
- Motion: `--ease`, `--dur-fast` 120ms, `--dur` 180ms.

## Component catalogue

| Component | Classes and notes |
|---|---|
| Button | `.btn` + `.btn-primary` / `.btn-secondary` / `.btn-ghost` / `.btn-danger`, `.btn-sm`, `.btn-lg`, `.btn-icon` (square, add `data-tip` and `aria-label`), `.btn-group`, `aria-busy="true"` for loading |
| Kbd | `.kbd` or `<kbd>` |
| Input | `.input` (or legacy `input.field`), `.input-sm`, `.input-group` (icon + input), `aria-invalid="true"` shows the danger border |
| Select | `.select` (or `select.field`), custom chevron |
| Field | `<div class="field [has-error|is-valid]">` wrapping `.field-label`, a control, `.field-hint`, `.field-error`. Errors show only under `.has-error` and carry an icon |
| Card | `.card` (flat, 1px border), `.card-pad`, `.card-head`, `.card-interactive` |
| Panel | `.panel`, `.panel-header`, `.panel-body` (surface-2, for inspectors) |
| Table | `.table` (or legacy `table.tbl`): sticky header, hover, `aria-selected="true"` or `.selected` row. Wrap in `.table-scroll` with a max-height to keep the header sticky |
| Tabs | `.tabs` > `.tab` (`aria-selected="true"` or `.is-active`), optional `.count` |
| Status pill | `.pill.st-passed|failed|blocked|error|cancelled|inconclusive|running|not-run|never` with `<span class="dot"></span>` and the label |
| Env badge | `.env-badge.env-production|staging|development|local` containing an icon (`#i-shield`, `#i-flask`, `#i-code`, `#i-laptop`) plus the label |
| Env banner | `.env-banner.env-<kind>` with the same icon, a strong label, optional `.mono` URL and `.env-banner-actions` |
| Empty state | `.empty` > `.art` (an icon gets a tile, a larger illustration is left alone), `h2`, `p`, one action |
| Skeleton | `.skeleton` plus a width/height, helpers `.skeleton-line`, `.skeleton-block` |
| Toast | `.toasts` host, `.toast` (+ `.good` / `.bad` / `.warn`) |
| Modal | `.overlay` > `.modal` (`.mhead`, `.mbody`, `.mfoot`); fade + 6px rise on enter |
| Menu | `.menu` with `button` or `[role=menuitem]`, `.danger`, `.mhead`, `.msep` |
| Tooltip | any element with `data-tip="text"`, optional `data-tip-pos="bottom|left|right"`; shown on hover and keyboard focus, hidden on touch |
| Divider | `.divider`, `.divider-v` |
| Utility | `.mono`, `.muted`, `.subtle`, `.truncate`, `.row`, `.col`, `.spread`, `.grow`, `.eyebrow`, `.badge-count`, `.sr-only` |

Legacy components still in `app.css` (nav, sidebar, steps, stepper, `.kv`, `.note`, `.seg`, `.switch`, checkbox, list rows, result header, lightbox, palette) keep working and use the same tokens.

## Icons

The sprite lives in `ui/index.html`; use `icon(name)` in JS, or `<svg class="i"><use href="#i-name"/></svg>`. Style: Lucide-like (ISC), 24px viewBox, 1.75 stroke, round caps and joins, set once by `.i` in `app.css` (symbols carry geometry only). Sizes: `.i` 16, `.i-sm` 14, `.i-lg` 20, `.i-xl` 26.

Added by the design system: `i-laptop i-flask i-code i-git-branch i-crosshair i-mouse-pointer i-list-checks i-alert-triangle i-circle-check i-circle-x i-circle-dashed i-ban i-square i-external-link i-panel-right i-maximize i-minimize i-grip-vertical i-chevron-up i-arrow-up i-arrow-down i-download i-link i-bug i-eye-off`. Existing ids were kept. Notes: older symbols drawn with a 8.5 radius circle (`i-check-circle`, `i-x-circle`, `i-info`) are slightly smaller than the new 10 radius ones (`i-circle-check`, `i-circle-x`); prefer the new names in new code.

## Accessibility checklist

Visible focus ring on every interactive element; status never by colour alone; 4.5:1 text contrast in both themes; targets grow to 40px on touch widths; `prefers-reduced-motion` honoured; tooltips are supplementary and never the only label (use `aria-label`).
