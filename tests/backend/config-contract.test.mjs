import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { evaluateConfigContract } from '../../src/lib/config/configContract.js';

// Cross-environment configuration contract (#944).
const secret = (label) => `${label}-`.padEnd(48, 'x');
const production = {
  NODE_ENV: 'production',
  NEXT_PUBLIC_APP_URL: 'https://eduvault.example',
  MONGODB_URI: 'mongodb+srv://app@cluster0.example.mongodb.net/eduvault',
  JWT_SECRET: secret('jwt'),
  PINATA_JWT: secret('pinata'),
  NEXT_PUBLIC_GATEWAY_URL: 'https://gateway.pinata.cloud',
  NEXT_PUBLIC_STELLAR_NETWORK: 'PUBLIC',
  UNSUBSCRIBE_TOKEN_SECRET: secret('unsubscribe'),
  STELLAR_WEBHOOK_SECRET: secret('webhook'),
};

function runCli(envFileContents, environment) {
  const dir = mkdtempSync(join(tmpdir(), 'config-contract-'));
  const file = join(dir, '.env.candidate');
  writeFileSync(file, envFileContents);
  try {
    const stdout = execFileSync(process.execPath, ['scripts/check-config-contract.mjs', '--env', environment, '--file', file], {
      encoding: 'utf8',
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout) };
  }
}

describe('config contract (#944)', () => {
  it('passes a complete production config and fails a partial one', () => {
    assert.equal(evaluateConfigContract(production, 'production').ok, true);
    const { JWT_SECRET: _omit, ...missing } = production;
    const result = evaluateConfigContract(missing, 'production');
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.setting === 'JWT_SECRET' && e.rule === 'required'));
  });

  it('CLI exits non-zero on violations without printing values', () => {
    const lines = Object.entries({ ...production, JWT_SECRET: 'tiny-value' }).map(([k, v]) => `${k}=${v}`);
    const failed = runCli(lines.join('\n'), 'production');
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /JWT_SECRET must be at least 32 characters/);
    assert.ok(!failed.stdout.includes('tiny-value'));

    const ok = runCli(Object.entries(production).map(([k, v]) => `${k}="${v}"`).join('\n'), 'production');
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(runCli('', 'prod').code, 2);
  });
});
