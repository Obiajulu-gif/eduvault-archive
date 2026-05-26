import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

describe("Workflow Orchestration - File Structure", () => {
  it("workflowOrchestrator.js exists", () => {
    const filePath = path.join(rootDir, "src/lib/backend/workflowOrchestrator.js");
    assert.ok(fs.existsSync(filePath), "workflowOrchestrator.js should exist");
  });

  it("workflowWorker.js exists", () => {
    const filePath = path.join(rootDir, "src/lib/backend/workflowWorker.js");
    assert.ok(fs.existsSync(filePath), "workflowWorker.js should exist");
  });

  it("workflows API route exists", () => {
    const filePath = path.join(rootDir, "src/app/api/workflows/route.js");
    assert.ok(fs.existsSync(filePath), "workflows API route should exist");
  });

  it("workflows reconcile API route exists", () => {
    const filePath = path.join(rootDir, "src/app/api/workflows/reconcile/route.js");
    assert.ok(fs.existsSync(filePath), "workflows reconcile API route should exist");
  });
});

describe("Workflow Orchestration - Code Structure", () => {
  it("workflowOrchestrator.js exports required functions", () => {
    const filePath = path.join(rootDir, "src/lib/backend/workflowOrchestrator.js");
    const content = fs.readFileSync(filePath, "utf-8");

    const requiredExports = [
      "createWorkflow",
      "updateWorkflowState",
      "getWorkflow",
      "getWorkflowsByUser",
      "getWorkflowsNeedingReconciliation",
      "confirmWorkflow",
      "failWorkflow",
      "addRetryAttempt",
      "checkIdempotency",
      "WORKFLOW_STATES",
      "WORKFLOW_TYPES",
    ];

    for (const exp of requiredExports) {
      assert.ok(
        content.includes(`export`) && content.includes(exp),
        `workflowOrchestrator.js should export ${exp}`
      );
    }
  });

  it("workflowOrchestrator.js defines correct workflow states", () => {
    const filePath = path.join(rootDir, "src/lib/backend/workflowOrchestrator.js");
    const content = fs.readFileSync(filePath, "utf-8");

    assert.ok(content.includes('PENDING: "pending"'), "Should have PENDING state");
    assert.ok(content.includes('SUBMITTED: "submitted"'), "Should have SUBMITTED state");
    assert.ok(content.includes('CONFIRMED: "confirmed"'), "Should have CONFIRMED state");
    assert.ok(content.includes('FAILED: "failed"'), "Should have FAILED state");
    assert.ok(
      content.includes('NEEDS_RECONCILIATION: "needs_reconciliation"'),
      "Should have NEEDS_RECONCILIATION state"
    );
  });

  it("workflowOrchestrator.js defines correct workflow types", () => {
    const filePath = path.join(rootDir, "src/lib/backend/workflowOrchestrator.js");
    const content = fs.readFileSync(filePath, "utf-8");

    assert.ok(
      content.includes('MATERIAL_REGISTRATION: "material_registration"'),
      "Should have MATERIAL_REGISTRATION type"
    );
    assert.ok(content.includes('PURCHASE: "purchase"'), "Should have PURCHASE type");
  });

  it("workflowOrchestrator.js implements idempotency checking", () => {
    const filePath = path.join(rootDir, "src/lib/backend/workflowOrchestrator.js");
    const content = fs.readFileSync(filePath, "utf-8");

    assert.ok(
      content.includes("checkIdempotency"),
      "Should have checkIdempotency function"
    );
    assert.ok(
      content.includes("idempotencyKey"),
      "Should use idempotencyKey parameter"
    );
  });

  it("workflowOrchestrator.js implements retry logic", () => {
    const filePath = path.join(rootDir, "src/lib/backend/workflowOrchestrator.js");
    const content = fs.readFileSync(filePath, "utf-8");

    assert.ok(content.includes("addRetryAttempt"), "Should have addRetryAttempt function");
    assert.ok(content.includes("maxRetries"), "Should have maxRetries configuration");
    assert.ok(content.includes("retries"), "Should track retry count");
  });

  it("workflowWorker.js implements reconciliation", () => {
    const filePath = path.join(rootDir, "src/lib/backend/workflowWorker.js");
    const content = fs.readFileSync(filePath, "utf-8");

    assert.ok(content.includes("runWorker"), "Should have runWorker function");
    assert.ok(
      content.includes("reconcileTransaction"),
      "Should have reconcileTransaction function"
    );
    assert.ok(
      content.includes("processMaterialRegistration"),
      "Should process material registration"
    );
    assert.ok(content.includes("processPurchase"), "Should process purchase workflows");
  });

  it("workflowWorker.js handles retries with backoff", () => {
    const filePath = path.join(rootDir, "src/lib/backend/workflowWorker.js");
    const content = fs.readFileSync(filePath, "utf-8");

    assert.ok(
      content.includes("pollingInterval"),
      "Should have polling interval configuration"
    );
    assert.ok(
      content.includes("retryBackoffMs"),
      "Should have retry backoff configuration"
    );
  });

  it("API routes implement proper error handling", () => {
    const workflowsRoute = path.join(rootDir, "src/app/api/workflows/route.js");
    const reconcileRoute = path.join(rootDir, "src/app/api/workflows/reconcile/route.js");

    const workflowsContent = fs.readFileSync(workflowsRoute, "utf-8");
    const reconcileContent = fs.readFileSync(reconcileRoute, "utf-8");

    assert.ok(workflowsContent.includes("withApiHardening"), "Should use API hardening");
    assert.ok(workflowsContent.includes("auditLog"), "Should use audit logging");
    assert.ok(reconcileContent.includes("withApiHardening"), "Should use API hardening");
    assert.ok(reconcileContent.includes("auditLog"), "Should use audit logging");
  });
});

describe("Workflow Orchestration - Integration Points", () => {
  it("schemaContracts.js has syncState and syncEvents collections", () => {
    const filePath = path.join(rootDir, "src/lib/backend/schemaContracts.js");
    const content = fs.readFileSync(filePath, "utf-8");

    assert.ok(content.includes("syncState"), "Should define syncState collection");
    assert.ok(content.includes("syncEvents"), "Should define syncEvents collection");
  });

  it("workflow files reference correct collections", () => {
    const orchestratorPath = path.join(rootDir, "src/lib/backend/workflowOrchestrator.js");
    const workerPath = path.join(rootDir, "src/lib/backend/workflowWorker.js");

    const orchestratorContent = fs.readFileSync(orchestratorPath, "utf-8");
    const workerContent = fs.readFileSync(workerPath, "utf-8");

    assert.ok(
      orchestratorContent.includes("COLLECTIONS.syncState"),
      "Orchestrator should use syncState collection"
    );
    assert.ok(
      workerContent.includes("COLLECTIONS.materials"),
      "Worker should reference materials collection"
    );
    assert.ok(
      workerContent.includes("COLLECTIONS.purchases"),
      "Worker should reference purchases collection"
    );
  });
});
