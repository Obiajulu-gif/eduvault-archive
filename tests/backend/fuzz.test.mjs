/**
 * Fuzz coverage for malformed payloads and boundary numeric values (#1013).
 *
 * Strategy: throw every entry from the fuzz corpus at each validator and assert
 * two properties:
 *
 *   1. **No uncaught exception** — every adversarial input must be handled by
 *      returning a safe value or throwing a ValidationError.  A generic Error,
 *      TypeError, or RangeError from inside a validator means it has an
 *      unhandled edge case.
 *
 *   2. **Output invariants** — when the validator succeeds it must produce
 *      output that satisfies the contract (e.g. price is non-negative finite,
 *      string length ≤ declared max, no control characters remain).
 *
 * The fuzz corpus lives in src/lib/api/fuzzCorpus.js so it can be reused by
 * other test files and regression harnesses.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  sanitizeString,
  validateEmail,
  normalizeWalletAddress,
  validatePrice,
  validateProfilePayload,
  validateMaterialPayload,
  validateUploadPayload,
  validateUploadFileMetadata,
  validateDateRangeQuery,
  parsePagination,
  ValidationError,
} from "../../src/lib/api/validation.js";

import { isSafeUrl } from "../../src/lib/api/safeUrl.js";

import {
  FUZZ_STRINGS,
  FUZZ_NUMBERS,
  FUZZ_URLS,
  FUZZ_EMAILS,
  FUZZ_WALLET_ADDRESSES,
  FUZZ_OBJECTS,
  FUZZ_PAGINATION,
  FUZZ_DATES,
  FUZZ_FILE_META,
} from "../../src/lib/api/fuzzCorpus.js";

// ---------------------------------------------------------------------------
// Helper: assert that a call either returns without throwing, or throws only
// a ValidationError — never a raw Error/TypeError/RangeError.
// ---------------------------------------------------------------------------
function assertSafeOrValidation(fn, label) {
  try {
    const result = fn();
    return { threw: false, result };
  } catch (err) {
    if (err instanceof ValidationError) return { threw: true, validationError: true, message: err.message };
    throw new assert.AssertionError({
      message: `${label} threw a non-ValidationError: [${err?.constructor?.name}] ${err?.message}`,
      actual:   err?.constructor?.name,
      expected: "ValidationError",
    });
  }
}

// ---------------------------------------------------------------------------
// sanitizeString — must always return a string, never throw
// ---------------------------------------------------------------------------

describe("fuzz: sanitizeString", () => {
  test("returns a string for every corpus input", () => {
    for (const input of FUZZ_STRINGS) {
      const result = sanitizeString(input);
      assert.equal(typeof result, "string", `Expected string for input: ${String(input).slice(0, 50)}`);
    }
  });

  test("output never contains C0 control characters", () => {
    const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
    for (const input of FUZZ_STRINGS) {
      const result = sanitizeString(input);
      assert.ok(!CONTROL.test(result), `Control character survived in: ${JSON.stringify(result).slice(0, 80)}`);
    }
  });

  test("output is always within the declared maxLength", () => {
    for (const maxLength of [0, 1, 10, 80, 160, 5000]) {
      for (const input of FUZZ_STRINGS) {
        const result = sanitizeString(input, { maxLength });
        assert.ok(
          result.length <= maxLength,
          `Length ${result.length} > maxLength ${maxLength} for input type ${typeof input}`
        );
      }
    }
  });

  test("output is always trimmed", () => {
    for (const input of FUZZ_STRINGS) {
      const result = sanitizeString(input);
      assert.equal(result, result.trim(), `Untrimmed output for: ${String(input).slice(0, 40)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// validatePrice — boundary numerics
// ---------------------------------------------------------------------------

describe("fuzz: validatePrice — boundary numerics", () => {
  test("every fuzz number either returns a valid non-negative finite price or throws ValidationError", () => {
    for (const input of FUZZ_NUMBERS) {
      const { threw, result } = assertSafeOrValidation(
        () => validatePrice(input),
        `validatePrice(${String(input)})`
      );
      if (!threw) {
        assert.ok(Number.isFinite(result),     `result must be finite for input ${String(input)}`);
        assert.ok(result >= 0,                 `result must be non-negative for input ${String(input)}`);
        assert.ok(result <= 1_000_000,         `result must not exceed ceiling for input ${String(input)}`);
      }
    }
  });

  test("negative numbers always throw ValidationError", () => {
    for (const n of [-1, -0.001, -100, -Infinity, Number.MIN_SAFE_INTEGER]) {
      assert.throws(
        () => validatePrice(n),
        ValidationError,
        `Expected ValidationError for negative price: ${n}`
      );
    }
  });

  test("Infinity, -Infinity, NaN all throw ValidationError", () => {
    for (const n of [Infinity, -Infinity, NaN]) {
      assert.throws(() => validatePrice(n), ValidationError, `Expected ValidationError for ${n}`);
    }
  });

  test("price exceeding 1 000 000 throws ValidationError", () => {
    assert.throws(() => validatePrice(1_000_001), ValidationError);
    assert.throws(() => validatePrice(Number.MAX_VALUE), ValidationError);
    assert.throws(() => validatePrice(2 ** 63), ValidationError);
  });

  test("price of exactly 0, 1, 1000000 are accepted", () => {
    assert.equal(validatePrice(0), 0);
    assert.equal(validatePrice(1), 1);
    assert.equal(validatePrice(1_000_000), 1_000_000);
  });

  test("allowZero=false rejects 0", () => {
    assert.throws(() => validatePrice(0, { allowZero: false }), ValidationError);
    assert.equal(validatePrice(0.01, { allowZero: false }), 0.01);
  });
});

// ---------------------------------------------------------------------------
// validateEmail
// ---------------------------------------------------------------------------

describe("fuzz: validateEmail", () => {
  test("each fuzz email either returns a valid lowercase string or throws ValidationError", () => {
    for (const input of FUZZ_EMAILS) {
      const { threw, result } = assertSafeOrValidation(
        () => validateEmail(input),
        `validateEmail(${String(input).slice(0, 60)})`
      );
      if (!threw) {
        assert.equal(typeof result, "string");
        assert.equal(result, result.toLowerCase(), "email must be lowercased");
        assert.ok(result.includes("@"),            "returned email must contain @");
        assert.ok(result.length <= 254,            "email must not exceed 254 chars");
      }
    }
  });

  test("embedding CRLF in an email always fails", () => {
    assert.throws(() => validateEmail("user@example.com\r\nBcc: evil@evil.com"), ValidationError);
    assert.throws(() => validateEmail("user\n@example.com"), ValidationError);
  });

  test("overlong email local part is rejected", () => {
    assert.throws(() => validateEmail("a".repeat(300) + "@example.com"), ValidationError);
  });
});

// ---------------------------------------------------------------------------
// normalizeWalletAddress
// ---------------------------------------------------------------------------

describe("fuzz: normalizeWalletAddress", () => {
  test("each fuzz address either returns a valid address string or throws ValidationError", () => {
    for (const input of FUZZ_WALLET_ADDRESSES) {
      const { threw, result } = assertSafeOrValidation(
        () => normalizeWalletAddress(input),
        `normalizeWalletAddress(${String(input).slice(0, 70)})`
      );
      if (!threw && result !== null) {
        assert.equal(typeof result, "string");
        const isEvm     = /^0x[a-fA-F0-9]{40}$/.test(result);
        const isStellar = /^G[A-Z2-7]{55}$/.test(result);
        assert.ok(isEvm || isStellar, `Returned address matches neither EVM nor Stellar: ${result}`);
      }
    }
  });

  test("empty / null / undefined returns null without throwing", () => {
    assert.equal(normalizeWalletAddress(""),        null);
    assert.equal(normalizeWalletAddress(null),      null);
    assert.equal(normalizeWalletAddress(undefined), null);
  });

  test("injection strings are rejected with ValidationError", () => {
    assert.throws(() => normalizeWalletAddress("' OR '1'='1"), ValidationError);
    assert.throws(() => normalizeWalletAddress("<script>0x000</script>"), ValidationError);
  });
});

// ---------------------------------------------------------------------------
// isSafeUrl
// ---------------------------------------------------------------------------

describe("fuzz: isSafeUrl", () => {
  test("dangerous schemes always return false", () => {
    const dangerous = [
      "javascript:alert(1)",
      "javascript:void(0)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<h1>XSS</h1>",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "Java\tScript:alert(1)",
      "java\nscript:alert(1)",
    ];
    for (const url of dangerous) {
      assert.equal(isSafeUrl(url), false, `Expected false for: ${url}`);
    }
  });

  test("safe http/https/mailto return true", () => {
    assert.equal(isSafeUrl("https://example.com"), true);
    assert.equal(isSafeUrl("http://example.com/path?q=1"), true);
    assert.equal(isSafeUrl("mailto:user@example.com"), true);
  });

  test("every fuzz URL either returns true or false — never throws", () => {
    for (const url of FUZZ_URLS) {
      const result = isSafeUrl(url);
      assert.ok(typeof result === "boolean", `isSafeUrl must return boolean, got ${typeof result} for: ${String(url).slice(0, 60)}`);
    }
  });

  test("protocol-relative URLs return false", () => {
    assert.equal(isSafeUrl("//evil.com"), false);
    assert.equal(isSafeUrl("\\\\evil.com"), false);
  });
});

// ---------------------------------------------------------------------------
// validateProfilePayload — with fuzz objects
// ---------------------------------------------------------------------------

describe("fuzz: validateProfilePayload", () => {
  test("non-object bodies throw ValidationError without crashing", () => {
    for (const input of FUZZ_OBJECTS) {
      assertSafeOrValidation(
        () => validateProfilePayload(input),
        `validateProfilePayload(${String(input).slice(0, 50)})`
      );
    }
  });

  test("prototype-polluting keys do not escape into the returned object", () => {
    const poisoned = Object.create(null);
    poisoned.fullName = "Ada";
    poisoned.email    = "ada@example.com";
    poisoned["__proto__"] = { admin: true };
    poisoned["constructor"] = null;

    assertSafeOrValidation(
      () => validateProfilePayload(poisoned),
      "validateProfilePayload with poisoned proto"
    );
    // The global prototype must not have been mutated
    assert.equal(({}).admin, undefined, "Prototype pollution: admin key leaked to Object.prototype");
  });

  test("excessively long fullName is truncated, not passed through", () => {
    const result = assertSafeOrValidation(
      () => validateProfilePayload({
        fullName: "A".repeat(500),
        email: "user@example.com",
      }),
      "overlong fullName"
    );
    if (!result.threw) {
      assert.ok(result.result.fullName.length <= 120, "fullName must be bounded to 120 chars");
    }
  });

  test("control characters in fullName are stripped", () => {
    const { threw, result } = assertSafeOrValidation(
      () => validateProfilePayload({ fullName: "Ad\u0000a\u001FCreator", email: "ada@example.com" }),
      "control chars in fullName"
    );
    if (!threw) {
      assert.ok(!/[\u0000-\u001F]/.test(result.fullName), "control characters must be stripped from fullName");
    }
  });
});

// ---------------------------------------------------------------------------
// validateMaterialPayload — boundary numerics for price
// ---------------------------------------------------------------------------

describe("fuzz: validateMaterialPayload — price boundary", () => {
  const base = { title: "Title", fileUrl: "ipfs://file" };

  test("price boundary values are handled safely", () => {
    const priceInputs = [
      0, 0.001, 1, 99.99, 100, 999.99, 1000, 999_999, 1_000_000,
      // These must throw:
      -1, -0.001, 1_000_001, Infinity, -Infinity, NaN,
      // Coercion
      "100", "0", null, undefined, "", {}, [],
    ];
    for (const price of priceInputs) {
      assertSafeOrValidation(
        () => validateMaterialPayload({ ...base, price }),
        `validateMaterialPayload price=${String(price)}`
      );
    }
  });

  test("MAX_SAFE_INTEGER price is rejected", () => {
    assert.throws(
      () => validateMaterialPayload({ ...base, price: Number.MAX_SAFE_INTEGER }),
      ValidationError
    );
  });

  test("price as a string number is parsed", () => {
    const result = validateMaterialPayload({ ...base, price: "42.50" });
    assert.ok(Number.isFinite(result.price));
    assert.ok(result.price >= 0);
  });

  test("visibility receives all fuzz strings — only valid values pass", () => {
    const valid = new Set(["private", "public", "unlisted"]);
    for (const vis of [...FUZZ_STRINGS, "private", "public", "unlisted"]) {
      const { threw, result } = assertSafeOrValidation(
        () => validateMaterialPayload({ ...base, visibility: vis }),
        `visibility fuzz: ${String(vis).slice(0, 40)}`
      );
      if (!threw) {
        assert.ok(valid.has(result.visibility), `Unexpected visibility: ${result.visibility}`);
      }
    }
  });

  test("XSS in title is stripped of control chars (not reflected raw)", () => {
    const { threw, result } = assertSafeOrValidation(
      () => validateMaterialPayload({ ...base, title: "<script>alert(1)</script>", price: 1 }),
      "XSS in title"
    );
    if (!threw) {
      // Control chars stripped; the HTML tags themselves may remain (they are
      // stored and escaped at render time), but no control chars.
      assert.ok(!/[\u0000-\u001F]/.test(result.title));
    }
  });
});

// ---------------------------------------------------------------------------
// validateUploadFileMetadata — file size boundary
// ---------------------------------------------------------------------------

describe("fuzz: validateUploadFileMetadata — file size and type", () => {
  test("every fuzz file meta entry is handled safely", () => {
    for (const meta of FUZZ_FILE_META) {
      assertSafeOrValidation(
        () => validateUploadFileMetadata(meta, "file"),
        `validateUploadFileMetadata(${JSON.stringify(meta).slice(0, 80)})`
      );
    }
  });

  test("size of exactly 10 MB is allowed; 10 MB + 1 byte is rejected", () => {
    const MAX = 10 * 1024 * 1024;
    const valid = validateUploadFileMetadata({ size: MAX, type: "application/pdf", name: "test.pdf" }, "file");
    assert.ok(valid.size === MAX);

    assert.throws(
      () => validateUploadFileMetadata({ size: MAX + 1, type: "application/pdf", name: "test.pdf" }, "file"),
      ValidationError
    );
  });

  test("size of 0 does not crash (may or may not throw ValidationError)", () => {
    assertSafeOrValidation(
      () => validateUploadFileMetadata({ size: 0, type: "application/pdf", name: "empty.pdf" }, "file"),
      "size=0"
    );
  });

  test("Infinity size throws ValidationError", () => {
    assert.throws(
      () => validateUploadFileMetadata({ size: Infinity, type: "application/pdf", name: "inf.pdf" }, "file"),
      ValidationError
    );
  });

  test("disallowed MIME types are rejected", () => {
    for (const type of ["text/html", "application/javascript", "image/svg+xml", "application/x-php"]) {
      assert.throws(
        () => validateUploadFileMetadata({ size: 100, type, name: "x" }, "file"),
        ValidationError,
        `Expected ValidationError for MIME type: ${type}`
      );
    }
  });

  test("missing file (null/undefined) throws ValidationError", () => {
    assert.throws(() => validateUploadFileMetadata(null,      "file"), ValidationError);
    assert.throws(() => validateUploadFileMetadata(undefined, "file"), ValidationError);
  });
});

// ---------------------------------------------------------------------------
// parsePagination — boundary / injection
// ---------------------------------------------------------------------------

describe("fuzz: parsePagination", () => {
  function makeSearchParams(obj) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && v !== undefined) params.set(k, String(v));
    }
    return params;
  }

  test("every fuzz pagination input is handled safely", () => {
    for (const input of FUZZ_PAGINATION) {
      const params = makeSearchParams(input);
      assertSafeOrValidation(
        () => parsePagination(params),
        `parsePagination(${JSON.stringify(input)})`
      );
    }
  });

  test("pageSize is always clamped to [1, maxPageSize]", () => {
    const cases = ["0", "-1", "1000000", "NaN", "Infinity", "", "abc", "50.9"];
    for (const ps of cases) {
      const params = makeSearchParams({ pageSize: ps });
      const { threw, result } = assertSafeOrValidation(
        () => parsePagination(params, { defaultPageSize: 12, maxPageSize: 50 }),
        `pageSize=${ps}`
      );
      if (!threw) {
        assert.ok(Number.isInteger(result.pageSize), `pageSize must be integer, got ${result.pageSize}`);
        assert.ok(result.pageSize >= 1,  `pageSize must be >= 1, got ${result.pageSize}`);
        assert.ok(result.pageSize <= 50, `pageSize must be <= maxPageSize, got ${result.pageSize}`);
      }
    }
  });

  test("cursor injection strings do not crash parsePagination", () => {
    for (const cursor of ["' OR '1'='1", "<script>alert(1)</script>", "\u0000cursor", "a".repeat(10_000)]) {
      const params = makeSearchParams({ cursor });
      const { threw, result } = assertSafeOrValidation(
        () => parsePagination(params),
        `cursor injection: ${cursor.slice(0, 40)}`
      );
      if (!threw) {
        // The raw cursor value is passed through for the DB layer to validate;
        // what matters here is that parsePagination itself does not throw raw errors.
        assert.equal(typeof result.cursor, "string");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// validateDateRangeQuery — boundary dates
// ---------------------------------------------------------------------------

describe("fuzz: validateDateRangeQuery — date boundaries", () => {
  function makeSearchParams(from, to) {
    const params = new URLSearchParams();
    if (from !== undefined && from !== null) params.set("from", String(from));
    if (to   !== undefined && to   !== null) params.set("to",   String(to));
    return params;
  }

  test("every fuzz date as 'from' is handled safely", () => {
    for (const from of FUZZ_DATES) {
      assertSafeOrValidation(
        () => validateDateRangeQuery(makeSearchParams(from, "2024-12-31")),
        `from date: ${String(from).slice(0, 50)}`
      );
    }
  });

  test("every fuzz date as 'to' is handled safely", () => {
    for (const to of FUZZ_DATES) {
      assertSafeOrValidation(
        () => validateDateRangeQuery(makeSearchParams("2024-01-01", to)),
        `to date: ${String(to).slice(0, 50)}`
      );
    }
  });

  test("from > to is rejected", () => {
    assert.throws(
      () => validateDateRangeQuery(makeSearchParams("2024-12-31", "2024-01-01")),
      ValidationError
    );
  });

  test("range exceeding maxRangeDays is rejected", () => {
    assert.throws(
      () => validateDateRangeQuery(makeSearchParams("2020-01-01", "2024-12-31"), { maxRangeDays: 30 }),
      ValidationError
    );
  });

  test("valid range returns Date objects", () => {
    const { from, to } = validateDateRangeQuery(makeSearchParams("2024-01-01", "2024-01-31"));
    assert.ok(from instanceof Date);
    assert.ok(to   instanceof Date);
    assert.ok(from <= to);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: output invariant — no ValidationError leaks raw internals
// ---------------------------------------------------------------------------

describe("fuzz: ValidationError messages do not leak stack traces or raw errors", () => {
  function collectMessages(fn) {
    try {
      fn();
      return null;
    } catch (err) {
      if (err instanceof ValidationError) return err.message;
      throw err;
    }
  }

  test("ValidationError messages contain no stack traces", () => {
    const cases = [
      () => validateEmail("not-an-email"),
      () => validatePrice(-1),
      () => validatePrice(Infinity),
      () => normalizeWalletAddress("bad-address"),
      () => validateUploadFileMetadata({ size: -1, type: "application/pdf" }, "file"),
    ];
    for (const fn of cases) {
      const msg = collectMessages(fn);
      if (msg !== null) {
        assert.ok(!msg.includes("at "),          `Stack trace leaked in: ${msg.slice(0, 100)}`);
        assert.ok(!msg.includes("node_modules"), `Internal path leaked in: ${msg.slice(0, 100)}`);
      }
    }
  });
});
