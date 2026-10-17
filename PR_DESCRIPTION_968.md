### Description

Adds a stable RFC 9457 Problem Details taxonomy for EduVault API failures. The shared handler and critical purchase, entitlement/download, creator payout, archive, and wallet-verification paths now provide machine-readable codes, safe messages, remediation guidance, and correlation IDs. Existing success shapes and HTTP statuses are preserved on migrated routes, with a deprecated `error` compatibility alias for older clients.

### Type of Change

- [ ] Bug fix
- [x] New feature
- [ ] Breaking change
- [x] Documentation update

### Files Modified

- `src/lib/errors/` — stable error catalog, correlation validation, safe serialization, and response rendering.
- `src/lib/api/hardening.js` and `src/lib/utils/errorResponse.js` — shared structured handling and legacy adapter.
- `src/app/api/` — purchase/quote, entitlement, download, creator payout/archive, and wallet verification error responses.
- `src/lib/checkout/quotes.js` — stable archived/unavailable material errors.
- `src/**/__tests__/` — taxonomy drift, sanitization, API route, and quote tests.
- `docs/api-problem-details.md`, `docs/API_REFERENCE.md`, `docs/openapi.yaml`, `public/openapi.yaml` — public contract and operational guidance.

### Testing

- [x] Tested locally
- [x] Added unit tests
- [ ] Tested on Stellar Testnet (for wallet/contract changes)

Focused Vitest run: **45 tests passed across 6 files**. ESLint, `git diff --check`, and YAML parsing for both OpenAPI documents passed.

### Code Quality checks

- Runtime error codes and statuses are checked against a pinned contract catalog and both OpenAPI copies.
- Unexpected exceptions are logged server-side and serialized without exception messages or stack traces.
- Correlation IDs are length- and character-validated; query parameters are excluded from `instance`.
- Dependencies were installed with `npm install --no-package-lock` because `npm ci` reports the existing `undici` lockfile mismatch. No package manifest or lockfile changes were made.
- The repository's default jsdom Vitest environment is incompatible with the installed Undici override; focused tests passed with Vitest's Node environment.

### Behavioural Changes

- Migrated API failures return `application/problem+json` with stable `code`, `retryable`, `recovery`, `correlationId`, and legacy `error` compatibility text.
- Protected downloads remain fail-closed when entitlement or storage verification is unavailable.
- Archived materials cannot receive new checkout quotes; existing entitlements and successful API response shapes are unchanged.
- Other legacy API handlers are documented as incremental migrations and are not changed by this PR.
- Operational documentation covers uncertain payment status, payout reconciliation, archive/search projection recovery, and storage restoration.

### Tests Errors

No failures in the focused test run. `npm ci` could not run because the existing lockfile pins `undici@6.29.0` where the manifest override requires `undici@6.29.1`. The focused Vitest tests passed using `--environment node` due to an existing jsdom/Undici compatibility issue.

Closes #968
