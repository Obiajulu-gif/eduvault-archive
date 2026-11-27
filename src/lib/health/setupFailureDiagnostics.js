/**
 * src/lib/health/setupFailureDiagnostics.js
 *
 * Contributor diagnostics for local setup failures (#1079).
 *
 * `contributorDiagnostics.js` (#1061) reports dependency health. This module
 * covers the steps before that: the local checkout itself. It answers
 * "why does `npm run dev` / `npm test` fail on my machine?" with a stable
 * failure code, a category, and one concrete fix for each problem.
 *
 * Categories decide what a contributor should do next:
 *   - configuration  -> edit local config, retrying will not help
 *   - connectivity   -> a local service is not reachable yet, retry is safe
 *   - authorization  -> credentials were rejected, retrying will not help and
 *                       repeated attempts can lock an account, so never retry
 *   - dependencies   -> install or reinstall packages
 *   - runtime        -> wrong Node.js version or platform tooling
 *
 * Guarantees:
 *   - Pure and injectable: filesystem, env, Node version, and sleep are all
 *     passed in, so every path is covered by tests without a real machine.
 *   - Read-only: nothing is written, installed, or started.
 *   - No secret values: only key names and presence are reported, and every
 *     error message goes through `sanitizeDiagnostics`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sanitizeDiagnostics } from './dependencyChecker.js';

export const SETUP_FAILURE_CATEGORY = Object.freeze({
  CONFIGURATION: 'configuration',
  CONNECTIVITY: 'connectivity',
  AUTHORIZATION: 'authorization',
  DEPENDENCIES: 'dependencies',
  RUNTIME: 'runtime',
  UNKNOWN: 'unknown',
});

export const SETUP_STATUS = Object.freeze({
  READY: 'ready',
  RETRY_LATER: 'retry_later',
  ACTION_REQUIRED: 'action_required',
});

/** Exit codes used by the CLI. 75 is EX_TEMPFAIL from sysexits.h. */
export const SETUP_EXIT_CODE = Object.freeze({
  [SETUP_STATUS.READY]: 0,
  [SETUP_STATUS.ACTION_REQUIRED]: 1,
  [SETUP_STATUS.RETRY_LATER]: 75,
});

export const MIN_NODE_MAJOR = 20;

/** Keys a local checkout needs before `npm run dev` can serve pages. */
export const REQUIRED_LOCAL_ENV = Object.freeze(['NEXT_PUBLIC_APP_URL', 'MONGODB_URI', 'JWT_SECRET']);

const PLACEHOLDER_VALUES = new Set([
  'replace-with-a-long-random-string',
  'replace-me',
  'change-me',
  'changeme',
  'your-secret-here',
  'YOUR_PINATA_JWT',
  'YOUR_MONGODB_URI',
]);

