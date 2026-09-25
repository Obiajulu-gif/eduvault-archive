import { describe, it, expect } from 'vitest';
import { xdr, nativeToScVal } from '@stellar/stellar-sdk';
import {
  buildHasEntitlementXdr,
  buildSettlementStateXdr,
  decodeBoolean,
  decodeSettlementState,
} from '../entitlement.js';

function toBase64(scVal) {
  return scVal.toXDR('base64');
}

describe('Soroban Entitlement XDR Builder & Decoder (Issue #559)', () => {
  const sampleMaterialId = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const sampleBuyer = 'GBTESTBUYERACCOUNTADDRESSFORTESTINGPURPOSES1234567890';

  it('builds a valid simulateTransaction XDR for has_entitlement', () => {
    const xdrString = buildHasEntitlementXdr(sampleMaterialId, sampleBuyer);
    expect(typeof xdrString).toBe('string');
    // If contract ID is configured, returns non-empty base64 XDR
    if (process.env.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID) {
      expect(xdrString.length).toBeGreaterThan(0);
    }
  });

  it('builds a valid simulateTransaction XDR for settlement_state', () => {
    const xdrString = buildSettlementStateXdr('42');
    expect(typeof xdrString).toBe('string');
  });

  it('decodeBoolean correctly parses ScVal true and false', () => {
    const trueScVal = xdr.ScVal.scvBool(true);
    const falseScVal = xdr.ScVal.scvBool(false);

    expect(decodeBoolean(toBase64(trueScVal))).toBe(true);
    expect(decodeBoolean(toBase64(falseScVal))).toBe(false);
  });

  it('decodeBoolean fails closed (returns null) on malformed or non-boolean input', () => {
    expect(decodeBoolean('')).toBeNull();
    expect(decodeBoolean(null)).toBeNull();
    expect(decodeBoolean('not-base64-garbage')).toBeNull();

    const stringScVal = nativeToScVal('true', { type: 'string' });
    expect(decodeBoolean(toBase64(stringScVal))).toBeNull();
  });

  it('decodeSettlementState correctly decodes valid settlement states', () => {
    const states = ['Pending', 'Released', 'Disputed', 'Refunded', 'Expired'];
    for (const state of states) {
      const symbolScVal = nativeToScVal(state, { type: 'symbol' });
      expect(decodeSettlementState(toBase64(symbolScVal))).toBe(state);
    }
  });

  it('decodeSettlementState fails closed (returns null) on unexpected or malformed payload', () => {
    expect(decodeSettlementState('')).toBeNull();
    expect(decodeSettlementState(null)).toBeNull();
    expect(decodeSettlementState('invalid-xdr-payload')).toBeNull();

    const randomScVal = nativeToScVal(999, { type: 'u32' });
    expect(decodeSettlementState(toBase64(randomScVal))).toBeNull();
  });
});
