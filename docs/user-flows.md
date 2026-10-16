# EduVault User Flows

Three concise user flows are documented below: Creator, Buyer, and Accessibility.

## Creator Flow

1. Connect wallet and create profile in the app.
2. Upload material metadata and file via the Creator Upload UI.
3. Backend pins file and metadata to IPFS (Pinata) and creates a `materials` record in MongoDB.
4. Creator sets price, visibility, and rights.
5. Optionally the backend registers the material on-chain via `MaterialRegistry` (Soroban), emitting `material.registered` events.
6. Indexer picks up on-chain events and updates derived state.

Systems involved: Frontend, Backend API, MongoDB (`materials`), IPFS/Pinata, Soroban `MaterialRegistry`, Indexer.

## Buyer Flow

1. Browse marketplace, open a material detail page.
2. View bounded/watermarked preview of paid material.
3. Start checkout; frontend requests a signed Stellar transaction via wallet.
4. Backend or frontend submits transaction to Soroban `PurchaseManager`.
5. Soroban emits `purchase.completed` event on success.
6. Indexer consumes events and writes `purchases` and `entitlement_cache`.
7. Buyer requests material access; backend checks `entitlement_cache` and `purchases` and returns an access status.

Systems involved: Frontend, Wallet, Soroban `PurchaseManager`, Stellar RPC, Indexer, MongoDB (`purchases`, `entitlement_cache`).

## Maintainer Operations

- Run the indexer locally: `npm run indexer:stellar` (uses `scripts/run-stellar-indexer.mjs`).
- Reprocess dead-letter entries: `node scripts/reprocess-deadletter.mjs`.
- Inspect dead-letter events in MongoDB collection `dead_letter_events` for failure details.

## Mobile checkout recovery (#684)

Mobile users who leave the browser or wallet popup mid-checkout can now resume or safely cancel:

- `PurchaseManager::begin_checkout(buyer, material_id)` records a pending attempt; a second submission while pending is blocked with `CheckoutPending` (no duplicate checkout).
- `PurchaseManager::cancel_checkout(buyer, material_id)` clears a pending attempt after an interruption (safe to call; missing attempts are not an error).
- A completed `purchase` clears the pending state automatically.

Flow: begin checkout -> wallet signing interrupted -> return to app -> either retry (pending blocks duplicates until cancelled) or cancel and re-quote.

## Learner progress bookmarks tied to material versions (#708)

Learners track their progress and bookmark states tied to the exact material version purchased:
- Progress records are composite-indexed by `(walletAddress, materialId, version)`.
- When a material creator releases an updated material version, existing bookmarks remain attached to the purchased version without data corruption.
- Material rollbacks query historical version bookmarks directly.
- Learners can export their progress history via privacy export APIs.

## Accessibility Flow (#712)

Complex forms and error recovery screens are keyboard-navigable and announced correctly to assistive technology. This covers the Creator Upload form, the checkout recovery screen, and the material edit form.

> Note: the accessibility component tests referenced below are authored as `.jsx` files and executed through the project's Jest/Babel pipeline (`npm test`). Do not run `node --check` directly against `.jsx` files; Node's built-in syntax checker does not understand the `.jsx` extension and will fail with `ERR_UNKNOWN_FILE_EXTENSION`. Use `npm test -- tests/accessibility` (or `npx jest tests/accessibility`) for syntax and behavior verification instead.

> Note: the accessibility component tests referenced below are authored as `.jsx` files and executed through the project's Jest/Babel pipeline (`npm test`). Do not run `node --check` directly against `.jsx` files; Node's built-in syntax checker does not understand the `.jsx` extension and will fail with `ERR_UNKNOWN_FILE_EXTENSION`. Use `npm test -- tests/accessibility` (or `npx jest tests/accessibility`) for syntax and behavior verification instead.

### Keyboard navigation

- Tab order follows the visual layout: field label -> field control -> help text -> error message -> next field.
- All interactive controls (buttons, checkboxes, radio groups, selects) are reachable with Tab/Shift+Tab.
- Enter submits the form; Escape dismisses the current dialog or cancels a pending checkout attempt.
- Focus is trapped inside modals and returned to the triggering element on close.
- No keyboard traps: every focusable element has a visible focus indicator and a logical exit path.

### Labels and descriptions

- Every input has a programmatically associated `<label>` via `id` / `htmlFor`.
- Required fields are marked with `aria-required="true"` and a visible required indicator.
- Help text is linked with `aria-describedby`.
- Error messages use `role="alert"` and are referenced from the field via `aria-describedby`.
- Invalid fields set `aria-invalid="true"` and move focus to the first invalid field on submit.

### Error announcement

- Validation errors are announced through a live region (`role="alert"`, `aria-live="assertive"`).
- Success confirmations use `aria-live="polite"` so they do not interrupt in-progress reading.
- Error summaries link to the affected fields so users can jump directly to the problem.
- Error text is descriptive and actionable (for example, "Price must be a positive number").

### Verification

Automated component tests cover keyboard navigation, error announcement, and field linking:

- `tests/accessibility/creator-upload.form.test.jsx` — keyboard-only completion and validation failure.
- `tests/accessibility/checkout-recovery.form.test.jsx` — focus management and Error announcement.
- `tests/accessibility/material-edit.form.test.jsx` — label association and aria-describedby linkage.

Documented manual checks:

1. Navigate the Creator Upload form with Tab only; confirm every field receives focus in order.
2. Submit with an invalid price; confirm the error is announced and focus moves to the price field.
3. Open the checkout recovery screen with a screen reader; confirm the pending attempt and cancel action are announced.
4. Run `npm test -- tests/accessibility` and confirm all accessibility checks pass.
5. Confirm the accessibility suite is executed via Jest (not `node --check`); `.jsx` files must be transformed by the project's Babel config before syntax validation.
5. Confirm the accessibility suite is executed via Jest (not `node --check`); `.jsx` files must be transformed by the project's Babel config before syntax validation.
