import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateRuntimeEnv } from "../src/lib/env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredRuntimeVariables = [
  "NEXT_PUBLIC_APP_URL",
  "MONGODB_URI",
  "JWT_SECRET",
  "PINATA_JWT",
  "NEXT_PUBLIC_GATEWAY_URL",
];

if (process.env.CI !== "true") {
  console.error("CI must be set to true when running the CI environment check.");
  process.exit(1);
}

const envExamplePath = path.join(root, ".env.example");
if (!fs.existsSync(envExamplePath)) {
  console.error(".env.example is required so developers can reproduce the CI configuration.");
  process.exit(1);
}

const documentedVariables = new Set(
  fs
    .readFileSync(envExamplePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
    .filter(Boolean),
);

const undocumentedVariables = requiredRuntimeVariables.filter(
  (name) => !documentedVariables.has(name),
);
if (undocumentedVariables.length > 0) {
  console.error(`.env.example is missing required CI settings: ${undocumentedVariables.join(", ")}`);
  process.exit(1);
}

const missingVariables = requiredRuntimeVariables.filter((name) => !process.env[name]?.trim());
if (missingVariables.length > 0) {
  console.error(`CI is missing required environment settings: ${missingVariables.join(", ")}`);
  process.exit(1);
}

const errors = validateRuntimeEnv();
if (errors.length > 0) {
  console.error(`Invalid CI environment:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log("CI environment configuration is valid and documented in .env.example.");
