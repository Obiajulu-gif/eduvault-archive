import { describe, expect, it, vi } from 'vitest';
import {
  createWebhookSignatureHeader,
  sendWebhookWithRetry,
  verifyWebhookSignature,
} from './sender';

vi.mock('@/lib/mongodb', () => ({ getDb: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('creator webhook signatures', () => {
  it('computes and verifies an HMAC-SHA256 signature over timestamp and raw body', () => {
    const body = JSON.stringify({ event: 'purchase.completed', data: { id: 'mat-1' } });
    const header = createWebhookSignatureHeader(body, 'secret', 123456);

    expect(header).toMatch(/^t=123456,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(body, header, 'secret', { now: 123456 })).toBe(true);
  });

  it('rejects tampered payloads', () => {
    const body = JSON.stringify({ event: 'purchase.completed', amount: 10 });
    const header = createWebhookSignatureHeader(body, 'secret', 123456);

    expect(verifyWebhookSignature(JSON.stringify({ event: 'purchase.completed', amount: 99 }), header, 'secret', { now: 123456 })).toBe(false);
  });

  it('sends a signature header without logging the secret', async () => {
    const { logger } = await import('@/lib/logger');
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    // 1.1.1.1 is a public IP literal, so it passes SSRF validation without DNS.
    await sendWebhookWithRetry('https://1.1.1.1/webhook', { ok: true }, 1, { signingSecret: 'very-secret' });

    expect(fetch).toHaveBeenCalledWith(
      'https://1.1.1.1/webhook',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-EduVault-Signature': expect.stringMatching(/^t=\d+,v1=[0-9a-f]{64}$/),
        }),
      }),
    );
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toContain('very-secret');
  });

  it('rejects destinations blocked by the SSRF policy', async () => {
    const { logger } = await import('@/lib/logger');
    global.fetch = vi.fn();

    const result = await sendWebhookWithRetry('http://169.254.169.254/latest/meta-data', { ok: true }, 1);

    expect(result).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
