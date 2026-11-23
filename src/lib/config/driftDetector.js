/**
 * src/lib/config/driftDetector.js
 *
 * Cross-environment configuration drift detector for EduVault (#875).
 *
 * Compares configuration across environments (local, staging, production)
 * to identify missing keys, mismatched values, and unexpected drift.
 * Secrets are redacted in all output.
 */

import { CONFIG_CONTRACT } from './configContract.js';

export const ENVIRONMENTS = Object.freeze(['development', 'test', 'ci', 'staging', 'production']);
export const DEPLOYED = Object.freeze(['staging', 'production']);

/**
 * Secret key patterns that should be redacted in output.
 * These are settings that contain sensitive values.
 */
export const SECRET_KEYS = Object.freeze(new Set([
  'JWT_SECRET',
  'PINATA_JWT',
  'STELLAR_WEBHOOK_SECRET',
  'CRON_SECRET',
  'DOWNLOAD_CAPABILITY_SECRET',
  'CONTENT_MANIFEST_SECRET',
  'UNSUBSCRIBE_TOKEN_SECRET',
  'ANALYTICS_HASH_SECRET',
  'STELLAR_ADMIN_SECRET',
  'EMAIL_PASS',
  'SMTP_PASS',
  'SECONDARY_PINNING_TOKEN',
  'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID',
  'WEBHOOK_URL',
  'STELLAR_ADMIN_PUBLIC_KEY',
]));

/**
 * Keys that are expected to differ between environments.
 * These are documented allowed differences with their comparison rules.
 */
