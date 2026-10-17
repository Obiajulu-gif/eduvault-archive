/**
 * Fuzz corpus for malformed payloads and boundary numeric values (#1013).
 *
 * This module exports categorised sets of adversarial inputs used by the fuzz
 * test suite (`tests/backend/fuzz.test.mjs`).  Keeping the corpus in a
 * separate file lets it be imported by other test suites, regression harnesses,
 * or CI property-based tests without duplicating the input lists.
 *
 * Categories:
 *   STRINGS     — encoding tricks, injection strings, control characters, huge
 *                 values, Unicode edge cases.
 *   NUMBERS     — boundary numerics: Infinity, -Infinity, NaN, MAX_SAFE_INTEGER,
 *                 MIN_SAFE_INTEGER, MAX_VALUE, -0, very small fractions, etc.
 *   URLS        — protocol-relative, javascript:/data: schemes, embedded
 *                 whitespace/tab/newline, overlong, null-byte injections.
 *   EMAILS      — malformed addresses, embedded newlines, overlong local parts.
 *   WALLET_ADDRESSES — wrong-length, wrong-prefix, mixed-case, look-alike chars.
 *   OBJECTS     — deeply nested, prototype-polluting, circular-like structures,
 *                 non-object types passed as object.
 *   ARRAYS      — huge arrays, nested arrays, non-array iterables.
 *   PAGINATION  — cursor injection, negative/fractional page sizes, huge values.
 *   DATES       — invalid ISO strings, negative timestamps, far-future/far-past.
 *   FILE_META   — negative sizes, missing type, overlong file name.
 */

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

export const FUZZ_STRINGS = Object.freeze([
  // Empty / whitespace
  "",
  " ",
  "\t",
  "\n",
  "\r\n",
  "   \t\n  ",

  // Null bytes and C0 control characters
  "\u0000",
  "hello\u0000world",
  "\u0001\u0002\u0003",
  "text\u001Fmore",
  "\u007F",

  // Unicode edge cases
  "\uFFFD",              // replacement character
  "\uFEFF",              // BOM
  "\u200B",              // zero-width space
  "\u200C\u200D",        // zero-width non-joiner / joiner
  "\u202E",              // right-to-left override
  "\u2028\u2029",        // line / paragraph separator
  "\uD800\uDFFF",        // surrogate pair (valid UTF-16, tricky in JSON)
  "𐀀",                  // U+10000, multi-byte UTF-8
  "✓",                   // beyond ASCII

  // Overlong values
  "A".repeat(10_001),
  "B".repeat(100_000),
  "\u4E2D\u6587".repeat(3_000), // CJK × 3 000

  // HTML / XSS injection
  "<script>alert(1)</script>",
  '"><img src=x onerror=alert(1)>',
  "javascript:alert(1)",
  "<svg onload=alert(1)>",
  "&#x3C;script&#x3E;",
  "&lt;script&gt;alert(1)&lt;/script&gt;",

  // SQL injection
  "' OR '1'='1",
  "'; DROP TABLE users;--",
  "1; SELECT * FROM secrets",

  // NoSQL injection
  '{"$gt": ""}',
  '{"$where": "sleep(1000)"}',
  "{ $ne: null }",

  // Path traversal
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "%2e%2e%2f%2e%2e%2f",
  "....//....//etc/passwd",

  // CRLF injection
  "header\r\nX-Inject: evil",
  "value\nSet-Cookie: bad=1",

  // Format strings (legacy C; still tested for robustness)
  "%s%s%s%s%s",
  "%x%x%x%x",
  "%n%n%n",

  // JSON stringification edge cases
  "null",
  "undefined",
  "true",
  "false",
  "[]",
  "{}",
  "[[[[[",

  // Very long repeated pattern (ReDoS probe)
  "a".repeat(50) + "b",
  ("aaa").repeat(1000),

  // Non-string types coerced to string (passed as-is for testing)
  null,
  undefined,
  0,
  false,
  [],
  {},
  Symbol("fuzz"),
  () => {},
]);

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export const FUZZ_NUMBERS = Object.freeze([
  // IEEE 754 special values
  Infinity,
  -Infinity,
  NaN,
  -NaN,

  // Negative zero
  -0,
  +0,

  // Extremes
  Number.MAX_SAFE_INTEGER,        //  9 007 199 254 740 991
  Number.MIN_SAFE_INTEGER,        // -9 007 199 254 740 991
  Number.MAX_VALUE,               //  ~1.8e308
  Number.MIN_VALUE,               //  ~5e-324 (smallest positive)
  -Number.MAX_VALUE,
  -Number.MIN_VALUE,

  // Boundary edge cases for typical range checks
  -1,
  -0.001,
  0,
  0.001,
  0.5,
  1,
  1.0000000000000002, // smallest float > 1

  // Common API field boundaries
  99,
  100,
  101,
  999,
  1000,
  1001,
  999_999,
  1_000_000,
  1_000_001,

  // Precision/rounding traps
  0.1 + 0.2,          // 0.30000000000000004
  1 / 3,
  Math.PI,
  Math.E,

  // Overflow probes
  2 ** 53,            // beyond MAX_SAFE_INTEGER
  2 ** 53 + 1,
  2 ** 63,
  2 ** 128,

  // Coercion traps (non-number types)
  "10",
  "  10  ",
  "0x10",             // hex string → 16 via Number()
  "1e2",
  "1.5e3",
  null,
  undefined,
  true,
  false,
  "",
  " ",
  "abc",
  "1abc",
  "abc1",
  [],
  [1],
  [1, 2],
  {},
]);

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export const FUZZ_URLS = Object.freeze([
  // Safe / expected to pass
  "https://example.com",
  "http://example.com/path?q=1&r=2",
  "mailto:user@example.com",

  // Dangerous schemes — must be rejected
  "javascript:alert(1)",
  "javascript:void(0)",
  "JAVASCRIPT:alert(1)",
  "Java\tScript:alert(1)",
  "java\nscript:alert(1)",
  "java\rscript:alert(1)",
  "java\r\nscript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "ftp://evil.com",

  // Protocol-relative
  "//evil.com/path",
  "\\\\evil.com\\path",
  " //evil.com",

  // Overlong
  "https://example.com/" + "a".repeat(5000),

  // Embedded whitespace / control
  "https://examp\tle.com",
  "https://examp\nle.com",
  "https://examp\rle.com",
  "https://example.com/ path",

  // Null-byte
  "https://example.com\u0000.evil.com/",

  // Unicode confusables
  "https://exаmple.com",   // Cyrillic 'a' U+0430
  "https://ɢoogle.com",    // IPA G

  // Empty / whitespace
  "",
  "   ",
  null,
  undefined,
  42,
]);

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

