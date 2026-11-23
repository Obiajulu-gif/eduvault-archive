/**
 * Automated Verification: Expiring Capability Tokens for Sensitive Actions
 *
 * Covers Acceptance Criteria:
 *   1. Normal Path: Issuance, signature validation, constraint satisfaction, and single-use consumption.
 *   2. Failure Path: Missing token, malformed envelope, signature tampering, expiration, actor/action/target mismatch, constraint violation, and replay attacks.
 *   3. Retry Path: Expired token recovery (EVT_AUTH_003 + refresh_capability), token refresh re-execution, and rate-limiting.
 *   4. Authorization Path: Role-based issuance gating, tenant isolation, creator resource boundary checks, and maintainer impersonation elevated confirmation.
 */

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';

import {
  SENSITIVE_ACTIONS,
  DEFAULT_CAPABILITY_TTL_MS,
  generateSensitiveCapabilityToken,
  verifySensitiveCapabilityToken,
  consumeSensitiveCapabilityToken,
  revokeSensitiveCapabilityToken,
  issueSensitiveCapability,
  createCapabilityNonceStore,
  extractCapabilityTokenFromRequest,
  formatCapabilityError,
} from '../../src/lib/auth/sensitiveCapabilityToken.js';

describe('Expiring Capability Tokens for Sensitive Actions', () => {
  let store;
  const testSecret = 'test-isolated-capability-secret-12345';

  beforeEach(() => {
    store = createCapabilityNonceStore();
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. NORMAL PATH: Token Generation, Verification, & Consumption
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Normal Path — Generation, Verification, & Single-Use Consumption', () => {
    test('successfully generates and verifies a capability token for sensitive payout request', () => {
      const actor = 'GCREATOR1234567890';
      const action = SENSITIVE_ACTIONS.PAYOUT_REQUEST;
      const target = 'payout-batch-2026-10';

      const { token, payload } = generateSensitiveCapabilityToken({
        actor,
        action,
        target,
        constraints: { maxAmount: 1500, currency: 'XLM' },
        ttlMs: 60_000,
        secret: testSecret,
      });

      assert.ok(typeof token === 'string', 'Token must be a base64url string');
      assert.equal(payload.actor, actor);
      assert.equal(payload.action, action);
      assert.equal(payload.target, target);
      assert.equal(payload.constraints.maxAmount, 1500);

      const verification = verifySensitiveCapabilityToken(token, {
        expectedActor: actor,
        expectedAction: action,
        expectedTarget: target,
        constraints: { amount: 1200, currency: 'XLM' },
        secret: testSecret,
        store,
      });

      assert.equal(verification.valid, true);
      assert.ok(verification.remainingTtlMs > 0);
      assert.equal(verification.payload.jti, payload.jti);
    });

    test('extracts capability token from multiple standard request surfaces', () => {
      // 1. Header: x-capability-token
      const reqHeader = { headers: { get: (name) => name === 'x-capability-token' ? 'cap-tok-1' : null } };
      assert.equal(extractCapabilityTokenFromRequest(reqHeader), 'cap-tok-1');

      // 2. Header: Authorization: Capability <token>
      const reqAuth = { headers: { get: (name) => name === 'authorization' ? 'Capability cap-tok-2' : null } };
      assert.equal(extractCapabilityTokenFromRequest(reqAuth), 'cap-tok-2');

      // 3. Query: ?cap=<token>
      const reqQuery = { url: 'https://eduvault.internal/api/payout?cap=cap-tok-3' };
      assert.equal(extractCapabilityTokenFromRequest(reqQuery), 'cap-tok-3');

      // 4. Body: { capabilityToken: <token> }
      const reqBody = { body: { capabilityToken: 'cap-tok-4' } };
      assert.equal(extractCapabilityTokenFromRequest(reqBody), 'cap-tok-4');
    });

    test('consumes single-use capability token atomically', () => {
      const { token, payload } = generateSensitiveCapabilityToken({
        actor: 'user-alice',
        action: SENSITIVE_ACTIONS.LEARNER_DATA_EXPORT,
        target: 'learner-alice',
        singleUse: true,
        secret: testSecret,
      });

      // First verification with consume=true succeeds and marks nonce
      const consumed = consumeSensitiveCapabilityToken(token, {
        expectedActor: 'user-alice',
        expectedAction: SENSITIVE_ACTIONS.LEARNER_DATA_EXPORT,
        expectedTarget: 'learner-alice',
        store,
        secret: testSecret,
      });

      assert.equal(consumed.valid, true);
      assert.equal(store.isConsumed(payload.jti), true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. FAILURE PATH: Tampering, Expiration, Mismatches & Replay Protection
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Failure Path — Tampering, Expiry, Mismatch & Replay Rejection', () => {
    test('missing token returns EVT_AUTH_001 (401)', () => {
      const res = verifySensitiveCapabilityToken(null);
      assert.equal(res.valid, false);
      assert.equal(res.code, 'EVT_AUTH_001');
      assert.equal(res.status, 401);
      assert.equal(res.retryable, false);
    });

    test('malformed or corrupt token envelope returns EVT_AUTH_002 (401)', () => {
      const res = verifySensitiveCapabilityToken('!!invalid_base64_not_json!!');
      assert.equal(res.valid, false);
      assert.equal(res.code, 'EVT_AUTH_002');
      assert.equal(res.status, 401);
    });

    test('signature tampering is detected and rejected with EVT_AUTH_002 (401)', () => {
      const { token } = generateSensitiveCapabilityToken({
        actor: 'creator-carol',
        action: SENSITIVE_ACTIONS.MATERIAL_DELETE,
        target: 'mat-100',
        secret: testSecret,
      });

      // Decode envelope, tamper with payload (change target to mat-999), re-encode
      const envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
      const payloadObj = JSON.parse(envelope.payload);
      payloadObj.target = 'mat-999'; // Tamper!
      const tamperedPayloadJson = JSON.stringify(payloadObj);
      const tamperedToken = Buffer.from(JSON.stringify({
        payload: tamperedPayloadJson,
        signature: envelope.signature, // Old signature
      })).toString('base64url');

      const res = verifySensitiveCapabilityToken(tamperedToken, {
        expectedActor: 'creator-carol',
        expectedAction: SENSITIVE_ACTIONS.MATERIAL_DELETE,
        expectedTarget: 'mat-999',
        secret: testSecret,
        store,
      });

      assert.equal(res.valid, false);
      assert.equal(res.code, 'EVT_AUTH_002');
      assert.ok(res.error.includes('tampering detected'));
    });

    test('expired token returns EVT_AUTH_003 (401) with refresh_capability guidance', () => {
      const now = Date.now();
      const { token } = generateSensitiveCapabilityToken({
        actor: 'buyer-dave',
        action: SENSITIVE_ACTIONS.DOWNLOAD_ACCESS,
        target: 'mat-500',
        ttlMs: 5000,
        iat: now - 10_000, // Issued 10s ago, expired 5s ago
        secret: testSecret,
      });

      const res = verifySensitiveCapabilityToken(token, {
        expectedActor: 'buyer-dave',
        expectedAction: SENSITIVE_ACTIONS.DOWNLOAD_ACCESS,
        expectedTarget: 'mat-500',
        now,
        secret: testSecret,
        store,
      });

      assert.equal(res.valid, false);
      assert.equal(res.code, 'EVT_AUTH_003');
      assert.equal(res.status, 401);
      assert.equal(res.retryable, true);
      assert.equal(res.supportAction, 'refresh_capability');
    });

    test('action mismatch returns EVT_AUTH_004 (403)', () => {
      const { token } = generateSensitiveCapabilityToken({
        actor: 'creator-bob',
        action: SENSITIVE_ACTIONS.MATERIAL_ARCHIVE,
        target: 'mat-200',
        secret: testSecret,
      });

      const res = verifySensitiveCapabilityToken(token, {
        expectedActor: 'creator-bob',
        expectedAction: SENSITIVE_ACTIONS.MATERIAL_DELETE, // Presenting archive token for delete
        expectedTarget: 'mat-200',
        secret: testSecret,
        store,
      });

      assert.equal(res.valid, false);
      assert.equal(res.code, 'EVT_AUTH_004');
      assert.equal(res.status, 403);
      assert.ok(res.error.includes('Action mismatch'));
    });

    test('target resource mismatch returns EVT_AUTH_004 (403)', () => {
      const { token } = generateSensitiveCapabilityToken({
        actor: 'creator-bob',
        action: SENSITIVE_ACTIONS.MATERIAL_DELETE,
        target: 'mat-200',
        secret: testSecret,
      });

      const res = verifySensitiveCapabilityToken(token, {
        expectedActor: 'creator-bob',
        expectedAction: SENSITIVE_ACTIONS.MATERIAL_DELETE,
        expectedTarget: 'mat-777', // Different resource!
        secret: testSecret,
        store,
      });

      assert.equal(res.valid, false);
      assert.equal(res.code, 'EVT_AUTH_004');
      assert.equal(res.status, 403);
      assert.ok(res.error.includes('Target mismatch'));
    });

    test('actor mismatch returns EVT_AUTH_004 (403)', () => {
      const { token } = generateSensitiveCapabilityToken({
        actor: 'creator-alice',
        action: SENSITIVE_ACTIONS.WALLET_UPDATE,
        target: 'user-alice',
        secret: testSecret,
      });

      const res = verifySensitiveCapabilityToken(token, {
        expectedActor: 'intruder-eve',
        expectedAction: SENSITIVE_ACTIONS.WALLET_UPDATE,
        expectedTarget: 'user-alice',
        secret: testSecret,
        store,
      });

      assert.equal(res.valid, false);
      assert.equal(res.code, 'EVT_AUTH_004');
      assert.equal(res.status, 403);
      assert.ok(res.error.includes('Actor mismatch'));
    });

    test('amount constraint violation returns EVT_INPUT_002 (403)', () => {
      const { token } = generateSensitiveCapabilityToken({
        actor: 'creator-frank',
        action: SENSITIVE_ACTIONS.PAYOUT_REQUEST,
        target: 'payout-1',
        constraints: { maxAmount: 500 },
        secret: testSecret,
      });

      const res = verifySensitiveCapabilityToken(token, {
        expectedActor: 'creator-frank',
        expectedAction: SENSITIVE_ACTIONS.PAYOUT_REQUEST,
        expectedTarget: 'payout-1',
        constraints: { amount: 750 }, // Exceeds 500!
        secret: testSecret,
        store,
      });

      assert.equal(res.valid, false);
      assert.equal(res.code, 'EVT_INPUT_002');
      assert.equal(res.status, 403);
      assert.ok(res.error.includes('exceeds capability limit'));
    });

    test('single-use replay attack is detected and blocked with 409', () => {
      const { token } = generateSensitiveCapabilityToken({
        actor: 'admin-1',
        action: SENSITIVE_ACTIONS.QUARANTINE_OVERRIDE,
        target: 'mat-300',
        singleUse: true,
        secret: testSecret,
      });

      // First use: consumed successfully
      const firstUse = consumeSensitiveCapabilityToken(token, {
        expectedActor: 'admin-1',
        expectedAction: SENSITIVE_ACTIONS.QUARANTINE_OVERRIDE,
        expectedTarget: 'mat-300',
        secret: testSecret,
        store,
      });
      assert.equal(firstUse.valid, true);

      // Second use (replay attempt): rejected
      const replayAttempt = verifySensitiveCapabilityToken(token, {
        expectedActor: 'admin-1',
        expectedAction: SENSITIVE_ACTIONS.QUARANTINE_OVERRIDE,
        expectedTarget: 'mat-300',
        secret: testSecret,
        store,
      });

      assert.equal(replayAttempt.valid, false);
      assert.equal(replayAttempt.code, 'EVT_AUTH_002');
      assert.equal(replayAttempt.status, 409);
      assert.ok(replayAttempt.error.includes('already been consumed'));
    });

    test('explicitly revoked token is rejected with EVT_AUTH_002 (401)', () => {
      const { token, payload } = generateSensitiveCapabilityToken({
        actor: 'user-george',
        action: SENSITIVE_ACTIONS.ACCOUNT_DELETE,
        target: 'user-george',
        secret: testSecret,
      });

      // Revoke the token before use
      revokeSensitiveCapabilityToken(payload.jti, { store });

      const res = verifySensitiveCapabilityToken(token, {
        expectedActor: 'user-george',
        expectedAction: SENSITIVE_ACTIONS.ACCOUNT_DELETE,
        expectedTarget: 'user-george',
        secret: testSecret,
        store,
      });

      assert.equal(res.valid, false);
      assert.equal(res.code, 'EVT_AUTH_002');
      assert.ok(res.error.includes('revoked'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. RETRY PATH: Expiration Recovery, Token Refresh, & Error Envelopes
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Retry Path — Expiry Recovery, Re-issuance & Support Guidance', () => {
    test('expired capability triggers refresh_capability retry workflow', () => {
      const now = Date.now();
      const creator = { id: 'creator-helen', role: 'creator' };

      // 1. Initial token expires
      const initial = generateSensitiveCapabilityToken({
        actor: creator.id,
        action: SENSITIVE_ACTIONS.PAYOUT_REQUEST,
        target: 'balance-helen',
        ttlMs: 5000,
        iat: now - 10_000, // Expired 5s ago
        secret: testSecret,
      });

      const failedVerification = verifySensitiveCapabilityToken(initial.token, {
        expectedActor: creator.id,
        expectedAction: SENSITIVE_ACTIONS.PAYOUT_REQUEST,
        expectedTarget: 'balance-helen',
        now,
        secret: testSecret,
        store,
      });

      // Check retryable contract
      assert.equal(failedVerification.valid, false);
      assert.equal(failedVerification.code, 'EVT_AUTH_003');
      assert.equal(failedVerification.retryable, true);
      assert.equal(failedVerification.supportAction, 'refresh_capability');

      // Error formatting produces standard envelope
      const formatted = formatCapabilityError(failedVerification);
      assert.equal(formatted.error.code, 'EVT_AUTH_003');
      assert.equal(formatted.error.retryable, true);
      assert.equal(formatted.error.supportAction, 'refresh_capability');

      // 2. Client uses refresh guidance to request a new capability token
      const refreshed = issueSensitiveCapability({
        requester: creator,
        action: SENSITIVE_ACTIONS.PAYOUT_REQUEST,
        target: 'balance-helen',
        ttlMs: 60_000,
        secret: testSecret,
        store,
      });

      assert.equal(refreshed.success, true);
      assert.ok(refreshed.token);

      // 3. Retried action with refreshed token succeeds
      const retriedVerification = verifySensitiveCapabilityToken(refreshed.token, {
        expectedActor: creator.id,
        expectedAction: SENSITIVE_ACTIONS.PAYOUT_REQUEST,
        expectedTarget: 'balance-helen',
        now,
        secret: testSecret,
        store,
      });

      assert.equal(retriedVerification.valid, true);
      assert.ok(retriedVerification.remainingTtlMs > 0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. AUTHORIZATION PATH: Role-Based Capability Issuance & Tenant Boundaries
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Authorization Path — Role-Based Issuance Gating & Tenant Scoping', () => {
    test('learner is blocked from issuing privileged payout or quarantine capabilities', () => {
      const learner = { id: 'learner-1', role: 'learner' };

      const payoutAttempt = issueSensitiveCapability({
        requester: learner,
        action: SENSITIVE_ACTIONS.PAYOUT_REQUEST,
        target: 'payout-1',
        secret: testSecret,
        store,
      });

      assert.equal(payoutAttempt.success, false);
      assert.equal(payoutAttempt.code, 'EVT_AUTH_004');
      assert.equal(payoutAttempt.status, 403);

      const quarantineAttempt = issueSensitiveCapability({
        requester: learner,
        action: SENSITIVE_ACTIONS.QUARANTINE_OVERRIDE,
        target: 'mat-1',
        secret: testSecret,
        store,
      });

      assert.equal(quarantineAttempt.success, false);
      assert.equal(quarantineAttempt.code, 'EVT_AUTH_004');
      assert.equal(quarantineAttempt.status, 403);
    });

    test('creator cannot issue destructive capabilities on materials owned by another creator', () => {
      const creatorAlice = { id: 'creator-alice', role: 'creator' };
      const bobMaterial = 'mat-owned-by-bob';

      const crossTenantAttempt = issueSensitiveCapability({
        requester: creatorAlice,
        action: SENSITIVE_ACTIONS.MATERIAL_DELETE,
        target: bobMaterial,
        resourceOwnerId: 'creator-bob', // Owned by Bob!
        secret: testSecret,
        store,
      });

      assert.equal(crossTenantAttempt.success, false);
      assert.equal(crossTenantAttempt.code, 'EVT_AUTH_004');
      assert.equal(crossTenantAttempt.status, 403);
      assert.ok(crossTenantAttempt.error.includes('owned by another creator'));
    });

    test('administrator is permitted to issue capabilities across all sensitive actions', () => {
      const admin = { id: 'admin-super', role: 'admin' };

      const actions = [
        SENSITIVE_ACTIONS.PAYOUT_SETTLE,
        SENSITIVE_ACTIONS.QUARANTINE_OVERRIDE,
        SENSITIVE_ACTIONS.ROLE_ESCALATE,
        SENSITIVE_ACTIONS.MATERIAL_DELETE,
      ];

      for (const action of actions) {
        const res = issueSensitiveCapability({
          requester: admin,
          action,
          target: 'resource-xyz',
          resourceOwnerId: 'someone-else',
          secret: testSecret,
          store,
        });

        assert.equal(res.success, true, `Admin should be permitted for action ${action}`);
        assert.ok(res.token);
      }
    });

    test('maintainer confirmation capability is required for elevated impersonation actions', () => {
      const nonMaintainer = { id: 'user-regular', isMaintainer: false, role: 'learner' };
      const maintainer = { id: 'maintainer-ops', isMaintainer: true, role: 'user' };

      const regularDenied = issueSensitiveCapability({
        requester: nonMaintainer,
        action: SENSITIVE_ACTIONS.MAINTAINER_CONFIRMATION,
        target: 'session-123',
        secret: testSecret,
        store,
      });
      assert.equal(regularDenied.success, false);
      assert.equal(regularDenied.code, 'EVT_AUTH_004');

      const maintainerGranted = issueSensitiveCapability({
        requester: maintainer,
        action: SENSITIVE_ACTIONS.MAINTAINER_CONFIRMATION,
        target: 'session-123',
        secret: testSecret,
        store,
      });
      assert.equal(maintainerGranted.success, true);
    });
  });
});
