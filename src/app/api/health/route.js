export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import {
  checkAllDependencies,
  DEPENDENCY_STATUS,
  sanitizeDiagnostics,
} from "@/lib/health/dependencyChecker";

const CRITICAL_DEPENDENCIES = ["database"];
const OPTIONAL_DEPENDENCIES = ["email", "pinata"];
const CHAIN_DEPENDENCIES = ["stellar"];

function assessHealthStatus(services, criticalDeps) {
  const failed = Object.entries(services)
    .filter(([_, status]) => status !== "online")
    .map(([service]) => service);

  const criticalFailed = failed.filter((dep) =>
    criticalDeps.includes(dep)
  );

  if (criticalFailed.length > 0) {
    return {
      status: "unhealthy",
      statusCode: 503,
      failureReason: `Critical dependencies failed: ${criticalFailed.join(", ")}`,
    };
  }

  if (failed.length > 0) {
    return {
      status: "degraded",
      statusCode: 200,
      failureReason: `Some optional dependencies unavailable: ${failed.join(", ")}`,
    };
  }

  return {
    status: "healthy",
    statusCode: 200,
    failureReason: null,
  };
}

async function checkDatabaseHealth(db) {
  try {
    await db.command({ ping: 1 });
    return { status: "online", latencyMs: 0 };
  } catch (err) {
    return {
      status: "offline",
      error: sanitizeErrorMessage(err),
    };
  }
}

async function checkPinataHealth() {
  try {
    if (!process.env.PINATA_JWT) {
      return {
        status: "offline",
        error: "PINATA_JWT not configured",
      };
    }
    const start = Date.now();
    await pinata.testAuthentication();
    return { status: "online", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "offline",
      error: sanitizeErrorMessage(err),
    };
  }
}

async function checkEmailHealth() {
  try {
    const start = Date.now();
    await verifyEmailConnection();
    return { status: "online", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "offline",
      error: sanitizeErrorMessage(err),
    };
  }
}

async function checkStellarHealth() {
  try {
    const horizonStart = Date.now();
    const horizonServer = new Server(HORIZON_URL);
    await horizonServer.root();
    const horizonLatency = Date.now() - horizonStart;

    const rpcStart = Date.now();
    const rpcServer = new rpc.Server(STELLAR_RPC_URL);
    const health = await rpcServer.getHealth();
    const rpcLatency = Date.now() - rpcStart;

    if (health && health.status === "healthy") {
      return {
        status: "online",
        horizon: { status: "online", latencyMs: horizonLatency },
        rpc: { status: "online", latencyMs: rpcLatency },
      };
    } else {
      return {
        status: "degraded",
        rpc: {
          status: "degraded",
          error: `RPC status: ${health?.status || "unknown"}`,
          latencyMs: rpcLatency,
        },
        horizon: { status: "online", latencyMs: horizonLatency },
      };
    }
  } catch (err) {
    return {
      status: "offline",
      error: sanitizeErrorMessage(err),
    };
  }
}

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "health-check", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const { searchParams } = new URL(request.url);
      const includeDiagnostics = searchParams.get("diagnostics") === "true";

      const report = await checkAllDependencies();

      // Maintain backward-compatible services mapping for existing consumers
      const legacyServices = {
        database:
          report.dependencies.database.status === DEPENDENCY_STATUS.HEALTHY
            ? "online"
            : `offline: ${report.dependencies.database.message}`,
        pinata:
          report.dependencies.storage.status === DEPENDENCY_STATUS.HEALTHY
            ? "online"
            : `offline: ${report.dependencies.storage.message}`,
        email:
          report.dependencies.email.status === DEPENDENCY_STATUS.HEALTHY
            ? "online"
            : `offline: ${report.dependencies.email.message}`,
        stellar:
          report.dependencies.stellar.status === DEPENDENCY_STATUS.HEALTHY
            ? "online"
            : `offline: ${report.dependencies.stellar.message}`,
      };

      const isHealthy = report.status === DEPENDENCY_STATUS.HEALTHY;
      const isDegraded = report.status === DEPENDENCY_STATUS.DEGRADED;
      const statusCode = isHealthy || isDegraded ? 200 : 503;

      const payload = {
        status: report.status,
        timestamp: report.timestamp,
        services: legacyServices,
        dependencies: report.dependencies,
        remediations: report.remediations,
        summary: report.summary,
      };

      if (includeDiagnostics) {
        payload.diagnostics = sanitizeDiagnostics({
          environment: process.env.NODE_ENV || "development",
          stellarNetwork: process.env.NEXT_PUBLIC_STELLAR_NETWORK || "TESTNET",
          gatewayConfigured: Boolean(process.env.NEXT_PUBLIC_GATEWAY_URL),
          emailConfigured: Boolean(process.env.SMTP_HOST || process.env.EMAIL_USER),
          contractsConfigured: Boolean(
            process.env.NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID ||
            process.env.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID ||
            process.env.NEXT_PUBLIC_SOROBAN_CONTRACT_ID
          ),
        });
      }

      return NextResponse.json(payload, { status: statusCode });
    }
  );
}
