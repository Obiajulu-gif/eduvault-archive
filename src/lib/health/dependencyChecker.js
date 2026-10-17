/**
 * src/lib/health/dependencyChecker.js
 *
 * Dependency Health Checks for External Services and Network Assumptions (Issue #843).
 *
 * Provides structured health checks with 4 states:
 * - healthy: fully operational and responsive
 * - degraded: operational with reduced capabilities, high latency, or local fallback
 * - unavailable: service unreachable, offline, or connection refused
 * - misconfigured: invalid credentials format, missing required environment variables, malformed endpoints
 *
 * Guarantees:
 * - All secrets, tokens, connection strings, and Stellar private keys are STRICTLY redacted.
 * - Clear remediation hints for operators and maintainers on any failure or degradation.
 */

import { sanitizeText, sanitizeErrorMessage } from '../status/publicStatusModel.js';

export const DEPENDENCY_STATUS = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNAVAILABLE: 'unavailable',
  MISCONFIGURED: 'misconfigured',
});

export const REQUIRED_DEPENDENCIES = Object.freeze({
  DATABASE: 'database',
  STORAGE: 'storage',
  STELLAR: 'stellar',
  EMAIL: 'email',
  CONTRACTS: 'contracts',
});

const CONTRACT_ID_PATTERN = /^C[A-Z0-9]{55}$/;

const PLACEHOLDERS = new Set([
  '',
  'replace-with-a-long-random-string',
  'replace-me',
  'change-me',
  'your-secret-here',
  'YOUR_PROJECT_ID',
  'YOUR_PINATA_JWT',
  'YOUR_MONGODB_URI',
  'CHANGE_ME',
  'changeme',
  'xxxx',
  'secret',
  'password',
]);

function isPlaceholder(value) {
  return typeof value !== 'string' || PLACEHOLDERS.has(value.trim());
}

/**
 * Strips credentials, tokens, and seeds from any arbitrary string or object.
 *
 * @param {unknown} value
 * @returns {unknown} Redacted value
 */
export function sanitizeDiagnostics(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return sanitizeText(value)
      .replace(/(mongodb(?:\+srv)?:\/\/)[^@\s]+@/gi, '$1[REDACTED_CREDENTIALS]@')
      .replace(/((?:password|passwd|secret|jwt|token|apiKey|auth)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .replace(/\bS[A-Za-z0-9]{50,60}\b/g, '[REDACTED_STELLAR_SECRET]')
      .replace(/\b0x[a-fA-F0-9]{64}\b/g, '[REDACTED_EVM_PRIVATE_KEY]');
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeDiagnostics);
  }
  if (typeof value === 'object' && !(value instanceof Date)) {
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
      const lower = k.toLowerCase();
      const sanitizedVal = sanitizeDiagnostics(v);
      if (
        (lower.includes('secret') ||
          lower.includes('password') ||
          lower.includes('token') ||
          lower.includes('jwt') ||
          lower.includes('key') ||
          lower.includes('auth')) &&
        typeof v === 'string' &&
        sanitizedVal === v
      ) {
        clean[k] = '[REDACTED]';
      } else {
        clean[k] = sanitizedVal;
      }
    }
    return clean;
  }
  return value;
}

/**
 * 1. Database Dependency Check (MongoDB)
 * Checks MONGODB_URI configuration, connects, and sends ping command.
 */
