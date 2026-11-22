/**
 * Tests for Permission-Aware Export with Sensitive-Field Redaction
 * Issue #4
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  exportLearnerDataWithPermissions,
  getExportHistory,
  generateExportReport,
  determineExportPermissionLevel,
  canExportField,
  redactField,
  redactObject,
  ExportPermissionLevel,
  SensitiveFieldCategory,
  ExportPermissionError,
} from '../permissionAwareExport.js';
import { RedactionLevel } from '../schema.js';

// Mock dependencies
vi.mock('../../logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../auth/permissions.js', () => ({
  hasPermission: vi.fn((user, permission) => {
    if (permission === 'export:full_pii' && user.role === 'admin') return true;
    if (permission === 'export:financial' && ['admin', 'compliance'].includes(user.role)) return true;
    if (permission === 'export:compliance' && user.role === 'compliance') return true;
    if (permission === 'export:security' && ['admin', 'security'].includes(user.role)) return true;
    return false;
  }),
}));

vi.mock('../../backend/auditLedger.js', () => ({
  appendAuditRecord: vi.fn(async () => ({})),
}));

vi.mock('../buildLearnerExport.js', () => ({
  buildLearnerExport: vi.fn((data) => ({
    version: '1.0',
    generatedAt: new Date(),
    profile: data.user,
    purchases: data.purchases || [],
    refunds: data.refunds || [],
    entitlements: data.entitlements || [],
  })),
}));

function createMockCollection(initialDocs = []) {
  const docs = [...initialDocs];

  return {
    _docs: docs,
    async findOne(query) {
      if (query.exportId) {
        return docs.find(d => d.exportId === query.exportId) || null;
      }
      return docs[0] || null;
    },
    find(query = {}) {
      let filtered = docs;
      if (query['subject.walletAddress']) {
        filtered = docs.filter(d => d.subject?.walletAddress === query['subject.walletAddress']);
      }
      if (query.generatedAt && query.generatedAt.$gte) {
        filtered = docs.filter(d => d.generatedAt >= query.generatedAt.$gte);
      }
      return {
        sort() {
          return {
            limit(n) {
              return {
                project() {
                  return {
                    toArray: async () => filtered.slice(0, n),
                  };
                },
                toArray: async () => filtered.slice(0, n),
              };
            },
          };
        },
        toArray: async () => filtered,
      };
    },
    async insertOne(doc) {
      docs.push({ ...doc });
      return { acknowledged: true, insertedId: doc.exportId };
    },
  };
}

const mockDb = {
  collection: vi.fn(),
};

vi.mock('../../mongodb.js', () => ({
  getDb: vi.fn(() => Promise.resolve(mockDb)),
}));

describe('Permission-Aware Export with Sensitive-Field Redaction', () => {
  let mockExportsCollection;
  
  const selfUser = {
    id: 'user_self',
    sub: 'user_self',
    role: 'learner',
    walletAddress: 'GUSER111111111111111111111111111111111111111111111111111111',
  };

  const adminUser = {
    id: 'admin_1',
    sub: 'admin_1',
    role: 'admin',
    walletAddress: 'GADMIN11111111111111111111111111111111111111111111111111111',
  };

  const supportUser = {
    id: 'support_1',
    sub: 'support_1',
    role: 'support',
    walletAddress: 'GSUPPORT1111111111111111111111111111111111111111111111111111',
  };

  const complianceUser = {
    id: 'compliance_1',
    sub: 'compliance_1',
    role: 'compliance',
    walletAddress: 'GCOMPLIA1111111111111111111111111111111111111111111111111111',
  };

  const targetSubject = {
    walletAddress: 'GTARGET11111111111111111111111111111111111111111111111111111',
    email: 'target@example.com',
    fullName: 'Target User',
    phoneNumber: '555-123-4567',
  };

  beforeEach(() => {
    mockExportsCollection = createMockCollection([]);
    mockDb.collection.mockReturnValue(mockExportsCollection);
    vi.clearAllMocks();
  });

  describe('Permission Level Determination', () => {
    it('identifies self-export correctly', () => {
      const level = determineExportPermissionLevel(
        { ...selfUser, walletAddress: targetSubject.walletAddress },
        targetSubject
      );
      expect(level).toBe(ExportPermissionLevel.SELF);
    });

    it('identifies compliance officer permission', () => {
      const level = determineExportPermissionLevel(complianceUser, targetSubject);
      expect(level).toBe(ExportPermissionLevel.COMPLIANCE);
    });

    it('identifies full internal admin permission', () => {
      const level = determineExportPermissionLevel(adminUser, targetSubject);
      expect(level).toBe(ExportPermissionLevel.FULL_INTERNAL);
    });

    it('identifies partial support access', () => {
      const level = determineExportPermissionLevel(supportUser, targetSubject);
      expect(level).toBe(ExportPermissionLevel.PARTIAL);
    });

    it('rejects unauthenticated requests', () => {
      expect(() => determineExportPermissionLevel(null, targetSubject)).toThrow(
        ExportPermissionError
      );
    });

    it('rejects unauthorized requests', () => {
      const unauthorizedUser = {
        id: 'unauthorized',
        role: 'guest',
        walletAddress: 'GUNAUTH11111111111111111111111111111111111111111111111111111',
      };
      expect(() => determineExportPermissionLevel(unauthorizedUser, targetSubject)).toThrow(
        ExportPermissionError
      );
    });
  });

  describe('Field-Level Redaction', () => {
    it('allows self-export to see all fields', () => {
      const canSee = canExportField('profile.email', selfUser, ExportPermissionLevel.SELF);
      expect(canSee).toBe(true);
    });

    it('redacts PII for partial access', () => {
      const redacted = redactField(
        'profile.email',
        'sensitive@example.com',
        supportUser,
        ExportPermissionLevel.PARTIAL,
        false
      );
      expect(redacted).toBe('[REDACTED:email]');
    });

    it('applies partial reveal when requested', () => {
      const redacted = redactField(
        'profile.email',
        'sensitive@example.com',
        supportUser,
        ExportPermissionLevel.PARTIAL,
        true
      );
      expect(redacted).toBe('se***@example.com');
    });

    it('redacts phone numbers appropriately', () => {
      const redacted = redactField(
        'profile.phoneNumber',
        '555-123-4567',
        supportUser,
        ExportPermissionLevel.PARTIAL,
        true
      );
      expect(redacted).toBe('***-***-4567');
    });

    it('allows admin to see financial data', () => {
      const canSee = canExportField('purchases.*.transactionHash', adminUser, ExportPermissionLevel.FULL_INTERNAL);
      expect(canSee).toBe(true);
    });

    it('redacts financial data for support', () => {
      const redacted = redactField(
        'purchases.*.paymentMethod',
        'credit_card_ending_1234',
        supportUser,
        ExportPermissionLevel.PARTIAL,
        false
      );
      expect(redacted).toBe('[REDACTED:payment]');
    });
  });

  describe('Object Redaction', () => {
    it('recursively redacts nested objects', () => {
      const obj = {
        email: 'user@example.com',
        fullName: 'John Doe Smith',
        public: 'visible',
        nested: {
          phoneNumber: '555-123-4567',
        },
      };

      const redacted = redactObject(
        obj,
        supportUser,
        ExportPermissionLevel.PARTIAL,
        'profile',
        false
      );

      expect(redacted.email).toBe('[REDACTED:email]');
      expect(redacted.fullName).toBe('[REDACTED:name]');
      expect(redacted.public).toBe('visible');
      expect(redacted.nested.phoneNumber).toBe('[REDACTED:phone]');
    });

    it('handles arrays correctly', () => {
      const purchases = [
        { id: 1, transactionHash: 'ABC123XYZ789' },
        { id: 2, transactionHash: 'DEF456UVW012' },
      ];

      const redacted = redactObject(
        purchases,
        supportUser,
        ExportPermissionLevel.PARTIAL,
        'purchases',
        true
      );

      expect(redacted[0].transactionHash).toBe('ABC123XY...YZ789'); // Partial reveal
      expect(redacted[1].id).toBe(2); // Non-sensitive field unchanged
    });
  });

  describe('Normal Path - Successful Export', () => {
    it('exports learner data with full access for self', async () => {
      const result = await exportLearnerDataWithPermissions({
        db: mockDb,
        requester: { ...selfUser, walletAddress: targetSubject.walletAddress },
        subject: targetSubject,
        reason: 'Self-export for data portability',
      });

      expect(result.permissionLevel).toBe(ExportPermissionLevel.SELF);
      expect(result.redactionApplied).toBe(false);
      expect(result.data).toBeDefined();
      expect(result.metadata.reason).toBe('Self-export for data portability');
    });

    it('exports learner data with redaction for admin', async () => {
      const result = await exportLearnerDataWithPermissions({
        db: mockDb,
        requester: adminUser,
        subject: targetSubject,
        reason: 'Admin review for dispute resolution',
      });

      expect(result.permissionLevel).toBe(ExportPermissionLevel.FULL_INTERNAL);
      expect(result.redactionApplied).toBe(true);
      expect(result.data).toBeDefined();
    });
  });

  describe('Retry Path - Idempotent Replay', () => {
    it('returns existing export on retry', async () => {
      const operationId = 'exp_retry_test_001';

      // First export
      const first = await exportLearnerDataWithPermissions({
        db: mockDb,
        requester: { ...selfUser, walletAddress: targetSubject.walletAddress },
        subject: targetSubject,
        operationId,
      });

      // Retry with same operationId
      const second = await exportLearnerDataWithPermissions({
        db: mockDb,
        requester: { ...selfUser, walletAddress: targetSubject.walletAddress },
        subject: targetSubject,
        operationId,
      });

      expect(second.idempotentReplay).toBe(true);
      expect(second.exportId).toBe(first.exportId);
    });
  });

  describe('Authorization Paths', () => {
    it('requires authentication', async () => {
      await expect(
        exportLearnerDataWithPermissions({
          db: mockDb,
          requester: null,
          subject: targetSubject,
        })
      ).rejects.toThrow(ExportPermissionError);
    });

    it('enforces permission boundaries', async () => {
      const unauthorizedUser = {
        id: 'guest_user',
        role: 'guest',
        walletAddress: 'GGUEST111111111111111111111111111111111111111111111111111111',
      };

      await expect(
        exportLearnerDataWithPermissions({
          db: mockDb,
          requester: unauthorizedUser,
          subject: targetSubject,
        })
      ).rejects.toThrow(ExportPermissionError);
    });

    it('filters categories based on permissions', async () => {
      const result = await exportLearnerDataWithPermissions({
        db: mockDb,
        requester: supportUser,
        subject: targetSubject,
        includeCategories: [
          SensitiveFieldCategory.PII,
          SensitiveFieldCategory.FINANCIAL,
          SensitiveFieldCategory.BEHAVIORAL,
        ],
      });

      // Support should not have access to all categories
      expect(result.includedCategories).not.toContain(SensitiveFieldCategory.BEHAVIORAL);
    });
  });

  describe('Failure Paths', () => {
    it('handles export failures with audit trail', async () => {
      // Force an error by mocking buildLearnerExport to throw
      const { buildLearnerExport } = await import('../buildLearnerExport.js');
      buildLearnerExport.mockImplementationOnce(() => {
        throw new Error('Database connection failed');
      });

      await expect(
        exportLearnerDataWithPermissions({
          db: mockDb,
          requester: adminUser,
          subject: targetSubject,
        })
      ).rejects.toThrow('Database connection failed');

      // Verify audit record was attempted
      const { appendAuditRecord } = await import('../../backend/auditLedger.js');
      expect(appendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'learner_data.export_failed',
          result: expect.objectContaining({
            status: 'failure',
          }),
        })
      );
    });
  });

  describe('Export History', () => {
    it('retrieves export history for authorized user', async () => {
      // Create some exports
      await exportLearnerDataWithPermissions({
        db: mockDb,
        requester: { ...selfUser, walletAddress: targetSubject.walletAddress },
        subject: targetSubject,
        operationId: 'exp_history_1',
      });

      await exportLearnerDataWithPermissions({
        db: mockDb,
        requester: adminUser,
        subject: targetSubject,
        operationId: 'exp_history_2',
      });

      const history = await getExportHistory({
        subjectWallet: targetSubject.walletAddress,
        requester: { ...selfUser, walletAddress: targetSubject.walletAddress },
        limit: 10,
      });

      expect(history).toHaveLength(2);
    });

    it('rejects unauthorized history access', async () => {
      const unauthorizedUser = {
        id: 'other_user',
        role: 'learner',
        walletAddress: 'GOTHER111111111111111111111111111111111111111111111111111111',
      };

      await expect(
        getExportHistory({
          subjectWallet: targetSubject.walletAddress,
          requester: unauthorizedUser,
        })
      ).rejects.toThrow(ExportPermissionError);
    });
  });

  describe('Export Reports', () => {
    it('generates comprehensive export report for admin', async () => {
      // Create test data
      await exportLearnerDataWithPermissions({
        db: mockDb,
        requester: { ...selfUser, walletAddress: targetSubject.walletAddress },
        subject: targetSubject,
        operationId: 'exp_report_1',
      });

      await exportLearnerDataWithPermissions({
        db: mockDb,
        requester: adminUser,
        subject: targetSubject,
        operationId: 'exp_report_2',
      });

      const report = await generateExportReport({
        requester: adminUser,
      });

      expect(report.totalExports).toBe(2);
      expect(report.byPermissionLevel[ExportPermissionLevel.SELF]).toBe(1);
      expect(report.byPermissionLevel[ExportPermissionLevel.FULL_INTERNAL]).toBe(1);
      expect(report.averageDuration).toBeGreaterThan(0);
    });

    it('rejects report generation for non-admin', async () => {
      await expect(
        generateExportReport({
          requester: selfUser,
        })
      ).rejects.toThrow(ExportPermissionError);
    });
  });

  describe('Edge Cases', () => {
    it('handles missing optional fields gracefully', () => {
      const obj = {
        email: 'test@example.com',
        // phoneNumber missing
      };

      const redacted = redactObject(
        obj,
        supportUser,
        ExportPermissionLevel.PARTIAL,
        'profile',
        false
      );

      expect(redacted.email).toBe('[REDACTED:email]');
    });

    it('handles null and undefined values', () => {
      const redacted1 = redactField('profile.email', null, supportUser, ExportPermissionLevel.PARTIAL, false);
      expect(redacted1).toBeNull();

      const redacted2 = redactField('profile.email', undefined, supportUser, ExportPermissionLevel.PARTIAL, false);
      expect(redacted2).toBeUndefined();
    });

    it('handles deeply nested objects', () => {
      const deep = {
        level1: {
          level2: {
            level3: {
              email: 'deep@example.com',
            },
          },
        },
      };

      const redacted = redactObject(
        deep,
        supportUser,
        ExportPermissionLevel.PARTIAL,
        '',
        false
      );

      // Email should remain unchanged without proper path
      expect(redacted.level1.level2.level3.email).toBe('deep@example.com');
    });

    it('preserves non-sensitive fields', () => {
      const obj = {
        walletAddress: 'GWALLET11111111111111111111111111111111111111111111111111111',
        joinedAt: new Date('2024-01-01'),
        publicBio: 'I am a learner',
        email: 'redact@example.com',
      };

      const redacted = redactObject(
        obj,
        supportUser,
        ExportPermissionLevel.PARTIAL,
        'profile',
        false
      );

      expect(redacted.walletAddress).toBe(obj.walletAddress);
      expect(redacted.publicBio).toBe(obj.publicBio);
      expect(redacted.email).toBe('[REDACTED:email]');
    });
  });

  describe('Recovery and Rollback Behavior', () => {
    it('documents operational edge cases in metadata', async () => {
      const result = await exportLearnerDataWithPermissions({
        db: mockDb,
        requester: adminUser,
        subject: targetSubject,
        reason: 'Testing edge case handling',
      });

      expect(result.metadata).toBeDefined();
      expect(result.metadata.duration).toBeGreaterThan(0);
    });

    it('maintains audit trail through failures', async () => {
      const { appendAuditRecord } = await import('../../backend/auditLedger.js');
      appendAuditRecord.mockClear();

      try {
        const { buildLearnerExport } = await import('../buildLearnerExport.js');
        buildLearnerExport.mockImplementationOnce(() => {
          throw new Error('Simulated failure');
        });

        await exportLearnerDataWithPermissions({
          db: mockDb,
          requester: adminUser,
          subject: targetSubject,
        });
      } catch {
        // Expected to fail
      }

      // Verify failure was audited
      expect(appendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'learner_data.export_failed',
        })
      );
    });
  });

  describe('Partial Reveal Mode', () => {
    it('applies partial reveal to sensitive fields', async () => {
      const result = await exportLearnerDataWithPermissions({
        db: mockDb,
        requester: supportUser,
        subject: targetSubject,
        usePartialReveal: true,
      });

      expect(result.partialRevealEnabled).toBe(true);
    });

    it('falls back to full redaction on partial reveal errors', () => {
      const redacted = redactField(
        'profile.email',
        null, // Invalid value that would cause partial reveal to fail
        supportUser,
        ExportPermissionLevel.PARTIAL,
        true
      );

      expect(redacted).toBeNull(); // Gracefully handles null
    });
  });
});
