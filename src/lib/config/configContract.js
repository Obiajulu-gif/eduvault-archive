/**
 * src/lib/config/configContract.js
 *
 * Cross-environment configuration contract for production-critical settings
 * (#944).
 *
 * `src/lib/env.js` validates the *current* process at startup. This module
 * declares, in one table, what every environment (development, test, ci,
 * staging, production) must provide, and evaluates any env map against it —
 * so tests can check fixtures, CI workflow env blocks and `.env.example`
 * without mutating `process.env`, and operators can dry-run a candidate
 * deployment config (`npm run config:contract -- --env production`).
 *
 * It is additive: nothing here runs at startup or changes how the app reads
 * configuration. Messages name settings and rules, never secret values.
 */

export const ENVIRONMENTS = Object.freeze(['development', 'test', 'ci', 'staging', 'production']);
const DEPLOYED = Object.freeze(['staging', 'production']);

export const STELLAR_NETWORKS = Object.freeze(['TESTNET', 'PUBLIC']);

// Template values copied from .env.example / docs. Any value starting with
// "replace-" or "your-"/"your_" is also treated as a placeholder.
const PLACEHOLDER_PREFIX = /^(replace[-_]|your[-_])/;
const PLACEHOLDERS = new Set([
  'replace-me',
  'change-me',
  'changeme',
  'changeme-in-production',
  'change_me',
  'your-secret-here',
  'your_project_id',
  'your_pinata_jwt',
  'your_mongodb_uri',
  'your-stellar-webhook-secret',
  'your-cron-secret',
  'xxxx',
  'secret',
  'password',
  'todo',
]);

export const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;
const STELLAR_SEED_PATTERN = /^S[A-Z2-7]{55}$/;
const STELLAR_PUBLIC_PATTERN = /^G[A-Z2-7]{55}$/;
const SECRET_SHAPES = [/\bS[A-Z2-7]{55}\b/, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/];
export const MIN_DEPLOYED_SECRET_LENGTH = 32;

/**
 * kind:        url | mongoUri | secret | contractId | network | stellarSeed | stellarPublicKey | flag
 * requiredIn:  environments where the setting must be present and non-placeholder.
 * Secrets in DEPLOYED environments must be >= MIN_DEPLOYED_SECRET_LENGTH chars.
 * URLs in DEPLOYED environments must be https and must not point at localhost.
 */
export const CONFIG_CONTRACT = Object.freeze([
  { name: 'NEXT_PUBLIC_APP_URL', kind: 'url', requiredIn: ['ci', ...DEPLOYED] },
  { name: 'MONGODB_URI', kind: 'mongoUri', requiredIn: ['ci', ...DEPLOYED] },
  { name: 'JWT_SECRET', kind: 'secret', requiredIn: ['ci', ...DEPLOYED] },
  { name: 'PINATA_JWT', kind: 'secret', requiredIn: ['ci', ...DEPLOYED] },
  { name: 'NEXT_PUBLIC_GATEWAY_URL', kind: 'url', requiredIn: ['ci', ...DEPLOYED] },
  // chain.js treats anything except the exact string 'PUBLIC' as testnet, so
  // production must pick a network explicitly rather than inherit the default.
  { name: 'NEXT_PUBLIC_STELLAR_NETWORK', kind: 'network', requiredIn: ['production'] },
  { name: 'NEXT_PUBLIC_STELLAR_RPC_URL', kind: 'url', requiredIn: [] },
  { name: 'NEXT_PUBLIC_HORIZON_URL', kind: 'url', requiredIn: [] },
  { name: 'NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID', kind: 'contractId', requiredIn: [] },
  { name: 'NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID', kind: 'contractId', requiredIn: [] },
  { name: 'NEXT_PUBLIC_SOROBAN_CONTRACT_ID', kind: 'contractId', requiredIn: [] },
  { name: 'STELLAR_WEBHOOK_SECRET', kind: 'secret', requiredIn: [] },
  { name: 'CRON_SECRET', kind: 'secret', requiredIn: [] },
  { name: 'DOWNLOAD_CAPABILITY_SECRET', kind: 'secret', requiredIn: [] },
  { name: 'CONTENT_MANIFEST_SECRET', kind: 'secret', requiredIn: [] },
  // unsubscribeToken.js falls back to a hard-coded default when unset, which
  // would let anyone forge unsubscribe links in production.
  { name: 'UNSUBSCRIBE_TOKEN_SECRET', kind: 'secret', requiredIn: ['production'] },
  { name: 'ANALYTICS_HASH_SECRET', kind: 'secret', requiredIn: [] },
  { name: 'STELLAR_ADMIN_SECRET', kind: 'stellarSeed', requiredIn: [] },
  { name: 'STELLAR_ADMIN_PUBLIC_KEY', kind: 'stellarPublicKey', requiredIn: [] },
  { name: 'EDUVAULT_SANDBOX', kind: 'flag', requiredIn: [] },
]);