export async function checkDatabaseDependency(options = {}) {
  const env = options.env || process.env;
  const mongoUri = env.MONGODB_URI;
  const timeoutMs = options.timeoutMs ?? 3000;

  if (isPlaceholder(mongoUri)) {
    return {
      name: REQUIRED_DEPENDENCIES.DATABASE,
      status: DEPENDENCY_STATUS.MISCONFIGURED,
      critical: true,
      message: 'MONGODB_URI is missing or set to a placeholder.',
      remediation: 'Configure MONGODB_URI in environment variables with a valid connection string (e.g., mongodb://localhost:27017/eduvault).',
      latencyMs: null,
    };
  }

  // Validate format
  if (!mongoUri.startsWith('mongodb://') && !mongoUri.startsWith('mongodb+srv://')) {
    return {
      name: REQUIRED_DEPENDENCIES.DATABASE,
      status: DEPENDENCY_STATUS.MISCONFIGURED,
      critical: true,
      message: 'MONGODB_URI format is invalid. Must start with mongodb:// or mongodb+srv://.',
      remediation: 'Correct MONGODB_URI to start with mongodb:// or mongodb+srv:// protocol.',
      latencyMs: null,
    };
  }

  const startTime = Date.now();
  try {
    if (options.db) {
      await options.db.command({ ping: 1 });
    } else {
      const { getDb } = await import('../mongodb.js');
      const db = await Promise.race([
        getDb(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('MongoDB connection timed out')), timeoutMs)),
      ]);
      await db.command({ ping: 1 });
    }
    const latencyMs = Date.now() - startTime;

    if (latencyMs > 1500) {
      return {
        name: REQUIRED_DEPENDENCIES.DATABASE,
        status: DEPENDENCY_STATUS.DEGRADED,
        critical: true,
        message: `MongoDB response is slow (${latencyMs}ms).`,
        remediation: 'Inspect database network latency, replica set performance, and active connection pool utilization.',
        latencyMs,
      };
    }

    return {
      name: REQUIRED_DEPENDENCIES.DATABASE,
      status: DEPENDENCY_STATUS.HEALTHY,
      critical: true,
      message: 'MongoDB is connected and responsive.',
      remediation: null,
      latencyMs,
    };
  } catch (err) {
    const cleanErr = sanitizeDiagnostics(sanitizeErrorMessage(err));
    return {
      name: REQUIRED_DEPENDENCIES.DATABASE,
      status: DEPENDENCY_STATUS.UNAVAILABLE,
      critical: true,
      message: `Database ping failed: ${cleanErr}`,
      remediation: 'Verify MongoDB is running, network routing allows port access, and cluster firewall permits traffic.',
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * 2. Storage / IPFS Dependency Check (Pinata)
 * Checks PINATA_JWT and verifies authentication with Pinata API.
 */
export async function checkStorageDependency(options = {}) {
  const env = options.env || process.env;
  const pinataJwt = env.PINATA_JWT;
  const gatewayUrl = env.NEXT_PUBLIC_GATEWAY_URL;

  if (isPlaceholder(pinataJwt)) {
    return {
      name: REQUIRED_DEPENDENCIES.STORAGE,
      status: DEPENDENCY_STATUS.MISCONFIGURED,
      critical: false,
      message: 'PINATA_JWT is missing or set to a placeholder.',
      remediation: 'Add a valid PINATA_JWT from Pinata Dashboard with pinList and pinFile permissions.',
      latencyMs: null,
    };
  }

  const startTime = Date.now();
  try {
    if (options.pinataClient) {
      await options.pinataClient.testAuthentication();
    } else {
      const { pinata } = await import('../pinata.js');
      await pinata.testAuthentication();
    }
    const latencyMs = Date.now() - startTime;

    if (!gatewayUrl || isPlaceholder(gatewayUrl) || gatewayUrl.includes('gateway.pinata.cloud')) {
      return {
        name: REQUIRED_DEPENDENCIES.STORAGE,
        status: DEPENDENCY_STATUS.DEGRADED,
        critical: false,
        message: 'Pinata authenticated, but dedicated gateway URL is not configured (using public gateway fallback).',
        remediation: 'Set NEXT_PUBLIC_GATEWAY_URL to your dedicated Pinata gateway URL to prevent public gateway rate limits.',
        latencyMs,
      };
    }

    return {
      name: REQUIRED_DEPENDENCIES.STORAGE,
      status: DEPENDENCY_STATUS.HEALTHY,
      critical: false,
      message: 'Pinata IPFS service authenticated and operational.',
      remediation: null,
      latencyMs,
    };
  } catch (err) {
    const cleanErr = sanitizeDiagnostics(sanitizeErrorMessage(err));
    return {
      name: REQUIRED_DEPENDENCIES.STORAGE,
      status: DEPENDENCY_STATUS.UNAVAILABLE,
      critical: false,
      message: `Pinata IPFS authentication failed: ${cleanErr}`,
      remediation: 'Verify PINATA_JWT is active, not revoked, and outbound requests to api.pinata.cloud are allowed.',
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * 3. Stellar Blockchain & Network Assumptions Check (Horizon & Soroban RPC)
 */
export async function checkStellarDependency(options = {}) {
  const env = options.env || process.env;
  const rpcUrl = env.NEXT_PUBLIC_STELLAR_RPC_URL || env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
  const horizonUrl = env.NEXT_PUBLIC_HORIZON_URL || (env.NEXT_PUBLIC_STELLAR_NETWORK === 'PUBLIC'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org');

  if (!rpcUrl.startsWith('http://') && !rpcUrl.startsWith('https://')) {
    return {
      name: REQUIRED_DEPENDENCIES.STELLAR,
      status: DEPENDENCY_STATUS.MISCONFIGURED,
      critical: true,
      message: 'STELLAR_RPC_URL must start with http:// or https://.',
      remediation: 'Update NEXT_PUBLIC_STELLAR_RPC_URL to a valid RPC endpoint (e.g. https://soroban-testnet.stellar.org).',
      latencyMs: null,
    };
  }

  if (!horizonUrl.startsWith('http://') && !horizonUrl.startsWith('https://')) {
    return {
      name: REQUIRED_DEPENDENCIES.STELLAR,
      status: DEPENDENCY_STATUS.MISCONFIGURED,
      critical: true,
      message: 'HORIZON_URL must start with http:// or https://.',
      remediation: 'Update NEXT_PUBLIC_HORIZON_URL to a valid Horizon endpoint.',
      latencyMs: null,
    };
  }

  const startTime = Date.now();
  try {
    let horizonOk = false;
    let rpcHealthStatus = 'unknown';

    if (options.horizonServer && options.rpcServer) {
      await options.horizonServer.root();
      horizonOk = true;
      const health = await options.rpcServer.getHealth();
      rpcHealthStatus = health?.status || 'unknown';
    } else {
      const { Server, rpc } = await import('@stellar/stellar-sdk');
      const horizonServer = new Server(horizonUrl);
      await horizonServer.root();
      horizonOk = true;

      const rpcServer = new rpc.Server(rpcUrl);
      const health = await rpcServer.getHealth();
      rpcHealthStatus = health?.status || 'unknown';
    }

    const latencyMs = Date.now() - startTime;

    if (horizonOk && rpcHealthStatus === 'healthy') {
      return {
        name: REQUIRED_DEPENDENCIES.STELLAR,
        status: DEPENDENCY_STATUS.HEALTHY,
        critical: true,
        message: 'Stellar Horizon and Soroban RPC endpoints are healthy.',
        remediation: null,
        latencyMs,
      };
    }

    return {
      name: REQUIRED_DEPENDENCIES.STELLAR,
      status: DEPENDENCY_STATUS.DEGRADED,
      critical: true,
      message: `Soroban RPC reported non-healthy status: ${sanitizeDiagnostics(rpcHealthStatus)}`,
      remediation: 'Wait for Soroban RPC node sync or switch NEXT_PUBLIC_STELLAR_RPC_URL to an alternate node provider.',
      latencyMs,
    };
  } catch (err) {
    const cleanErr = sanitizeDiagnostics(sanitizeErrorMessage(err));
    return {
      name: REQUIRED_DEPENDENCIES.STELLAR,
      status: DEPENDENCY_STATUS.UNAVAILABLE,
      critical: true,
      message: `Stellar network endpoint unreachable: ${cleanErr}`,
      remediation: 'Ensure your network connection is active and Stellar Horizon / Soroban RPC nodes are online.',
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * 4. Email / Notifications Dependency Check (Nodemailer / SMTP)
 */
export async function checkEmailDependency(options = {}) {
  const env = options.env || process.env;
  const isProduction = env.NODE_ENV === 'production';
  const smtpHost = env.SMTP_HOST;
  const smtpUser = env.SMTP_USER || env.EMAIL_USER;
  const smtpPass = env.SMTP_PASS || env.EMAIL_PASS;

  const hasAnyEmailConfig = Boolean(smtpHost || smtpUser || smtpPass);

  if (!hasAnyEmailConfig) {
    if (isProduction) {
      return {
        name: REQUIRED_DEPENDENCIES.EMAIL,
        status: DEPENDENCY_STATUS.MISCONFIGURED,
        critical: false,
        message: 'Email service credentials not configured in production.',
        remediation: 'Configure SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS (or EMAIL_USER/EMAIL_PASS) in production.',
        latencyMs: null,
      };
    }
    return {
      name: REQUIRED_DEPENDENCIES.EMAIL,
      status: DEPENDENCY_STATUS.DEGRADED,
      critical: false,
      message: 'Email credentials not set; running in local mock fallback mode.',
      remediation: 'Set SMTP credentials in .env if you wish to test welcome emails and purchase receipts locally.',
      latencyMs: null,
    };
  }

  // Partial configuration check
  if ((smtpUser && !smtpPass) || (!smtpUser && smtpPass)) {
    return {
      name: REQUIRED_DEPENDENCIES.EMAIL,
      status: DEPENDENCY_STATUS.MISCONFIGURED,
      critical: false,
      message: 'SMTP credentials partially configured (missing username or password).',
      remediation: 'Ensure both SMTP_USER and SMTP_PASS are set in environment variables.',
      latencyMs: null,
    };
  }

  const startTime = Date.now();
  try {
    if (options.emailVerifier) {
      await options.emailVerifier();
    } else {
      const { verifyEmailConnection } = await import('../email.js');
      await verifyEmailConnection();
    }
    const latencyMs = Date.now() - startTime;

    return {
      name: REQUIRED_DEPENDENCIES.EMAIL,
      status: DEPENDENCY_STATUS.HEALTHY,
      critical: false,
      message: 'SMTP email connection verified and operational.',
      remediation: null,
      latencyMs,
    };
  } catch (err) {
    const cleanErr = sanitizeDiagnostics(sanitizeErrorMessage(err));
    return {
      name: REQUIRED_DEPENDENCIES.EMAIL,
      status: DEPENDENCY_STATUS.UNAVAILABLE,
      critical: false,
      message: `SMTP connection verification failed: ${cleanErr}`,
      remediation: 'Check SMTP server address, port (587 or 465), SSL/TLS settings, and authentication credentials.',
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * 5. Smart Contracts Configuration Check (Soroban Contract IDs)
 */
export async function checkContractsDependency(options = {}) {
  const env = options.env || process.env;
  const isProduction = env.NODE_ENV === 'production';

  const materialContract = env.NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID;
  const purchaseContract = env.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID;
  const sorobanContract = env.NEXT_PUBLIC_SOROBAN_CONTRACT_ID;

  const configuredContracts = {
    materialRegistry: materialContract,
    purchaseManager: purchaseContract,
    sorobanContract: sorobanContract,
  };

  const invalidContracts = [];
  let configuredCount = 0;

  for (const [key, id] of Object.entries(configuredContracts)) {
    if (id && !isPlaceholder(id)) {
      configuredCount++;
      if (!CONTRACT_ID_PATTERN.test(id.trim())) {
        invalidContracts.push(`${key} (${sanitizeDiagnostics(id)})`);
      }
    }
  }

  if (invalidContracts.length > 0) {
    return {
      name: REQUIRED_DEPENDENCIES.CONTRACTS,
      status: DEPENDENCY_STATUS.MISCONFIGURED,
      critical: true,
      message: `Invalid Soroban contract ID format: ${invalidContracts.join(', ')}. Expected 56-char C-prefixed address.`,
      remediation: 'Check NEXT_PUBLIC_*_CONTRACT_ID in environment variables and provide valid 56-character C-prefixed Stellar contract addresses.',
      latencyMs: null,
    };
  }

  if (configuredCount === 0) {
    if (isProduction) {
      return {
        name: REQUIRED_DEPENDENCIES.CONTRACTS,
        status: DEPENDENCY_STATUS.UNAVAILABLE,
        critical: true,
        message: 'No Soroban smart contracts configured in production environment.',
        remediation: 'Deploy Soroban contracts (npm run deploy:soroban) and populate NEXT_PUBLIC_*_CONTRACT_ID in .env.',
        latencyMs: null,
      };
    }
    return {
      name: REQUIRED_DEPENDENCIES.CONTRACTS,
      status: DEPENDENCY_STATUS.DEGRADED,
      critical: false,
      message: 'Soroban contract IDs are not set; on-chain licensing and settlement run in mock/test sandbox mode.',
      remediation: 'Run `npm run deploy:soroban` or configure NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID in .env.local to test on-chain contracts.',
      latencyMs: null,
    };
  }

  return {
    name: REQUIRED_DEPENDENCIES.CONTRACTS,
    status: DEPENDENCY_STATUS.HEALTHY,
    critical: false,
    message: `Soroban smart contracts configured (${configuredCount} active contract IDs).`,
    remediation: null,
    latencyMs: null,
  };
}

/**
 * Runs all dependency health checks concurrently and aggregates results.
 *
 * @param {object} [options]
 * @returns {Promise<object>} Complete health diagnostics
 */
export async function checkAllDependencies(options = {}) {
  const [dbResult, storageResult, stellarResult, emailResult, contractsResult] =
    await Promise.all([
      checkDatabaseDependency(options),
      checkStorageDependency(options),
      checkStellarDependency(options),
      checkEmailDependency(options),
      checkContractsDependency(options),
    ]);

  const dependencies = {
    [REQUIRED_DEPENDENCIES.DATABASE]: dbResult,
    [REQUIRED_DEPENDENCIES.STORAGE]: storageResult,
    [REQUIRED_DEPENDENCIES.STELLAR]: stellarResult,
    [REQUIRED_DEPENDENCIES.EMAIL]: emailResult,
    [REQUIRED_DEPENDENCIES.CONTRACTS]: contractsResult,
  };

  const resultsList = Object.values(dependencies);

  // Overall status evaluation:
  // 1. If any critical service is UNAVAILABLE -> overall UNAVAILABLE
  // 2. If any critical service is MISCONFIGURED -> overall MISCONFIGURED
  // 3. If any service is DEGRADED or non-critical service UNAVAILABLE/MISCONFIGURED -> overall DEGRADED
  // 4. Otherwise -> HEALTHY
  let overallStatus = DEPENDENCY_STATUS.HEALTHY;
  const criticalUnavailable = resultsList.some((r) => r.critical && r.status === DEPENDENCY_STATUS.UNAVAILABLE);
  const criticalMisconfigured = resultsList.some((r) => r.critical && r.status === DEPENDENCY_STATUS.MISCONFIGURED);
  const anyDegradedOrFailed = resultsList.some((r) => r.status !== DEPENDENCY_STATUS.HEALTHY);

  if (criticalUnavailable) {
    overallStatus = DEPENDENCY_STATUS.UNAVAILABLE;
  } else if (criticalMisconfigured) {
    overallStatus = DEPENDENCY_STATUS.MISCONFIGURED;
  } else if (anyDegradedOrFailed) {
    overallStatus = DEPENDENCY_STATUS.DEGRADED;
  }

  const remediations = resultsList
    .filter((r) => r.remediation)
    .map((r) => ({
      dependency: r.name,
      status: r.status,
      hint: r.remediation,
    }));

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    dependencies,
    remediations,
    summary: {
      total: resultsList.length,
      healthy: resultsList.filter((r) => r.status === DEPENDENCY_STATUS.HEALTHY).length,
      degraded: resultsList.filter((r) => r.status === DEPENDENCY_STATUS.DEGRADED).length,
      unavailable: resultsList.filter((r) => r.status === DEPENDENCY_STATUS.UNAVAILABLE).length,
      misconfigured: resultsList.filter((r) => r.status === DEPENDENCY_STATUS.MISCONFIGURED).length,
    },
  };
}

/**
 * Maintainer-readable CLI formatter for diagnostics report.
 * Guaranteed audit-safe (zero secrets).
 *
 * @param {object} report
 * @returns {string} Formatted text report
 */
export function formatMaintainerReport(report) {
  const lines = [];
  lines.push('\n======================================================');
  lines.push('       EDUVAULT DEPENDENCY HEALTH & DIAGNOSTICS       ');
  lines.push('======================================================');
  lines.push(`OVERALL STATUS : ${report.status.toUpperCase()}`);
  lines.push(`Timestamp      : ${report.timestamp}`);
  lines.push('------------------------------------------------------');

  for (const [name, check] of Object.entries(report.dependencies)) {
    const icon =
      check.status === DEPENDENCY_STATUS.HEALTHY
        ? '[PASS]'
        : check.status === DEPENDENCY_STATUS.DEGRADED
          ? '[WARN]'
          : check.status === DEPENDENCY_STATUS.MISCONFIGURED
            ? '[MISCONFIG]'
            : '[FAIL]';

    const latency = check.latencyMs != null ? ` (${check.latencyMs}ms)` : '';
    lines.push(`${icon.padEnd(11)} ${name.padEnd(12)} : ${check.status.toUpperCase()}${latency}`);
    lines.push(`            Message     : ${check.message}`);
    if (check.remediation) {
      lines.push(`            Remediation : ${check.remediation}`);
    }
  }

  if (report.remediations.length > 0) {
    lines.push('\n--- Actionable Remediation Hints ---');
    for (const rem of report.remediations) {
      lines.push(`* [${rem.dependency.toUpperCase()} - ${rem.status}]: ${rem.hint}`);
    }
  }

  lines.push('======================================================\n');
  return lines.join('\n');
}