export const ALLOWED_DIFFERENCES = Object.freeze([
  // Network-specific settings that legitimately differ
  {
    keys: ['NEXT_PUBLIC_STELLAR_NETWORK'],
    rule: 'network',
    description: 'Stellar network differs between testnet (local/ci/staging) and mainnet (production)',
    compare: (a, b) => a === b || (a === 'TESTNET' && b === 'PUBLIC') || (a === 'PUBLIC' && b === 'TESTNET'),
  },
  {
    keys: ['NEXT_PUBLIC_STELLAR_RPC_URL', 'NEXT_PUBLIC_HORIZON_URL', 'NEXT_PUBLIC_EXPLORER_URL'],
    rule: 'network-url',
    description: 'RPC/Horizon/Explorer URLs point to different network endpoints',
    compare: (a, b) => {
      if (!a || !b) return false;
      // Allow if both are valid URLs for their respective networks
      return true; // Network URLs are expected to differ
    },
  },
  {
    keys: ['NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID', 'NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID', 'NEXT_PUBLIC_SOROBAN_CONTRACT_ID'],
    rule: 'contract-id',
    description: 'Contract IDs differ per deployment (testnet vs mainnet contracts)',
    compare: (a, b) => {
      if (!a || !b) return false;
      // Both should be valid contract IDs but different values
      return /^C[A-Z2-7]{55}$/.test(a) && /^C[A-Z2-7]{55}$/.test(b);
    },
  },
  {
    keys: ['NEXT_PUBLIC_APP_URL'],
    rule: 'app-url',
    description: 'Base application URL differs per environment',
    compare: (a, b) => {
      if (!a || !b) return false;
      // Both should be valid URLs
      try { new URL(a); new URL(b); return true; } catch { return false; }
    },
  },
  {
    keys: ['MONGODB_URI'],
    rule: 'database-uri',
    description: 'Database connection string differs per environment',
    compare: (a, b) => {
      if (!a || !b) return false;
      return a.startsWith('mongodb') && b.startsWith('mongodb');
    },
  },
  {
    keys: ['NEXT_PUBLIC_GATEWAY_URL', 'SECONDARY_IPFS_GATEWAY'],
    rule: 'gateway-url',
    description: 'IPFS gateway URLs may differ per environment',
    compare: (a, b) => {
      if (!a || !b) return false;
      try { new URL(a); new URL(b); return true; } catch { return false; }
    },
  },
  {
    keys: ['EDUVAULT_SANDBOX'],
    rule: 'sandbox-flag',
    description: 'Sandbox mode enabled in local/test, disabled in deployed',
    compare: (a, b) => a === b || (a === 'true' && b === 'false') || (a === 'false' && b === 'true'),
  },
  {
    keys: ['STELLAR_SURGE_FEE_THRESHOLD', 'STELLAR_SURGE_FEE_MULTIPLIER', 'STELLAR_HIGH_SURGE_FEE_MULTIPLIER', 'STELLAR_MAX_FEE_STROOPS'],
    rule: 'fee-tuning',
    description: 'Fee tuning parameters may be adjusted per environment',
    compare: (a, b) => a === b || (!isNaN(a) && !isNaN(b)),
  },
  {
    keys: ['RECOVERY_LOOKBACK_LEDGERS', 'CHECKOUT_MAX_ADDRESS_WARNINGS', 'CAPABILITY_TTL_MS', 'CAPABILITY_MAX_BYTES', 'MONGODB_MAX_POOL_SIZE', 'MONGODB_MIN_POOL_SIZE', 'MONGODB_TIMEOUT_MS'],
    rule: 'tuning-parameter',
    description: 'Tuning parameters may be adjusted per environment',
    compare: (a, b) => a === b || (!isNaN(a) && !isNaN(b)),
  },
  {
    keys: ['REFUND_WINDOW_DAYS', 'REFUND_MAX_RETRY_ATTEMPTS', 'REFUND_STUCK_SUBMITTING_MS', 'REFUND_MAX_AMOUNT_PER_TX'],
    rule: 'refund-policy',
    description: 'Refund policy parameters may differ per environment',
    compare: (a, b) => a === b || (!isNaN(a) && !isNaN(b)),
  },
  {
    keys: ['FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS', 'FEATURE_FLAG_LEARNER_DATA_EXPORT', 'FEATURE_FLAG_ARCHIVE_MATERIAL'],
    rule: 'feature-flag',
    description: 'Feature flags may be rolled out differently per environment',
    compare: (a, b) => a === b || (['true', 'false'].includes(a) && ['true', 'false'].includes(b)),
  },
  {
    keys: ['STELLAR_HORIZON_FALLBACKS', 'STELLAR_HORIZON_TIMEOUT_MS', 'STELLAR_HORIZON_RETRIES'],
    rule: 'horizon-failover',
    description: 'Horizon failover settings may differ per environment',
    compare: (a, b) => a === b || (!isNaN(a) && !isNaN(b)),
  },
  {
    keys: ['NODE_ENV'],
    rule: 'node-env',
    description: 'NODE_ENV differs between development/test and production deployments',
    compare: (a, b) => a === b || (['development', 'test', 'ci'].includes(a) && ['production', 'staging'].includes(b)) || (['production', 'staging'].includes(a) && ['development', 'test', 'ci'].includes(b)),
  },
  {
    keys: ['EDUVAULT_DEPLOY_ENV'],
    rule: 'deploy-env',
    description: 'EDUVAULT_DEPLOY_ENV explicitly sets the deployment environment',
    compare: (a, b) => a === b || (['development', 'test', 'ci', 'staging', 'production'].includes(a) && ['development', 'test', 'ci', 'staging', 'production'].includes(b)),
  },
  // Secrets are expected to differ per environment (each env has its own)
  {
    keys: [
      'JWT_SECRET', 'PINATA_JWT', 'STELLAR_WEBHOOK_SECRET', 'CRON_SECRET',
      'DOWNLOAD_CAPABILITY_SECRET', 'CONTENT_MANIFEST_SECRET', 'UNSUBSCRIBE_TOKEN_SECRET',
      'ANALYTICS_HASH_SECRET', 'STELLAR_ADMIN_SECRET', 'EMAIL_PASS', 'SMTP_PASS',
      'SECONDARY_PINNING_TOKEN', 'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'WEBHOOK_URL',
      'STELLAR_ADMIN_PUBLIC_KEY'
    ],
    rule: 'secret-per-environment',
    description: 'Secrets are environment-specific and expected to differ',
    compare: (a, b) => a !== b && a.length > 0 && b.length > 0, // Both present but different
  },
]);