export const FUZZ_EMAILS = Object.freeze([
  // Valid
  "user@example.com",
  "user+tag@sub.example.co.uk",

  // Malformed
  "notanemail",
  "@nodomain.com",
  "noat",
  "a@",
  "@",
  "",
  "   ",

  // Injection
  "user@example.com\r\nBcc: evil@evil.com",
  "user%0d%0aTo:evil@evil.com@example.com",
  "evil\"@example.com",
  '"user"@example.com',
  "user\u0000@example.com",

  // Overlong
  "a".repeat(300) + "@example.com",
  "user@" + "b".repeat(300) + ".com",

  // Non-string types
  null,
  undefined,
  42,
  {},
  [],
]);

// ---------------------------------------------------------------------------
// Wallet addresses
// ---------------------------------------------------------------------------

export const FUZZ_WALLET_ADDRESSES = Object.freeze([
  // Valid EVM
  "0x0000000000000000000000000000000000000001",

  // Valid Stellar
  "GAAHI3TNKQXGWHSJQTD7AYPV2GOWKOSROIGRMSYLHYZJLUPIWMKLXZXY",

  // Wrong prefix
  "1x0000000000000000000000000000000000000001",
  "0X0000000000000000000000000000000000000001",
  "G1HI3TNKQXGWHSJQTD7AYPV2GOWKOSROIGRMSYLHYZJLUPIWMKLXZXY",

  // Wrong length
  "0x0000000000000000000000000000000000000",   // too short
  "0x00000000000000000000000000000000000000001", // too long
  "G".repeat(54),                                // Stellar too short
  "G".repeat(57),                                // Stellar too long

  // Non-hex chars in EVM
  "0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
  "0x!@#$%^&*()__+{}|:<>?0000000000000000000",

  // Empty / null
  "",
  null,
  undefined,
  "  ",

  // Injection
  "0x'; DROP TABLE wallets;--0000000000000000000",
  "<script>0x000</script>",
]);

