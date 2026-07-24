export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { pinata } from "@/lib/pinata";
import { verifyEmailConnection } from "@/lib/email";
import { withApiHardening } from "@/lib/api/hardening";
import { Server, rpc } from "@stellar/stellar-sdk";
import { HORIZON_URL, STELLAR_RPC_URL } from "@/lib/config/chain";
import { setGauge } from "@/lib/telemetry/metrics";

/**
 * Readiness probe (#20): "can this instance actually serve traffic right now?"
 *
 * Distinguishes two failure classes (acceptance criterion):
 *  - CRITICAL dependency down (database, Stellar RPC) -> core purchase/
 *    publishing flows cannot function at all -> "unhealthy", HTTP 503.
 *    An orchestrator should stop routing traffic here.
 *  - NON-CRITICAL dependency down (Pinata, email) -> uploads or
 *    notifications degrade, but purchases/browsing/reads still work
 *    -> "degraded", HTTP 200. Traffic should keep flowing.
 */
const CRITICAL_DEPENDENCIES = new Set(["database", "stellar"]);

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "readiness-check", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const status = {
        database: "offline",
        pinata: "offline",
        email: "offline",
        stellar: "offline",
      };

      const failedCritical = [];
      const failedNonCritical = [];

      function recordFailure(dep) {
        if (CRITICAL_DEPENDENCIES.has(dep)) failedCritical.push(dep);
        else failedNonCritical.push(dep);
      }

      // 1. Database (critical)
      try {
        const db = await getDb();
        await db.command({ ping: 1 });
        status.database = "online";
      } catch (err) {
        status.database = `offline: ${err.message}`;
        recordFailure("database");
      }

      // 2. Pinata (non-critical — degrades uploads only)
      try {
        if (!process.env.PINATA_JWT) {
          status.pinata = "offline: PINATA_JWT not configured";
          recordFailure("pinata");
        } else {
          await pinata.testAuthentication();
          status.pinata = "online";
        }
      } catch (err) {
        status.pinata = `offline: ${err.message}`;
        recordFailure("pinata");
      }

      // 3. Email (non-critical — degrades notifications only)
      try {
        await verifyEmailConnection();
        status.email = "online";
      } catch (err) {
        status.email = `offline: ${err.message}`;
        recordFailure("email");
      }

      // 4. Stellar Horizon & RPC (critical — purchases/publishing need it)
      try {
        const horizonServer = new Server(HORIZON_URL);
        await horizonServer.root();

        const rpcServer = new rpc.Server(STELLAR_RPC_URL);
        const health = await rpcServer.getHealth();

        if (health && health.status === "healthy") {
          status.stellar = "online";
        } else {
          status.stellar = `offline: RPC status is ${health?.status || "unknown"}`;
          recordFailure("stellar");
        }
      } catch (err) {
        status.stellar = `offline: ${err.message}`;
        recordFailure("stellar");
      }

      let overall;
      let statusCode;
      if (failedCritical.length > 0) {
        overall = "unhealthy";
        statusCode = 503;
      } else if (failedNonCritical.length > 0) {
        overall = "degraded";
        statusCode = 200;
      } else {
        overall = "healthy";
        statusCode = 200;
      }

      for (const [dep, value] of Object.entries(status)) {
        setGauge("dependency_up", { dependency: dep }, value === "online" ? 1 : 0);
      }

      return NextResponse.json(
        {
          status: overall,
          timestamp: new Date().toISOString(),
          services: status,
          failedCritical,
          failedNonCritical,
        },
        { status: statusCode }
      );
    }
  );
}