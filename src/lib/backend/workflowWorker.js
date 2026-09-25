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
  claimWorkflowForProcessing,
  renewWorkflowLease,
  poisonWorkflow,
  FencingTokenMismatchError,
  WORKFLOW_STATES,
  WORKFLOW_TYPES,
} from "./workflowOrchestrator";
import { getDb } from "@/lib/mongodb";
import { COLLECTIONS } from "./schemaContracts";
import {
  getRefundsAwaitingSubmission,
  getRefundsAwaitingReconciliation,
  processApprovedRefund,
  reconcileRefund,
} from "@/lib/refunds/refundWorkflow";

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
  const fencingToken = workflow.fencingToken;

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
        await confirmWorkflow(
          workflow._id,
          {
            txHash: existingMaterial.mintTxHash,
            tokenId: existingMaterial.tokenId,
          },
          { fencingToken }
        );
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
    if (error instanceof FencingTokenMismatchError) {
      // Lease was reassigned; stop processing this generation.
      console.warn(`[Worker] Fencing token lost for ${workflow._id}; abandoning unit of work`);
      return;
    }
    console.error(`[Worker] Error processing material registration ${workflow._id}:`, error);
    await addRetryAttempt(workflow._id, error.message, { fencingToken });
  }
}

/**
 * Process a single purchase workflow
 * @param {Object} workflow - Workflow record
 */
async function processPurchase(workflow) {
  const { metadata, userAddress } = workflow;
  const fencingToken = workflow.fencingToken;

  try {
    const db = await getDb();
    const purchasesCollection = db.collection(COLLECTIONS.purchases);

    // Check if purchase was already recorded
    const existingPurchase = await purchasesCollection.findOne({
      "metadata.workflowId": workflow._id.toString(),
    });

    if (existingPurchase && existingPurchase.status === "confirmed") {
      await confirmWorkflow(
        workflow._id,
        {
          txHash: existingPurchase.chainTxHash,
        },
        { fencingToken }
      );
      console.log(`[Worker] Purchase ${existingPurchase._id} already confirmed`);
      return;
    }

    // If we have a txHash, verify on-chain
    if (metadata.txHash) {
      await reconcileTransaction(workflow);
    }
  } catch (error) {
    if (error instanceof FencingTokenMismatchError) {
      console.warn(`[Worker] Fencing token lost for ${workflow._id}; abandoning unit of work`);
      return;
    }
    console.error(`[Worker] Error processing purchase ${workflow._id}:`, error);
    await addRetryAttempt(workflow._id, error.message, { fencingToken });
  }
}

/**
 * Reconcile a transaction with on-chain state
 * This would typically query the blockchain or use the indexer
 * @param {Object} workflow - Workflow record
 */
async function reconcileTransaction(workflow) {
  const { metadata } = workflow;
  const fencingToken = workflow.fencingToken;

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
        await confirmWorkflow(
          workflow._id,
          {
            txHash: metadata.txHash,
            tokenId: indexedEvent.tokenId,
            blockNumber: indexedEvent.blockNumber,
          },
          { fencingToken }
        );

        // Update material record
        const materialsCollection = db.collection(COLLECTIONS.materials);
        // Stable idempotency key derived from the workflow guarantees repeated
        // reconciliations for the same generation never duplicate the row.
        await materialsCollection.updateOne(
          { "metadata.workflowId": workflow._id.toString() },
          {
            $set: {
              tokenId: indexedEvent.tokenId,
              mintTxHash: metadata.txHash,
              mintStatus: "confirmed",
              mintedAt: new Date(),
              idempotencyKey: workflow._id.toString(),
            },
          },
          { upsert: false }
        );
      } else if (workflow.type === WORKFLOW_TYPES.PURCHASE) {
        await confirmWorkflow(
          workflow._id,
          {
            txHash: metadata.txHash,
          },
          { fencingToken }
        );

        // Update purchase record
        const purchasesCollection = db.collection(COLLECTIONS.purchases);
        await purchasesCollection.updateOne(
          { "metadata.workflowId": workflow._id.toString() },
          {
            $set: {
              status: "confirmed",
              confirmedAt: new Date(),
              idempotencyKey: workflow._id.toString(),
            },
          }
        );
      }

      console.log(`[Worker] Reconciled workflow ${workflow._id} successfully`);
    } else {
      // Transaction not yet indexed, will retry later
      console.log(`[Worker] Transaction ${metadata.txHash} not yet indexed, will retry`);
      await addRetryAttempt(workflow._id, "Transaction not yet indexed", { fencingToken });
    }
  } catch (error) {
    if (error instanceof FencingTokenMismatchError) {
      console.warn(`[Worker] Fencing token lost for ${workflow._id}; abandoning unit of work`);
      return;
    }
    console.error(`[Worker] Error reconciling transaction ${metadata.txHash}:`, error);
    await addRetryAttempt(workflow._id, error.message, { fencingToken });
  }
}

