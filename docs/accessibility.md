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

## Session timeout dialog: keyboard and async status (#1153)

`src/components/SessionWarning.jsx` is mounted on every page (`src/app/layout.js`). It shows a
`role="alertdialog"` warning shortly before the session cookie expires, and a "Session expired" dialog once
it has expired. Tests: `src/components/__tests__/SessionWarning.test.jsx`. They run the real
`useSessionExpiry` hook with `fetch` mocked, so the refresh request's real outcomes drive the dialog.

```bash
npx vitest run src/components/__tests__/SessionWarning.test.jsx
```

| Path | Behaviour covered |
|------|-------------------|
| Normal | When the warning opens, focus moves to "Keep me signed in". Tab and Shift+Tab stay inside the dialog. Enter renews the session, the dialog closes and focus returns to the element that had it before. |
| Async status | While renewing, the button reads "Renewing..." and is disabled. A failed renewal is announced with `role="alert"`. The countdown is `role="timer"`. |
| Retry | After a failure the button is enabled again. A second attempt that succeeds closes the dialog and clears the alert. |
| Authorization | A refresh rejected by the server (e.g. 401) switches to the "Session expired" dialog with focus on "Sign in again". |
| Audit | No axe violations in either dialog. |

Fixes made for this coverage:

- **Focus moves into the dialog.** Both dialogs declared `aria-modal="true"` but left focus behind them, so
  keyboard and screen-reader users were still on the page underneath. They now use the shared
  `useFocusTrap` hook, as `Modal` does. That gives focus on open, Tab containment, and focus restored on close.
- **No announcement every second.** The countdown was `aria-live="polite"` and changed every second, so
  screen readers queued a new announcement each second. `role="timer"` has an implicit `aria-live` of
  `off` (WAI-ARIA 1.2). The time is still readable on demand, and the dialog's description announces the
  warning once.

Edge cases:

- **Escape does nothing.** Neither dialog has a dismiss action. Closing the warning would let the session
  lapse unnoticed, and the expired dialog has to lead to signing in again.
- **Warning turns into expired.** If the refresh is rejected while the warning is open, the warning's trap
  releases and the expired dialog's trap takes focus. Focus ends on "Sign in again", never on the page.
- **Network failure vs rejection.** A network error keeps the warning open with an alert, so the user can
  retry. A non-OK refresh response means the session cannot be renewed and is treated as expired. Recovery
  in that case is to sign in again (the button reloads the page).
- **Known gap.** The renew button is `disabled` while the request is in flight, and browsers may move
  focus off a disabled element. That is unchanged here. The alert still announces the outcome.

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
