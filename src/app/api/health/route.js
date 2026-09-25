export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { pinata } from "@/lib/pinata";
import { verifyEmailConnection } from "@/lib/email";
import { withApiHardening } from "@/lib/api/hardening";
import { Server, rpc } from "@stellar/stellar-sdk";
import { HORIZON_URL, STELLAR_RPC_URL } from "@/lib/config/chain";

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "health-check", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const status = {
        database: "offline",
        pinata: "offline",
        email: "offline",
        stellar: "offline",
      };
      
      let isHealthy = true;

      // 1. Check Database
      try {
        const db = await getDb();
        await db.command({ ping: 1 });
        status.database = "online";
      } catch (err) {
        status.database = `offline: ${err.message}`;
        isHealthy = false;
      }

      // 2. Check Pinata Gateway / Authentication API
      try {
        if (!process.env.PINATA_JWT) {
          status.pinata = "offline: PINATA_JWT not configured";
          isHealthy = false;
        } else {
          await pinata.testAuthentication();
          status.pinata = "online";
        }
      } catch (err) {
        status.pinata = `offline: ${err.message}`;
        isHealthy = false;
      }

      // 3. Check Email Connection (Nodemailer verification)
      try {
        await verifyEmailConnection();
        status.email = "online";
      } catch (err) {
        status.email = `offline: ${err.message}`;
        isHealthy = false;
      }

      // 4. Check Stellar Horizon & RPC Connection
      try {
        const horizonServer = new Server(HORIZON_URL);
        await horizonServer.root();

        const rpcServer = new rpc.Server(STELLAR_RPC_URL);
        const health = await rpcServer.getHealth();

        if (health && health.status === "healthy") {
          status.stellar = "online";
        } else {
          status.stellar = `offline: RPC status is ${health?.status || "unknown"}`;
          isHealthy = false;
        }
      } catch (err) {
        status.stellar = `offline: ${err.message}`;
        isHealthy = false;
      }

      const statusCode = isHealthy ? 200 : 503;
      return NextResponse.json(
        {
          status: isHealthy ? "healthy" : "unhealthy",
          timestamp: new Date().toISOString(),
          services: status,
        },
        { status: statusCode }
      );
    }
  );
}
