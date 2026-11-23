/**
 * High-cardinality log protection (#883).
 *
 * Covers field classification, the unsafe-log examples the logger hook must
 * neutralize, pseudonym stability, the real pino wiring, and the lint rule
 * that keeps values out of log messages across src/ and scripts/.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, after } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import pino from 'pino';
import { Linter } from 'eslint';

import {
  LOG_FIELD_CLASSES,
  classifyLogField,
  createLogSafetyOptions,
  maskIdentifiersInText,
  protectLogArguments,
  protectLogFields,
  pseudonymize,
  resetLogHashKey,
  sanitizeUrl,
} from '../../src/lib/monitoring/logSafety.js';
import { runWithCorrelationId } from '../../src/lib/monitoring/telemetry.js';
import { UNSAFE_LOG_SYNTAX } from '../../eslint.config.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// SEP-53 test-vector account; any valid G-address works.
const WALLET = 'GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L';
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7';
const EMAIL = 'student@example.edu';
// Assembled at runtime so secret scanners don't flag the fixtures.
const TX_HASH_A = 'a'.repeat(64);
const TX_HASH_B = 'b'.repeat(64);
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXZhbHVl'].join('.');

const PSEUDONYM = /^(stellar|evm|email|ip|id)#[0-9a-f]{16}$/;
const serialized = (value) => JSON.stringify(value);

beforeEach(() => {
  process.env.LOG_HASH_SECRET = 'log-safety-test-key-0123456789abcdef';
  resetLogHashKey();
});

after(() => {
  delete process.env.LOG_HASH_SECRET;
  resetLogHashKey();
});

describe('field classification', () => {
  const cases = [
    ['buyerAddress', LOG_FIELD_CLASSES.IDENTIFIER],
    ['sessionAddress', LOG_FIELD_CLASSES.IDENTIFIER],
    ['walletAddress', LOG_FIELD_CLASSES.IDENTIFIER],
    ['publicKey', LOG_FIELD_CLASSES.IDENTIFIER],
    ['userId', LOG_FIELD_CLASSES.IDENTIFIER],
    ['creator_id', LOG_FIELD_CLASSES.IDENTIFIER],
    ['actor', LOG_FIELD_CLASSES.IDENTIFIER],
    ['txHash', LOG_FIELD_CLASSES.IDENTIFIER],
    ['clientIp', LOG_FIELD_CLASSES.IDENTIFIER],
    ['userAgent', LOG_FIELD_CLASSES.IDENTIFIER],
    ['url', LOG_FIELD_CLASSES.LOCATOR],
    ['failoverUrl', LOG_FIELD_CLASSES.LOCATOR],
    ['body', LOG_FIELD_CLASSES.PAYLOAD],
    ['searchQuery', LOG_FIELD_CLASSES.PAYLOAD],
    ['headers', LOG_FIELD_CLASSES.PAYLOAD],
    // Categories and internal resource ids stay readable for debugging.
    ['actorType', LOG_FIELD_CLASSES.DEFAULT],
    ['materialId', LOG_FIELD_CLASSES.DEFAULT],
    ['purchaseId', LOG_FIELD_CLASSES.DEFAULT],
    ['status', LOG_FIELD_CLASSES.DEFAULT],
  ];

  for (const [key, expected] of cases) {
    it(`classifies ${key} as ${expected}`, () => {
      assert.equal(classifyLogField(key), expected);
    });
  }
});

describe('unsafe log examples are neutralized', () => {
  it('pseudonymizes person-linked identifier fields', () => {
    const safe = protectLogFields({ buyerAddress: WALLET, userId: '64f1c0ffee0000000000abcd', payloadAddress: EVM });
    assert.match(safe.buyerAddress, PSEUDONYM);
    assert.ok(safe.buyerAddress.startsWith('stellar#'));
    assert.ok(safe.payloadAddress.startsWith('evm#'));
    assert.match(safe.userId, PSEUDONYM);
    assert.ok(!serialized(safe).includes(WALLET));
    assert.ok(!serialized(safe).includes('64f1c0ffee0000000000abcd'));
  });

  it('pseudonymizes bare ids nested under an identifier field', () => {
    const safe = protectLogFields({ user: { id: 'u-42', role: 'creator' } });
    assert.match(safe.user.id, PSEUDONYM);
    assert.equal(safe.user.role, 'creator');
  });

  it('keeps tx hashes distinguishable instead of collapsing them into [REDACTED]', () => {
    const a = protectLogFields({ txHash: TX_HASH_A }).txHash;
    const b = protectLogFields({ txHash: TX_HASH_B }).txHash;
    assert.match(a, PSEUDONYM);
    assert.notEqual(a, b);
  });

  it('masks identifiers embedded in free text and error messages', () => {
    const safe = protectLogFields({ err: new Error(`Account ${WALLET} not found for ${EMAIL}`) });
    assert.equal(safe.err.type, 'Error');
    assert.ok(!safe.err.message.includes(WALLET));
    assert.ok(!safe.err.message.includes(EMAIL));
    assert.match(safe.err.message, /stellar#[0-9a-f]{16}/);
    assert.ok(!safe.err.stack.includes(WALLET));
  });

  it('strips query strings, fragments and credentials from URLs and templates id segments', () => {
    const safe = protectLogFields({
      url: `https://user:pw@eduvault.example/api/materials/64f1c0ffee0000000000abcd/access?token=abc&q=calculus#frag`,
    });
    assert.equal(safe.url, 'https://eduvault.example/api/materials/:id/access');
    assert.equal(sanitizeUrl(`/creator/${WALLET}`), '/creator/:id');
  });

  it('replaces raw payloads with a size summary', () => {
    const safe = protectLogFields({ body: { email: EMAIL, password: 'x' }, searchQuery: 'my private search' });
    assert.equal(safe.body, '[omitted object:2]');
    assert.equal(safe.searchQuery, '[omitted string:17]');
  });

  it('still redacts secrets through the telemetry redactor', () => {
    const safe = protectLogFields({ authorization: `Bearer ${JWT}`, note: `token ${JWT}` });
    assert.equal(safe.authorization, '[REDACTED]');
    assert.ok(!serialized(safe).includes(JWT));
  });

  it('leaves categories and internal resource ids readable', () => {
    const safe = protectLogFields({ actorType: 'user', materialId: 'mat_123', status: 409, retryable: true });
    assert.deepEqual(safe, { actorType: 'user', materialId: 'mat_123', status: 409, retryable: true });
  });

  it('bounds attacker-controlled structure', () => {
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    assert.ok(Object.keys(protectLogFields(wide)).length <= 40);
  });

  it('adds the ambient correlation id for traceability', async () => {
    await runWithCorrelationId('corr-883', async () => {
      assert.equal(protectLogFields({ buyerAddress: WALLET }).correlationId, 'corr-883');
      assert.deepEqual(protectLogArguments(['plain message']), [{ correlationId: 'corr-883' }, 'plain message']);
    });
    assert.equal(protectLogFields({ status: 1 }).correlationId, undefined);
  });
});

describe('pseudonyms', () => {
  it('are stable and case-insensitive for the same identifier', () => {
    assert.equal(pseudonymize(WALLET), pseudonymize(WALLET.toLowerCase()));
    assert.equal(pseudonymize(EMAIL), pseudonymize(EMAIL.toUpperCase()));
    assert.equal(maskIdentifiersInText(`paid by ${WALLET}`), `paid by ${pseudonymize(WALLET)}`);
  });

  it('depend on LOG_HASH_SECRET so they cannot be precomputed from public addresses', () => {
    const first = pseudonymize(WALLET);
    process.env.LOG_HASH_SECRET = 'a-different-log-hash-key-0123456789';
    resetLogHashKey();
    assert.notEqual(pseudonymize(WALLET), first);
  });

  it('fall back to a per-process random key when LOG_HASH_SECRET is unset', () => {
    delete process.env.LOG_HASH_SECRET;
    resetLogHashKey();
    assert.match(pseudonymize(WALLET), PSEUDONYM);
  });
});

describe('pino wiring', () => {
  function captureLogger() {
    const lines = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(JSON.parse(chunk.toString()));
        callback();
      },
    });
    return { lines, log: pino(createLogSafetyOptions(), stream) };
  }

  it('protects merging objects, messages and Error arguments end to end', () => {
    const { lines, log } = captureLogger();
    log.warn({ sessionAddress: WALLET, warnings: 2 }, 'Wallet address mismatch detected at checkout');
    log.info(`legacy message mentioning ${EMAIL}`);
    log.error(new Error(`lookup failed for ${WALLET}`), 'lookup failed');

    const output = serialized(lines);
    assert.ok(!output.includes(WALLET));
    assert.ok(!output.includes(EMAIL));
    assert.equal(lines[0].warnings, 2);
    assert.equal(lines[0].msg, 'Wallet address mismatch detected at checkout');
    assert.equal(lines[2].msg, 'lookup failed');
    assert.equal(lines[2].err.type, 'Error');
  });
});

describe('lint: values must not be interpolated into log messages', () => {
  const linter = new Linter();
  const config = [
    {
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
      rules: { 'no-restricted-syntax': ['error', ...UNSAFE_LOG_SYNTAX] },
    },
  ];
  const lint = (code) => linter.verify(code, config).map((message) => message.ruleId);

  it('flags template-literal and concatenated log messages', () => {
    assert.deepEqual(lint('logger.info(`paid by ${buyer}`);'), ['no-restricted-syntax']);
    assert.deepEqual(lint("log.error('failed for ' + url);"), ['no-restricted-syntax']);
  });

  it('allows constant messages with structured fields', () => {
    assert.deepEqual(lint("logger.info({ buyerAddress }, 'Purchase confirmed');"), []);
    assert.deepEqual(lint('logger.info(`constant template`);'), []);
  });

  it('finds no violations in src/ or scripts/', () => {
    const violations = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(js|jsx|mjs)$/.test(entry.name)) {
          for (const message of linter.verify(readFileSync(path, 'utf8'), config)) {
            if (message.ruleId === 'no-restricted-syntax') violations.push(`${relative(repoRoot, path)}:${message.line}`);
          }
        }
      }
    };
    walk(join(repoRoot, 'src'));
    walk(join(repoRoot, 'scripts'));
    assert.deepEqual(violations, []);
  });
});
