import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  clearWebhookReplayCache,
  createWebhookSignatureHeader,
  verifyWebhookSignature,
} from './sender';

// Golden corpus: see test/fixtures/webhook-adversarial/README.md. Every case
// here is malformed or adversarial and MUST be rejected -- none of these
// represent a payload any version of the verifier should ever accept.
const FIXTURES_PATH = path.join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'webhook-adversarial',
  'cases.json',
);

const cases = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'));

describe('golden corpus: malformed/adversarial webhook payloads', () => {
  beforeEach(() => {
    clearWebhookReplayCache();
  });

  it('has at least one fixture for every documented category', () => {
    const categories = new Set(cases.map((c) => c.category));
    for (const expected of [
      'invalid-signature',
      'missing-field',
      'oversized-value',
      'replay',
      'schema-drift',
    ]) {
      expect(categories.has(expected), `no fixture covers category "${expected}"`).toBe(true);
    }
  });

  for (const testCase of cases) {
    it(`rejects: ${testCase.id} (${testCase.category}) -- ${testCase.description}`, () => {
      const result = verifyWebhookSignature(
        testCase.body,
        testCase.signatureHeader,
        testCase.secret,
        { now: testCase.verifyAt },
      );
      expect(result).toBe(false);
    });
  }
});

describe('golden corpus: adversarial use of a genuinely valid signature', () => {
  beforeEach(() => {
    clearWebhookReplayCache();
  });

  it('rejects a byte-for-byte valid signature replayed a second time', () => {
    const body = JSON.stringify({ event: 'purchase.completed', data: { id: 'replay-1' } });
    const header = createWebhookSignatureHeader(body, 'replay-secret', 1_700_000_000);

    expect(verifyWebhookSignature(body, header, 'replay-secret', { now: 1_700_000_000 })).toBe(
      true,
    );
    // Second verification of the identical header must be rejected even
    // though the signature itself is still mathematically correct.
    expect(verifyWebhookSignature(body, header, 'replay-secret', { now: 1_700_000_001 })).toBe(
      false,
    );
  });

  it('rejects a valid signature applied to a mutated body (field added after signing)', () => {
    const originalBody = JSON.stringify({ event: 'refund.issued', amount: 100 });
    const header = createWebhookSignatureHeader(originalBody, 'tamper-secret', 1_700_000_000);

    const tamperedBody = JSON.stringify({ event: 'refund.issued', amount: 100, approvedBy: 'attacker' });

    expect(
      verifyWebhookSignature(tamperedBody, header, 'tamper-secret', { now: 1_700_000_000 }),
    ).toBe(false);
  });

  it('rejects a valid signature verified against the wrong secret', () => {
    const body = JSON.stringify({ event: 'entitlement.granted', materialId: 'mat-9' });
    const header = createWebhookSignatureHeader(body, 'secret-a', 1_700_000_000);

    expect(verifyWebhookSignature(body, header, 'secret-b', { now: 1_700_000_000 })).toBe(false);
  });

  it('rejects a signature that is valid for a different, same-length body (bit-swap style forgery)', () => {
    const bodyA = JSON.stringify({ event: 'purchase.completed', data: { id: 'aaaaaaaa' } });
    const bodyB = JSON.stringify({ event: 'purchase.completed', data: { id: 'bbbbbbbb' } });
    const headerForA = createWebhookSignatureHeader(bodyA, 'swap-secret', 1_700_000_000);

    expect(bodyA.length).toBe(bodyB.length);
    expect(verifyWebhookSignature(bodyB, headerForA, 'swap-secret', { now: 1_700_000_000 })).toBe(
      false,
    );
  });
});
