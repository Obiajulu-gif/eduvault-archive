import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validateRuntimeEnv } from '../../env.js';
import {
  CONFIG_CONTRACT,
  ENVIRONMENTS,
  evaluateConfigContract,
  formatConfigContractReport,
  resolveEnvironment,
} from '../configContract.js';

// jsdom replaces the global URL, so resolve the repo root via node:path.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const readRepoFile = (path) => readFileSync(join(repoRoot, path), 'utf8');

// Fixture values are assembled at runtime so secret scanners don't flag them.
const secret = (label) => `${label}-`.padEnd(48, 'x');
const contractId = (letter) => `C${letter.repeat(55)}`;
const seed = `S${'A'.repeat(55)}`;

function productionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    NEXT_PUBLIC_APP_URL: 'https://eduvault.example',
    MONGODB_URI: 'mongodb+srv://app@cluster0.example.mongodb.net/eduvault',
    JWT_SECRET: secret('jwt'),
    PINATA_JWT: secret('pinata'),
    NEXT_PUBLIC_GATEWAY_URL: 'https://gateway.pinata.cloud',
    NEXT_PUBLIC_STELLAR_NETWORK: 'PUBLIC',
    NEXT_PUBLIC_STELLAR_RPC_URL: 'https://soroban-mainnet.stellar.org',
    NEXT_PUBLIC_HORIZON_URL: 'https://horizon.stellar.org',
    NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID: contractId('A'),
    NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID: contractId('B'),
    STELLAR_WEBHOOK_SECRET: secret('webhook'),
    UNSUBSCRIBE_TOKEN_SECRET: secret('unsubscribe'),
    DOWNLOAD_CAPABILITY_SECRET: secret('download'),
    ...overrides,
  };
}

const rules = (result) => result.errors.map((e) => `${e.setting}:${e.rule}`);

