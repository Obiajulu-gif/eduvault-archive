import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEvidenceBundle, verifyEvidenceBundle } from '../../src/lib/audit/evidenceBundle.js';

// Privacy-preserving evidence bundles (#943).
const KEY = 'support-bundle-key-'.padEnd(48, 'x');
const WALLET = `G${'B'.repeat(55)}`;

const events = [
  {
    _id: 'refund-evt-1',
    type: 'refund.requested',
    createdAt: new Date('2026-10-01T09:00:00Z'),
    purchaseId: 'pur-7',
    learnerWallet: WALLET,
    reason: 'I paid twice, my email is someone@example.com',
  },
  {
    _id: 'refund-evt-2',
    type: 'refund.submitted',
    createdAt: new Date('2026-10-01T09:05:00Z'),
    purchaseId: 'pur-7',
    refundTxHash: 'f'.repeat(64),
    amount: '5.00',
  },
];

describe('audit evidence bundles (#943)', () => {
  it('exports a verifiable bundle without PII', () => {
    const bundle = buildEvidenceBundle({ investigationId: 'SUP-77', events, bundleKey: KEY });
    const text = JSON.stringify(bundle);
    assert.ok(!text.includes(WALLET));
    assert.ok(!text.includes('someone@example.com'));
    assert.equal(bundle.entries[1].payload.refundTxHash, 'f'.repeat(64));
    assert.equal(bundle.entries[0].occurredAt, '2026-10-01T09:00:00.000Z');
    assert.deepEqual(verifyEvidenceBundle(bundle), { valid: true, errors: [] });
    assert.equal(verifyEvidenceBundle(bundle, { bundleKey: KEY, sourceEvents: events }).valid, true);
  });

  it('detects tampering', () => {
    const bundle = buildEvidenceBundle({ investigationId: 'SUP-77', events, bundleKey: KEY });
    bundle.entries[1].payload.amount = '500.00';
    assert.equal(verifyEvidenceBundle(bundle).valid, false);
  });
});
