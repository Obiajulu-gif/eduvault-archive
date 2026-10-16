import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  canonicalizeLegacy,
  canonicalHash,
  canonicalString,
  canonicalJson,
  normalizePayload,
  assertCanonical,
} from './canonical';

describe('canonical serialization', () => {
  describe('ordering', () => {
    it('sorts object keys lexicographically', () => {
      const a = { b: 2, a: 1, c: { z: 1, y: 2 } };
      const b = { c: { y: 2, z: 1 }, a: 1, b: 2 };
      expect(canonicalString(a)).toBe(canonicalString(b));
    });

    it('produces stable output for nested arrays', () => {
      const a = { arr: [3, { b: 2, a: 1 }, 1] };
      const b = { arr: [3, { a: 1, b: 2 }, 1] };
      expect(canonicalString(a)).toBe(canonicalString(b));
    });

    it('preserves array order', () => {
      expect(canonicalString([1, 2, 3])).toBe('[1,2,3]');
      expect(canonicalString([3, 2, 1])).toBe('[3,2,1]');
    });
  });

  describe('whitespace', () => {
    it('normalizes whitespace in strings', () => {
      expect(canonicalString('  hello \n world  ')).toBe('[hello world:string]');
    });

    it('treats whitespace-only strings as empty', () => {
      expect(canonicalString('   ')).toBe('[:string]');
    });

    it('strips whitespace from keys', () => {
      expect(canonicalString({ '  a': 1 })).toBe(canonicalString({ a: 1 }));
    });
  });

  describe('casing', () => {
    it('normalizes key casing to lowercase', () => {
      expect(canonicalString({ Foo : 1 })).toBe(canonicalString({ foo: 1 }));
    });

    it('preserves string value casing', () => {
      expect(canonicalString('Hello')).toBe(canonicalString('Hello'));
      expect(canonicalString('Hello')).not.toBe(canonicalString('hello'));
    });
  });

  describe('numeric precision', () => {
    it('normalizes integer-valued floats', () => {
      expect(canonicalString(1.0)).toBe(canonicalString(1));
      expect(canonicalString(100.0)).toBe(canonicalString(100));
    });

    it('normalizes negative zero', () => {
      expect(canonicalString(-0)).toBe(canonicalString(0));
    });

    it('rejects NaN and Infinity', () => {
      expect(() => canonicalString(NaN)).toThrow();
      expect(() => canonicalString(Infinity)).toThrow();
      expect(() => canonicalString(-Infinity)).toThrow();
    });

    it('preserves decimal precision', () => {
      expect(canonicalString(0.1 + 0.2)).toBe(canonicalString(0.30000000000000004));
    });
  });

  describe('legacy payloads', () => {
    it('normalizes legacy flat key paths', () => {
      const legacy = { 'user.name': 'Ada', 'user.id': 1 };
      const modern = { user: { name: 'Ada', id: 1 } };
      expect(canonicalizeLegacy(legacy)).toBe(canonicalize(modern));
    });

    it('normalizes legacy array wrappers', () => {
      const legacy = { items: { item: [1, 2, 3] } };
      const modern = { items: [1, 2, 3] };
      expect(canonicalizeLegacy(legacy)).toBe(canonicalize(modern));
    });

    it('normalizes legacy boolean strings', () => {
      expect(canonicalizeLegacy({ active: 'TRUE' })).toBe(canonicalize({ active: true }));
      expect(canonicalizeLegacy({ active: 'False' })).toBe(canonicalize({ active: false }));
    });

    it('rejects unknown legacy formats', () => {
      expect(() => canonicalizeLegacy({ items: { wrapped: [1] } })).toThrow();
    });
  });

  describe('hashing', () => {
    it('produces the same hash for equivalent payloads', () => {
      const a = { id: 1, name: ' Ada ', meta: { x: 1.0, y: 'TRUE' } };
      const b = { meta: { y: true, x: 1 }, name: 'Ada', id: 1 };
      expect(canonicalHash(a)).toBe(canonicalHash(b));
    });

    it('produces different hashes for different payloads', () => {
      expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
    });

    it('returns a hex digest', () => {
      expect(canonicalHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('normalizePayload', () => {
    it('returns a normalized object', () => {
      const out = normalizePayload({ B: 2, A: 1 });
      expect(Object.keys(out)).toEqual(['a', 'b']);
    });

    it('rejects undefined values', () => {
      expect(() => normalizePayload({ a: undefined })).toThrow();
    });

    it('rejects functions', () => {
      expect(() => normalizePayload({ a: () => 1 })).toThrow();
    });

    it('rejects symbols', () => {
      expect(() => normalizePayload({ a: Symbol('x') })).toThrow();
    });
  });

  describe('assertCanonical', () => {
    it('throws when payload is not canonical', () => {
      expect(() => assertCanonical({ B : 1 })).toThrow();
    });

    it('passes for canonical payloads', () => {
      expect(() => assertCanonical({ a: 1 })).not.toThrow();
    });
  });

  describe('canonicalJson', () => {
    it('produces valid JSON', () => {
      const out = canonicalJson({ b: 2, a: 1 });
      expect(JSON.parse(out)).toEqual({ a: 1, b: 2 });
    });

    it('matches canonicalString', () => {
      const payload = { b: 2, a: 1 };
      expect(canonicalJson(payload)).toBe(canonicalString(payload));
    });
  });
});
