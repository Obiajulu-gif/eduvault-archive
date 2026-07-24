export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

/**
 * Liveness probe (#20): "is the process itself running and able to respond?"
 * Intentionally has NO external dependency checks (DB, RPC, email, etc.) —
 * that's what /api/ready is for. Mixing the two means an orchestrator
 * (Kubernetes, ECS, etc.) can't tell "the process is stuck/dead, restart it"
 * apart from "the process is fine but a dependency is degraded" — restarting
 * a healthy process because Pinata is down just causes a thundering herd of
 * restarts that don't fix anything.
 */
export async function GET() {
  return NextResponse.json(
    { status: "alive", timestamp: new Date().toISOString() },
    { status: 200 }
  );
}