const LOCKFILES = Object.freeze(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

const ERROR_RULES = [
  {
    code: 'SERVICE_UNREACHABLE',
    category: SETUP_FAILURE_CATEGORY.CONNECTIVITY,
    retryable: true,
    match: (code, msg) =>
      ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(code) ||
      /server selection timed out|connection timed out|connect econnrefused|timed out/i.test(msg),
    remediation: 'Start the local service (for MongoDB: `docker compose up -d mongodb`) and rerun diagnostics.',
  },
  {
    code: 'HOST_NOT_FOUND',
    category: SETUP_FAILURE_CATEGORY.CONFIGURATION,
    retryable: false,
    match: (code, msg) => code === 'ENOTFOUND' || /getaddrinfo enotfound/i.test(msg),
    remediation: 'The host name in your connection string does not resolve. Check for typos in .env.local.',
  },
  {
    code: 'CREDENTIALS_REJECTED',
    category: SETUP_FAILURE_CATEGORY.AUTHORIZATION,
    retryable: false,
    match: (code, msg, status) =>
      status === 401 ||
      status === 403 ||
      code === 'EAUTH' ||
      /authentication failed|unauthorized|forbidden|invalid credentials|not authorized/i.test(msg),
    remediation:
      'The service rejected your credentials. Regenerate the key or password and update .env.local. Diagnostics will not retry, so repeated attempts cannot lock the account.',
  },
  {
    code: 'PERMISSION_DENIED',
    category: SETUP_FAILURE_CATEGORY.AUTHORIZATION,
    retryable: false,
    match: (code) => code === 'EACCES' || code === 'EPERM',
    remediation: 'Your user cannot access a file or port. Fix ownership of the checkout (do not run npm with sudo).',
  },
  {
    code: 'PORT_IN_USE',
    category: SETUP_FAILURE_CATEGORY.CONFIGURATION,
    retryable: false,
    match: (code) => code === 'EADDRINUSE',
    remediation: 'Another process holds the port. Stop it, or start Next.js on another port with `npm run dev -- -p 3001`.',
  },
  {
    code: 'MODULE_MISSING',
    category: SETUP_FAILURE_CATEGORY.DEPENDENCIES,
    retryable: false,
    match: (code, msg) =>
      code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND' || /cannot find (module|package)/i.test(msg),
    remediation: 'Packages are missing or out of date. Run `npm ci` from the repository root.',
  },
];

function failure(code, category, message, remediation, retryable = false) {
  return { code, category, message, remediation, retryable };
}

/**
 * Turns an arbitrary error from a local setup step into a stable, sanitized
 * failure record. Unknown errors are never retried.
 *
 * @param {unknown} error
 * @returns {{ code: string, category: string, message: string, remediation: string, retryable: boolean }}
 */
export function classifySetupError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status) || null;
  const rawMessage = typeof error === 'string' ? error : error?.message || 'Unknown setup error';
  const message = String(sanitizeDiagnostics(String(rawMessage))).slice(0, 300);

  // Authorization wins over connectivity: "authentication failed ... timed out"
  // must never be retried.
  const ordered = [...ERROR_RULES].sort((a, b) => {
    const rank = (rule) => (rule.category === SETUP_FAILURE_CATEGORY.AUTHORIZATION ? 0 : 1);
    return rank(a) - rank(b);
  });
  for (const rule of ordered) {
    if (rule.match(code, rawMessage, status)) {
      return failure(rule.code, rule.category, message, rule.remediation, rule.retryable);
    }
  }
  return failure(
    'UNCLASSIFIED',
    SETUP_FAILURE_CATEGORY.UNKNOWN,
    message,
    'Rerun with `npm run diagnostics:contributor -- --json` and attach the report to your support request.',
    false
  );
}

function parseNodeMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version || ''));
  return match ? Number(match[1]) : null;
}

/**
 * Parses KEY=VALUE lines from an env file. Values are only used for presence
 * and placeholder checks and are never returned.
 */