// ---------------------------------------------------------------------------
// Objects (for validateMaterialPayload and similar)
// ---------------------------------------------------------------------------

export const FUZZ_OBJECTS = Object.freeze([
  // Non-object primitives passed as body
  null,
  undefined,
  0,
  "",
  "string",
  true,
  false,
  42,
  [],

  // Prototype pollution attempts
  { "__proto__": { "admin": true } },
  { "constructor": { "prototype": { "admin": true } } },
  { "__proto__.admin": true },

  // Extra / unexpected keys — should be ignored safely
  { title: "ok", fileUrl: "ipfs://x", price: 1, visibility: "public", evil: "<script>", __proto__: { admin: true } },

  // Deeply nested
  { title: { nested: { deep: { value: "hello" } } }, fileUrl: "ipfs://x" },

  // Arrays as values
  { title: ["a", "b", "c"], fileUrl: "ipfs://x" },

  // Functions as values
  { title: () => "hello", fileUrl: "ipfs://x" },
]);

// ---------------------------------------------------------------------------
// Pagination params
// ---------------------------------------------------------------------------

export const FUZZ_PAGINATION = Object.freeze([
  // pageSize extremes
  { pageSize: "0" },
  { pageSize: "-1" },
  { pageSize: "1000000" },
  { pageSize: "NaN" },
  { pageSize: "Infinity" },
  { pageSize: "" },
  { pageSize: null },
  { pageSize: "abc" },
  { pageSize: "50.9" },

  // Cursor injection
  { cursor: "' OR '1'='1" },
  { cursor: "<script>alert(1)</script>" },
  { cursor: "\u0000cursor" },
  { cursor: "a".repeat(10_000) },
  { cursor: null },
  { cursor: undefined },
  { cursor: 0 },
  { cursor: {} },
  { cursor: [] },
]);

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export const FUZZ_DATES = Object.freeze([
  // Valid ISO strings
  "2024-01-01",
  "2024-01-01T00:00:00.000Z",

  // Invalid
  "not-a-date",
  "",
  "   ",
  "0000-00-00",
  "9999-99-99",
  "2024-13-01",
  "2024-01-32",

  // Far future / far past
  "9999-12-31T23:59:59.999Z",
  "0001-01-01T00:00:00.000Z",
  "-000001-01-01",

  // Timestamp numbers
  -1,
  0,
  -9999999999999,
  Number.MAX_SAFE_INTEGER,
  Infinity,
  NaN,

  // Injection
  "2024-01-01'; DROP TABLE events;--",
  "<script>new Date()</script>",

  // Non-string types
  null,
  undefined,
  {},
  [],
]);

// ---------------------------------------------------------------------------
// File metadata
// ---------------------------------------------------------------------------

export const FUZZ_FILE_META = Object.freeze([
  // Negative / zero size
  { size: -1,          type: "application/pdf", name: "file.pdf" },
  { size: -0,          type: "application/pdf", name: "file.pdf" },
  { size: 0,           type: "application/pdf", name: "file.pdf" },

  // Oversize
  { size: 10 * 1024 * 1024 + 1, type: "application/pdf",   name: "big.pdf" },
  { size: Number.MAX_VALUE,      type: "application/pdf",   name: "huge.pdf" },
  { size: Infinity,              type: "application/pdf",   name: "inf.pdf" },

  // Disallowed MIME types
  { size: 100, type: "text/html",             name: "index.html" },
  { size: 100, type: "application/javascript",name: "evil.js" },
  { size: 100, type: "image/svg+xml",         name: "evil.svg" },
  { size: 100, type: "application/x-php",     name: "shell.php" },
  { size: 100, type: "",                      name: "noext" },
  { size: 100, type: null,                    name: "nulltype" },

  // Missing fields
  { size: 100 },                      // no type
  { type: "application/pdf" },        // no size
  null,
  undefined,
  {},

  // Overlong name
  { size: 100, type: "application/pdf", name: "n".repeat(2000) + ".pdf" },

  // Name injection
  { size: 100, type: "application/pdf", name: "../../etc/passwd.pdf" },
  { size: 100, type: "application/pdf", name: "<script>.pdf" },
]);
