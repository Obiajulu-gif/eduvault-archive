import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractCorrelationId,
  getCurrentCorrelationId,
  runWithCorrelationId,
  buildPropagationHeaders,
  createCorrelatedFetch,
  withCorrelation,
  retryWithCorrelation,
  CORRELATION_HEADER,
} from './correlationPropagation.js';

function makeRequest(headers = {}) {
  return { headers: { get: (k) => headers[k] ?? null } };
}

describe('extractCorrelationId', () => {
  it('returns id from x-correlation-id header', () => {
    const req = makeRequest({ 'x-correlation-id': 'test-id-123' });
    expect(extractCorrelationId(req)).toBe('test-id-123');
  });

  it('falls back to x-request-id', () => {
    const req = makeRequest({ 'x-request-id': 'req-456' });
    expect(extractCorrelationId(req)).toBe('req-456');
  });

  it('generates a UUID when no header present', () => {
    const req = makeRequest({});
    const id = extractCorrelationId(req);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects oversized header values', () => {
    const req = makeRequest({ 'x-correlation-id': 'a'.repeat(65) });
    const id = extractCorrelationId(req);
    // Should have generated a new UUID instead
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects unsafe characters', () => {
    const req = makeRequest({ 'x-correlation-id': '<script>alert(1)</script>' });
    const id = extractCorrelationId(req);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('handles plain object headers', () => {
    const id = extractCorrelationId({ 'x-correlation-id': 'flat-123' });
    expect(id).toBe('flat-123');
  });

  it('handles null input', () => {
    expect(extractCorrelationId(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('AsyncLocalStorage context', () => {
  it('getCurrentCorrelationId returns null outside context', () => {
    expect(getCurrentCorrelationId()).toBeNull();
  });

  it('runWithCorrelationId makes id available inside context', async () => {
    let captured;
    await runWithCorrelationId('ctx-abc', async () => {
      captured = getCurrentCorrelationId();
    });
    expect(captured).toBe('ctx-abc');
  });

  it('context does not bleed out after run', async () => {
    await runWithCorrelationId('inside', async () => {});
    expect(getCurrentCorrelationId()).toBeNull();
  });

  it('nested contexts use innermost id', async () => {
    let inner;
    await runWithCorrelationId('outer', async () => {
      await runWithCorrelationId('inner', async () => {
        inner = getCurrentCorrelationId();
      });
    });
    expect(inner).toBe('inner');
  });
});

describe('buildPropagationHeaders', () => {
  it('uses provided correlationId', () => {
    const headers = buildPropagationHeaders({ correlationId: 'explicit-id', attempt: 2 });
    expect(headers[CORRELATION_HEADER]).toBe('explicit-id');
    expect(headers['x-attempt']).toBe('2');
  });

  it('uses context store id when correlationId omitted', async () => {
    let headers;
    await runWithCorrelationId('ctx-id', async () => {
      headers = buildPropagationHeaders({ attempt: 1 });
    });
    expect(headers[CORRELATION_HEADER]).toBe('ctx-id');
  });

  it('merges extra headers', () => {
    const h = buildPropagationHeaders({ correlationId: 'x', extra: { 'x-custom': 'val' } });
    expect(h['x-custom']).toBe('val');
  });

  it('defaults attempt to 1', () => {
    const h = buildPropagationHeaders({ correlationId: 'y' });
    expect(h['x-attempt']).toBe('1');
  });
});

describe('createCorrelatedFetch', () => {
  it('injects correlation header when in context', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const cfetch = createCorrelatedFetch(mockFetch);

    await runWithCorrelationId('fetch-id', async () => {
      await cfetch('https://example.com/api');
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers[CORRELATION_HEADER]).toBe('fetch-id');
  });

  it('passes through without header when no context', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const cfetch = createCorrelatedFetch(mockFetch);
    await cfetch('https://example.com/api');
    // Should have been called without injecting
    expect(mockFetch).toHaveBeenCalledWith('https://example.com/api', {});
  });

  it('does not overwrite caller-supplied correlation header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const cfetch = createCorrelatedFetch(mockFetch);

    await runWithCorrelationId('ctx-id', async () => {
      await cfetch('https://example.com', { headers: { [CORRELATION_HEADER]: 'caller-id' } });
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers[CORRELATION_HEADER]).toBe('caller-id');
  });
});

describe('withCorrelation', () => {
  it('stamps correlation id on successful response', async () => {
    const handler = vi.fn().mockImplementation((_req, correlationId) =>
      new Response(JSON.stringify({ correlationId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const wrapped = withCorrelation(handler);
    const req = new Request('https://example.com', {
      headers: { [CORRELATION_HEADER]: 'route-test' },
    });
    const resp = await wrapped(req);

    expect(resp.headers.get(CORRELATION_HEADER)).toBe('route-test');
    expect(handler).toHaveBeenCalledWith(req, 'route-test');
  });

  it('stamps correlation id on error response when handler throws', async () => {
    const handler = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 503 }));
    const wrapped = withCorrelation(handler);
    const req = new Request('https://example.com', {
      headers: { [CORRELATION_HEADER]: 'err-id' },
    });

    const resp = await wrapped(req);
    expect(resp.status).toBe(503);
    expect(resp.headers.get(CORRELATION_HEADER)).toBe('err-id');
    const body = await resp.json();
    expect(body.correlationId).toBe('err-id');
    expect(body.success).toBe(false);
  });

  it('generates id when request carries none', async () => {
    const handler = vi.fn().mockImplementation((_req, cid) =>
      new Response(JSON.stringify({ cid }), { status: 200 })
    );
    const wrapped = withCorrelation(handler);
    const req = new Request('https://example.com');
    const resp = await wrapped(req);
    expect(resp.headers.get(CORRELATION_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('retryWithCorrelation', () => {
  it('succeeds on first try', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryWithCorrelation(fn, { maxAttempts: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and passes attempt number', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('recovered');

    const result = await retryWithCorrelation(fn, { maxAttempts: 3 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1][0]).toBe(2); // attempt=2
  });

  it('propagates same correlationId across retries', async () => {
    const ids = [];
    const fn = vi
      .fn()
      .mockImplementationOnce((_attempt, headers) => {
        ids.push(headers[CORRELATION_HEADER]);
        throw new Error('fail');
      })
      .mockImplementationOnce((_attempt, headers) => {
        ids.push(headers[CORRELATION_HEADER]);
        return 'ok';
      });

    await runWithCorrelationId('retry-ctx', async () => {
      await retryWithCorrelation(fn, { maxAttempts: 3 });
    });

    expect(ids[0]).toBe('retry-ctx');
    expect(ids[1]).toBe('retry-ctx');
  });

  it('throws after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(retryWithCorrelation(fn, { maxAttempts: 2 })).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stops retrying when isRetryable returns false', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('auth'), { status: 401 }));
    const isRetryable = (err) => err.status !== 401;

    await expect(
      retryWithCorrelation(fn, { maxAttempts: 3, isRetryable })
    ).rejects.toThrow('auth');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