describe('configuration contract (#944)', () => {
  it('accepts a complete production configuration', () => {
    const result = evaluateConfigContract(productionEnv(), 'production');
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('accepts an empty local development environment', () => {
    expect(evaluateConfigContract({}, 'development').ok).toBe(true);
    expect(evaluateConfigContract({}, 'test').ok).toBe(true);
  });

  const requiredInProduction = CONFIG_CONTRACT.filter((s) => s.requiredIn.includes('production')).map((s) => s.name);

  it.each(requiredInProduction)('fails production when %s is missing or a placeholder', (name) => {
    expect(rules(evaluateConfigContract(productionEnv({ [name]: '' }), 'production'))).toContain(`${name}:required`);
    expect(rules(evaluateConfigContract(productionEnv({ [name]: '  ' }), 'production'))).toContain(`${name}:required`);
    expect(rules(evaluateConfigContract(productionEnv({ [name]: 'replace-me' }), 'production'))).toContain(
      `${name}:placeholder`
    );
  });

  it('rejects insecure URLs, local databases and short secrets in deployed environments', () => {
    for (const environment of ['staging', 'production']) {
      const result = evaluateConfigContract(
        productionEnv({
          NEXT_PUBLIC_APP_URL: 'http://eduvault.example',
          NEXT_PUBLIC_GATEWAY_URL: 'https://localhost:8080',
          MONGODB_URI: 'mongodb://localhost:27017/eduvault',
          JWT_SECRET: 'short',
          NEXT_PUBLIC_HORIZON_URL: 'not a url',
        }),
        environment
      );
      expect(rules(result)).toEqual(
        expect.arrayContaining([
          'NEXT_PUBLIC_APP_URL:https',
          'NEXT_PUBLIC_GATEWAY_URL:no-localhost',
          'MONGODB_URI:no-localhost',
          'JWT_SECRET:min-length',
          'NEXT_PUBLIC_HORIZON_URL:url',
        ])
      );
    }
  });

  it('detects network settings that disagree with NEXT_PUBLIC_STELLAR_NETWORK', () => {
    const mainnetOnTestnetUrls = productionEnv({
      NEXT_PUBLIC_STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      NEXT_PUBLIC_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    });
    expect(rules(evaluateConfigContract(mainnetOnTestnetUrls, 'production'))).toEqual(
      expect.arrayContaining(['NEXT_PUBLIC_STELLAR_RPC_URL:network-mismatch', 'NEXT_PUBLIC_HORIZON_URL:network-mismatch'])
    );

    const testnetOnMainnetUrls = productionEnv({ NEXT_PUBLIC_STELLAR_NETWORK: 'TESTNET' });
    expect(rules(evaluateConfigContract(testnetOnMainnetUrls, 'staging'))).toContain(
      'NEXT_PUBLIC_HORIZON_URL:network-mismatch'
    );

    // chain.js only honors the exact string 'PUBLIC'.
    const lowercase = evaluateConfigContract(productionEnv({ NEXT_PUBLIC_STELLAR_NETWORK: 'public' }), 'production');
    expect(rules(lowercase)).toContain('NEXT_PUBLIC_STELLAR_NETWORK:network');
    expect(rules(evaluateConfigContract(productionEnv({ NEXT_PUBLIC_STELLAR_NETWORK: 'MAINNET' }), 'production'))).toContain(
      'NEXT_PUBLIC_STELLAR_NETWORK:network'
    );
    // .env.example ships lowercase 'testnet', which still resolves to testnet: warn only.
    const devLowercase = evaluateConfigContract({ NEXT_PUBLIC_STELLAR_NETWORK: 'testnet' }, 'development');
    expect(devLowercase.ok).toBe(true);
    expect(devLowercase.warnings.map((w) => w.rule)).toContain('network-case');
  });

  it('validates contract IDs and their dependencies', () => {
    const result = evaluateConfigContract(
      productionEnv({
        NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID: 'CINVALID',
        NEXT_PUBLIC_SOROBAN_CONTRACT_ID: contractId('B'),
      }),
      'production'
    );
    expect(rules(result)).toEqual(
      expect.arrayContaining([
        'NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID:contract-id',
        'NEXT_PUBLIC_SOROBAN_CONTRACT_ID:distinct-contracts',
      ])
    );

    const noRpc = evaluateConfigContract(
      productionEnv({ NEXT_PUBLIC_STELLAR_RPC_URL: '', NEXT_PUBLIC_HORIZON_URL: '' }),
      'production'
    );
    expect(rules(noRpc)).toEqual(
      expect.arrayContaining([
        'NEXT_PUBLIC_STELLAR_RPC_URL:required-with-contracts',
        'NEXT_PUBLIC_HORIZON_URL:required-with-contracts',
      ])
    );
  });

  it('requires distinct signing secrets in deployed environments and warns locally', () => {
    const reused = { JWT_SECRET: secret('shared'), DOWNLOAD_CAPABILITY_SECRET: secret('shared') };
    expect(rules(evaluateConfigContract(productionEnv(reused), 'production'))).toContain(
      'DOWNLOAD_CAPABILITY_SECRET:distinct-secrets'
    );
    const local = evaluateConfigContract(reused, 'development');
    expect(local.ok).toBe(true);
    expect(local.warnings.map((w) => w.rule)).toContain('distinct-secrets');
  });

  it('requires a webhook secret when webhooks are enabled', () => {
    const env = productionEnv({ STELLAR_WEBHOOK_SECRET: '', WEBHOOK_URL: 'https://hooks.example/eduvault' });
    expect(rules(evaluateConfigContract(env, 'production'))).toContain('STELLAR_WEBHOOK_SECRET:required-with-webhooks');
    const withoutWebhooks = evaluateConfigContract(productionEnv({ STELLAR_WEBHOOK_SECRET: '' }), 'production');
    expect(withoutWebhooks.ok).toBe(true);
    expect(withoutWebhooks.warnings.map((w) => w.rule)).toContain('open-inbound-webhook');
  });

  it('blocks secrets in NEXT_PUBLIC_ variables, sandbox mode and a mismatched NODE_ENV', () => {
    const result = evaluateConfigContract(
      productionEnv({
        NEXT_PUBLIC_ADMIN_SECRET: 'anything',
        NEXT_PUBLIC_DEBUG_KEY: seed,
        EDUVAULT_SANDBOX: 'true',
        NODE_ENV: 'development',
      }),
      'production'
    );
    expect(rules(result)).toEqual(
      expect.arrayContaining([
        'NEXT_PUBLIC_ADMIN_SECRET:public-secret',
        'NEXT_PUBLIC_DEBUG_KEY:public-secret',
        'EDUVAULT_SANDBOX:sandbox-disabled',
        'NODE_ENV:node-env',
      ])
    );
  });

  it('validates Stellar signer keys', () => {
    const result = evaluateConfigContract(
      productionEnv({ STELLAR_ADMIN_SECRET: 'GNOTASEED', STELLAR_ADMIN_PUBLIC_KEY: 'nope' }),
      'production'
    );
    expect(rules(result)).toEqual(
      expect.arrayContaining(['STELLAR_ADMIN_SECRET:stellar-seed', 'STELLAR_ADMIN_PUBLIC_KEY:stellar-public-key'])
    );
    const valid = evaluateConfigContract(productionEnv({ STELLAR_ADMIN_SECRET: seed }), 'production');
    expect(valid.ok).toBe(true);
    expect(valid.warnings.map((w) => w.rule)).toContain('pair');
  });

  it('never includes setting values in messages or reports', () => {
    const leaky = productionEnv({ JWT_SECRET: 'tiny-but-secret', PINATA_JWT: 'replace-me', NEXT_PUBLIC_DEBUG_KEY: seed });
    const result = evaluateConfigContract(leaky, 'production');
    const report = formatConfigContractReport(result) + JSON.stringify(result);
    expect(result.ok).toBe(false);
    expect(report).not.toContain('tiny-but-secret');
    expect(report).not.toContain(seed);
  });

  it('resolves the environment from deployment signals', () => {
    expect(resolveEnvironment({ EDUVAULT_DEPLOY_ENV: 'Staging', NODE_ENV: 'production' })).toBe('staging');
    expect(resolveEnvironment({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe('staging');
    expect(resolveEnvironment({ VERCEL_ENV: 'production' })).toBe('production');
    expect(resolveEnvironment({ CI: 'true', NODE_ENV: 'production' })).toBe('ci');
    expect(resolveEnvironment({ NODE_ENV: 'test' })).toBe('test');
    expect(resolveEnvironment({})).toBe('development');
    expect(() => resolveEnvironment({ EDUVAULT_DEPLOY_ENV: 'prod' })).toThrow(/EDUVAULT_DEPLOY_ENV/);
    expect(() => evaluateConfigContract({}, 'prod')).toThrow(/Unknown environment/);
  });

  describe('cross-environment drift', () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('documents every contract setting in .env.example', () => {
      const documented = new Set(
        readRepoFile('.env.example')
          .split(/\r?\n/)
          .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
          .filter(Boolean)
      );
      const missing = CONFIG_CONTRACT.map((s) => s.name).filter((name) => !documented.has(name));
      expect(missing).toEqual([]);
    });

    it('.env.example template is a valid development configuration', () => {
      const template = Object.fromEntries(
        readRepoFile('.env.example')
          .split(/\r?\n/)
          .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
          .filter(Boolean)
          .map(([, key, value]) => [key, value])
      );
      const result = evaluateConfigContract(template, 'development');
      expect(result.errors).toEqual([]);
      // ...and a template copied verbatim to production must be rejected.
      expect(evaluateConfigContract({ ...template, NODE_ENV: 'production' }, 'production').ok).toBe(false);
    });

    it.each(['.github/workflows/backend.yml', '.github/workflows/frontend.yml'])(
      '%s build jobs satisfy the ci contract',
      (workflowPath) => {
        const workflow = parseYaml(readRepoFile(workflowPath));
        const buildJobs = Object.entries(workflow.jobs).filter(([, job]) =>
          (job.steps || []).some((step) => /npm run build/.test(step.run || ''))
        );
        expect(buildJobs.length).toBeGreaterThan(0);
        for (const [jobName, job] of buildJobs) {
          const env = { ...(workflow.env || {}), ...(job.env || {}) };
          const result = evaluateConfigContract(env, 'ci');
          expect({ jobName, errors: result.errors }).toEqual({ jobName, errors: [] });
        }
      }
    );

    it('stays at least as strict as the startup validator in env.js', () => {
      process.env = { ...originalEnv, ...productionEnv() };
      expect(validateRuntimeEnv()).toEqual([]);

      for (const name of ['NEXT_PUBLIC_APP_URL', 'MONGODB_URI', 'JWT_SECRET', 'PINATA_JWT', 'NEXT_PUBLIC_GATEWAY_URL']) {
        process.env = { ...originalEnv, ...productionEnv({ [name]: '' }) };
        expect(validateRuntimeEnv().length).toBeGreaterThan(0);
        expect(evaluateConfigContract(productionEnv({ [name]: '' }), 'production').ok).toBe(false);
      }
    });

    it('covers every environment', () => {
      for (const environment of ENVIRONMENTS) {
        expect(() => evaluateConfigContract({}, environment)).not.toThrow();
      }
    });
  });
});
