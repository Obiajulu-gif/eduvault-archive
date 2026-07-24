/**
 * Background Worker for Workflow Processing
 * 
 * This worker processes pending and failed workflows, handles retries,
 * and reconciles backend state with on-chain data.
 * 
 * Can be run as a separate process or integrated into Next.js API routes.
 */

import {
  getWorkflowsNeedingReconciliation,
  updateWorkflowState,
  confirmWorkflow,
  failWorkflow,
  addRetryAttempt,
  WORKFLOW_STATES,
  WORKFLOW_TYPES,
} from "./workflowOrchestrator";
import { getDb } from "@/lib/mongodb";
import { COLLECTIONS } from "./schemaContracts";
import { processOutboxEvents } from "./outboxWorker";
import { runWithContext } from "../telemetry/context.js";
import { withSpan } from "../telemetry/tracing.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { logger } from "../logger.js";

// Configuration
const CONFIG = {
  pollingInterval: 30000, // 30 seconds
  maxConcurrentJobs: 5,
  retryBackoffMs: 60000, // 1 minute
};

/**
 * Process a single material registration workflow
 * @param {Object} workflow - Workflow record
 */
async function processMaterialRegistration(workflow) {
  const { metadata, userAddress } = workflow;

  try {
    // Check if material was already created
    const db = await getDb();
    const materialsCollection = db.collection(COLLECTIONS.materials);
    
    const existingMaterial = await materialsCollection.findOne({
      "metadata.workflowId": workflow._id.toString(),
    });

    if (existingMaterial) {
      // Material already exists, check if it has a token ID
      if (existingMaterial.tokenId) {
        await confirmWorkflow(workflow._id, {
          txHash: existingMaterial.mintTxHash,
          tokenId: existingMaterial.tokenId,
        });
        console.log(`[Worker] Material ${existingMaterial._id} already confirmed`);
        return;
      }
    }

    // If we have a tokenURI but no mint yet, the frontend should handle minting
    // This worker mainly handles reconciliation
    if (metadata.tokenURI && !metadata.txHash) {
      // Wait for frontend to submit transaction
      // Mark for reconciliation check in 5 minutes
      await updateWorkflowState(workflow._id, workflow.state, {
        nextCheckAt: new Date(Date.now() + 5 * 60 * 1000),
      });
      return;
    }

    // If we have a txHash, verify on-chain
    if (metadata.txHash) {
      await reconcileTransaction(workflow);
    }
  } catch (error) {
    console.error(`[Worker] Error processing material registration ${workflow._id}:`, error);
    await addRetryAttempt(workflow._id, error.message);
  }
}

/**
 * Process a single purchase workflow
 * @param {Object} workflow - Workflow record
 */
async function processPurchase(workflow) {
  const { metadata, userAddress } = workflow;

  try {
    const db = await getDb();
    const purchasesCollection = db.collection(COLLECTIONS.purchases);

    // Check if purchase was already recorded
    const existingPurchase = await purchasesCollection.findOne({
      "metadata.workflowId": workflow._id.toString(),
    });

    if (existingPurchase && existingPurchase.status === "confirmed") {
      await confirmWorkflow(workflow._id, {
        txHash: existingPurchase.chainTxHash,
      });
      console.log(`[Worker] Purchase ${existingPurchase._id} already confirmed`);
      return;
    }

    // If we have a txHash, verify on-chain
    if (metadata.txHash) {
      await reconcileTransaction(workflow);
    }
  } catch (error) {
    console.error(`[Worker] Error processing purchase ${workflow._id}:`, error);
    await addRetryAttempt(workflow._id, error.message);
  }
}

/**
 * Reconcile a transaction with on-chain state
 * This would typically query the blockchain or use the indexer
 * @param {Object} workflow - Workflow record
 */
