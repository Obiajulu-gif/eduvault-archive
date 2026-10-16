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
 */
const CONTRACT_ID_PATTERN = /^C[A-Z0-9]{55}$/;

function isPlaceholder(value) {
  return typeof value !== "string" || PLACEHOLDERS.has(value.trim());
}

/**
 * Validates a value is not a placeholder
 */
function required(name, value, errors, { productionOnly = false } = {}) {
  if (productionOnly && process.env.NODE_ENV !== "production") {
    return;
  }

  if (isPlaceholder(value)) {
    errors.push(`${name} is missing or still set to a placeholder value.`);
  }
}

/**
 * True when `value` does not look like a deployed Soroban contract ID.
 */
function isInvalidContractId(value) {
  return typeof value !== "string" || !CONTRACT_ID_PATTERN.test(value.trim());
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

function validContractId(name, value, errors) {
  if (isPlaceholder(value)) return;
  if (isInvalidContractId(value)) {
    errors.push(
      `${name} is not a valid Soroban contract ID — expected a 56-character C-prefixed Stellar address.`
    );
  }
}

/**
 * @typedef {Object} EnvSchema
 * @property {string} [NODE_ENV]
 * @property {string} [CI]
 * @property {string} [NEXT_PUBLIC_APP_URL]
 * @property {string} [MONGODB_URI]
 * @property {string} [JWT_SECRET]
 * @property {string} [PINATA_JWT]
 * @property {string} [NEXT_PUBLIC_GATEWAY_URL]
 * @property {string} [NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID]
 * @property {string} [NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID]
 * @property {string} [NEXT_PUBLIC_SOROBAN_CONTRACT_ID]
 * @property {string} [NEXT_PUBLIC_STELLAR_RPC_URL]
 * @property {string} [NEXT_PUBLIC_HORIZON_URL]
 * @property {string} [STELLAR_WEBHOOK_SECRET]
 * @property {string} [CRON_SECRET]
 * @property {string} [WEBHOOK_URL]
 */

/**
 * Validates the runtime environment against our typed schema rules.
 * @returns {string[]} Array of actionable error messages.
 */
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

  const webhookSecret = process.env.STELLAR_WEBHOOK_SECRET || process.env.CRON_SECRET;
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
      errors.push("STELLAR_WEBHOOK_SECRET (or CRON_SECRET) is required in production when webhooks are enabled.");
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
  } else {
    // Fails fast when accidentally using production-like secrets in local mode
    if (process.env.MONGODB_URI && process.env.MONGODB_URI.includes("mongodb+srv://")) {
      errors.push("Local mode should not use a production MongoDB URI (mongodb+srv://).");
    }

    if (process.env.PINATA_JWT && process.env.PINATA_JWT.startsWith("eyJ")) {
      errors.push("Local mode is using a real Pinata JWT. Please use a local mock or a dedicated test token.");
    }
  }

  return errors;
}

export function assertRuntimeEnv() {
  if (process.env.CI === "true" || process.env.NODE_ENV === "test") {
    return;
  }

  const errors = validateRuntimeEnv();
  if (errors.length > 0) {
    throw new Error(`Invalid deployment environment:\n- ${errors.join("\n- ")}`);
  }
}
