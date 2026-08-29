const PLACEHOLDERS = new Set([
  "",
  "replace-with-a-long-random-string",
  "replace-me",
  "change-me",
  "your-secret-here",
  "YOUR_PROJECT_ID",
  "YOUR_PINATA_JWT",
  "YOUR_MONGODB_URI",
  "YOUR_STELLAR_WEBHOOK_SECRET",
  "your-stellar-webhook-secret",
  "YOUR_CRON_SECRET",
  "your-cron-secret",
  "CHANGE_ME",
  "changeme",
  "xxxx",
  "secret",
  "password",
]);

/**
 * A Soroban contract ID is a 56-char Stellar address beginning with C
 * (e.g. CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADWKM).
 * Anything else — a placeholder, a 0x address, a truncated value — cannot
 * possibly be a deployed contract, so it must fail fast rather than surface
 * as a confusing runtime error deep in a contract call.
 */
const CONTRACT_ID_PATTERN = /^C[A-Z0-9]{55}$/;

/**
 * True when `value` is missing, blank, or still carrying a placeholder
 * token. This is deliberately strict: a deployment that "works" with a
 * placeholder secret is one that cannot authenticate anything, and failing
 * at startup is cheaper than failing mid-request (#678).
 */
function isPlaceholder(value) {
  return typeof value !== "string" || PLACEHOLDERS.has(value.trim());
}

/** True when `value` does not look like a deployed Soroban contract ID. */
function isInvalidContractId(value) {
  return typeof value !== "string" || !CONTRACT_ID_PATTERN.test(value.trim());
}

function required(name, value, errors, { productionOnly = false } = {}) {
  if (productionOnly && process.env.NODE_ENV !== "production") {
    return;
  }

  if (isPlaceholder(value)) {
    errors.push(`${name} is missing or still set to a placeholder value.`);
  }
}

function optionalWhenEnabled(name, value, errors, enabled, { productionOnly = false } = {}) {
  if (!enabled) return;
  if (productionOnly && process.env.NODE_ENV !== "production") return;
  if (isPlaceholder(value)) {
    errors.push(`${name} is required when the related feature is enabled.`);
  }
}

function requiredWhenSet(name, value, errors, dependencyValue, { productionOnly = false } = {}) {
  if (!dependencyValue) return;
  if (productionOnly && process.env.NODE_ENV !== "production") return;
  if (isPlaceholder(value)) {
    errors.push(`${name} is required when ${dependencyValue} is configured.`);
  }
}

/**
 * Checks a configured contract ID is well-formed. Applies in every
 * environment the check runs in (not just production), because a malformed ID
 * breaks local development too — there is no dev-only way to make a bad
 * contract ID work.
 */
function validContractId(name, value, errors) {
  if (isPlaceholder(value)) return;
  if (isInvalidContractId(value)) {
    errors.push(
      `${name} (${value}) is not a valid Soroban contract ID — expected a 56-character C-prefixed Stellar address.`
    );
  }
}

export function validateRuntimeEnv() {
  const errors = [];
  const production = process.env.NODE_ENV === "production";

  required("NEXT_PUBLIC_APP_URL", process.env.NEXT_PUBLIC_APP_URL, errors, { productionOnly: production });
  required("MONGODB_URI", process.env.MONGODB_URI, errors, { productionOnly: production });
  required("JWT_SECRET", process.env.JWT_SECRET, errors, { productionOnly: production });
  required("PINATA_JWT", process.env.PINATA_JWT, errors, { productionOnly: production });
  required("NEXT_PUBLIC_GATEWAY_URL", process.env.NEXT_PUBLIC_GATEWAY_URL, errors, { productionOnly: production });

  const materialContract = process.env.NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID;
  const purchaseContract = process.env.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID;
  const sorobanContract = process.env.NEXT_PUBLIC_SOROBAN_CONTRACT_ID;
  const hasContract = Boolean(materialContract || purchaseContract || sorobanContract);

  // Any configured contract ID must be well-formed. This runs before the
  // "required when enabled" checks below so a broken ID is reported as a
  // format problem, not silently treated as "set".
  validContractId("NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID", materialContract, errors);
  validContractId("NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID", purchaseContract, errors);
  validContractId("NEXT_PUBLIC_SOROBAN_CONTRACT_ID", sorobanContract, errors);

  optionalWhenEnabled(
    "NEXT_PUBLIC_STELLAR_RPC_URL",
    process.env.NEXT_PUBLIC_STELLAR_RPC_URL,
    errors,
    hasContract,
    { productionOnly: production }
  );
  optionalWhenEnabled(
    "NEXT_PUBLIC_HORIZON_URL",
    process.env.NEXT_PUBLIC_HORIZON_URL,
    errors,
    hasContract,
    { productionOnly: production }
  );

  requiredWhenSet(
    "NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID",
    materialContract,
    errors,
    process.env.NEXT_PUBLIC_STELLAR_RPC_URL,
    { productionOnly: production }
  );
  requiredWhenSet(
    "NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID",
    purchaseContract,
    errors,
    process.env.NEXT_PUBLIC_STELLAR_RPC_URL,
    { productionOnly: production }
  );

  // Webhook integrity secrets (#678). The Stellar indexer and scheduled jobs
  // authenticate via these; a placeholder or missing secret means anyone can
  // forge a webhook delivery. In production the secret must be present and
  // strong; in local development a value is only enforced when the secret is
  // actually relied on (webhooks or cron are configured).
  const webhookSecret =
    process.env.STELLAR_WEBHOOK_SECRET || process.env.CRON_SECRET;
  const webhooksEnabled = Boolean(
    process.env.WEBHOOK_URL ||
      process.env.STELLAR_WEBHOOK_SECRET ||
      process.env.CRON_SECRET
  );
  optionalWhenEnabled(
    "STELLAR_WEBHOOK_SECRET (or CRON_SECRET)",
    webhookSecret,
    errors,
    webhooksEnabled,
    { productionOnly: production }
  );

  if (production) {
    if (webhooksEnabled && isPlaceholder(webhookSecret)) {
      errors.push(
        "STELLAR_WEBHOOK_SECRET (or CRON_SECRET) is required in production when webhooks are enabled."
      );
    }

    if (webhookSecret && webhookSecret.length < 32) {
      errors.push("STELLAR_WEBHOOK_SECRET / CRON_SECRET must be at least 32 characters long in production.");
    }

    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
      errors.push("JWT_SECRET must be at least 32 characters long in production.");
    }

    if (process.env.MONGODB_URI && process.env.MONGODB_URI.includes("localhost")) {
      errors.push("MONGODB_URI must point at a production database in production deployments.");
    }
  }

  return errors;
}

/**
 * Throws with every environment error when the process must not start.
 *
 * The check is skipped under CI so automated jobs that exercise build steps
 * (and therefore this module) can run without a full production .env — the
 * strictness belongs to deployments, not to CI scaffolding.
 */
export function assertRuntimeEnv() {
  if (process.env.CI === "true") {
    return;
  }

  const errors = validateRuntimeEnv();
  if (errors.length > 0) {
    throw new Error(`Invalid deployment environment:\n- ${errors.join("\n- ")}`);
  }
}
