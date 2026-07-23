const PLACEHOLDERS = new Set([
  "",
  "replace-with-a-long-random-string",
  "replace-me",
  "change-me",
  "your-secret-here",
  "YOUR_PROJECT_ID",
  "YOUR_PINATA_JWT",
  "YOUR_MONGODB_URI",
]);

function isPlaceholder(value) {
  return typeof value !== "string" || PLACEHOLDERS.has(value.trim());
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

export function validateRuntimeEnv() {
  const errors = [];
  const production = process.env.NODE_ENV === "production";

  required("NEXT_PUBLIC_APP_URL", process.env.NEXT_PUBLIC_APP_URL, errors, { productionOnly: production });
  required("MONGODB_URI", process.env.MONGODB_URI, errors, { productionOnly: production });
  required("JWT_SECRET", process.env.JWT_SECRET, errors, { productionOnly: production });
  required("PINATA_JWT", process.env.PINATA_JWT, errors, { productionOnly: production });
  required("NEXT_PUBLIC_GATEWAY_URL", process.env.NEXT_PUBLIC_GATEWAY_URL, errors, { productionOnly: production });

  optionalWhenEnabled(
    "NEXT_PUBLIC_STELLAR_RPC_URL",
    process.env.NEXT_PUBLIC_STELLAR_RPC_URL,
    errors,
    Boolean(process.env.NEXT_PUBLIC_SOROBAN_CONTRACT_ID),
    { productionOnly: production }
  );
  optionalWhenEnabled(
    "NEXT_PUBLIC_HORIZON_URL",
    process.env.NEXT_PUBLIC_HORIZON_URL,
    errors,
    Boolean(process.env.NEXT_PUBLIC_STELLAR_NETWORK || process.env.NEXT_PUBLIC_SOROBAN_CONTRACT_ID),
    { productionOnly: production }
  );
  optionalWhenEnabled(
    "NEXT_PUBLIC_SOROBAN_CONTRACT_ID",
    process.env.NEXT_PUBLIC_SOROBAN_CONTRACT_ID,
    errors,
    Boolean(process.env.NEXT_PUBLIC_STELLAR_RPC_URL || process.env.NEXT_PUBLIC_HORIZON_URL),
    { productionOnly: production }
  );

  if (process.env.NODE_ENV === "production") {
    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
      errors.push("JWT_SECRET must be at least 32 characters long in production.");
    }

    if (process.env.MONGODB_URI && process.env.MONGODB_URI.includes("localhost")) {
      errors.push("MONGODB_URI must point at a production database in production deployments.");
    }
  }

  return errors;
}

export function assertRuntimeEnv() {
  const errors = validateRuntimeEnv();
  if (errors.length > 0) {
    throw new Error(`Invalid deployment environment:\n- ${errors.join("\n- ")}`);
  }
}
