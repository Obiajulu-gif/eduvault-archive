import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import {
  CONFIG_AUDIT_CHANGE_TYPES,
  CONFIG_AUDIT_CATEGORIES,
  CONFIG_AUDIT_SEVERITY,
  ConfigAuditError,
  CONFIG_SETTING_REGISTRY,
  GENESIS_PREV_HASH,
  DEFAULT_AUDIT_SIGNING_KEY,
  validateConfigSetting,
  maskSensitiveConfigValue,
  computeActorProof,
  buildConfigAuditEvidence,
  verifyConfigAuditEvidence,
  verifyConfigAuditChain,
  applyAdminConfigChange,
  rollbackConfigChange,
  exportConfigAuditBundle,
} from '../../src/lib/config/adminConfigAudit.js';

function createMockCollection(initialDocs = []) {
  const docs = [...initialDocs];

  function matches(doc, query) {
    if (!query || Object.keys(query).length === 0) return true;
    for (const [key, val] of Object.entries(query)) {
      if (key === 'sequence' && typeof val === 'object' && val.$gt !== undefined) {
        if (!(doc.sequence > val.$gt)) return false;
        continue;
      }
      if (key === 'createdAt' && typeof val === 'object') {
        if (val.$gte && doc.createdAt < val.$gte) return false;
        if (val.$lte && doc.createdAt > val.$lte) return false;
        continue;
      }
      if (key.includes('.')) {
        const parts = key.split('.');
        let curr = doc;
        for (const p of parts) curr = curr?.[p];
        if (String(curr) !== String(val)) return false;
        continue;
      }
      if (String(doc[key]) !== String(val)) return false;
    }
    return true;
  }

  return {
    _docs: docs,
    async findOne(query) {
      return docs.find((d) => matches(d, query)) || null;
    },
    find(query = {}) {
      let filtered = docs.filter((d) => matches(d, query));
      return {
        sort(sortObj = {}) {
          const key = Object.keys(sortObj)[0];
          const dir = sortObj[key];
          filtered.sort((a, b) => {
            if (a[key] < b[key]) return dir === 1 ? -1 : 1;
            if (a[key] > b[key]) return dir === 1 ? 1 : -1;
            return 0;
          });
          return {
            limit(n) {
              return {
                toArray: async () => filtered.slice(0, n),
              };
            },
            toArray: async () => filtered,
          };
        },
        toArray: async () => filtered,
      };
    },
    async insertOne(doc) {
      // Unique constraint simulation
      if (doc.operationId && docs.some((d) => d.operationId === doc.operationId)) {
        const err = new Error('E11000 duplicate key error collection: operationId_1');
        err.code = 11000;
        throw err;
      }
      if (doc.sequence !== undefined && docs.some((d) => d.sequence === doc.sequence)) {
        const err = new Error('E11000 duplicate key error collection: sequence_1');
        err.code = 11000;
        throw err;
      }
      docs.push({ ...doc });
      return { acknowledged: true, insertedId: doc._id || doc.evidenceId };
    },
    async updateOne(query, update, options = {}) {
      const idx = docs.findIndex((d) => matches(d, query));
      if (idx >= 0) {
        if (update.$set) Object.assign(docs[idx], update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      }
      if (options.upsert) {
        const newDoc = { ...(query._id ? { _id: query._id } : {}), ...(update.$set || {}) };
        docs.push(newDoc);
        return { matchedCount: 0, modifiedCount: 0, upsertedId: newDoc._id };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
  };
}

describe('Audit Evidence for Administrative Configuration Changes (#1001)', () => {
  let mockDb;
  let evidenceCol;
  let configCol;
  const adminActor = { id: 'admin_1', sub: 'admin_1', role: 'admin', walletAddress: 'GADMIN111111111111111111111111111111111111111111111111111111' };
  const secondaryAdmin = { id: 'admin_2', sub: 'admin_2', role: 'admin' };
  const nonAdminActor = { id: 'user_1', sub: 'user_1', role: 'creator' };

  beforeEach(() => {
    evidenceCol = createMockCollection([]);
    configCol = createMockCollection([]);
    mockDb = {
      collection(name) {
        if (name === 'config_audit_evidence') return evidenceCol;
        if (name === 'system_config') return configCol;
        return createMockCollection([]);
      },
    };
  });

  describe('Registry & Input Validation', () => {
    test('validates known registered settings with boundaries and types', () => {
      const res = validateConfigSetting('marketplace.platformFeeBps', 500);
      assert.equal(res.settingKey, 'marketplace.platformFeeBps');
      assert.equal(res.category, CONFIG_AUDIT_CATEGORIES.MARKETPLACE);
      assert.equal(res.severity, CONFIG_AUDIT_SEVERITY.CRITICAL);
      assert.equal(res.dualApprovalRequired, true);

      // Boolean setting
      const flagRes = validateConfigSetting('feature_flags.stellar_indexer', false);
      assert.equal(flagRes.settingKey, 'feature_flags.stellar_indexer');
      assert.equal(flagRes.category, CONFIG_AUDIT_CATEGORIES.FEATURE_FLAGS);

      // String setting with allowedValues
      const scopeRes = validateConfigSetting('maintenance.scope', 'checkout');
      assert.equal(scopeRes.settingKey, 'maintenance.scope');
    });

    test('rejects values violating type or range constraints', () => {
      // Fee exceeding 10000 bps
      assert.throws(
        () => validateConfigSetting('marketplace.platformFeeBps', 10001),
        (err) => err instanceof ConfigAuditError && err.code === 'CONFIG_VALUE_OUT_OF_BOUNDS'
      );

      // Fee below 0 bps
      assert.throws(
        () => validateConfigSetting('marketplace.platformFeeBps', -5),
        (err) => err instanceof ConfigAuditError && err.code === 'CONFIG_VALUE_OUT_OF_BOUNDS'
      );

      // Non-integer for integer setting
      assert.throws(
        () => validateConfigSetting('marketplace.platformFeeBps', 'five_hundred'),
        (err) => err instanceof ConfigAuditError && err.code === 'INVALID_CONFIG_TYPE'
      );

      // Non-boolean for boolean setting
      assert.throws(
        () => validateConfigSetting('feature_flags.bulk_refunds', 'true'),
        (err) => err instanceof ConfigAuditError && err.code === 'INVALID_CONFIG_TYPE'
      );

      // Disallowed string value
      assert.throws(
        () => validateConfigSetting('maintenance.scope', 'invalid_scope_name'),
        (err) => err instanceof ConfigAuditError && err.code === 'CONFIG_VALUE_NOT_ALLOWED'
      );
    });

    test('accepts well-formed custom settings and rejects malformed keys', () => {
      const custom = validateConfigSetting('custom.security.allowed_proxies', '10.0.0.1');
      assert.equal(custom.settingKey, 'custom.security.allowed_proxies');
      assert.equal(custom.category, CONFIG_AUDIT_CATEGORIES.SECURITY);

      assert.throws(
        () => validateConfigSetting('badKeyWithoutDots', 'val'),
        (err) => err instanceof ConfigAuditError && err.code === 'UNKNOWN_SETTING_KEY'
      );
    });
  });

  describe('Secret Masking & Sanitization', () => {
    test('redacts Stellar secret seeds, JWTs, and Bearer tokens in snapshots', () => {
      const secretSeed = 'S' + 'A'.repeat(55);
      const jwtToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature123';
      const masked = maskSensitiveConfigValue('anySetting', {
        seed: secretSeed,
        nested: {
          token: jwtToken,
          safe: 'normal_config_text',
        },
      });

      assert.equal(masked.seed, '[REDACTED:secret]');
      assert.equal(masked.nested.token, '[REDACTED:secret]');
      assert.equal(masked.nested.safe, 'normal_config_text');
    });

    test('redacts values for keys explicitly containing secret/token/password', () => {
      assert.equal(maskSensitiveConfigValue('api_secret_token', 'unredacted_val'), '[REDACTED:secret]');
      assert.equal(maskSensitiveConfigValue('admin_password', 'p@ssword'), '[REDACTED:secret]');
    });
  });

  describe('Normal Path & Cryptographic Hash Chaining', () => {
    test('applies change, updates active config, and forms verifiable hash chain', async () => {
      const op1 = 'op-101';
      const change1 = await applyAdminConfigChange({
        db: mockDb,
        operationId: op1,
        settingKey: 'marketplace.creatorShareBps',
        proposedValue: 9500,
        actor: adminActor,
        reason: 'Adjusting creator share for new promo season',
      });

      assert.equal(change1.success, true);
      assert.equal(change1.idempotentReplay, false);
      assert.equal(change1.config['marketplace.creatorShareBps'], 9500);

      const ev1 = change1.evidence;
      assert.equal(ev1.sequence, 0);
      assert.equal(ev1.previousEvidenceHash, GENESIS_PREV_HASH);
      assert.equal(ev1.before, 9750); // Default value from registry
      assert.equal(ev1.after, 9500);
      assert.ok(ev1.recordHash && ev1.recordHash.length === 64);
      assert.ok(ev1.signature);
      assert.ok(ev1.actorProof);

      // Verify single evidence
      const singleCheck = verifyConfigAuditEvidence(ev1);
      assert.equal(singleCheck.valid, true);

      // Apply second change to test hash chaining
      const op2 = 'op-102';
      const change2 = await applyAdminConfigChange({
        db: mockDb,
        operationId: op2,
        settingKey: 'feature_flags.bulk_refunds',
        proposedValue: true,
        actor: adminActor,
        reason: 'Enabling bulk refund feature flag for pilot creators',
      });

      const ev2 = change2.evidence;
      assert.equal(ev2.sequence, 1);
      assert.equal(ev2.previousEvidenceHash, ev1.recordHash);
      assert.equal(ev2.before, false);
      assert.equal(ev2.after, true);

      // Verify complete chain
      const allEvidence = await evidenceCol.find({}).sort({ sequence: 1 }).toArray();
      assert.equal(allEvidence.length, 2);

      const chainCheck = verifyConfigAuditChain(allEvidence);
      assert.equal(chainCheck.valid, true);
      assert.equal(chainCheck.recordsCount, 2);
      assert.equal(chainCheck.brokenAtSequence, null);

      // Verify active config collection doc
      const activeDoc = await configCol.findOne({ _id: 'feature_flags.bulk_refunds' });
      assert.equal(activeDoc.value, true);
      assert.equal(activeDoc.lastEvidenceId, ev2.evidenceId);
    });
  });

  describe('Authorization Path & Dual-Approval Protection', () => {
    test('rejects non-admin actors with UNAUTHORIZED_ADMIN (403)', async () => {
      await assert.rejects(
        () =>
          applyAdminConfigChange({
            db: mockDb,
            operationId: 'op-unauth',
            settingKey: 'maintenance.global',
            proposedValue: true,
            actor: nonAdminActor,
            reason: 'Attempted unauthorized toggle',
          }),
        (err) => err instanceof ConfigAuditError && err.code === 'UNAUTHORIZED_ADMIN' && err.status === 403
      );
    });

    test('critical settings strictly require secondary maintainer approval (dual-approval)', async () => {
      // marketplace.platformFeeBps has severity: CRITICAL and dualApprovalRequired: true
      await assert.rejects(
        () =>
          applyAdminConfigChange({
            db: mockDb,
            operationId: 'op-fee-no-dual',
            settingKey: 'marketplace.platformFeeBps',
            proposedValue: 300,
            actor: adminActor,
            reason: 'Bumping fee without secondary approval',
          }),
        (err) => err instanceof ConfigAuditError && err.code === 'DUAL_APPROVAL_REQUIRED' && err.status === 428
      );
    });

    test('rejects self-approval for critical settings (two-person rule enforcement)', async () => {
      await assert.rejects(
        () =>
          applyAdminConfigChange({
            db: mockDb,
            operationId: 'op-fee-self-approval',
            settingKey: 'marketplace.platformFeeBps',
            proposedValue: 300,
            actor: adminActor,
            reason: 'Fee adjustment',
            approvalEvidence: {
              approver: adminActor.id, // Self approval!
              reason: 'I approve my own change',
            },
          }),
        (err) => err instanceof ConfigAuditError && err.code === 'SELF_APPROVAL_FORBIDDEN' && err.status === 422
      );
    });

    test('accepts critical setting when valid secondary approver is provided', async () => {
      const res = await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op-fee-valid-dual',
        settingKey: 'marketplace.platformFeeBps',
        proposedValue: 300,
        actor: adminActor,
        reason: 'Platform fee revision approved by governance council',
        approvalEvidence: {
          approver: secondaryAdmin.id,
          reason: 'Verified and signed off by lead finance administrator',
          approvalToken: 'appr_tok_valid_999',
        },
      });

      assert.equal(res.success, true);
      assert.equal(res.evidence.approvalEvidence.approver, 'admin_2');
      assert.equal(res.evidence.after, 300);
    });
  });

  describe('Failure Path & Validation Invariants', () => {
    test('rejects change when mandatory justification reason is missing or trivial', async () => {
      await assert.rejects(
        () =>
          applyAdminConfigChange({
            db: mockDb,
            operationId: 'op-no-reason',
            settingKey: 'maintenance.global',
            proposedValue: true,
            actor: adminActor,
            reason: '   ', // empty
          }),
        (err) => err instanceof ConfigAuditError && err.code === 'MISSING_AUDIT_REASON'
      );

      await assert.rejects(
        () =>
          applyAdminConfigChange({
            db: mockDb,
            operationId: 'op-short-reason',
            settingKey: 'maintenance.global',
            proposedValue: true,
            actor: adminActor,
            reason: 'hi', // too short (< 5 chars)
          }),
        (err) => err instanceof ConfigAuditError && err.code === 'MISSING_AUDIT_REASON'
      );
    });

    test('rejects no-op changes to prevent noise in evidence ledger', async () => {
      // First change: set to 9500
      await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op-noop-1',
        settingKey: 'marketplace.creatorShareBps',
        proposedValue: 9500,
        actor: adminActor,
        reason: 'Set to 9500',
      });

      // Second change: proposing 9500 again
      await assert.rejects(
        () =>
          applyAdminConfigChange({
            db: mockDb,
            operationId: 'op-noop-2',
            settingKey: 'marketplace.creatorShareBps',
            proposedValue: 9500,
            actor: adminActor,
            reason: 'Redundant set to same value',
          }),
        (err) => err instanceof ConfigAuditError && err.code === 'NOOP_MUTATION'
      );
    });
  });

  describe('Retry & Idempotency Path', () => {
    test('re-submitting identical operationId returns original evidence without duplicate write', async () => {
      const fixedOpId = 'op-idempotent-test-77';

      const firstAttempt = await applyAdminConfigChange({
        db: mockDb,
        operationId: fixedOpId,
        settingKey: 'security.sessionInactivityTimeoutMinutes',
        proposedValue: 30,
        actor: adminActor,
        reason: 'Hardening session inactivity timeout',
      });

      assert.equal(firstAttempt.success, true);
      assert.equal(firstAttempt.idempotentReplay, false);

      // Re-submit with same operationId
      const secondAttempt = await applyAdminConfigChange({
        db: mockDb,
        operationId: fixedOpId,
        settingKey: 'security.sessionInactivityTimeoutMinutes',
        proposedValue: 30,
        actor: adminActor,
        reason: 'Hardening session inactivity timeout (network retry)',
      });

      assert.equal(secondAttempt.success, true);
      assert.equal(secondAttempt.idempotentReplay, true);
      assert.equal(secondAttempt.evidence.evidenceId, firstAttempt.evidence.evidenceId);
      assert.equal(secondAttempt.evidence.recordHash, firstAttempt.evidence.recordHash);

      // Confirm only 1 record was written
      const totalRecords = await evidenceCol.find({}).toArray();
      assert.equal(totalRecords.length, 1);
    });
  });

  describe('Tamper-Evidence & Verification', () => {
    test('detects tampered payload in evidence entry', async () => {
      const res = await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op-tamper-entry',
        settingKey: 'financial.payoutHoldPeriodHours',
        proposedValue: 48,
        actor: adminActor,
        reason: 'Shorten hold period for trusted creators',
      });

      const legitEvidence = res.evidence;
      assert.equal(verifyConfigAuditEvidence(legitEvidence).valid, true);

      // Tamper with 'after' value
      const tamperedEvidence = { ...legitEvidence, after: 1 };
      const tamperCheck = verifyConfigAuditEvidence(tamperedEvidence);
      assert.equal(tamperCheck.valid, false);
      assert.ok(tamperCheck.errors.includes('record_hash_mismatch'));
    });

    test('detects signature mismatch if tampered signing key or recordHash', async () => {
      const res = await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op-tamper-sig',
        settingKey: 'maintenance.global',
        proposedValue: true,
        actor: adminActor,
        reason: 'Maintenance mode toggle',
      });

      const badKeyCheck = verifyConfigAuditEvidence(res.evidence, {
        signingKey: 'wrong-fake-audit-signing-key-32b',
      });
      assert.equal(badKeyCheck.valid, false);
      assert.ok(badKeyCheck.errors.includes('signature_mismatch'));
    });

    test('detects sequence gaps and broken linkages in the evidence chain', async () => {
      await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op-chain-1',
        settingKey: 'feature_flags.bulk_refunds',
        proposedValue: true,
        actor: adminActor,
        reason: 'Step 1',
      });

      await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op-chain-2',
        settingKey: 'feature_flags.learner_export',
        proposedValue: false,
        actor: adminActor,
        reason: 'Step 2',
      });

      await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op-chain-3',
        settingKey: 'maintenance.global',
        proposedValue: true,
        actor: adminActor,
        reason: 'Step 3',
      });

      const records = await evidenceCol.find({}).sort({ sequence: 1 }).toArray();
      assert.equal(records.length, 3);
      assert.equal(verifyConfigAuditChain(records).valid, true);

      // Break chain link at record 2
      const brokenChain = JSON.parse(JSON.stringify(records));
      brokenChain[2].previousEvidenceHash = 'f'.repeat(64); // Invalid linkage

      const brokenCheck = verifyConfigAuditChain(brokenChain);
      assert.equal(brokenCheck.valid, false);
      assert.equal(brokenCheck.brokenAtSequence, 2);
    });
  });

  describe('Rollback & Recovery Path', () => {
    test('rolls back previous configuration, records new rollback evidence, and preserves append-only integrity', async () => {
      // 1. Initial change from 90 days to 60 days
      const changeRes = await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op-purge-change',
        settingKey: 'storage.permanentPurgeRetentionDays',
        proposedValue: 60,
        actor: adminActor,
        reason: 'Temporary reduction of retention window',
        approvalEvidence: { approver: secondaryAdmin.id, reason: 'Approved retention reduction' },
      });

      const targetEvidenceId = changeRes.evidence.evidenceId;
      assert.equal((await configCol.findOne({ _id: 'storage.permanentPurgeRetentionDays' })).value, 60);

      // 2. Perform rollback
      const rollbackRes = await rollbackConfigChange({
        db: mockDb,
        evidenceId: targetEvidenceId,
        actor: adminActor,
        reason: 'Reverting retention window change due to learner feedback',
        approvalEvidence: { approver: secondaryAdmin.id, reason: 'Approved rollback to 90 days' },
      });

      assert.equal(rollbackRes.success, true);
      assert.equal(rollbackRes.config['storage.permanentPurgeRetentionDays'], 90); // Reverted to previous value

      const rollbackEv = rollbackRes.rollbackEvidence;
      assert.equal(rollbackEv.changeType, CONFIG_AUDIT_CHANGE_TYPES.ROLLBACK);
      assert.equal(rollbackEv.targetEvidenceId, targetEvidenceId);
      assert.equal(rollbackEv.sequence, 1);
      assert.equal(rollbackEv.previousEvidenceHash, changeRes.evidence.recordHash);
      assert.equal(rollbackEv.before, 60);
      assert.equal(rollbackEv.after, 90);

      // 3. Confirm target evidence was NOT deleted or mutated
      const originalEv = await evidenceCol.findOne({ evidenceId: targetEvidenceId });
      assert.equal(originalEv.after, 60);
      assert.equal(originalEv.sequence, 0);

      // 4. Verify entire chain integrity includes the rollback entry
      const allRecords = await evidenceCol.find({}).sort({ sequence: 1 }).toArray();
      assert.equal(allRecords.length, 2);
      assert.equal(verifyConfigAuditChain(allRecords).valid, true);
    });

    test('rejects rollback when evidenceId does not exist', async () => {
      await assert.rejects(
        () =>
          rollbackConfigChange({
            db: mockDb,
            evidenceId: 'ev_cfg_non_existent',
            actor: adminActor,
            reason: 'Revert phantom change',
          }),
        (err) => err instanceof ConfigAuditError && err.code === 'EVIDENCE_NOT_FOUND' && err.status === 404
      );
    });
  });

  describe('Exportable Evidence Bundles', () => {
    test('exports complete verifiable configuration audit bundle', async () => {
      await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op-bundle-1',
        settingKey: 'feature_flags.bulk_refunds',
        proposedValue: true,
        actor: adminActor,
        reason: 'Enabling bulk refunds',
      });

      const bundle = await exportConfigAuditBundle({
        db: mockDb,
        requestedBy: adminActor,
      });

      assert.equal(bundle.bundleType, 'administrative_configuration_audit_evidence');
      assert.equal(bundle.totalEntries, 1);
      assert.equal(bundle.chainVerification.valid, true);
      assert.equal(bundle.entries[0].settingKey, 'feature_flags.bulk_refunds');
      assert.ok(bundle.rootHash && bundle.rootHash.length === 64);
    });
  });
});
