import { checkAllDependencies, DEPENDENCY_STATUS, sanitizeDiagnostics } from './dependencyChecker.js';

export const ENVIRONMENT_KEYS = [
  'MONGODB_URI',
  'PINATA_JWT',
  'NEXT_PUBLIC_STELLAR_RPC_URL',
  'NEXT_PUBLIC_HORIZON_URL',
  'NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID',
  'NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID',
];

export class ContributorDiagnosticsAuthorizationError extends Error {
  constructor(message = "Unauthorized contributor diagnostics access.") {
    super(message);
    this.name = "ContributorDiagnosticsAuthorizationError";
    this.status = 403;
  }
}

export function assertContributorDiagnosticsAuthorized(actor) {
  if (!actor || (actor.role !== "admin" && actor.role !== "operator" && actor.role !== "contributor" && actor.role !== "service")) {
    throw new ContributorDiagnosticsAuthorizationError("Only contributor, operator, admin, or service identities may run diagnostics.");
  }
}

function checkNodeCompatibility(nodeVersion = process.version) {
  const match = nodeVersion.match(/^v?(\d+)/);
  const major = match ? parseInt(match[1], 10) : 0;
  return {
    version: nodeVersion,
    required: ">=20.0.0",
    compatible: major >= 20,
    warning: major < 20 ? `Node.js ${nodeVersion} is below the recommended version (>=20.0.0).` : null,
  };
}

export function collectContributorDiagnostics({ env = process.env, dependencyReport } = {}) {
  const present = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, Boolean(env[key])]));
  const nodeCheck = checkNodeCompatibility();
  const remediations = [...(dependencyReport?.remediations || [])];

  if (!nodeCheck.compatible && nodeCheck.warning) {
    remediations.unshift({
      dependency: 'node',
      status: 'warning',
      hint: nodeCheck.warning,
    });
  }

  const status = dependencyReport?.status || DEPENDENCY_STATUS.HEALTHY;
  const retryable = status === DEPENDENCY_STATUS.UNAVAILABLE;

  return {
    generatedAt: new Date().toISOString(),
    status,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      nodeCompatibility: nodeCheck,
    },
    packageManager: {
      npmLock: Boolean(env.npm_config_user_agent?.includes('npm')),
      lockfiles: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
    },
    environment: present,
    dependencyReport: sanitizeDiagnostics(dependencyReport),
    remediation: remediations,
    retryable,
  };
}

export async function runContributorDiagnostics(options = {}) {
  if (options.actor) {
    assertContributorDiagnosticsAuthorized(options.actor);
  }

  const maxRetries = Number.isInteger(options.retries) && options.retries > 0 ? options.retries : 0;
  const retryDelayMs = Number.isInteger(options.retryDelayMs) && options.retryDelayMs > 0 ? options.retryDelayMs : 100;
  let attempt = 0;
  let dependencyReport;

  while (true) {
    dependencyReport = options.dependencyReport || await checkAllDependencies(options);
    if (dependencyReport?.status !== DEPENDENCY_STATUS.UNAVAILABLE || attempt >= maxRetries) {
      break;
    }
    attempt++;
    if (typeof options.sleep === 'function') {
      await options.sleep(retryDelayMs * Math.pow(2, attempt - 1));
    } else {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * Math.pow(2, attempt - 1)));
    }
  }

  const diagnostics = collectContributorDiagnostics({ ...options, dependencyReport });
  diagnostics.retryAttempts = attempt;
  return diagnostics;
}