/**
 * Poll and advance the refund state machine — submits `approved` refunds and
 * reconciles anything left `pending`/stuck mid-submission/settled-but-not-
 * yet-converged. Runs every loop iteration regardless of material/purchase
 * workflow volume, since refunds live in their own `refunds` collection.
 */
async function processRefundQueue() {
  const db = await getDb();

  const toSubmit = await getRefundsAwaitingSubmission(db, CONFIG.maxConcurrentJobs);
  for (const refund of toSubmit) {
    try {
      await processApprovedRefund({ db, refund });
    } catch (error) {
      console.error(`[Worker] Error submitting refund ${refund._id}:`, error);
    }
  }

  const toReconcile = await getRefundsAwaitingReconciliation(db, CONFIG.maxConcurrentJobs);
  for (const refund of toReconcile) {
    try {
      await reconcileRefund({ db, refund });
    } catch (error) {
      console.error(`[Worker] Error reconciling refund ${refund._id}:`, error);
    }
  }
}

/**
 * Main worker loop
 *
 * Each iteration atomically claims a single workflow (owner + generation +
 * lease + fencing token) so that two workers can never process the same
 * generation, and a slow/crashed/partitioned worker's work is safely
 * reassigned once its lease expires.
 */
export async function runWorker() {
  console.log("[Worker] Starting workflow processor...");

  while (true) {
    try {
      const workflow = await claimWorkflowForProcessing(`worker-${process.pid}`, {
        leaseTtlMs: CONFIG.pollingInterval,
      });

      if (!workflow) {
        // Nothing claimable; either idle or everything is leased/healthy.
        await sleep(CONFIG.pollingInterval);
      } else {
        console.log(
          `[Worker] Claimed workflow ${workflow._id} (type=${workflow.type}, generation=${workflow.generation})`
        );

        try {
          // Heartbeat: refresh the lease before doing the work so a long
          // reconciliation does not lose the lease mid-flight.
          await renewWorkflowLease(workflow._id, workflow.fencingToken, `worker-${process.pid}`);

          if (workflow.type === WORKFLOW_TYPES.MATERIAL_REGISTRATION) {
            await processMaterialRegistration(workflow);
          } else if (workflow.type === WORKFLOW_TYPES.PURCHASE) {
            await processPurchase(workflow);
          } else {
            console.warn(`[Worker] Unknown workflow type: ${workflow.type}`);
            // Unknown types should not stay claimed forever; release the lease.
            await failWorkflow(workflow._id, `Unknown workflow type: ${workflow.type}`, {
              fencingToken: workflow.fencingToken,
            });
          }
        } catch (error) {
          if (error instanceof FencingTokenMismatchError) {
            console.warn(`[Worker] Lease for ${workflow._id} was reassigned; skipping`);
          } else {
            console.error(`[Worker] Error processing workflow ${workflow._id}:`, error);
            await poisonWorkflow(
              workflow._id,
              `Unexpected worker error: ${error.message}`
            ).catch(() => {});
          }
        }
      }

      await processRefundQueue();
      // Yield briefly so a rapid no-op loop does not pin the CPU.
      await sleep(50);
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
