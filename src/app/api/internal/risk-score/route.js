/**
 * POST /api/internal/risk-score
 *
 * Internal endpoint that runs explainable risk scoring for a high-impact action
 * before it is executed.  Callers are expected to be server-side services or
 * admin tooling — the route is protected by the service/admin token.
 *
 * Request body (JSON):
 *   {
 *     action: string,          // One of HIGH_IMPACT_ACTIONS
 *     ctx:    object,          // Enriched context for signal evaluation
 *     actorId?: string,        // For audit logging
 *   }
 *
 * Response (JSON):
 *   {
 *     action, score, level, gate, contributors, explanation,
 *     policyVersion, evaluatedAt
 *   }
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth";
import { scoreAction, HIGH_IMPACT_ACTIONS } from "@/lib/security/riskScoring";
import { auditLog } from "@/lib/api/audit";
import { getErrorCode } from "@/lib/errors/codes";

const VALID_ACTIONS = new Set(Object.values(HIGH_IMPACT_ACTIONS));

export async function POST(request) {
  // Require admin or service token
  const authResult = await requirePermission(request, "admin:access", { allowService: true });
  if (!authResult.ok) {
    const errCode = getErrorCode(authResult.status === 401 ? "AUTH_UNAUTHENTICATED" : "AUTH_FORBIDDEN");
    return NextResponse.json(
      { error: errCode.code, message: errCode.userMessage },
      { status: errCode.status }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    const errCode = getErrorCode("VALIDATION_FAILED");
    return NextResponse.json(
      { error: errCode.code, message: "Request body must be valid JSON." },
      { status: errCode.status }
    );
  }

  const { action, ctx = {}, actorId } = body ?? {};

  if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
    return NextResponse.json(
      {
        error: "VALIDATION_FIELD",
        message: `"action" must be one of: ${[...VALID_ACTIONS].join(", ")}`,
        validActions: [...VALID_ACTIONS],
      },
      { status: 400 }
    );
  }

  if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx)) {
    return NextResponse.json(
      { error: "VALIDATION_FIELD", message: '"ctx" must be a plain object.' },
      { status: 400 }
    );
  }

  const result = scoreAction(action, ctx);

  auditLog({
    event: "risk_score_evaluated",
    actor: actorId ? String(actorId) : authResult.user?.sub ?? "service",
    route: "/api/internal/risk-score",
    method: "POST",
    status: String(result.level),
    reason: `action=${action} score=${result.score.toFixed(3)} level=${result.level}`,
    policyVersion: result.policyVersion,
  });

  return NextResponse.json(result, { status: 200 });
}
