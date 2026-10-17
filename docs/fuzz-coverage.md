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