/**
 * Keys that should be present in all environments (core settings).
 * These are the settings that must be comparable across all environments.
 */
export const CORE_COMPARABLE_KEYS = Object.freeze(CONFIG_CONTRACT.map(s => s.name));

/**
 * All keys that the drift detector knows about (from CONFIG_CONTRACT + additional known keys).
 */
export const ALL_KNOWN_KEYS = Object.freeze(new Set([
  ...CONFIG_CONTRACT.map(s => s.name),
  'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID',
  'EMAIL_USER', 'EMAIL_PASS', 'EMAIL_FROM',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS',
  'SECONDARY_PINNING_ENDPOINT', 'SECONDARY_PINNING_TOKEN', 'SECONDARY_IPFS_GATEWAY',
  'PINATA_USAGE_URL', 'STORAGE_ALERT_WEBHOOK_URL',
  'WEBHOOK_URL',
  'REFUND_SIGNING_DISABLED', 'REFUND_MAX_AMOUNT_PER_TX', 'REFUND_WINDOW_DAYS',
  'REFUND_MAX_RETRY_ATTEMPTS', 'REFUND_STUCK_SUBMITTING_MS',
  'STELLAR_HORIZON_FALLBACKS', 'STELLAR_HORIZON_TIMEOUT_MS', 'STELLAR_HORIZON_RETRIES',
  'STELLAR_SURGE_FEE_THRESHOLD', 'STELLAR_SURGE_FEE_MULTIPLIER',
  'STELLAR_HIGH_SURGE_FEE_MULTIPLIER', 'STELLAR_MAX_FEE_STROOPS',
  'RECOVERY_LOOKBACK_LEDGERS', 'CHECKOUT_MAX_ADDRESS_WARNINGS',
  'CAPABILITY_TTL_MS', 'CAPABILITY_MAX_BYTES',
  'MONGODB_MAX_POOL_SIZE', 'MONGODB_MIN_POOL_SIZE', 'MONGODB_TIMEOUT_MS',
  'FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS', 'FEATURE_FLAG_LEARNER_DATA_EXPORT', 'FEATURE_FLAG_ARCHIVE_MATERIAL',
  'EDUVAULT_DEPLOY_ENV',
]));

/**
 * Redact a value for safe output.
 * @param {string} key - The configuration key name
 * @param {string} value - The value to potentially redact
 * @returns {string} - Redacted or original value
 */
export function redactValue(key, value) {
  if (!value || typeof value !== 'string') return value;
  if (SECRET_KEYS.has(key)) {
    // Show only first 4 and last 4 characters for secrets
    const trimmed = value.trim();
    if (trimmed.length <= 8) return '****';
    return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
  }
  // For non-secrets, return as-is (but truncate very long values)
  if (value.length > 200) return `${value.slice(0, 200)}...[truncated]`;
  return value;
}

/**
 * Check if a key is a secret that should be redacted.
 */
export function isSecretKey(key) {
  return SECRET_KEYS.has(key);
}

/**
 * Check if a difference between two values for a key is allowed/expected.
 * @param {string} key - Configuration key
 * @param {string} valueA - Value from environment A
 * @param {string} valueB - Value from environment B
 * @param {string} envA - Environment A name
 * @param {string} envB - Environment B name
 * @returns {{allowed: boolean, rule?: string, description?: string}}
 */
export function isAllowedDifference(key, valueA, valueB, envA, envB) {
  for (const diff of ALLOWED_DIFFERENCES) {
    if (diff.keys.includes(key)) {
      const allowed = diff.compare(valueA, valueB);
      if (allowed) {
        return { allowed: true, rule: diff.rule, description: diff.description };
      }
    }
  }
  return { allowed: false };
}

/**
 * Compare two environment configurations and detect drift.
 * @param {Object} envA - First environment configuration
 * @param {Object} envB - Second environment configuration
 * @param {string} nameA - Name of first environment
 * @param {string} nameB - Name of second environment
 * @param {Object} options - Options
 * @param {boolean} options.redactSecrets - Whether to redact secrets in output (default: true)
 * @param {string[]} options.keysToCompare - Specific keys to compare (default: all known keys)
 * @returns {Object} Drift report
 */
