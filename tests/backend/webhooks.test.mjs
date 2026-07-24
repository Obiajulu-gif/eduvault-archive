import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isPrivateIP, dispatchWebhook } from '../../src/lib/webhooks/dispatcher.js';
import { generateSignature, generateSignaturesHeader, verifySignature } from '../../src/lib/webhooks/signature.js';

describe('Webhooks SSRF Protection', () => {
  test('isPrivateIP identifies private ranges', () => {
    assert.strictEqual(isPrivateIP('127.0.0.1'), true);
    assert.strictEqual(isPrivateIP('10.5.0.1'), true);
    assert.strictEqual(isPrivateIP('172.16.0.0'), true);
    assert.strictEqual(isPrivateIP('192.168.1.1'), true);
    assert.strictEqual(isPrivateIP('169.254.169.254'), true);
    assert.strictEqual(isPrivateIP('::1'), true);
    assert.strictEqual(isPrivateIP('fe80::1'), true);
    assert.strictEqual(isPrivateIP('::ffff:127.0.0.1'), true);

    assert.strictEqual(isPrivateIP('8.8.8.8'), false);
    assert.strictEqual(isPrivateIP('1.1.1.1'), false);
    assert.strictEqual(isPrivateIP('2001:4860:4860::8888'), false);
  });

  test('dispatchWebhook rejects insecure connections', async () => {
    await assert.rejects(
      () => dispatchWebhook('http://example.com', '{}', 'sig'),
      { message: 'Only HTTPS is allowed' }
    );
  });

  test('dispatchWebhook rejects credentials', async () => {
    await assert.rejects(
      () => dispatchWebhook('https://user:pass@example.com', '{}', 'sig'),
      { message: 'URL credentials are not allowed' }
    );
  });

  test('dispatchWebhook rejects unsafe ports', async () => {
    await assert.rejects(
      () => dispatchWebhook('https://example.com:22', '{}', 'sig'),
      { message: 'Unsafe port' }
    );
  });

  test('dispatchWebhook rejects private IPs', async () => {
    // Requires ALLOW_LOCAL_WEBHOOKS to not be set to true
    process.env.ALLOW_LOCAL_WEBHOOKS = '';
    process.env.NODE_ENV = 'production';
    
    // Test a domain that resolves to localhost (e.g., localhost or localtest.me)
    await assert.rejects(
      () => dispatchWebhook('https://localhost', '{}', 'sig'),
      /SSRF Prevention: Cannot connect to private\/reserved IP/
    );

    process.env.NODE_ENV = 'test'; // Restore
  });
});

describe('Webhooks Signature', () => {
  test('verifySignature succeeds for valid signature', () => {
    const payload = '{"test": true}';
    const secret = 'my-secret-key';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sig = generateSignature(payload, secret, timestamp);
    const header = `t=${timestamp},${sig}`;

    assert.strictEqual(verifySignature(payload, header, secret), true);
  });

  test('verifySignature fails for invalid payload', () => {
    const payload = '{"test": true}';
    const secret = 'my-secret-key';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sig = generateSignature(payload, secret, timestamp);
    const header = `t=${timestamp},${sig}`;

    assert.strictEqual(verifySignature('{"test": false}', header, secret), false);
  });

  test('verifySignature fails for invalid secret', () => {
    const payload = '{"test": true}';
    const secret = 'my-secret-key';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sig = generateSignature(payload, secret, timestamp);
    const header = `t=${timestamp},${sig}`;

    assert.strictEqual(verifySignature(payload, header, 'wrong-secret'), false);
  });

  test('verifySignature fails for expired timestamp (replay)', () => {
    const payload = '{"test": true}';
    const secret = 'my-secret-key';
    const timestamp = (Math.floor(Date.now() / 1000) - 10 * 60).toString(); // 10 minutes ago
    const sig = generateSignature(payload, secret, timestamp);
    const header = `t=${timestamp},${sig}`;

    assert.strictEqual(verifySignature(payload, header, secret), false);
  });

  test('generateSignaturesHeader supports overlapping keys', () => {
    const payload = '{"test": true}';
    const secrets = [
      { key: 'old-secret' },
      { key: 'new-secret' }
    ];

    const header = generateSignaturesHeader(payload, secrets);

    // Should verify successfully with either secret
    assert.strictEqual(verifySignature(payload, header, 'old-secret'), true);
    assert.strictEqual(verifySignature(payload, header, 'new-secret'), true);
    assert.strictEqual(verifySignature(payload, header, 'wrong-secret'), false);
  });
});
