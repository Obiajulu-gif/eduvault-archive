import pino from "pino";
import { getContext } from "./telemetry/context.js";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  // Automatically attach correlation/trace IDs to every log line without
  // callers having to pass them manually (acceptance criterion: structured
  // fields + correlation model).
  mixin() {
    const ctx = getContext();
    if (!ctx) return {};
    return {
      correlationId: ctx.correlationId,
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      route: ctx.route || undefined,
      jobType: ctx.jobType || undefined,
    };
  },
  transport: isProduction
    ? undefined // In production, log plain JSON
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
});

export default logger;