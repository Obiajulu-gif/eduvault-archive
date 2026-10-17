export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import {
  checkAllDependencies,
  DEPENDENCY_STATUS,
  sanitizeDiagnostics,
} from "@/lib/health/dependencyChecker";

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