export function parseEnvFile(content) {
  const result = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const defaultFs = {
  exists: (p) => fs.existsSync(p),
  read: (p) => fs.readFileSync(p, 'utf8'),
};

/**
 * Static, offline checks of a local checkout. Never touches the network.
 *
 * @param {object} [options]
 * @param {string} [options.rootDir]      repository root
 * @param {object} [options.env]          process environment (wins over .env.local)
 * @param {string} [options.nodeVersion]  defaults to process.version
 * @param {{exists: Function, read: Function}} [options.fsApi]
 * @returns {Array<object>} failures, empty when the checkout looks ready
 */
export function checkLocalSetup({
  rootDir = process.cwd(),
  env = process.env,
  nodeVersion = process.version,
  fsApi = defaultFs,
} = {}) {
  const failures = [];
  const at = (name) => path.join(rootDir, name);

  const major = parseNodeMajor(nodeVersion);
  if (major === null || major < MIN_NODE_MAJOR) {
    failures.push(
      failure(
        'NODE_VERSION_UNSUPPORTED',
        SETUP_FAILURE_CATEGORY.RUNTIME,
        `Node.js ${nodeVersion || 'unknown'} is older than the supported ${MIN_NODE_MAJOR}.x used by CI.`,
        `Install Node.js ${MIN_NODE_MAJOR} or newer (for example \`nvm install ${MIN_NODE_MAJOR}\`).`
      )
    );
  }

  if (!fsApi.exists(at('package.json'))) {
    failures.push(
      failure(
        'NOT_REPOSITORY_ROOT',
        SETUP_FAILURE_CATEGORY.CONFIGURATION,
        'package.json was not found. Diagnostics must run from the repository root.',
        'cd into the eduvault-archive checkout and rerun the command.'
      )
    );
    return failures;
  }

  const lockfiles = LOCKFILES.filter((name) => fsApi.exists(at(name)));
  if (!lockfiles.includes('package-lock.json')) {
    failures.push(
      failure(
        'NPM_LOCKFILE_MISSING',
        SETUP_FAILURE_CATEGORY.DEPENDENCIES,
        'package-lock.json is missing, so installs are not reproducible.',
        'Restore it with `git checkout -- package-lock.json`, then run `npm ci`.'
      )
    );
  }
  const foreign = lockfiles.filter((name) => name !== 'package-lock.json');
  if (foreign.length > 0) {
    failures.push(
      failure(
        'CONFLICTING_LOCKFILES',
        SETUP_FAILURE_CATEGORY.DEPENDENCIES,
        `Found ${foreign.join(', ')} next to package-lock.json. CI installs with npm only.`,
        `Delete ${foreign.join(', ')} and run \`npm ci\`.`
      )
    );
  }

  if (!fsApi.exists(at(path.join('node_modules', '.package-lock.json'))) && !fsApi.exists(at('node_modules'))) {
    failures.push(
      failure(
        'DEPENDENCIES_NOT_INSTALLED',
        SETUP_FAILURE_CATEGORY.DEPENDENCIES,
        'node_modules is missing.',
        'Run `npm ci` from the repository root.'
      )
    );
  }

  let fileEnv = {};
  if (fsApi.exists(at('.env.local'))) {
    try {
      fileEnv = parseEnvFile(fsApi.read(at('.env.local')));
    } catch (error) {
      failures.push(
        failure(
          'ENV_FILE_UNREADABLE',
          SETUP_FAILURE_CATEGORY.AUTHORIZATION,
          `.env.local exists but cannot be read: ${sanitizeDiagnostics(error?.message || 'unknown error')}`,
          'Fix the file permissions on .env.local (it should be readable by your user).'
        )
      );
    }
  } else if (!REQUIRED_LOCAL_ENV.every((key) => env?.[key])) {
    failures.push(
      failure(
        'ENV_FILE_MISSING',
        SETUP_FAILURE_CATEGORY.CONFIGURATION,
        '.env.local is missing and the required variables are not exported in your shell.',
        'Run `cp .env.example .env.local` and fill in the values.'
      )
    );
  }

  const merged = { ...fileEnv, ...(env || {}) };
  const missing = REQUIRED_LOCAL_ENV.filter((key) => !String(merged[key] ?? '').trim());
  if (missing.length > 0) {
    failures.push(
      failure(
        'ENV_REQUIRED_MISSING',
        SETUP_FAILURE_CATEGORY.CONFIGURATION,
        `Required variables are empty: ${missing.join(', ')}.`,
        `Set ${missing.join(', ')} in .env.local (see .env.example for examples).`
      )
    );
  }

  const placeholders = Object.keys(merged)
    .filter((key) => PLACEHOLDER_VALUES.has(String(merged[key]).trim()))
    .sort();
  if (placeholders.length > 0) {
    failures.push(
      failure(
        'ENV_PLACEHOLDER_VALUE',
        SETUP_FAILURE_CATEGORY.CONFIGURATION,
        `Variables still hold the example placeholder: ${placeholders.join(', ')}.`,
        `Replace the placeholder for ${placeholders.join(', ')} (for secrets: \`openssl rand -hex 32\`).`
      )
    );
  }

  const mongoUri = String(merged.MONGODB_URI ?? '').trim();
  if (mongoUri && !/^mongodb(\+srv)?:\/\//.test(mongoUri)) {
    failures.push(
      failure(
        'MONGODB_URI_MALFORMED',
        SETUP_FAILURE_CATEGORY.CONFIGURATION,
        'MONGODB_URI must start with mongodb:// or mongodb+srv://.',
        'Use mongodb://localhost:27017/eduvault for the docker compose database.'
      )
    );
  }

  const sandbox = String(merged.EDUVAULT_SANDBOX ?? '').trim().toLowerCase() === 'true';
  if (!sandbox && !String(merged.PINATA_JWT ?? '').trim()) {
    failures.push(
      failure(
        'STORAGE_NOT_CONFIGURED',
        SETUP_FAILURE_CATEGORY.CONFIGURATION,
        'PINATA_JWT is empty and sandbox mode is off, so uploads will fail.',
        'Set EDUVAULT_SANDBOX=true for local work without Pinata, or add a PINATA_JWT.'
      )
    );
  }

  return failures;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a connectivity probe, retrying only failures that are safe to retry.
 * Authorization and configuration failures stop on the first attempt.
 *
 * @param {string} name
 * @param {() => Promise<unknown>} probeFn
 * @param {object} [options]
 * @param {number} [options.attempts=3]
 * @param {number} [options.baseDelayMs=250]  doubled after every attempt
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
export async function probeWithRetry(name, probeFn, { attempts = 3, baseDelayMs = 250, sleep = defaultSleep } = {}) {
  const maxAttempts = Math.max(1, Math.floor(attempts));
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await probeFn();
      return { name, ok: true, attempts: attempt, failure: null };
    } catch (error) {
      last = classifySetupError(error);
      if (!last.retryable || attempt === maxAttempts) {
        return { name, ok: false, attempts: attempt, failure: last };
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  return { name, ok: false, attempts: maxAttempts, failure: last };
}

/**
 * Combines static failures and probe results into one report.
 *
 * Status rules:
 *   - any non-retryable failure          -> action_required
 *   - only retryable connectivity issues -> retry_later
 *   - nothing failed                     -> ready
 */
export function buildSetupReport({ failures = [], probes = [], now = new Date() } = {}) {
  const probeFailures = probes.filter((p) => !p.ok && p.failure).map((p) => ({ ...p.failure, probe: p.name }));
  const all = [...failures, ...probeFailures];
  let status = SETUP_STATUS.READY;
  if (all.some((f) => !f.retryable)) status = SETUP_STATUS.ACTION_REQUIRED;
  else if (all.length > 0) status = SETUP_STATUS.RETRY_LATER;

  const byCategory = {};
  for (const item of all) byCategory[item.category] = (byCategory[item.category] || 0) + 1;

  return sanitizeDiagnostics({
    generatedAt: now.toISOString(),
    status,
    exitCode: SETUP_EXIT_CODE[status],
    failures: all,
    probes: probes.map((p) => ({ name: p.name, ok: p.ok, attempts: p.attempts })),
    summary: { total: all.length, byCategory },
  });
}

/** Plain-text rendering for terminals. */
export function formatSetupReport(report) {
  const lines = [`Local setup: ${report.status.toUpperCase()}`];
  for (const item of report.failures) {
    const retry = item.retryable ? ' (retryable)' : '';
    lines.push(`- [${item.category}] ${item.code}${retry}: ${item.message}`);
    lines.push(`  fix: ${item.remediation}`);
  }
  if (report.failures.length === 0) lines.push('No local setup problems found.');
  return lines.join('\n');
}
