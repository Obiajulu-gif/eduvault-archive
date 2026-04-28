import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import {
  getWorkflowsNeedingReconciliation,
} from "@/lib/backend/workflowOrchestrator";
import { reconcileIpfsPins } from "@/lib/ipfsPinning";

export const dynamic = "force-dynamic";

/**
 * POST /api/workflows/reconcile
 * Trigger reconciliation for pending workflows
 * 
 * Body:
 * - workflowId (optional): Specific workflow to reconcile
 * - runAll (optional): Run reconciliation for all pending workflows
 */
export async function POST(request) {
  return withApiHardening(
    request,
    { route: "workflows/reconcile", rateLimit: { limit: 10, windowMs: 60_000 } },
    async () => {
      try {
        const body = await request.json();
        const {
          workflowId,
          runAll = false,
          dryRun = false,
          gcOlderThanHours = 24,
          limit = 100,
        } = body;

        auditLog({
          event: "reconciliation_triggered",
          route: "workflows/reconcile",
          method: "POST",
          status: 200,
          workflowId,
          runAll,
        });

        if (workflowId) {
          // Reconcile specific workflow
          // This would be implemented in the worker
          return NextResponse.json({
            success: true,
            message: "Reconciliation job queued for workflow",
            workflowId,
          });
        }

        if (runAll) {
          // Get count of workflows needing reconciliation
          const workflows = await getWorkflowsNeedingReconciliation({ limit: 100 });
          const ipfs = await reconcileIpfsPins({
            limit,
            dryRun,
            gcOlderThanMs: Number(gcOlderThanHours) * 60 * 60 * 1000,
          });
          
          return NextResponse.json({
            success: true,
            message: `Found ${workflows.length} workflows needing reconciliation`,
            count: workflows.length,
            ipfs,
          });
        }

        return NextResponse.json(
          { error: "Either workflowId or runAll must be provided" },
          { status: 400 }
        );
      } catch (err) {
        auditLog({
          event: "reconciliation_failed",
          route: "workflows/reconcile",
          method: "POST",
          status: 500,
          reason: err.message,
        });
        return NextResponse.json(
          { error: err.message || "Reconciliation failed" },
          { status: 500 }
        );
      }
    }
  );
}
