import { describe, it, expect, beforeEach } from 'vitest';
import {
  CONFIG_AUDIT_CHANGE_TYPES,
  CONFIG_AUDIT_CATEGORIES,
  CONFIG_AUDIT_SEVERITY,
  ConfigAuditError,
  CONFIG_SETTING_REGISTRY,
  GENESIS_PREV_HASH,
  validateConfigSetting,
  maskSensitiveConfigValue,
  computeActorProof,
  buildConfigAuditEvidence,
  verifyConfigAuditEvidence,
  verifyConfigAuditChain,
  applyAdminConfigChange,
  rollbackConfigChange,
  exportConfigAuditBundle,
} from '../adminConfigAudit.js';

function createMockCollection(initialDocs = []) {
  const docs = [...initialDocs];

  function matches(doc, query) {
    if (!query || Object.keys(query).length === 0) return true;
    for (const [key, val] of Object.entries(query)) {
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
      if (doc.operationId && docs.some((d) => d.operationId === doc.operationId)) {
        const err = new Error('duplicate key error: operationId');
        err.code = 11000;
        throw err;
      }
      docs.push({ ...doc });
      return { acknowledged: true, insertedId: doc.evidenceId };
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

describe('Administrative Configuration Change Audit Evidence (Vitest)', () => {
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
    it('validates settings against registry bounds', () => {
      const fee = validateConfigSetting('marketplace.platformFeeBps', 150);
      expect(fee.settingKey).toBe('marketplace.platformFeeBps');
      expect(fee.category).toBe(CONFIG_AUDIT_CATEGORIES.MARKETPLACE);
      expect(fee.severity).toBe(CONFIG_AUDIT_SEVERITY.CRITICAL);
      expect(fee.dualApprovalRequired).toBe(true);

      const flag = validateConfigSetting('feature_flags.stellar_indexer', true);
      expect(flag.settingKey).toBe('feature_flags.stellar_indexer');
    });

    it('throws on out-of-range or invalid types', () => {
      expect(() => validateConfigSetting('marketplace.platformFeeBps', -1)).toThrow(ConfigAuditError);
      expect(() => validateConfigSetting('marketplace.platformFeeBps', 10001)).toThrow(ConfigAuditError);
      expect(() => validateConfigSetting('feature_flags.bulk_refunds', 'not-a-bool')).toThrow(ConfigAuditError);
    });

    it('masks secrets in configuration values', () => {
      const seed = 'S' + 'B'.repeat(55);
      const masked = maskSensitiveConfigValue('tokenSetting', { secretSeed: seed, normal: 'val' });
      expect(masked.secretSeed).toBe('[REDACTED:secret]');
      expect(masked.normal).toBe('val');
    });
  });

  describe('Normal, Retry, Authorization, and Failure Paths', () => {
    it('applies configuration change with valid hash chain', async () => {
      const res = await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op_vitest_1',
        settingKey: 'marketplace.creatorShareBps',
        proposedValue: 9200,
        actor: adminActor,
        reason: 'Adjusting creator revenue split for educational grant program',
      });

      expect(res.success).toBe(true);
      expect(res.idempotentReplay).toBe(false);
      expect(res.config['marketplace.creatorShareBps']).toBe(9200);

      const ev = res.evidence;
      expect(ev.sequence).toBe(0);
      expect(ev.previousEvidenceHash).toBe(GENESIS_PREV_HASH);
      expect(ev.recordHash).toHaveLength(64);

      const verifyResult = verifyConfigAuditEvidence(ev);
      expect(verifyResult.valid).toBe(true);
    });

    it('rejects unauthorized non-admin callers', async () => {
      await expect(
        applyAdminConfigChange({
          db: mockDb,
          operationId: 'op_unauth',
          settingKey: 'maintenance.global',
          proposedValue: true,
          actor: nonAdminActor,
          reason: 'Unauthorized toggle',
        })
      ).rejects.toThrow(ConfigAuditError);
    });

    it('requires secondary approver for critical settings and blocks self-approval', async () => {
      await expect(
        applyAdminConfigChange({
          db: mockDb,
          operationId: 'op_crit_missing',
          settingKey: 'marketplace.platformFeeBps',
          proposedValue: 350,
          actor: adminActor,
          reason: 'Fee update without second approver',
        })
      ).rejects.toThrow(ConfigAuditError);

      await expect(
        applyAdminConfigChange({
          db: mockDb,
          operationId: 'op_crit_self',
          settingKey: 'marketplace.platformFeeBps',
          proposedValue: 350,
          actor: adminActor,
          reason: 'Fee update with self approval',
          approvalEvidence: { approver: adminActor.id },
        })
      ).rejects.toThrow(ConfigAuditError);

      const validRes = await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op_crit_valid',
        settingKey: 'marketplace.platformFeeBps',
        proposedValue: 350,
        actor: adminActor,
        reason: 'Fee update with secondary approver',
        approvalEvidence: { approver: secondaryAdmin.id, reason: 'Approved by secondary maintainer' },
      });
      expect(validRes.success).toBe(true);
    });

    it('replays existing record on duplicate operationId (retry path)', async () => {
      const opId = 'op_retry_test';
      const first = await applyAdminConfigChange({
        db: mockDb,
        operationId: opId,
        settingKey: 'maintenance.global',
        proposedValue: true,
        actor: adminActor,
        reason: 'Enabling emergency maintenance mode',
      });

      const second = await applyAdminConfigChange({
        db: mockDb,
        operationId: opId,
        settingKey: 'maintenance.global',
        proposedValue: true,
        actor: adminActor,
        reason: 'Enabling emergency maintenance mode (retry)',
      });

      expect(second.idempotentReplay).toBe(true);
      expect(second.evidence.evidenceId).toBe(first.evidence.evidenceId);
    });
  });

  describe('Tamper-Evidence & Rollback Paths', () => {
    it('detects tampered payload and broken chains', async () => {
      const res = await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op_verify_test',
        settingKey: 'feature_flags.bulk_refunds',
        proposedValue: true,
        actor: adminActor,
        reason: 'Feature rollout',
      });

      const tampered = { ...res.evidence, after: false };
      expect(verifyConfigAuditEvidence(tampered).valid).toBe(false);
    });

    it('executes append-only rollback restoring prior state', async () => {
      const initial = await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op_before_rollback',
        settingKey: 'financial.payoutHoldPeriodHours',
        proposedValue: 24,
        actor: adminActor,
        reason: 'Shorten hold period',
      });

      const rollback = await rollbackConfigChange({
        db: mockDb,
        evidenceId: initial.evidence.evidenceId,
        actor: adminActor,
        reason: 'Reverting back to default 72h hold period due to audit recommendations',
      });

      expect(rollback.success).toBe(true);
      expect(rollback.config['financial.payoutHoldPeriodHours']).toBe(72);
      expect(rollback.rollbackEvidence.changeType).toBe(CONFIG_AUDIT_CHANGE_TYPES.ROLLBACK);

      const all = await evidenceCol.find({}).sort({ sequence: 1 }).toArray();
      expect(all).toHaveLength(2);
      expect(verifyConfigAuditChain(all).valid).toBe(true);
    });

    it('exports complete verifiable configuration bundle', async () => {
      await applyAdminConfigChange({
        db: mockDb,
        operationId: 'op_bundle',
        settingKey: 'feature_flags.learner_export',
        proposedValue: false,
        actor: adminActor,
        reason: 'Maintenance freeze on exports',
      });

      const bundle = await exportConfigAuditBundle({
        db: mockDb,
        requestedBy: adminActor,
      });

      expect(bundle.bundleType).toBe('administrative_configuration_audit_evidence');
      expect(bundle.chainVerification.valid).toBe(true);
      expect(bundle.entries).toHaveLength(1);
    });
  });
});