// Signing/HMAC secrets that must not share a value: rotating one must not
// silently rotate (or leak) another.
const DISTINCT_SECRETS = Object.freeze([
  'JWT_SECRET',
  'DOWNLOAD_CAPABILITY_SECRET',
  'CONTENT_MANIFEST_SECRET',
  'UNSUBSCRIBE_TOKEN_SECRET',
  'ANALYTICS_HASH_SECRET',
  'STELLAR_WEBHOOK_SECRET',
]);

const CONTRACT_ID_SETTINGS = CONFIG_CONTRACT.filter((s) => s.kind === 'contractId').map((s) => s.name);

function present(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function isPlaceholderValue(value) {
  if (!present(value)) return true;
  const normalized = value.trim().toLowerCase();
  return PLACEHOLDERS.has(normalized) || PLACEHOLDER_PREFIX.test(normalized);
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHost(hostname) {
  return /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1)$/i.test(hostname);
}

/**
 * Infer the environment from an env map. `EDUVAULT_DEPLOY_ENV` wins, then
 * Vercel's `VERCEL_ENV`, then CI, then NODE_ENV.
 */
export function resolveEnvironment(env = {}) {
  const explicit = env.EDUVAULT_DEPLOY_ENV?.trim().toLowerCase();
  if (explicit) {
    if (!ENVIRONMENTS.includes(explicit)) {
      throw new Error(`EDUVAULT_DEPLOY_ENV must be one of ${ENVIRONMENTS.join(', ')}.`);
    }
    return explicit;
  }
  if (env.VERCEL_ENV === 'production') return 'production';
  if (env.VERCEL_ENV === 'preview') return 'staging';
  if (env.CI === 'true') return 'ci';
  if (env.NODE_ENV === 'production') return 'production';
  if (env.NODE_ENV === 'test') return 'test';
  return 'development';
}

/**
 * Evaluate `env` against the contract for `environment`.
 * @returns {{ environment: string, ok: boolean, errors: Array<{setting, rule, message}>, warnings: Array<{setting, rule, message}> }}
 */
export function evaluateConfigContract(env = {}, environment = resolveEnvironment(env)) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(`Unknown environment "${environment}". Expected one of ${ENVIRONMENTS.join(', ')}.`);
  }
  const deployed = DEPLOYED.includes(environment);
  const errors = [];
  const warnings = [];
  const fail = (setting, rule, message) => errors.push({ setting, rule, message });
  const warn = (setting, rule, message) => warnings.push({ setting, rule, message });

  for (const setting of CONFIG_CONTRACT) {
    const { name, kind, requiredIn } = setting;
    const value = env[name];

    if (!present(value)) {
      if (requiredIn.includes(environment)) fail(name, 'required', `${name} is required in ${environment}.`);
      continue;
    }
    const trimmed = value.trim();
    if (isPlaceholderValue(trimmed)) {
      if (requiredIn.includes(environment) || deployed) {
        fail(name, 'placeholder', `${name} is still set to a placeholder value.`);
      }
      continue;
    }

    switch (kind) {
      case 'url': {
        const url = parseUrl(trimmed);
        if (!url || !/^https?:$/.test(url.protocol)) {
          fail(name, 'url', `${name} must be an absolute http(s) URL.`);
        } else if (deployed && url.protocol !== 'https:') {
          fail(name, 'https', `${name} must use https in ${environment}.`);
        } else if (deployed && isLocalHost(url.hostname)) {
          fail(name, 'no-localhost', `${name} must not point at localhost in ${environment}.`);
        }
        break;
      }
      case 'mongoUri': {
        if (!/^mongodb(\+srv)?:\/\//.test(trimmed)) {
          fail(name, 'mongo-uri', `${name} must start with mongodb:// or mongodb+srv://.`);
        } else if (deployed && /@?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(trimmed.replace(/^mongodb(\+srv)?:\/\//, ''))) {
          fail(name, 'no-localhost', `${name} must point at a managed database in ${environment}.`);
        } else if (!deployed && trimmed.startsWith('mongodb+srv://') && environment !== 'ci') {
          warn(name, 'prod-like-db', `${name} looks like a hosted cluster; local ${environment} should use a local database.`);
        }
        break;
      }
      case 'secret': {
        if (deployed && trimmed.length < MIN_DEPLOYED_SECRET_LENGTH) {
          fail(name, 'min-length', `${name} must be at least ${MIN_DEPLOYED_SECRET_LENGTH} characters in ${environment}.`);
        }
        break;
      }
      case 'contractId': {
        if (!CONTRACT_ID_PATTERN.test(trimmed)) {
          fail(name, 'contract-id', `${name} is not a valid Soroban contract ID (56-char, C-prefixed).`);
        }
        break;
      }
      case 'network': {
        if (!STELLAR_NETWORKS.includes(trimmed)) {
          if (STELLAR_NETWORKS.includes(trimmed.toUpperCase()) && trimmed.toUpperCase() === 'PUBLIC') {
            // chain.js compares with === 'PUBLIC'; 'public' silently selects testnet.
            fail(name, 'network', `${name} must be exactly "PUBLIC" (uppercase); other casings silently select TESTNET.`);
          } else if (trimmed.toUpperCase() === 'TESTNET') {
            warn(name, 'network-case', `${name} should be "TESTNET" (uppercase) for clarity.`);
          } else {
            fail(name, 'network', `${name} must be one of ${STELLAR_NETWORKS.join(', ')}.`);
          }
        }
        break;
      }
      case 'stellarSeed': {
        if (!STELLAR_SEED_PATTERN.test(trimmed)) {
          fail(name, 'stellar-seed', `${name} is not a valid Stellar secret seed.`);
        }
        break;
      }
      case 'stellarPublicKey': {
        if (!STELLAR_PUBLIC_PATTERN.test(trimmed)) {
          fail(name, 'stellar-public-key', `${name} is not a valid Stellar public key.`);
        }
        break;
      }
      case 'flag': {
        if (!['true', 'false'].includes(trimmed)) fail(name, 'flag', `${name} must be "true" or "false".`);
        break;
      }
      default:
        break;
    }
  }

  // --- Cross-setting rules ------------------------------------------------

  const network = env.NEXT_PUBLIC_STELLAR_NETWORK?.trim() === 'PUBLIC' ? 'PUBLIC' : 'TESTNET';
  for (const name of ['NEXT_PUBLIC_STELLAR_RPC_URL', 'NEXT_PUBLIC_HORIZON_URL']) {
    const url = present(env[name]) ? parseUrl(env[name].trim()) : null;
    if (!url) continue;
    const looksTestnet = /testnet|futurenet/i.test(url.hostname);
    const looksMainnet = /^(horizon\.stellar\.org|mainnet\.sorobanrpc\.com|soroban-mainnet\.stellar\.org)$/i.test(url.hostname);
    if (network === 'PUBLIC' && looksTestnet) {
      fail(name, 'network-mismatch', `${name} points at a test network while NEXT_PUBLIC_STELLAR_NETWORK is PUBLIC.`);
    }
    if (network === 'TESTNET' && looksMainnet) {
      fail(name, 'network-mismatch', `${name} points at mainnet while NEXT_PUBLIC_STELLAR_NETWORK is TESTNET.`);
    }
  }

  const contractValues = CONTRACT_ID_SETTINGS.filter((n) => present(env[n])).map((n) => [n, env[n].trim()]);
  const seenContracts = new Map();
  for (const [name, value] of contractValues) {
    if (seenContracts.has(value)) {
      fail(name, 'distinct-contracts', `${name} has the same contract ID as ${seenContracts.get(value)}.`);
    } else {
      seenContracts.set(value, name);
    }
  }
  if (deployed && contractValues.length > 0 && !present(env.NEXT_PUBLIC_STELLAR_RPC_URL)) {
    fail('NEXT_PUBLIC_STELLAR_RPC_URL', 'required-with-contracts', `NEXT_PUBLIC_STELLAR_RPC_URL is required in ${environment} when contract IDs are configured.`);
  }
  if (deployed && contractValues.length > 0 && !present(env.NEXT_PUBLIC_HORIZON_URL)) {
    fail('NEXT_PUBLIC_HORIZON_URL', 'required-with-contracts', `NEXT_PUBLIC_HORIZON_URL is required in ${environment} when contract IDs are configured.`);
  }

  const webhooksEnabled = present(env.WEBHOOK_URL) || present(env.STELLAR_WEBHOOK_SECRET) || present(env.CRON_SECRET);
  if (deployed && webhooksEnabled && !present(env.STELLAR_WEBHOOK_SECRET) && !present(env.CRON_SECRET)) {
    fail('STELLAR_WEBHOOK_SECRET', 'required-with-webhooks', 'STELLAR_WEBHOOK_SECRET (or CRON_SECRET) is required when webhooks are enabled.');
  }
  if (environment === 'production' && !present(env.STELLAR_WEBHOOK_SECRET) && !present(env.CRON_SECRET)) {
    warn('STELLAR_WEBHOOK_SECRET', 'open-inbound-webhook', 'Neither STELLAR_WEBHOOK_SECRET nor CRON_SECRET is set: POST /api/webhooks/stellar accepts any caller.');
  }

  const seenSecrets = new Map();
  for (const name of DISTINCT_SECRETS) {
    if (!present(env[name]) || isPlaceholderValue(env[name])) continue;
    const value = env[name].trim();
    if (seenSecrets.has(value)) {
      const rule = deployed ? fail : warn;
      rule(name, 'distinct-secrets', `${name} reuses the value of ${seenSecrets.get(value)}; use a dedicated secret.`);
    } else {
      seenSecrets.set(value, name);
    }
  }

  if (present(env.STELLAR_ADMIN_SECRET) && !present(env.STELLAR_ADMIN_PUBLIC_KEY) && deployed) {
    warn('STELLAR_ADMIN_PUBLIC_KEY', 'pair', 'STELLAR_ADMIN_PUBLIC_KEY should be set alongside STELLAR_ADMIN_SECRET so the signer can be verified.');
  }

  // Anything NEXT_PUBLIC_* is inlined into the client bundle.
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('NEXT_PUBLIC_') || !present(value)) continue;
    if (/SECRET|PRIVATE|PASSWORD|_JWT$|TOKEN/i.test(name.slice('NEXT_PUBLIC_'.length))) {
      fail(name, 'public-secret', `${name} looks like a secret but NEXT_PUBLIC_ variables are shipped to browsers.`);
    } else if (SECRET_SHAPES.some((pattern) => pattern.test(value))) {
      fail(name, 'public-secret', `${name} contains a secret-shaped value but NEXT_PUBLIC_ variables are shipped to browsers.`);
    }
  }

  if (deployed && env.EDUVAULT_SANDBOX?.trim() === 'true') {
    fail('EDUVAULT_SANDBOX', 'sandbox-disabled', `EDUVAULT_SANDBOX must not be enabled in ${environment}.`);
  }

  if (environment === 'production' && env.NODE_ENV && env.NODE_ENV !== 'production') {
    fail('NODE_ENV', 'node-env', 'NODE_ENV must be "production" for a production deployment.');
  }

  return { environment, ok: errors.length === 0, errors, warnings };
}

/** Human-readable report; never includes setting values. */
export function formatConfigContractReport(result) {
  const lines = [`Config contract (${result.environment}): ${result.ok ? 'PASS' : 'FAIL'}`];
  for (const e of result.errors) lines.push(`  ✗ [${e.rule}] ${e.message}`);
  for (const w of result.warnings) lines.push(`  ! [${w.rule}] ${w.message}`);
  return lines.join('\n');
}
