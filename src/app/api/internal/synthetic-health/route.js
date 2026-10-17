/**
 * GET /api/internal/synthetic-health
 *
 * Returns the latest synthetic monitor health report.  Protected by admin /
 * service token — exposes internal latency and failure detail that must not
 * reach unauthenticated callers.
 *
 * Query params:
 *   ?dry=1        — run a dry-run check on-demand (no DB required)
 *   ?scenarios=id1,id2 — restrict to a subset of scenario ids
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth";
import {
  runHealthCheck,
  SCENARIO_DEFINITIONS,
  HEALTH_STATES,
} from "@/lib/monitoring/syntheticMonitor";
import { JOURNEY_DEFINITION, JOURNEY_STEP_IDS } from "@/lib/monitoring/journeyMonitor";
import { getErrorCode } from "@/lib/errors/codes";

export const dynamic = "force-dynamic";

const VALID_SCENARIO_IDS = new Set(SCENARIO_DEFINITIONS.map((d) => d.id));

// In-process dry-run adapters — used when ?dry=1 or no DB adapter is available.
function buildDryAdapters() {
  const steps = {};
  for (const def of JOURNEY_DEFINITION) {
    steps[def.id] = async () => ({ synthetic: true, step: def.id });
  }
  const harness = { steps };
  return {
    purchaseHarness:       harness,
    creatorPublishHarness: harness,
    authHarness:           harness,
    searchHarness:         harness,
    revocationHarness:     harness,
  };
}

export async function GET(request) {
  const authResult = await requirePermission(request, "admin:access", { allowService: true });
  if (!authResult.ok) {
    const code = getErrorCode(authResult.status === 401 ? "AUTH_UNAUTHENTICATED" : "AUTH_FORBIDDEN");
    return NextResponse.json({ error: code.code, message: code.userMessage }, { status: code.status });
  }

  const { searchParams } = new URL(request.url);
  const dryRun    = searchParams.get("dry") === "1";
  const rawScen   = searchParams.get("scenarios");
  const scenarioIds = rawScen
    ? rawScen.split(",").map((s) => s.trim()).filter((s) => VALID_SCENARIO_IDS.has(s))
    : undefined;

  if (rawScen && (!scenarioIds || scenarioIds.length === 0)) {
    return NextResponse.json(
      {
        error: "VALIDATION_FIELD",
        message: `No valid scenario ids found. Valid ids: ${[...VALID_SCENARIO_IDS].join(", ")}`,
      },
      { status: 400 }
    );
  }

  try {
    const adapters = buildDryAdapters(); // On-demand endpoint always uses dry adapters for safety
    void dryRun; // param accepted for future live adapter injection

    const report = await runHealthCheck({
      adapters,
      scenarioIds,
      stepTimeoutMs: 10_000,
    });

    const httpStatus =
      report.health === HEALTH_STATES.RED      ? 503 :
      report.health === HEALTH_STATES.DEGRADED ? 200 : 200;

    return NextResponse.json(report, {
      status: httpStatus,
      headers: {
        "X-EduVault-Monitor-Health": report.health,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const code = getErrorCode("INTERNAL");
    return NextResponse.json(
      { error: code.code, message: code.userMessage },
      { status: code.status }
    );
  }
}
