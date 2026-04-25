import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import {
  getWorkflowsByUser,
  getWorkflow,
  WORKFLOW_TYPES,
} from "@/lib/backend/workflowOrchestrator";

export const dynamic = "force-dynamic";

/**
 * GET /api/workflows
 * Query workflows for the authenticated user
 * 
 * Query params:
 * - type: Filter by workflow type (material_registration | purchase)
 * - state: Filter by workflow state
 * - limit: Number of results (default 50)
 * - skip: Pagination offset
 */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "workflows", rateLimit: { limit: 100, windowMs: 60_000 } },
    async () => {
      try {
        const { searchParams } = new URL(request.url);
        const userAddress = searchParams.get("userAddress");
        const type = searchParams.get("type");
        const state = searchParams.get("state");
        const limit = parseInt(searchParams.get("limit") || "50");
        const skip = parseInt(searchParams.get("skip") || "0");

        if (!userAddress) {
          auditLog({
            event: "workflows_query_failed",
            route: "workflows",
            method: "GET",
            status: 400,
            reason: "missing_user_address",
          });
          return NextResponse.json(
            { error: "userAddress query parameter is required" },
            { status: 400 }
          );
        }

        const workflows = await getWorkflowsByUser(userAddress, {
          type: type || undefined,
          state: state || undefined,
          limit: Math.min(limit, 100), // Cap at 100
          skip,
        });

        auditLog({
          event: "workflows_query_success",
          route: "workflows",
          method: "GET",
          status: 200,
          count: workflows.length,
        });

        return NextResponse.json({
          success: true,
          workflows,
          count: workflows.length,
        });
      } catch (err) {
        auditLog({
          event: "workflows_query_failed",
          route: "workflows",
          method: "GET",
          status: 500,
          reason: err.message,
        });
        return NextResponse.json(
          { error: err.message || "Failed to query workflows" },
          { status: 500 }
        );
      }
    }
  );
}
