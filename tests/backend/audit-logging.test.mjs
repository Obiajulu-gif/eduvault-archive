import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { auditLog } from '../../src/lib/api/audit.js';

describe('Audit Logging - Redaction and Reason Codes', () => {
  test('redacts bearer tokens', () => {
    let output = '';
    const originalConsoleInfo = console.info;
    console.info = (msg) => { output = msg; };

    try {
      auditLog({
        event: 'download_granted',
        reason: 'support',
        actor: 'user-123 bearer abcdef1234567890',
        material: 'My file with bearer token123 in name'
      });

      const logEntry = JSON.parse(output);
      assert.ok(logEntry.actor.includes('bearer ***'));
      assert.ok(!logEntry.actor.includes('abcdef1234567890'));
      assert.equal(logEntry.reason, 'support');
      assert.ok(logEntry.material.includes('bearer ***'));
    } finally {
      console.info = originalConsoleInfo;
    }
  });

  test('redacts standard token query params', () => {
    let output = '';
    const originalConsoleInfo = console.info;
    console.info = (msg) => { output = msg; };

    try {
      auditLog({
        event: 'download_access_denied',
        reason: 'admin_review',
        actor: 'user-456',
        material: 'File with token=supersecretkey in name'
      });

      const logEntry = JSON.parse(output);
      assert.ok(logEntry.material.includes('token=***'));
      assert.ok(!logEntry.material.includes('supersecretkey'));
      assert.equal(logEntry.reason, 'admin_review');
    } finally {
      console.info = originalConsoleInfo;
    }
  });

  test('redacts URLs', () => {
    let output = '';
    const originalConsoleInfo = console.info;
    console.info = (msg) => { output = msg; };

    try {
      auditLog({
        event: 'download_granted',
        reason: 'buyer_download',
        actor: 'user-789',
        material: 'File from https://secret-domain.com/path'
      });

      const logEntry = JSON.parse(output);
      assert.ok(logEntry.material.includes('***'));
      assert.ok(!logEntry.material.includes('https://secret-domain.com/path'));
      assert.equal(logEntry.reason, 'buyer_download');
    } finally {
      console.info = originalConsoleInfo;
    }
  });
  
  test('keeps non-sensitive values intact', () => {
    let output = '';
    const originalConsoleInfo = console.info;
    console.info = (msg) => { output = msg; };

    try {
      auditLog({
        event: 'download_granted',
        reason: 'preview',
        actor: 'user-123',
        role: 'admin',
        material: 'Clean Material Name',
        version: '1.0',
        purchase: 'purch-123'
      });

      const logEntry = JSON.parse(output);
      assert.equal(logEntry.event, 'download_granted');
      assert.equal(logEntry.reason, 'preview');
      assert.equal(logEntry.actor, 'user-123');
      assert.equal(logEntry.role, 'admin');
      assert.equal(logEntry.material, 'Clean Material Name');
      assert.equal(logEntry.version, '1.0');
      assert.equal(logEntry.purchase, 'purch-123');
    } finally {
      console.info = originalConsoleInfo;
    }
  });
});
