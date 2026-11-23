import pino from "pino";
import { createLogSafetyOptions } from "./monitoring/logSafety.js";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  // Pseudonymize identifiers, strip URL queries/payloads and redact secrets
  // on every log line (#883). See docs/OBSERVABILITY_TELEMETRY.md.
  ...createLogSafetyOptions(),
  transport: isProduction
    ? undefined // In production, log plain JSON
    : {
        target: "pino-pretty", // In development, log pretty string
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
});

export default logger;
