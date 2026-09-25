import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createReceiptProvenanceBundle,
  verifyReceiptProvenanceBundle,
  canonicalize,
  RECEIPT_SCHEMA_VERSION,
} from '../../src/lib/purchases/receiptProvenance.js';

const BASE = {
  purchaseId: 'p_1234',
  materialId: 'mat_guide_01',
  materialVersion: 'v2.3.0',
  creator: 'GAAAAAAAEXAMPLE_CREATOR_ADDRESS_0000000001',
  asset: 'native',
  amount: '250.0000000',
  transactionHash: 'abc123def456',
  entitlementState: 'finalized',
};

describe('Receipt provenance bundle (#679)', () => {
  it('produces a bundle with schema version and a deterministic hash', () => {
    const { bundle, hash } = createReceiptProvenanceBundle(BASE);
    assert.equal(bundle.schemaVersion, RECEIPT_SCHEMA_VERSION);
    assert.equal(bundle.purchase.materialId, BASE.materialId);
    assert.equal(bundle.purchase.materialVersion, BASE.materialVersion);
    assert.equal(bundle.purchase.transactionHash, BASE.transactionHash);
    assert.equal(bundle.purchase.entitlementState, 'finalized');
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  it('is deterministic across separate calls with identical input', () => {
    const a = createReceiptProvenanceBundle(BASE);
    const b = createReceiptProvenanceBundle(BASE);
    assert.equal(a.hash, b.hash);
    assert.equal(a.bundle.purchase.issuedAt, b.bundle.purchase.issuedAt);
  });

  it('re-verifies successfully with the issued hash', () => {
    const { bundle, hash } = createReceiptProvenanceBundle(BASE);
    assert.equal(verifyReceiptProvenanceBundle({ bundle, hash }), true);
  });

  it('fails verification when a field changes after issuance', () => {
    const { bundle, hash } = createReceiptProvenanceBundle(BASE);
    const tampered = { ...bundle, purchase: { ...bundle.purchase, materialVersion: 'v2.3.1' } };
    assert.equal(verifyReceiptProvenanceBundle({ bundle: tampered, hash }), false);
  });

  it('fails verification when refund status is flipped after issuance', () => {
    const { bundle, hash } = createReceiptProvenanceBundle(BASE);
    const tampered = { ...bundle, purchase: { ...bundle.purchase, refundStatus: 'refunded', refundRefundedAt: new Date().toISOString() } };
    assert.equal(verifyReceiptProvenanceBundle({ bundle: tampered, hash }), false);
  });

  it('fails verification for a wrong/empty hash', () => {
    const { bundle } = createReceiptProvenanceBundle(BASE);
    assert.equal(verifyReceiptProvenanceBundle({ bundle, hash: 'beef' }), false);
    assert.equal(verifyReceiptProvenanceBundle({ bundle, hash: '' }), false);
    assert.equal(verifyReceiptProvenanceBundle({}), false);
  });

  it('canonicalization is key-order independent', () => {
    const x = { a: 1, b: { d: 2, c: 3 } };
    const y = { b: { c: 3, d: 2 }, a: 1 };
    assert.equal(canonicalize(x), canonicalize(y));
  });

  it('requires the mandatory provenance fields', () => {
    assert.throws(() => createReceiptProvenanceBundle({ ...BASE, materialVersion: undefined }), /materialVersion/);
    assert.throws(() => createReceiptProvenanceBundle({ ...BASE, transactionHash: undefined }), /transactionHash/);
    assert.throws(() => createReceiptProvenanceBundle({ ...BASE, amount: undefined }), /amount/);
  });
});