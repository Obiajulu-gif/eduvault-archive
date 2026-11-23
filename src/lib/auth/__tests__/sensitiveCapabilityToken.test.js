import { describe, it, expect, beforeEach } from 'vitest';
import {
  SENSITIVE_ACTIONS,
  DEFAULT_CAPABILITY_TTL_MS,
  generateSensitiveCapabilityToken,
  verifySensitiveCapabilityToken,
  consumeSensitiveCapabilityToken,
  revokeSensitiveCapabilityToken,
  issueSensitiveCapability,
  createCapabilityNonceStore,
  formatCapabilityError,
} from '../sensitiveCapabilityToken.js';

describe('sensitiveCapabilityToken Vitest suite', () => {
  let store;
  const testSecret = 'vitest-capability-secret-key-999';

  beforeEach(() => {
    store = createCapabilityNonceStore();
  });

  describe('generateSensitiveCapabilityToken', () => {
    it('throws if required fields are missing', () => {
      expect(() => generateSensitiveCapabilityToken({ action: 'act', target: 'tgt' })).toThrow('Actor');
      expect(() => generateSensitiveCapabilityToken({ actor: 'act', target: 'tgt' })).toThrow('Action');
      expect(() => generateSensitiveCapabilityToken({ actor: 'act', action: 'act' })).toThrow('Target');
    });

    it('clamps TTL within MIN and MAX boundaries', () => {
      // 100ms should be clamped to 5000ms (MIN)
      const { payload: minPayload } = generateSensitiveCapabilityToken({
        actor: 'user-1',
        action: SENSITIVE_ACTIONS.WALLET_UPDATE,
        target: 'wallet-1',
        ttlMs: 100,
        secret: testSecret,
      });
      expect(minPayload.exp - minPayload.iat).toBe(5000);

      // 100 hours should be clamped to 1 hour (MAX)
      const { payload: maxPayload } = generateSensitiveCapabilityToken({
        actor: 'user-1',
        action: SENSITIVE_ACTIONS.WALLET_UPDATE,
        target: 'wallet-1',
        ttlMs: 100 * 3600 * 1000,
        secret: testSecret,
      });
      expect(maxPayload.exp - maxPayload.iat).toBe(3600 * 1000);
    });
  });

  describe('verifySensitiveCapabilityToken', () => {
    it('validates currency constraint matching', () => {
      const { token } = generateSensitiveCapabilityToken({
        actor: 'creator-1',
        action: SENSITIVE_ACTIONS.PAYOUT_REQUEST,
        target: 'payout-1',
        constraints: { currency: 'USDC' },
        secret: testSecret,
      });

      // Mismatch
      const mismatch = verifySensitiveCapabilityToken(token, {
        expectedActor: 'creator-1',
        expectedAction: SENSITIVE_ACTIONS.PAYOUT_REQUEST,
        expectedTarget: 'payout-1',
        constraints: { currency: 'XLM' },
        secret: testSecret,
        store,
      });
      expect(mismatch.valid).toBe(false);
      expect(mismatch.code).toBe('EVT_INPUT_002');

      // Match (case-insensitive)
      const match = verifySensitiveCapabilityToken(token, {
        expectedActor: 'creator-1',
        expectedAction: SENSITIVE_ACTIONS.PAYOUT_REQUEST,
        expectedTarget: 'payout-1',
        constraints: { currency: 'usdc' },
        secret: testSecret,
        store,
      });
      expect(match.valid).toBe(true);
    });

    it('rejects future-dated tokens beyond 60s', () => {
      const now = Date.now();
      const { token } = generateSensitiveCapabilityToken({
        actor: 'user-1',
        action: SENSITIVE_ACTIONS.ACCOUNT_DELETE,
        target: 'user-1',
        iat: now + 120_000, // 2 minutes in future
        secret: testSecret,
      });

      const res = verifySensitiveCapabilityToken(token, {
        now,
        secret: testSecret,
        store,
      });
      expect(res.valid).toBe(false);
      expect(res.code).toBe('EVT_AUTH_002');
      expect(res.error).toContain('future-dated');
    });

    it('supports wildcard target (*)', () => {
      const { token } = generateSensitiveCapabilityToken({
        actor: 'admin-1',
        action: SENSITIVE_ACTIONS.ROLE_ESCALATE,
        target: '*', // Wildcard target
        secret: testSecret,
      });

      const res = verifySensitiveCapabilityToken(token, {
        expectedActor: 'admin-1',
        expectedAction: SENSITIVE_ACTIONS.ROLE_ESCALATE,
        expectedTarget: 'any-target-user',
        secret: testSecret,
        store,
      });
      expect(res.valid).toBe(true);
    });
  });

  describe('createCapabilityNonceStore', () => {
    it('prunes expired entries accurately', () => {
      const store = createCapabilityNonceStore({ maxEntries: 100 });
      const now = Date.now();

      store.consume('jti-1', now - 1000); // Expired
      store.consume('jti-2', now + 10000); // Active
      store.revoke('jti-3', now - 500); // Expired revocation
      store.revoke('jti-4', now + 10000); // Active revocation

      store.prune(now);

      expect(store.isConsumed('jti-1')).toBe(false);
      expect(store.isConsumed('jti-2')).toBe(true);
      expect(store.isRevoked('jti-3')).toBe(false);
      expect(store.isRevoked('jti-4')).toBe(true);
    });
  });

  describe('formatCapabilityError', () => {
    it('returns compliant problem details error structure', () => {
      const formatted = formatCapabilityError({
        code: 'EVT_AUTH_003',
        error: 'Capability token expired',
        status: 401,
        retryable: true,
        supportAction: 'refresh_capability',
      });

      expect(formatted.error.code).toBe('EVT_AUTH_003');
      expect(formatted.error.status).toBe(401);
      expect(formatted.error.retryable).toBe(true);
      expect(formatted.error.supportAction).toBe('refresh_capability');
      expect(formatted.error.timestamp).toBeDefined();
    });
  });
});
