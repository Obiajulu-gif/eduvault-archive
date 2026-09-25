import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeWebhookUrl,
  isBlockedAddress,
  validateWebhookDestination,
  validateWebhookUrls,
  SsrfError,
} from './ssrfGuard';

describe('SSRF / DNS-rebinding guard (issue #634)', () => {
  it('accepts a public https URL and rejects credentials/ports', () => {
    expect(() => canonicalizeWebhookUrl('https://hooks.example.com/path')).not.toThrow();
    expect(() => canonicalizeWebhookUrl('http://user:pass@host.com')).toThrow(SsrfError);
    expect(() => canonicalizeWebhookUrl('ftp://host.com')).toThrow(SsrfError);
    expect(() => canonicalizeWebhookUrl('https://host.com:22/')).toThrow(SsrfError);
  });

  it('blocks loopback, link-local/metadata, and private IPv4 literals', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('10.0.0.5')).toBe(true);
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
    expect(isBlockedAddress('172.16.5.5')).toBe(true);
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('100.100.100.200')).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
  });

  it('blocks IPv4-mapped and IPv6 loopback forms', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('fc00::1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('rejects blocked hosts at validation time', async () => {
    await expect(validateWebhookDestination('http://127.0.0.1/')).rejects.toBeInstanceOf(SsrfError);
    await expect(validateWebhookDestination('http://169.254.169.254/')).rejects.toBeInstanceOf(SsrfError);
    await expect(validateWebhookDestination('https://8.8.8.8/')).resolves.toMatchObject({ protocol: 'https:' });
  });

  it('rejects duplicate or invalid url lists at registration', async () => {
    await expect(validateWebhookUrls(['https://8.8.8.8/a', 'https://8.8.8.8/a'])).rejects.toBeInstanceOf(SsrfError);
    await expect(validateWebhookUrls(['http://127.0.0.1/'])).rejects.toBeInstanceOf(SsrfError);
  });
});

// Provide a deterministic dns resolver for the host-based checks so the suite
// does not depend on the network.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockImplementation(async (host) => {
    if (host === 'localhost') return [{ address: '127.0.0.1', family: 4 }];
    if (host === 'metadata.internal') return [{ address: '169.254.169.254', family: 4 }];
    return [{ address: '93.184.216.34', family: 4 }];
  }),
}));

describe('SSRF guard with resolved hosts', () => {
  it('blocks hosts that resolve to private addresses', async () => {
    await expect(validateWebhookDestination('https://metadata.internal/x')).rejects.toBeInstanceOf(SsrfError);
  });

  it('allows hosts that resolve to public addresses', async () => {
    await expect(validateWebhookDestination('https://public.example/x')).resolves.toMatchObject({
      hostname: 'public.example',
    });
  });
});
