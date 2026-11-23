import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from '../route.js';
import { POST as ROLLBACK_POST } from '../rollback/route.js';
import { GET as EVIDENCE_GET } from '../evidence/route.js';

const mocks = vi.hoisted(() => {
  const mockDbInstance = {
    collection: vi.fn().mockReturnValue({
      find: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
          toArray: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  };

  return {
    mockRequireAdmin: vi.fn(),
    mockApplyAdminConfigChange: vi.fn(),
    mockRollbackConfigChange: vi.fn(),
    mockExportConfigAuditBundle: vi.fn(),
    mockVerifyConfigAuditChain: vi.fn(),
    mockDb: mockDbInstance,
  };
});

vi.mock('@/lib/api/auth', () => ({
  requireAdmin: (req) => mocks.mockRequireAdmin(req),
}));

vi.mock('@/lib/config/adminConfigAudit', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    applyAdminConfigChange: (params) => mocks.mockApplyAdminConfigChange(params),
    rollbackConfigChange: (params) => mocks.mockRollbackConfigChange(params),
    exportConfigAuditBundle: (params) => mocks.mockExportConfigAuditBundle(params),
    verifyConfigAuditChain: (records) => mocks.mockVerifyConfigAuditChain(records),
  };
});

vi.mock('@/lib/mongodb', () => ({
  getDb: vi.fn().mockResolvedValue(mocks.mockDb),
}));

describe('Admin Config API Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/admin/config', () => {
    it('returns 403 when user is not admin', async () => {
      mocks.mockRequireAdmin.mockResolvedValue(null);
      const req = new Request('http://localhost:3000/api/admin/config');
      const res = await GET(req);
      expect(res.status).toBe(403);
    });

    it('returns config and chain verification when admin', async () => {
      mocks.mockRequireAdmin.mockResolvedValue({ id: 'admin_1', role: 'admin' });
      mocks.mockVerifyConfigAuditChain.mockReturnValue({ valid: true, recordsCount: 0 });

      const req = new Request('http://localhost:3000/api/admin/config');
      const res = await GET(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.registeredSettings).toBeDefined();
      expect(json.chainVerification.valid).toBe(true);
    });
  });

  describe('POST /api/admin/config', () => {
    it('returns 403 when user is not admin', async () => {
      mocks.mockRequireAdmin.mockResolvedValue(null);
      const req = new Request('http://localhost:3000/api/admin/config', {
        method: 'POST',
        body: JSON.stringify({ settingKey: 'maintenance.global', value: true }),
      });
      const res = await POST(req);
      expect(res.status).toBe(403);
    });

    it('delegates to applyAdminConfigChange and returns 200 on success', async () => {
      mocks.mockRequireAdmin.mockResolvedValue({ id: 'admin_1', role: 'admin' });
      mocks.mockApplyAdminConfigChange.mockResolvedValue({
        success: true,
        evidence: { evidenceId: 'ev_123', recordHash: 'hash_abc' },
        config: { 'maintenance.global': true },
      });

      const req = new Request('http://localhost:3000/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-idempotency-key': 'idem-key-1' },
        body: JSON.stringify({
          settingKey: 'maintenance.global',
          value: true,
          reason: 'Scheduled platform maintenance window',
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.evidence.evidenceId).toBe('ev_123');
      expect(mocks.mockApplyAdminConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({
          settingKey: 'maintenance.global',
          proposedValue: true,
          operationId: 'idem-key-1',
        })
      );
    });
  });

  describe('POST /api/admin/config/rollback', () => {
    it('returns 403 when user is not admin', async () => {
      mocks.mockRequireAdmin.mockResolvedValue(null);
      const req = new Request('http://localhost:3000/api/admin/config/rollback', {
        method: 'POST',
        body: JSON.stringify({ evidenceId: 'ev_123', reason: 'Revert test' }),
      });
      const res = await ROLLBACK_POST(req);
      expect(res.status).toBe(403);
    });

    it('executes rollback and returns 200 on success', async () => {
      mocks.mockRequireAdmin.mockResolvedValue({ id: 'admin_1', role: 'admin' });
      mocks.mockRollbackConfigChange.mockResolvedValue({
        success: true,
        rollbackEvidence: { evidenceId: 'ev_rollback_1' },
        config: { 'marketplace.platformFeeBps': 250 },
      });

      const req = new Request('http://localhost:3000/api/admin/config/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evidenceId: 'ev_123',
          reason: 'Emergency fee revert following community consensus',
        }),
      });

      const res = await ROLLBACK_POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.rollbackEvidence.evidenceId).toBe('ev_rollback_1');
    });
  });

  describe('GET /api/admin/config/evidence', () => {
    it('returns 403 when user is not admin', async () => {
      mocks.mockRequireAdmin.mockResolvedValue(null);
      const req = new Request('http://localhost:3000/api/admin/config/evidence');
      const res = await EVIDENCE_GET(req);
      expect(res.status).toBe(403);
    });

    it('returns exported bundle with 200 when admin', async () => {
      mocks.mockRequireAdmin.mockResolvedValue({ id: 'admin_1', role: 'admin' });
      mocks.mockExportConfigAuditBundle.mockResolvedValue({
        bundleType: 'administrative_configuration_audit_evidence',
        totalEntries: 5,
        chainVerification: { valid: true },
        entries: [],
      });

      const req = new Request('http://localhost:3000/api/admin/config/evidence?category=marketplace');
      const res = await EVIDENCE_GET(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.bundleType).toBe('administrative_configuration_audit_evidence');
      expect(mocks.mockExportConfigAuditBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({ category: 'marketplace' }),
        })
      );
    });
  });
});