async function reconcileTransaction(workflow) {
  const { metadata } = workflow;

  try {
    // In a production environment, this would:
    // 1. Query the Stellar RPC or indexer for transaction status
    // 2. Verify the transaction was successful
    // 3. Extract relevant events (e.g., Transfer, Purchase)
    // 4. Update backend state accordingly

    // For now, we'll check if the indexer has recorded this transaction
    const db = await getDb();
    const syncEventsCollection = db.collection(COLLECTIONS.syncEvents);

    const indexedEvent = await syncEventsCollection.findOne({
      txHash: metadata.txHash,
    });

    if (indexedEvent) {
      // Transaction confirmed on-chain
      if (workflow.type === WORKFLOW_TYPES.MATERIAL_REGISTRATION) {
        await confirmWorkflow(workflow._id, {
          txHash: metadata.txHash,
          tokenId: indexedEvent.tokenId,
          blockNumber: indexedEvent.blockNumber,
        });

        // Update material record
        const materialsCollection = db.collection(COLLECTIONS.materials);
        await materialsCollection.updateOne(
          { "metadata.workflowId": workflow._id.toString() },
          {
            $set: {
              tokenId: indexedEvent.tokenId,
              mintTxHash: metadata.txHash,
              mintStatus: "confirmed",
              mintedAt: new Date(),
            },
          }
        );
      } else if (workflow.type === WORKFLOW_TYPES.PURCHASE) {
        await confirmWorkflow(workflow._id, {
          txHash: metadata.txHash,
        });

        // Update purchase record
        const purchasesCollection = db.collection(COLLECTIONS.purchases);
        await purchasesCollection.updateOne(
          { "metadata.workflowId": workflow._id.toString() },
          {
            $set: {
              status: "confirmed",
              confirmedAt: new Date(),
            },
          }
        );
      }

      console.log(`[Worker] Reconciled workflow ${workflow._id} successfully`);
    } else {
      // Transaction not yet indexed, will retry later
      logger.info({ txHash: metadata.txHash }, "[Worker] Transaction not yet indexed, will retry");
      await addRetryAttempt(workflow._id, "Transaction not yet indexed");
    }
  } catch (error) {
    incrementCounter("rpc_errors_total", { operation: "reconcile_transaction" });
    logger.error({ err: error, txHash: metadata.txHash }, "[Worker] Error reconciling transaction");
    await addRetryAttempt(workflow._id, error.message);
  }
}

/**
 * Main worker loop
 */
export async function runWorker() {
  console.log("[Worker] Starting workflow processor...");

  while (true) {
    try {
      const workflows = await getWorkflowsNeedingReconciliation({
        limit: CONFIG.maxConcurrentJobs,
      });

      if (workflows.length === 0) {
        // Also process outbox events before sleeping
        const outboxCount = await processOutboxEvents();
        if (outboxCount === 0) {
          console.log("[Worker] No workflows or outbox events to process, waiting...");
        }
        await sleep(CONFIG.pollingInterval);
        continue;
      }

      console.log(`[Worker] Processing ${workflows.length} workflow(s)...`);

      for (const workflow of workflows) {
        // Resume the trace that started on the HTTP request which created
        // this workflow (stamped in createWorkflow), instead of starting a
        // disconnected new one. Falls back to a fresh trace for older
        // workflows that predate telemetry stamping.
        const telemetry = workflow.metadata?.telemetry || {};

        await runWithContext(
          {
            correlationId: telemetry.correlationId,
            traceparent: telemetry.traceparent,
            jobType: workflow.type,
          },
          async () => {
            try {
              await withSpan(
                "worker.process_workflow",
                { workflowType: workflow.type, workflowId: String(workflow._id) },
                async () => {
                  if (workflow.type === WORKFLOW_TYPES.MATERIAL_REGISTRATION) {
                    await processMaterialRegistration(workflow);
                  } else if (workflow.type === WORKFLOW_TYPES.PURCHASE) {
                    await processPurchase(workflow);
                  } else {
                    logger.warn({ workflowType: workflow.type }, "[Worker] Unknown workflow type");
                  }
                }
              );
              incrementCounter("worker_jobs_total", { type: workflow.type, outcome: "success" });
            } catch (error) {
              incrementCounter("worker_jobs_total", { type: workflow.type, outcome: "error" });
              logger.error({ err: error, workflowId: String(workflow._id) }, "[Worker] Error processing workflow");
            }
          }
        );
      }

      // Also process outbox events after workflows
      await processOutboxEvents();

      await sleep(CONFIG.pollingInterval);
    } catch (error) {
      console.error("[Worker] Error in worker loop:", error);
      await sleep(CONFIG.retryBackoffMs);
    }
  }
}

/**
 * Sleep utility
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run worker if executed directly
 */
if (process.env.RUN_WORKER === "true") {
  runWorker().catch((error) => {
    console.error("[Worker] Fatal error:", error);
    process.exit(1);
  });
}