export function detectDrift(envA, envB, nameA = 'envA', nameB = 'envB', options = {}) {
  const { redactSecrets = true, keysToCompare } = options;
  const keys = keysToCompare || Array.from(ALL_KNOWN_KEYS);
  const allKeys = new Set([...keys, ...Object.keys(envA), ...Object.keys(envB)]);

  const missingInA = [];
  const missingInB = [];
  const mismatched = [];
  const allowedDifferences = [];
  const matching = [];

  for (const key of allKeys) {
    const valA = envA[key];
    const valB = envB[key];
    const presentA = valA !== undefined && valA !== '' && valA.trim() !== '';
    const presentB = valB !== undefined && valB !== '' && valB.trim() !== '';

    if (!presentA && !presentB) {
      // Key not set in either - skip (not a drift)
      continue;
    }

    if (!presentA) {
      missingInA.push({
        key,
        [nameB]: redactSecrets ? redactValue(key, valB) : valB,
        severity: isSecretKey(key) ? 'high' : 'medium',
      });
      continue;
    }

    if (!presentB) {
      missingInB.push({
        key,
        [nameA]: redactSecrets ? redactValue(key, valA) : valA,
        severity: isSecretKey(key) ? 'high' : 'medium',
      });
      continue;
    }

    // Both present - compare values
    if (valA === valB) {
      matching.push({
        key,
        value: redactSecrets ? redactValue(key, valA) : valA,
      });
      continue;
    }

    // Values differ - check if allowed
    const allowed = isAllowedDifference(key, valA, valB, nameA, nameB);
    if (allowed.allowed) {
      allowedDifferences.push({
        key,
        [nameA]: redactSecrets ? redactValue(key, valA) : valA,
        [nameB]: redactSecrets ? redactValue(key, valB) : valB,
        rule: allowed.rule,
        description: allowed.description,
      });
    } else {
      mismatched.push({
        key,
        [nameA]: redactSecrets ? redactValue(key, valA) : valA,
        [nameB]: redactSecrets ? redactValue(key, valB) : valB,
        severity: isSecretKey(key) ? 'critical' : 'high',
      });
    }
  }

  return {
    environmentA: nameA,
    environmentB: nameB,
    timestamp: new Date().toISOString(),
    summary: {
      totalCompared: allKeys.size,
      matching: matching.length,
      missingInA: missingInA.length,
      missingInB: missingInB.length,
      mismatched: mismatched.length,
      allowedDifferences: allowedDifferences.length,
      hasCriticalDrift: mismatched.some(m => m.severity === 'critical'),
      hasHighDrift: mismatched.some(m => m.severity === 'high'),
    },
    matching,
    missingInA,
    missingInB,
    mismatched,
    allowedDifferences,
  };
}

/**
 * Compare multiple environments against a baseline (e.g., production).
 * @param {Object} baseline - Baseline environment configuration
 * @param {string} baselineName - Name of baseline environment
 * @param {Object[]} targets - Array of { name, config } for target environments
 * @param {Object} options - Options passed to detectDrift
 * @returns {Object[]} Array of drift reports
 */
export function detectDriftAgainstBaseline(baseline, baselineName, targets, options = {}) {
  return targets.map(({ name, config }) =>
    detectDrift(baseline, config, baselineName, name, options)
  );
}

/**
 * Format a drift report for human-readable console output.
 * @param {Object} report - Drift report from detectDrift
 * @param {Object} options - Formatting options
 * @param {boolean} options.color - Use ANSI colors (default: true)
 * @param {boolean} options.verbose - Show matching keys (default: false)
 * @returns {string} Formatted report
 */
