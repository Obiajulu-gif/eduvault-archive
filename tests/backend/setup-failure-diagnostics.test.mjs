/**
 * Contributor diagnostics for local setup failures (#1079).
 * Covers the normal, failure, retry, and authorization paths.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  SETUP_FAILURE_CATEGORY,
  SETUP_STATUS,
  buildSetupReport,
  checkLocalSetup,
  classifySetupError,
  formatSetupReport,
  parseEnvFile,
  probeWithRetry,
} from '../../src/lib/health/setupFailureDiagnostics.js';

const ROOT = '/repo';
const GOOD_ENV_FILE = [
  'NEXT_PUBLIC_APP_URL=http://localhost:3000',
  'MONGODB_URI=mongodb://localhost:27017/eduvault',
  'JWT_SECRET=0123456789abcdef0123456789abcdef',
  'EDUVAULT_SANDBOX=true',
].join('\n');

function fakeFs(files) {
  const map = new Map(Object.entries(files).map(([name, content]) => [path.join(ROOT, name), content]));
  return {
    exists: (p) => map.has(p),
    read: (p) => {
      const value = map.get(p);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

const healthyFiles = {
  'package.json': '{}',
  'package-lock.json': '{}',
  node_modules: '',
  '.env.local': GOOD_ENV_FILE,
};

const codes = (failures) => failures.map((f) => f.code).sort();
const noSleep = async () => {};

describe('checkLocalSetup — normal path', () => {
  test('a configured checkout has no failures and reports ready', () => {
    const failures = checkLocalSetup({ rootDir: ROOT, env: {}, nodeVersion: 'v20.11.0', fsApi: fakeFs(healthyFiles) });
    assert.deepEqual(failures, []);
    const report = buildSetupReport({ failures });
    assert.equal(report.status, SETUP_STATUS.READY);
    assert.equal(report.exitCode, 0);
    assert.match(formatSetupReport(report), /No local setup problems/);
  });

  test('exported shell variables satisfy requirements without .env.local', () => {
    const { '.env.local': _omit, ...files } = healthyFiles;
    const env = parseEnvFile(GOOD_ENV_FILE);
    const failures = checkLocalSetup({ rootDir: ROOT, env, nodeVersion: 'v22.0.0', fsApi: fakeFs(files) });
    assert.deepEqual(failures, []);
  });
});

describe('checkLocalSetup — failure paths', () => {
  test('outside the repository root stops early with one actionable failure', () => {
    const failures = checkLocalSetup({ rootDir: ROOT, env: {}, nodeVersion: 'v20.0.0', fsApi: fakeFs({}) });
    assert.deepEqual(codes(failures), ['NOT_REPOSITORY_ROOT']);
  });

  test('old Node.js, missing installs and foreign lockfiles are reported', () => {
    const failures = checkLocalSetup({
      rootDir: ROOT,
      env: {},
      nodeVersion: 'v18.19.0',
      fsApi: fakeFs({ 'package.json': '{}', 'yarn.lock': '', '.env.local': GOOD_ENV_FILE }),
    });
    assert.deepEqual(codes(failures), [
      'CONFLICTING_LOCKFILES',
      'DEPENDENCIES_NOT_INSTALLED',
      'NODE_VERSION_UNSUPPORTED',
      'NPM_LOCKFILE_MISSING',
    ]);
    assert.equal(failures.find((f) => f.code === 'NODE_VERSION_UNSUPPORTED').category, SETUP_FAILURE_CATEGORY.RUNTIME);
  });

  test('missing env file, placeholders, malformed URIs and storage gaps', () => {
    const { '.env.local': _omit, ...files } = healthyFiles;
    const env = {
      MONGODB_URI: 'localhost:27017',
      JWT_SECRET: 'replace-with-a-long-random-string',
    };
    const failures = checkLocalSetup({ rootDir: ROOT, env, nodeVersion: 'v20.0.0', fsApi: fakeFs(files) });
    assert.deepEqual(codes(failures), [
      'ENV_FILE_MISSING',
      'ENV_PLACEHOLDER_VALUE',
      'ENV_REQUIRED_MISSING',
      'MONGODB_URI_MALFORMED',
      'STORAGE_NOT_CONFIGURED',
    ]);
    const report = buildSetupReport({ failures });
    assert.equal(report.status, SETUP_STATUS.ACTION_REQUIRED);
    assert.equal(report.exitCode, 1);
  });

  test('never echoes secret values from the environment', () => {
    const secretUri = 'mongodb://admin:hunter2pass@db.internal:27017/eduvault';
    const failures = checkLocalSetup({
      rootDir: ROOT,
      env: { MONGODB_URI: secretUri },
      nodeVersion: 'v20.0.0',
      fsApi: fakeFs({ 'package.json': '{}', 'package-lock.json': '{}', node_modules: '' }),
    });
    const report = buildSetupReport({ failures });
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('hunter2pass'));
    assert.ok(!serialized.includes('db.internal'));
  });
});

describe('classifySetupError', () => {
  test('connectivity errors are retryable', () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']) {
      const result = classifySetupError(Object.assign(new Error('boom'), { code }));
      assert.equal(result.category, SETUP_FAILURE_CATEGORY.CONNECTIVITY, code);
      assert.equal(result.retryable, true, code);
    }
  });

  test('authorization wins over connectivity and is never retryable', () => {
    const result = classifySetupError(new Error('Authentication failed: server selection timed out'));
    assert.equal(result.code, 'CREDENTIALS_REJECTED');
    assert.equal(result.category, SETUP_FAILURE_CATEGORY.AUTHORIZATION);
    assert.equal(result.retryable, false);
    assert.equal(classifySetupError({ message: 'nope', status: 401 }).code, 'CREDENTIALS_REJECTED');
    assert.equal(classifySetupError(Object.assign(new Error('x'), { code: 'EACCES' })).code, 'PERMISSION_DENIED');
  });

  test('dependency, port and unknown errors get stable codes', () => {
    assert.equal(classifySetupError(Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' })).code, 'MODULE_MISSING');
    assert.equal(classifySetupError(Object.assign(new Error('x'), { code: 'EADDRINUSE' })).code, 'PORT_IN_USE');
    assert.equal(classifySetupError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })).code, 'HOST_NOT_FOUND');
    const unknown = classifySetupError('something odd');
    assert.equal(unknown.code, 'UNCLASSIFIED');
    assert.equal(unknown.retryable, false);
  });

  test('redacts credentials embedded in error messages', () => {
    const result = classifySetupError(new Error('connect ECONNREFUSED mongodb://root:topsecret@localhost:27017'));
    assert.ok(!result.message.includes('topsecret'));
  });
});

describe('probeWithRetry — retry and authorization paths', () => {
  test('recovers after transient connectivity failures with exponential backoff', async () => {
    const delays = [];
    let calls = 0;
    const result = await probeWithRetry(
      'mongodb',
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      },
      { attempts: 3, baseDelayMs: 100, sleep: async (ms) => delays.push(ms) }
    );
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.deepEqual(delays, [100, 200]);
  });

  test('exhausted retries produce a retry_later report with EX_TEMPFAIL', async () => {
    const result = await probeWithRetry(
      'mongodb',
      async () => {
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      },
      { attempts: 2, sleep: noSleep }
    );
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
    const report = buildSetupReport({ probes: [result] });
    assert.equal(report.status, SETUP_STATUS.RETRY_LATER);
    assert.equal(report.exitCode, 75);
    assert.equal(report.failures[0].probe, 'mongodb');
  });

  test('rejected credentials stop after one attempt', async () => {
    let calls = 0;
    const result = await probeWithRetry(
      'pinata',
      async () => {
        calls += 1;
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
      { attempts: 5, sleep: noSleep }
    );
    assert.equal(calls, 1);
    assert.equal(result.failure.category, SETUP_FAILURE_CATEGORY.AUTHORIZATION);
    assert.equal(buildSetupReport({ probes: [result] }).status, SETUP_STATUS.ACTION_REQUIRED);
  });
});

describe('parseEnvFile', () => {
  test('handles comments, quotes and export prefixes', () => {
    const parsed = parseEnvFile('# c\nexport A="1"\nB=\'two\'\n\nC=3=3\ninvalid');
    assert.deepEqual(parsed, { A: '1', B: 'two', C: '3=3' });
  });
});
