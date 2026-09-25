import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '../route';

const { mockWithApiHardening } = vi.hoisted(() => ({ mockWithApiHardening: vi.fn() }));

vi.mock('@/lib/api/hardening', () => ({ withApiHardening: mockWithApiHardening }));
vi.mock('@/lib/api/audit', () => ({ auditLog: vi.fn() }));

describe('GET /api/subjects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithApiHardening.mockImplementation((req, opts, handler) => handler());
  });

  it('sets a public Cache-Control header for the full taxonomy response', async () => {
    const request = new Request('http://localhost:3000/api/subjects');
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=3600, stale-while-revalidate=86400'
    );
  });

  it('sets the same Cache-Control header when filtering by category', async () => {
    const request = new Request('http://localhost:3000/api/subjects?category=academic');
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=3600, stale-while-revalidate=86400'
    );
  });
});
