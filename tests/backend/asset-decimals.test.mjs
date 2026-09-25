import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAssetDecimals,
  toMinorUnits,
  toDisplayAmount,
  calculateMaxRefundMinorUnits,
} from '../../src/lib/assets/assetDecimals.js';

describe('Canonical Asset Decimal & Minor-Unit Handling (#710)', () => {
  it('resolves correct default and custom asset decimals', () => {
    assert.equal(getAssetDecimals('XLM'), 7);
    assert.equal(getAssetDecimals('native'), 7);
    assert.equal(getAssetDecimals('USDC:GABC...'), 7);
    assert.equal(getAssetDecimals('CUSTOM', 6), 6);
    assert.equal(getAssetDecimals('CUSTOM', 18), 18);
  });

  it('converts display amounts to minor units accurately across decimals', () => {
    // 7 Decimals (XLM / USDC)
    assert.equal(toMinorUnits('10.5', 7), 105000000n);
    assert.equal(toMinorUnits('0.0000001', 7), 1n);
    assert.equal(toMinorUnits('100', 7), 1000000000n);

    // 6 Decimals
    assert.equal(toMinorUnits('10.5', 6), 10500000n);

    // 18 Decimals
    assert.equal(toMinorUnits('1.234567890123456789', 18), 1234567890123456789n);
  });

  it('converts minor units back to clean display amounts', () => {
    assert.equal(toDisplayAmount(105000000n, 7), '10.5');
    assert.equal(toDisplayAmount(1n, 7), '0.0000001');
    assert.equal(toDisplayAmount(1000000000n, 7), '100');
    assert.equal(toDisplayAmount(10500000n, 6), '10.5');
  });

  it('enforces maximum i128 boundary on minor-unit conversion', () => {
    // Max i128 is 170141183460469231731687303715884105727
    const huge = '170141183460469231731687303715884105728'; // exceeds i128 max
    assert.throws(() => toMinorUnits(huge, 0), /amount_exceeds_max_i128_boundary/);
  });

  it('guarantees refunds cannot round above original payment', () => {
    const originalPayment = 100000003n; // 10.0000003 USDC in minor units

    // 100% refund (10000 bps)
    const fullRefund = calculateMaxRefundMinorUnits(originalPayment, 10000);
    assert.equal(fullRefund, originalPayment);
    assert.ok(fullRefund <= originalPayment);

    // 50% refund (5000 bps)
    const halfRefund = calculateMaxRefundMinorUnits(originalPayment, 5000);
    assert.equal(halfRefund, 50000001n); // truncated down from 50000001.5
    assert.ok(halfRefund <= originalPayment / 2n + 1n);

    // 33.33% refund (3333 bps)
    const partialRefund = calculateMaxRefundMinorUnits(originalPayment, 3333);
    assert.equal(partialRefund, 33330000n); // truncated down from 33330000.9989
    assert.ok(partialRefund < originalPayment);

    // Bps > 10000 capped to original payment
    const overCap = calculateMaxRefundMinorUnits(originalPayment, 15000);
    assert.equal(overCap, originalPayment);
  });
});