export function formatDriftReport(report, options = {}) {
  const { color = true, verbose = false } = options;
  const c = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    bold: '\x1b[1m',
  };
  const nc = color ? c : { reset: '', red: '', green: '', yellow: '', blue: '', cyan: '', gray: '', bold: '' };

  const lines = [];
  lines.push(`${nc.bold}Configuration Drift Report${nc.reset}`);
  lines.push(`${nc.gray}Comparing: ${report.environmentA} ↔ ${report.environmentB}${nc.reset}`);
  lines.push(`${nc.gray}Timestamp: ${report.timestamp}${nc.reset}`);
  lines.push('');

  const s = report.summary;
  lines.push(`${nc.bold}Summary:${nc.reset}`);
  lines.push(`  ${nc.green}✓ Matching:${nc.reset} ${s.matching}`);
  lines.push(`  ${nc.blue}⟳ Allowed differences:${nc.reset} ${s.allowedDifferences}`);
  if (s.missingInA > 0) lines.push(`  ${nc.yellow}⚠ Missing in ${report.environmentA}:${nc.reset} ${s.missingInA}`);
  if (s.missingInB > 0) lines.push(`  ${nc.yellow}⚠ Missing in ${report.environmentB}:${nc.reset} ${s.missingInB}`);
  if (s.mismatched > 0) lines.push(`  ${nc.red}✗ Mismatched:${nc.reset} ${s.mismatched} ${s.hasCriticalDrift ? `${nc.red}(CRITICAL)${nc.reset}` : ''}`);
  lines.push('');

  if (report.missingInA.length > 0) {
    lines.push(`${nc.yellow}Missing in ${report.environmentA}:${nc.reset}`);
    for (const item of report.missingInA) {
      lines.push(`  ${item.key} = ${item[report.environmentB]} ${nc.gray}(${item.severity})${nc.reset}`);
    }
    lines.push('');
  }

  if (report.missingInB.length > 0) {
    lines.push(`${nc.yellow}Missing in ${report.environmentB}:${nc.reset}`);
    for (const item of report.missingInB) {
      lines.push(`  ${item.key} = ${item[report.environmentA]} ${nc.gray}(${item.severity})${nc.reset}`);
    }
    lines.push('');
  }

  if (report.mismatched.length > 0) {
    lines.push(`${nc.red}Mismatched values (unexpected drift):${nc.reset}`);
    for (const item of report.mismatched) {
      lines.push(`  ${item.key}:`);
      lines.push(`    ${report.environmentA}: ${item[report.environmentA]}`);
      lines.push(`    ${report.environmentB}: ${item[report.environmentB]}`);
      lines.push(`    ${nc.gray}Severity: ${item.severity}${nc.reset}`);
    }
    lines.push('');
  }

  if (report.allowedDifferences.length > 0) {
    lines.push(`${nc.blue}Allowed differences (expected):${nc.reset}`);
    for (const item of report.allowedDifferences) {
      lines.push(`  ${item.key} [${item.rule}]: ${item.description}`);
      lines.push(`    ${report.environmentA}: ${item[report.environmentA]}`);
      lines.push(`    ${report.environmentB}: ${item[report.environmentB]}`);
    }
    lines.push('');
  }

  if (verbose && report.matching.length > 0) {
    lines.push(`${nc.gray}Matching keys (${report.matching.length}):${nc.reset}`);
    for (const item of report.matching) {
      lines.push(`  ${item.key} = ${item.value}`);
    }
    lines.push('');
  }

  // Overall status
  if (s.hasCriticalDrift || s.hasHighDrift || s.missingInA > 0 || s.missingInB > 0) {
    lines.push(`${nc.red}${nc.bold}⚠ DRIFT DETECTED${nc.reset} - Review mismatched and missing keys above.`);
  } else {
    lines.push(`${nc.green}${nc.bold}✓ NO UNEXPECTED DRIFT${nc.reset} - All differences are documented/allowed.`);
  }

  return lines.join('\n');
}

/**
 * Parse an environment file (.env, .env.local, etc.) into an object.
 */
export function parseEnvFile(content) {
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    // Remove surrounding quotes if present
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

/**
 * Load environment from a file path.
 */
export function loadEnvFile(filePath) {
  import('node:fs').then(fs => {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseEnvFile(content);
  });
}