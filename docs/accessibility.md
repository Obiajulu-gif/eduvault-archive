# Accessibility

Accessibility remediation for the primary workflow screens (#795). The goal is
that the main user journey — discover, purchase, publish, and manage materials —
is usable with keyboard navigation, screen readers, visible focus states, and
accessible error messaging.

## Automated checks

The project uses [jest-axe](https://github.com/nickcolley/jest-axe) (already a
dev dependency, wired up in `test/setup-vitest.js`) to run WCAG audits against
rendered components in tests.

Run the accessibility tests:

```bash
# All tests (including axe)
npm test

# Just the upload-form axe suite
npx vitest run src/app/dashboard/upload/components/__tests__/UploadForm.a11y.test.js
```

### What the automated checks cover

- **No axe violations** on the primary creator upload form (`UploadForm`).
- **Accessible labels** — every input on the upload form has a linked `<label>`,
  `aria-label`, or `aria-labelledby`.
- **Required fields** — announced via `aria-required`.
- **Error descriptions** — field errors are linked from the input via
  `aria-describedby` and announced with `role="alert"`.
- **Submit button** — exposes an accessible name and `aria-busy` state.

## Structural fixes applied (#795)

- **Skip-to-content link** — added to `src/app/layout.js` as the first
  focusable element on every page, letting keyboard users jump past the
  navigation straight to the main content.
- **Single `<main>` landmark** — all page content is wrapped in
  `<main id="main-content" tabIndex={-1}>`, giving screen readers a consistent
  navigation target and the skip link a stable destination.
- **Marketplace page** — removed ~700 lines of dead code that caused a syntax
  error (two `export default` statements and undefined references), restoring
  the primary discovery screen to a working state.

## Manual verification checklist

Automated checks can't catch everything. Before shipping a change to a primary
workflow screen, verify the following manually:

### Keyboard navigation

1. **Tab order** — press `Tab` through the page. Focus should move in a logical
   order (skip link → nav → main content → footer) and never get trapped.
2. **Skip link** — press `Tab` once on a page; the skip link should appear.
   Activate it; focus should move to the main content.
3. **All interactive elements reachable** — every button, link, input, select,
   and radio must be focusable and activatable with `Enter`/`Space`.
4. **Focus visible** — every focused element must have a visible focus ring
   (the app uses `focus-visible:ring-2` utilities; verify none are removed).
5. **Modals** — opening a modal (e.g. Buy Now) should move focus into it;
   `Escape` should close it; focus should return to the trigger on close.

### Screen readers

6. **Labels** — every form field announces its label (e.g. "Document Title,
   edit, required").
7. **Errors** — submitting an invalid form announces each error and moves
   focus to the first invalid field.
8. **Headings** — the page has a logical heading hierarchy (`h1` → `h2` →
   `h3`) with no skipped levels.
9. **Landmarks** — the page exposes `navigation`, `main`, and `contentinfo`
   landmarks.
10. **Live regions** — async status changes (upload success/failure) are
    announced via `role="status"` / `role="alert"`.

### Contrast

11. **Text contrast** — body text meets WCAG AA (4.5:1). The app's
    `text-gray-500` on white is acceptable for large text only; body copy uses
    `text-gray-600` or darker.
12. **Focus indicators** — focus rings meet 3:1 against adjacent colors.

## Reproducing the automated checks

```bash
npm install
npm test
```

The axe tests run as part of the standard vitest suite. A violation fails the
test with a full report of the offending nodes and the WCAG criteria they
break.
