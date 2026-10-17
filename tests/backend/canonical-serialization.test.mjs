import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_VERSION,
  MAX_PRECISION,
  MAX_MAGNITUDE,
  CanonicalizationError,
  normalizeString,
  normalizeNumber,
  normalizePayload,
  canonicalize,
  canonicalJson,
  canonicalString,
  canonicalBytes,
  canonicalHash,
  canonicalizeLegacy,
  normalizeLegacy,
  assertCanonical,
  isCanonicallyEqual,
  canonicalEqual,
  normalizeLegacyRecord,
  normalizeLegacyPayload,
} from '../../src/lib/canonical.js';

import {
  createCanonicalPayload,
  canonicalizePayload,
  canonicalPayloadBytes,
  createSigningDigest,
  signatureMatches,
  SIGNING_DOMAIN,
  SIGNING_DIGEST_ALGORITHM,
} from '../../src/lib/signing.js';

describe('Canonical Serialization Layer (#955)', () => {
  describe('Ordering and Field Stability', () => {
    it('sorts object keys lexicographically regardless of insertion order', () => {
      const a = { b: 2, a: 1, c: { z: 1, y: 2 } };
      const b = { c: { y: 2, z: 1 }, a: 1, b: 2 };
      assert.equal(canonicalString(a), canonicalString(b));
      assert.equal(canonicalize(a), canonicalize(b));
    });

    it('produces stable output for deeply nested structures and arrays', () => {
      const a = { arr: [3, { b: 2, a: 1 }, 1] };
      const b = { arr: [3, { a: 1, b: 2 }, 1] };
      assert.equal(canonicalString(a), canonicalString(b));
      assert.equal(canonicalize(a), '{"arr":[3,{"a":1,"b":2},1]}');
    });

    it('preserves array order by default because array order is semantic', () => {
      assert.equal(canonicalString([1, 2, 3]), '[1,2,3]');
      assert.equal(canonicalString([3, 2, 1]), '[3,2,1]');
      assert.notEqual(canonicalString([1, 2, 3]), canonicalString([3, 2, 1]));
    });

    it('supports sorting primitive arrays when explicitly requested', () => {
      const a = normalizePayload([3, 1, 2], { sortArrays: true });
      assert.deepEqual(a, [1, 2, 3]);
    });
  });

  describe('Whitespace Normalization', () => {
    it('normalizes internal whitespace runs and trims surrounding whitespace in strings', () => {
      assert.equal(canonicalString('  hello \n world  '), '[hello world:string]');
    });

    it('treats whitespace-only strings as empty', () => {
      assert.equal(canonicalString('   '), '[:string]');
      assert.equal(normalizeString('   '), '');
    });

    it('strips leading and trailing whitespace from object keys', () => {
      assert.equal(canonicalString({ '  a': 1 }), canonicalString({ a: 1 }));
    });
  });

  describe('Key Casing and Collision Protection', () => {
    it('normalizes key casing to lowercase', () => {
      assert.equal(canonicalString({ Foo: 1 }), canonicalString({ foo: 1 }));
    });

    it('preserves string value casing', () => {
      assert.equal(canonicalString('Hello'), canonicalString('Hello'));
      assert.notEqual(canonicalString('Hello'), canonicalString('hello'));
    });

    it('throws when two keys in the same object collide after normalization', () => {
      assert.throws(() => normalizePayload({ Foo: 1, foo: 2 }), /Duplicate key after normalization/);
      assert.throws(() => normalizePayload({ '  key': 1, key: 2 }), /Duplicate key after normalization/);
    });
  });

  describe('Numeric Precision and Float Edge Cases', () => {
    it('normalizes integer-valued floats to collision with integers', () => {
      assert.equal(canonicalString(1.0), canonicalString(1));
      assert.equal(canonicalString(100.0), canonicalString(100));
    });

    it('normalizes negative zero to zero', () => {
      assert.equal(canonicalString(-0), canonicalString(0));
    });

    it('rejects non-finite values (NaN and Infinity)', () => {
      assert.throws(() => canonicalString(NaN), /finite/);
      assert.throws(() => canonicalString(Infinity), /finite/);
      assert.throws(() => canonicalString(-Infinity), /finite/);
    });

    it('preserves standard IEEE-754 decimal precision without truncation errors', () => {
      assert.equal(canonicalString(0.1 + 0.2), canonicalString(0.30000000000000004));
    });

    it('rejects numbers exceeding safe maximum magnitude', () => {
      assert.throws(() => normalizeNumber(Number.MAX_SAFE_INTEGER + 1000000000), /max magnitude/);
    });
  });

  describe('Legacy Payload Normalization (#955 Backward Compatibility)', () => {
    it('normalizes legacy flat dotted key paths into nested objects', () => {
      const legacy = { 'user.name': 'Ada', 'user.id': 1 };
      const modern = { user: { name: 'Ada', id: 1 } };
      assert.equal(canonicalizeLegacy(legacy), canonicalize(modern));
    });

    it('normalizes deep dotted key paths', () => {
      const legacy = { 'a.b.c': 'deep' };
      const modern = { a: { b: { c: 'deep' } } };
      assert.equal(canonicalizeLegacy(legacy), canonicalize(modern));
    });

    it('normalizes legacy XML-style array wrappers ({ item: [...] })', () => {
      const legacy = { items: { item: [1, 2, 3] } };
      const modern = { items: [1, 2, 3] };
      assert.equal(canonicalizeLegacy(legacy), canonicalize(modern));
    });

    it('normalizes singular parent key wrappers', () => {
      const legacy = { tags: { tag: ['alpha', 'beta'] } };
      const modern = { tags: ['alpha', 'beta'] };
      assert.equal(canonicalizeLegacy(legacy), canonicalize(modern));
    });

    it('normalizes legacy boolean strings to boolean literals', () => {
      assert.equal(canonicalizeLegacy({ active: 'TRUE' }), canonicalize({ active: true }));
      assert.equal(canonicalizeLegacy({ active: 'False' }), canonicalize({ active: false }));
    });

    it('rejects unknown legacy wrapper formats to prevent ambiguous serialization', () => {
      assert.throws(() => canonicalizeLegacy({ items: { wrapped: [1] } }), /Unknown legacy format/);
    });
  });

  describe('Deterministic Hashing (canonicalHash)', () => {
    it('produces identical SHA-256 digests for equivalent payloads with mixed formats', () => {
      const a = { id: 1, name: ' Ada ', meta: { x: 1.0, y: 'TRUE' } };
      const b = { meta: { y: true, x: 1 }, name: 'Ada', id: 1 };
      assert.equal(canonicalHash(a), canonicalHash(b));
    });

    it('produces different hashes for non-equivalent payloads', () => {
      assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
    });

    it('returns a valid 64-character lowercase hex digest', () => {
      assert.match(canonicalHash({ a: 1 }), /^[0-9a-f]{64}$/);
    });
  });

  describe('Strict Type Safety and Forbidden Value Rejection', () => {
    it('returns normalized object with lowercase sorted keys', () => {
      const out = normalizePayload({ B: 2, A: 1 });
      assert.deepEqual(Object.keys(out), ['a', 'b']);
    });

    it('rejects undefined values in strict mode', () => {
      assert.throws(() => normalizePayload({ a: undefined }), /Undefined values are not allowed/);
    });

    it('allows dropping undefined values when option is set', () => {
      const out = normalizePayload({ a: undefined, b: 1 }, { dropUndefined: true });
      assert.deepEqual(out, { b: 1 });
    });

    it('rejects function values to prevent injection and code execution', () => {
      assert.throws(() => normalizePayload({ a: () => 1 }), /function values are not allowed/);
    });

    it('rejects symbol values', () => {
      assert.throws(() => normalizePayload({ a: Symbol('x') }), /symbol values are not allowed/);
    });

    it('rejects non-plain object prototypes (e.g. classes, RegExp)', () => {
      assert.throws(() => normalizePayload({ re: /abc/ }), /Only plain objects are allowed/);
    });

    it('serializes valid Dates to ISO-8601 strings and rejects invalid Dates', () => {
      const d = new Date('2026-03-01T12:00:00.000Z');
      assert.equal(normalizePayload(d), '2026-03-01T12:00:00.000Z');
      assert.throws(() => normalizePayload(new Date('invalid')), /Invalid Date/);
    });
  });

  describe('Assertion and Verification (assertCanonical)', () => {
    it('throws when payload has uppercase keys', () => {
      assert.throws(() => assertCanonical({ B: 1 }), /Payload is not in canonical form/);
    });

    it('throws when payload has unnormalized string whitespace', () => {
      assert.throws(() => assertCanonical({ a: '  spaces  ' }), /Payload is not in canonical form/);
    });

    it('throws when keys are not sorted', () => {
      assert.throws(() => assertCanonical({ b: 1, a: 2 }), /Payload is not in canonical form/);
    });

    it('passes for canonical payloads', () => {
      assert.doesNotThrow(() => assertCanonical({ a: 1 }));
      assert.doesNotThrow(() => assertCanonical({ a: 1, b: 'clean', c: [1, 2, 3] }));
    });
  });

  describe('canonicalJson and canonicalString Compatibility', () => {
    it('produces valid JSON parseable by standard JSON parsers', () => {
      const out = canonicalJson({ b: 2, a: 1 });
      assert.deepEqual(JSON.parse(out), { a: 1, b: 2 });
    });

    it('matches canonicalString for objects and arrays', () => {
      const payload = { b: 2, a: 1 };
      assert.equal(canonicalJson(payload), canonicalString(payload));
    });
  });

  describe('Signing Layer Integration and Replay Protection', () => {
    it('enforces domain separator and canonical version tags to prevent replay across contexts', () => {
      const payload1 = createCanonicalPayload({ action: 'payout', amount: 50 });
      assert.equal(payload1.domain, 'eduvault');
      assert.equal(payload1.version, CANONICAL_VERSION);
      assert.deepEqual(payload1.body, { action: 'payout', amount: 50 });

      const customDomain = createCanonicalPayload({ action: 'payout', amount: 50 }, { domain: 'marketplace' });
      assert.equal(customDomain.domain, 'marketplace');

      // Digests differ across different domain separation tags even with identical body
      assert.notEqual(canonicalize(payload1), canonicalize(customDomain));
    });

    it('generates deterministic signing digests', async () => {
      const digest1 = await createSigningDigest({ tx: 'tx_123', amount: 100 });
      const digest2 = await createSigningDigest({ amount: 100, tx: 'tx_123' });
      assert.equal(digest1, digest2);
      assert.match(digest1, /^[0-9a-f]{64}$/);
    });

    it('constant-time signature matching handles whitespace and casing variations safely', () => {
      const sigHex = 'A1B2C3D4E5F67890';
      assert.equal(signatureMatches('a1b2c3d4e5f67890', sigHex), true);
      assert.equal(signatureMatches(' a1b2 c3d4 e5f6 7890 ', sigHex), true);
      assert.equal(signatureMatches('wrong', sigHex), false);
      assert.equal(signatureMatches(null, sigHex), false);
    });
  });

  describe('Legacy Record and Migration Helpers', () => {
    it('normalizeLegacyRecord handles undefined fields without crashing', () => {
      const record = { id: 1, optional: undefined, 'user.name': 'Ada' };
      const normalized = normalizeLegacyRecord(record);
      assert.deepEqual(normalized, { id: 1, user: { name: 'Ada' } });
    });

    it('normalizeLegacyPayload detects if record was already canonical', () => {
      const alreadyCanonical = '{"a":1,"b":2}';
      const res1 = normalizeLegacyPayload(alreadyCanonical);
      assert.equal(res1.alreadyCanonical, true);

      const nonCanonical = { B: 2, A: 1 };
      const res2 = normalizeLegacyPayload(nonCanonical);
      assert.equal(res2.alreadyCanonical, false);
      assert.equal(res2.canonical, '{"a":1,"b":2}');
    });

    it('isCanonicallyEqual correctly evaluates payload equivalence', () => {
      assert.equal(isCanonicallyEqual({ B: 2, A: 1 }, { a: 1, b: 2 }), true);
      assert.equal(isCanonicallyEqual({ a: 1 }, { a: 2 }), false);
      assert.equal(isCanonicallyEqual(undefined, {}), false);
    });
  });
});
