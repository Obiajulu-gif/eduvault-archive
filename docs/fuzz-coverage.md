# Fuzz Coverage for Malformed Payloads and Boundary Numeric Values

**Issue #1013** — `src/lib/api/fuzzCorpus.js` + `tests/backend/fuzz.test.mjs`

## Overview

The fuzz layer systematically exercises every input validator with adversarial,
malformed, and boundary-edge inputs.  It enforces two invariants on every entry:

1. **No uncaught exception** — validators must either return a safe value or
   throw a `ValidationError`.  A raw `TypeError`, `RangeError`, or unhandled
   `Error` from inside a validator is a test failure.
2. **Output invariants** — when a validator succeeds, its return value must
   satisfy the contract (non-negative finite price, length ≤ declared max, no
   control characters, canonical form, etc.).

---

## Fuzz Corpus Categories

| Export              | Contents |
|---------------------|----------|
| `FUZZ_STRINGS`      | Control chars, null bytes, Unicode edge cases, XSS/SQLi/NoSQLi/path-traversal injection, overlong strings, CRLF injection, ReDoS probes, non-string primitives |
| `FUZZ_NUMBERS`      | `Infinity`, `-Infinity`, `NaN`, `-0`, `MAX_SAFE_INTEGER`, `MIN_SAFE_INTEGER`, `MAX_VALUE`, precision traps (`0.1+0.2`), overflow probes (`2**63`), string coercions |
| `FUZZ_URLS`         | `javascript:`, `data:`, `vbscript:`, `file:`, protocol-relative, embedded whitespace/tabs/newlines, Cyrillic confusables, null-byte injection |
| `FUZZ_EMAILS`       | CRLF injection, missing `@`, overlong local parts, null bytes, non-string types |
| `FUZZ_WALLET_ADDRESSES` | Wrong-length EVM/Stellar, wrong prefix, non-hex chars, injection strings |
| `FUZZ_OBJECTS`      | `null`, primitives as body, prototype-polluting keys (`__proto__`, `constructor`), deeply nested, function values |
| `FUZZ_PAGINATION`   | Cursor injection, `pageSize` coercion traps (`NaN`, `Infinity`, `-1`, `1000000`) |
| `FUZZ_DATES`        | Invalid ISO strings, far-future/far-past, negative timestamps, `Infinity`/`NaN`, injection strings |
| `FUZZ_FILE_META`    | Negative/zero/`Infinity` sizes, disallowed MIME types, missing fields, overlong names, path-traversal names |
| `FUZZ_AUTH_COOKIES` | Raw `Cookie` headers: empty, malformed percent-encoding, non-JWT values, `alg: none`, forged signatures, CRLF and operator injection (#1147) |

---

## Validators Covered

| Validator | Key assertions |
|-----------|----------------|
| `sanitizeString` | Always returns `string`; output ≤ `maxLength`; no C0 control chars; trimmed |
| `validatePrice` | Only returns non-negative finite values ≤ 1 000 000; rejects `Infinity`/`NaN`/negatives |
| `validateEmail` | Returns lowercase string with `@`; length ≤ 254; CRLF injection rejected |
| `normalizeWalletAddress` | Returns valid EVM or Stellar address, or `null`; injection strings rejected |
| `isSafeUrl` | `javascript:`/`data:`/`vbscript:`/`file:`/protocol-relative always `false`; never throws |
| `validateProfilePayload` | Non-object bodies handled; prototype pollution does not mutate `Object.prototype` |
| `validateMaterialPayload` | Price boundary; visibility enum; XSS in title stripped of control chars |
| `validateUploadFileMetadata` | Exact 10 MB boundary; `Infinity` size rejected; disallowed MIME types rejected |
| `parsePagination` | `pageSize` clamped to `[1, maxPageSize]`; cursor injection does not crash |
| `validateDateRangeQuery` | Invalid dates rejected; `from > to` rejected; range > `maxRangeDays` rejected |
| `validateMaterialUpdatePayload` | Non-object bodies are a `ValidationError`; every editable field survives the string corpus; `javascript:`/`data:`/`vbscript:`/protocol-relative thumbnails never stored; price boundaries |
| `validateExpectedVersion` | Returns `null` (no precondition) or a positive integer; zero, negative, fractional and non-finite versions rejected; the same `If-Match` value always parses to the same version |
| `validateChangeReason` | Never throws; result is `null` or ≤ 500 characters |
| `getUserFromCookie` / `requireActiveUser` / `requireAdmin` | Never throw; every fuzz cookie, plus expired, wrong-secret, wrong-algorithm, missing-`sub` and tampered tokens, fails closed (`null` / `{ ok: false, status: 401 }`); a correctly signed token still authenticates |

---

## Normal, failure, retry and authorization paths (#1147)

| Path | What the fuzz suite proves |
|------|----------------------------|
| Normal | Boundary values that are valid (price `0`, version `7`, a signed token, a percent-encoded token next to other cookies) are accepted unchanged. |
| Failure | Malformed material updates fail with a `ValidationError` (HTTP 400), never a raw `TypeError` (HTTP 500). |
| Retry | `expectedVersion` / `If-Match` parsing is deterministic, so a retried update carries the same precondition and the versioned write returns 409 rather than applying twice. |
| Authorization | Malformed or forged session cookies never authenticate and never throw out of the auth helpers. |

### Defects the suite found and the fixes

- `src/lib/api/validation.js` declared `validateMaterialUpdatePayload` and `validateChangeReason` twice, so the
  module failed to load with `SyntaxError: Identifier ... has already been declared`. This broke this suite
  and every route importing the module. The later copies were removed. The remaining original checks
  `thumbnailUrl` with `validateOptionalUrl`; the removed copy stored any string.
- `validateMaterialUpdatePayload(null)` (a `null` JSON body) threw `TypeError`. It now throws
  `ValidationError("Request body must be a JSON object")`.
- `getUserFromCookie` decoded the cookie with `decodeURIComponent` outside any `try`, so a cookie such as
  `auth_token=%E0%A4%A` threw `URIError` (HTTP 500) out of `requireActiveUser`, `requirePermission` and
  `requireAdmin`. A malformed cookie is now treated as no session (HTTP 401).

### Edge cases and recovery

- **Recovery from a bad cookie** needs no server action: the request is unauthenticated (401). The client
  signs in again and receives a fresh cookie.
- **Lenient version coercion (unchanged, documented).** `validateExpectedVersion` uses `Number()`, so
  `"0x10"` → 16, `"1e2"` → 100, `true` and `[1]` → 1. A wrong precondition can only cause a 409, never a
  silent overwrite, because the write is compare-and-set on the stored version.
- **Corpus scope.** `Symbol` and function values in `FUZZ_STRINGS` cannot arrive in a JSON body or a header,
  so the request-level validators above are fuzzed without them.
- **Other cookie parsers.** Six route files still have their own copy of the cookie decode
  (`admin/disputes`, `admin/users/suspend`, `auth/refresh`, `collections`, `progress`,
  `transactions/history`). Each runs inside the handler's `try`, so a malformed cookie there returns 500
  rather than crashing. Moving them to `@/lib/api/auth` is left for a separate change.
- **Contracts.** No exported signature changed. Valid inputs return exactly what they did before.

---

## Running the Fuzz Tests

```bash
# Run just the fuzz suite:
npm run test:fuzz

# Run as part of the full backend suite:
npm run test:backend
```

---

## Adding New Corpus Entries

Add entries to the relevant array in `src/lib/api/fuzzCorpus.js`.  The fuzz test
suite will automatically pick them up on the next run — no test code changes
needed for pure corpus additions.

When adding a new validator, add a `describe` block in
`tests/backend/fuzz.test.mjs` that:

1. Iterates the relevant corpus category with `assertSafeOrValidation`.
2. Asserts output invariants for the success path.
3. Explicitly tests the most security-sensitive rejection cases.
