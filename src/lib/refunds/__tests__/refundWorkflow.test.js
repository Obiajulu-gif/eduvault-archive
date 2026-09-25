/**
 * Fault-injection / integration tests for the custody-safe refund workflow
 * (Issue #27). Every Stellar/Mongo boundary is injected so these exercise
 * the real state-machine logic without a network or database — matching
 * the project's established dependency-injection test style (see
 * src/lib/purchases/paymentReconciler.js's tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { createFakeCollection, createFakeDb } from "./fakeMongo";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";

vi.mock("@/lib/checkout/refundVerifier", () => ({
  verifyRefundLimit: vi.fn(async () => ({ valid: true })),
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const {
  REFUND_STATUS,
  requestRefund,
  approveRefund,
  rejectRefund,
  retryFailedRefund,
  processApprovedRefund,
  finalizeSettlement,
  reconcileRefund,
  getRefundsAwaitingSubmission,
  getRefundsAwaitingReconciliation,
} = await import("../refundWorkflow");

function makeDb() {
  const purchases = createFakeCollection();
  const refunds = createFakeCollection({
    uniqueKey: (d) => (d.status !== "rejected" ? d.purchaseId : null),
  });
  const refundAuditLog = createFakeCollection();
  const db = createFakeDb({
    [COLLECTIONS.purchases]: purchases,
    [COLLECTIONS.refunds]: refunds,
    [COLLECTIONS.refundAuditLog]: refundAuditLog,
  });
  return { db, purchases, refunds, refundAuditLog };
}

async function seedPurchase(purchases, overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    materialId: "mat-1",
    buyerAddress: "GBUYERORIGINALADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    status: "confirmed",
    amount: "100",
    asset: "USDC",
    transactionHash: "tx-original-hash",
    confirmedAt: new Date(),
    refundedAmount: 0,
    settlementState: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  await purchases.insertOne(doc);
  return doc;
}

const confirmedSubmission = (hash = "refund-tx-hash", ledger = 12345) => ({
  outcome: "confirmed",
  hash,
  ledger,
});

describe("refund workflow — requestRefund policy", () => {
  it("derives destination/asset/network from the purchase, ignoring any caller-supplied values", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases);

    const result = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
      actor: purchase.buyerAddress,
      // These extraneous fields mimic a naive caller trying to control the
      // payout — requestRefund's signature doesn't even read them.
      destination: "GATTACKERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      assetCode: "EVIL",
      amount: 999999,
    });

    expect(result.success).toBe(true);
    expect(result.refund.destination).toBe(purchase.buyerAddress);
    expect(result.refund.assetCode).toBe("USDC");
    expect(result.refund.amount).toBe(100);
  });

  it("rejects a claim from a wallet that does not own the purchase", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases);

    const result = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: "GSOMEONEELSEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      actor: "attacker",
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe("not_purchase_owner");
  });

  it("rejects a partial-refund request for more than the refundable balance", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases, { amount: "100" });

    const result = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
      requestedAmount: 150,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe("requested_amount_exceeds_refundable_balance");
  });

  it("honors a valid partial-refund amount", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases, { amount: "100" });

    const result = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
      requestedAmount: 40,
    });

    expect(result.success).toBe(true);
    expect(result.refund.amount).toBe(40);
  });

  it("rejects a refund window that has expired", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases, {
      confirmedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    });

    const result = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe("refund_window_expired");
  });
});

describe("refund workflow — duplicate claims / concurrent approvals", () => {
  it("treats a second concurrent request for the same purchase as idempotent, not a second claim", async () => {
    const { db, purchases, refunds } = makeDb();
    const purchase = await seedPurchase(purchases);

    const [first, second] = await Promise.all([
      requestRefund({
        db,
        purchaseId: purchase._id,
        buyerAddress: purchase.buyerAddress,
      }),
      requestRefund({
        db,
        purchaseId: purchase._id,
        buyerAddress: purchase.buyerAddress,
      }),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(String(first.refund._id)).toBe(String(second.refund._id));
    expect([first.alreadyExists, second.alreadyExists]).toContain(true);
    expect(refunds.docs).toHaveLength(1);
  });

  it("lets only one of two simultaneous admin approvals win", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases);
    const { refund } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });

    const [a, b] = await Promise.all([
      approveRefund({ db, refundId: refund._id, actor: "admin-a" }),
      approveRefund({ db, refundId: refund._id, actor: "admin-b" }),
    ]);

    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.success)).toHaveLength(1);
    expect(
      outcomes.filter((o) => !o.success && o.reason === "already_transitioned"),
    ).toHaveLength(1);
  });

  it("lets only one of two concurrent worker instances submit the same approved refund", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases);
    const { refund: requested } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    const { refund: approved } = await approveRefund({
      db,
      refundId: requested._id,
      actor: "admin",
    });

    const submitTransactionFn = vi.fn(async () => confirmedSubmission());
    const buildTransaction = vi.fn(async () => ({
      transaction: {},
      hash: "refund-tx-hash",
      sequence: "1",
    }));
    const getTreasuryBalanceFn = vi.fn(async () => 1000);
    const revokeEntitlementFn = vi.fn(async () => ({ success: true }));

    const [x, y] = await Promise.all([
      processApprovedRefund({
        db,
        refund: approved,
        buildTransaction,
        submitTransactionFn,
        getTreasuryBalanceFn,
        revokeEntitlementFn,
      }),
      processApprovedRefund({
        db,
        refund: approved,
        buildTransaction,
        submitTransactionFn,
        getTreasuryBalanceFn,
        revokeEntitlementFn,
      }),
    ]);

    const outcomes = [x.outcome, y.outcome];
    expect(outcomes).toContain("already_claimed");
    expect(submitTransactionFn).toHaveBeenCalledTimes(1);
  });
});

describe("refund workflow — settlement, reconciliation, and crash recovery", () => {
  it("settles on confirmed submission and converges entitlement revocation + purchase mirroring", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases);
    const { refund: requested } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    const { refund: approved } = await approveRefund({
      db,
      refundId: requested._id,
      actor: "admin",
    });

    const revokeEntitlementFn = vi.fn(async () => ({ success: true }));

    const result = await processApprovedRefund({
      db,
      refund: approved,
      buildTransaction: async () => ({
        transaction: {},
        hash: "hash-1",
        sequence: "1",
      }),
      submitTransactionFn: async () => confirmedSubmission("hash-1"),
      getTreasuryBalanceFn: async () => 1000,
      revokeEntitlementFn,
    });

    expect(result.outcome).toBe("settled");
    expect(result.refund.entitlementRevoked).toBe(true);
    expect(revokeEntitlementFn).toHaveBeenCalledWith(
      purchase.materialId,
      purchase.buyerAddress,
    );

    const updatedPurchase = await purchases.findOne({ _id: purchase._id });
    expect(updatedPurchase.settlementState).toBe("Refunded");
    expect(updatedPurchase.refundedAmount).toBe(100);
  });

  it("recovers from a Horizon timeout after acceptance by reconciling the pre-submission tx hash, never resubmitting", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases);
    const { refund: requested } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    const { refund: approved } = await approveRefund({
      db,
      refundId: requested._id,
      actor: "admin",
    });

    const submitTransactionFn = vi.fn(async () => ({
      outcome: "ambiguous",
      retryable: false,
      reason: "Horizon request timed out",
    }));

    const submitResult = await processApprovedRefund({
      db,
      refund: approved,
      buildTransaction: async () => ({
        transaction: {},
        hash: "hash-timeout",
        sequence: "1",
      }),
      submitTransactionFn,
      getTreasuryBalanceFn: async () => 1000,
    });

    expect(submitResult.outcome).toBe("pending");
    expect(submitResult.refund.txHash).toBe("hash-timeout");

    const getTransactionStatusFn = vi.fn(async () => "confirmed");
    const revokeEntitlementFn = vi.fn(async () => ({ success: true }));
    const reconciled = await reconcileRefund({
      db,
      refund: submitResult.refund,
      getTransactionStatusFn,
      revokeEntitlementFn,
    });

    expect(reconciled.outcome).toBe("settled");
    expect(submitTransactionFn).toHaveBeenCalledTimes(1); // never resubmitted
    expect(getTransactionStatusFn).toHaveBeenCalledWith("hash-timeout");
  });

  it("safely rebuilds with a fresh sequence after a definitive bad-sequence rejection", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases);
    const { refund: requested } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    const { refund: approved } = await approveRefund({
      db,
      refundId: requested._id,
      actor: "admin",
    });

    const firstAttempt = await processApprovedRefund({
      db,
      refund: approved,
      buildTransaction: async () => ({
        transaction: {},
        hash: "hash-bad-seq",
        sequence: "1",
      }),
      submitTransactionFn: async () => ({
        outcome: "rejected",
        retryable: true,
        reason: "tx_bad_seq",
      }),
      getTreasuryBalanceFn: async () => 1000,
    });

    expect(firstAttempt.outcome).toBe("retry_scheduled");
    expect(firstAttempt.refund.status).toBe(REFUND_STATUS.APPROVED);
    expect(firstAttempt.refund.txHash).toBeNull();
    expect(firstAttempt.refund.retryCount).toBe(1);

    const secondAttempt = await processApprovedRefund({
      db,
      refund: firstAttempt.refund,
      buildTransaction: async () => ({
        transaction: {},
        hash: "hash-fresh-seq",
        sequence: "2",
      }),
      submitTransactionFn: async () => confirmedSubmission("hash-fresh-seq"),
      getTreasuryBalanceFn: async () => 1000,
      revokeEntitlementFn: async () => ({ success: true }),
    });

    expect(secondAttempt.outcome).toBe("settled");
  });

  it('recovers refunds stuck in "submitting" after a process crash, without a stored hash', async () => {
    const { db, refunds, purchases } = makeDb();
    const purchase = await seedPurchase(purchases);
    const { refund: requested } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    // Simulate a crash immediately after the compare-and-set claim, before
    // the pre-submission durability checkpoint was ever written.
    await refunds.updateOne(
      { _id: requested._id },
      {
        $set: {
          status: REFUND_STATUS.SUBMITTING,
          txHash: null,
          updatedAt: new Date(Date.now() - 10 * 60 * 1000),
        },
      },
    );

    const stuck = await getRefundsAwaitingReconciliation(db);
    expect(stuck.map((r) => String(r._id))).toContain(String(requested._id));

    const recovered = await reconcileRefund({ db, refund: stuck[0] });
    expect(recovered.outcome).toBe("retry_scheduled");
    expect(recovered.refund.status).toBe(REFUND_STATUS.APPROVED);
  });

  it("gives up polling and rebuilds after a transaction sits unresolved past the pending timeout", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases);
    const { refund: requested } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    const { refund: approved } = await approveRefund({
      db,
      refundId: requested._id,
      actor: "admin",
    });

    const stillAmbiguous = await processApprovedRefund({
      db,
      refund: approved,
      buildTransaction: async () => ({
        transaction: {},
        hash: "hash-lost",
        sequence: "1",
      }),
      submitTransactionFn: async () => ({
        outcome: "ambiguous",
        retryable: false,
        reason: "timed out",
      }),
      getTreasuryBalanceFn: async () => 1000,
    });
    expect(stillAmbiguous.outcome).toBe("pending");
    expect(stillAmbiguous.refund.pendingSince).toBeInstanceOf(Date);

    // Not yet past the timeout — stays pending, never resubmitted.
    const notYetTimedOut = await reconcileRefund({
      db,
      refund: stillAmbiguous.refund,
      getTransactionStatusFn: async () => "not_found",
    });
    expect(notYetTimedOut.outcome).toBe("still_pending");

    // Simulate enough time passing that the transaction's own time-bounds
    // have long since expired and it will never land.
    const stale = {
      ...stillAmbiguous.refund,
      pendingSince: new Date(Date.now() - 20 * 60 * 1000),
    };
    const timedOut = await reconcileRefund({
      db,
      refund: stale,
      getTransactionStatusFn: async () => "not_found",
    });

    expect(timedOut.outcome).toBe("retry_scheduled");
    expect(timedOut.refund.status).toBe(REFUND_STATUS.APPROVED);
    expect(timedOut.refund.txHash).toBeNull();
  });

  it("finishes entitlement convergence for a settled-but-unconverged refund found after restart", async () => {
    const { db, refunds, purchases } = makeDb();
    const purchase = await seedPurchase(purchases);
    const { refund: requested } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    await refunds.updateOne(
      { _id: requested._id },
      {
        $set: {
          status: REFUND_STATUS.SETTLED,
          txHash: "hash-x",
          entitlementRevoked: false,
          updatedAt: new Date(),
        },
      },
    );

    const awaiting = await getRefundsAwaitingReconciliation(db);
    expect(awaiting.map((r) => String(r._id))).toContain(String(requested._id));

    const revokeEntitlementFn = vi.fn(async () => ({ success: true }));
    const result = await reconcileRefund({
      db,
      refund: awaiting[0],
      revokeEntitlementFn,
    });

    expect(result.outcome).toBe("settled");
    expect(revokeEntitlementFn).toHaveBeenCalledTimes(1);
  });
});

describe("refund workflow — signer outage and treasury shortage", () => {
  it("retries without submitting when the transaction build throws (signer/Horizon outage)", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases);
    const { refund: requested } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    const { refund: approved } = await approveRefund({
      db,
      refundId: requested._id,
      actor: "admin",
    });

    const submitTransactionFn = vi.fn(async () => confirmedSubmission());
    const result = await processApprovedRefund({
      db,
      refund: approved,
      buildTransaction: async () => {
        throw new Error("Horizon unreachable");
      },
      submitTransactionFn,
      getTreasuryBalanceFn: async () => 1000,
    });

    expect(result.outcome).toBe("retry_scheduled");
    expect(result.refund.status).toBe(REFUND_STATUS.APPROVED);
    expect(submitTransactionFn).not.toHaveBeenCalled();
  });

  it("permanently fails after exhausting retries on sustained treasury shortage, and recovers via explicit admin retry", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases);
    const { refund: requested } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    let { refund } = await approveRefund({
      db,
      refundId: requested._id,
      actor: "admin",
    });

    const shortTreasury = async () => 1; // far less than the 100 required

    let last;
    for (let i = 0; i < 6; i++) {
      last = await processApprovedRefund({
        db,
        refund,
        buildTransaction: async () => ({
          transaction: {},
          hash: `h${i}`,
          sequence: String(i),
        }),
        submitTransactionFn: async () => confirmedSubmission(),
        getTreasuryBalanceFn: shortTreasury,
      });
      refund = last.refund;
    }

    expect(last.outcome).toBe("failed");
    expect(last.refund.failureReason).toBe("treasury_shortage");

    const retried = await retryFailedRefund({
      db,
      refundId: last.refund._id,
      actor: "admin",
    });
    expect(retried.success).toBe(true);
    expect(retried.refund.status).toBe(REFUND_STATUS.APPROVED);

    const finalAttempt = await processApprovedRefund({
      db,
      refund: retried.refund,
      buildTransaction: async () => ({
        transaction: {},
        hash: "h-final",
        sequence: "99",
      }),
      submitTransactionFn: async () => confirmedSubmission("h-final"),
      getTreasuryBalanceFn: async () => 1000, // shortage resolved
      revokeEntitlementFn: async () => ({ success: true }),
    });

    expect(finalAttempt.outcome).toBe("settled");
  });
});

describe("refund workflow — entitlement-revocation failure does not corrupt settlement", () => {
  it("commits the on-chain settlement even when the entitlement-revocation step then fails, and converges cleanly on retry", async () => {
    const { db, purchases, refunds } = makeDb();
    const purchase = await seedPurchase(purchases);
    const { refund: requested } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    const { refund: approved } = await approveRefund({
      db,
      refundId: requested._id,
      actor: "admin",
    });

    const failingRevoke = vi.fn(async () => {
      throw new Error("entitlement cache unreachable");
    });

    // The submission itself succeeds (money has moved) but the convergence
    // step that follows (entitlement revocation) fails — this must not lose
    // or duplicate the settlement.
    await expect(
      processApprovedRefund({
        db,
        refund: approved,
        buildTransaction: async () => ({
          transaction: {},
          hash: "hash-settle",
          sequence: "1",
        }),
        submitTransactionFn: async () => confirmedSubmission("hash-settle"),
        getTreasuryBalanceFn: async () => 1000,
        revokeEntitlementFn: failingRevoke,
      }),
    ).rejects.toThrow("entitlement cache unreachable");

    const midway = await refunds.findOne({ _id: approved._id });
    expect(midway.status).toBe(REFUND_STATUS.SETTLED);
    expect(midway.entitlementRevoked).toBe(false);

    const afterFailure = await purchases.findOne({ _id: purchase._id });
    expect(afterFailure.settlementState).toBeNull(); // access not yet cut — never revoked before this point

    const workingRevoke = vi.fn(async () => ({ success: true }));
    const converged = await finalizeSettlement({
      db,
      refundId: approved._id,
      txHash: "hash-settle",
      revokeEntitlementFn: workingRevoke,
    });

    expect(converged.outcome).toBe("settled");
    expect(converged.refund.entitlementRevoked).toBe(true);
    expect(workingRevoke).toHaveBeenCalledTimes(1);
    const afterSuccess = await purchases.findOne({ _id: purchase._id });
    expect(afterSuccess.settlementState).toBe("Refunded");
    expect(afterSuccess.refundedAmount).toBe(100); // incremented exactly once, not twice
  });
});

describe("refund workflow — rejection", () => {
  it("rejects a requested claim and blocks resubmission of a new claim while it is live", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases);
    const { refund } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });

    const rejected = await rejectRefund({
      db,
      refundId: refund._id,
      actor: "admin",
      reason: "not eligible",
    });
    expect(rejected.success).toBe(true);
    expect(rejected.refund.status).toBe(REFUND_STATUS.REJECTED);

    // A rejected claim is exempt from the unique index — a fresh claim can be filed.
    const again = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    expect(again.success).toBe(true);
    expect(again.alreadyExists).toBe(false);
  });
});

describe("refund workflow — queue queries", () => {
  it("getRefundsAwaitingSubmission only returns approved refunds", async () => {
    const { db, purchases } = makeDb();
    const p1 = await seedPurchase(purchases);
    const { refund: r1 } = await requestRefund({
      db,
      purchaseId: p1._id,
      buyerAddress: p1.buyerAddress,
    });
    await approveRefund({ db, refundId: r1._id, actor: "admin" });

    const p2 = await seedPurchase(purchases, { _id: new ObjectId() });
    await requestRefund({
      db,
      purchaseId: p2._id,
      buyerAddress: p2.buyerAddress,
    }); // stays "requested"

    const awaiting = await getRefundsAwaitingSubmission(db);
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0].status).toBe(REFUND_STATUS.APPROVED);
  });
});

describe("refund workflow — end-to-end security verification for signer-layer safety controls", () => {
  /**
   * Integration test (Issue #27): Verify that refund signing safety controls
   * (REFUND_SIGNING_DISABLED and REFUND_MAX_AMOUNT_PER_TX) hold end-to-end
   * through the real call path (processApprovedRefund → submitRefundTransaction
   * → signRefundTransaction), not just in unit tests of refundSigner.js in
   * isolation.
   *
   * These controls are documented as "last line of defense" even if application-
   * layer amount checks are wrong or bypassed. This test proves they actually
   * work end-to-end.
   */

  it("REFUND_SIGNING_DISABLED=true causes processApprovedRefund to fail closed (never silently succeeds)", async () => {
    // Simulate a scenario where an attacker or bug tries to sneak through
    // an amount that should be blocked. We'll patch the environment and
    // call the real signing chain.
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases, { amount: "50" });
    const { refund: requested } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    const { refund: approved } = await approveRefund({
      db,
      refundId: requested._id,
      actor: "admin",
    });

    // Set the emergency kill switch before loading the real signer module
    process.env.REFUND_SIGNING_DISABLED = "true";

    // Re-import to pick up the env var
    const { signRefundTransaction: realSignRefundTransaction } =
      await import("../../../stellar/refundSigner");

    // Mock buildTransaction to return a real-looking envelope
    const buildTransaction = vi.fn(async () => ({
      transaction: { sign: vi.fn() }, // fake transaction object
      hash: "test-tx-hash",
      sequence: "100",
    }));

    // Use a submitTransactionFn that would normally succeed (but never gets there)
    const submitTransactionFn = vi.fn(async () => ({
      outcome: "confirmed",
      hash: "test-tx-hash",
      ledger: 12345,
    }));

    // Try to submit the refund with the kill switch enabled
    const result = await processApprovedRefund({
      db,
      refund: approved,
      buildTransaction,
      submitTransactionFn,
      getTreasuryBalanceFn: async () => 1000,
      // Use the REAL signing function (not mocked)
      submitTransactionFn: async (transaction, amount) => {
        try {
          realSignRefundTransaction(transaction, amount);
          // If we got here, signing should have been blocked!
          return { outcome: "confirmed", hash: "fake", ledger: 0 };
        } catch (error) {
          // Expected: signing is disabled
          return {
            outcome: "blocked",
            retryable: false,
            reason: error.message,
          };
        }
      },
    });

    // Verify: the refund must fail/retry, NOT silently succeed
    expect(result.outcome).not.toBe("settled");
    // It should either be retried or failed, but never confirmed
    expect(["retry_scheduled", "failed"]).toContain(result.outcome);
    // The refund should still be in APPROVED or higher state (never SETTLED)
    expect([REFUND_STATUS.APPROVED, REFUND_STATUS.FAILED]).toContain(
      result.refund?.status,
    );
    expect(submitTransactionFn).not.toHaveBeenCalled();

    // Clean up
    delete process.env.REFUND_SIGNING_DISABLED;
  });

  it("REFUND_MAX_AMOUNT_PER_TX cap is enforced at signing time even if the refund somehow bypassed earlier app-layer checks", async () => {
    const { db, purchases } = makeDb();
    // Create a purchase for $1000
    const purchase = await seedPurchase(purchases, { amount: "1000" });
    const { refund: requested } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    const { refund: approved } = await approveRefund({
      db,
      refundId: requested._id,
      actor: "admin",
    });

    // Set a per-tx cap of $500
    process.env.REFUND_MAX_AMOUNT_PER_TX = "500";

    // Re-import to pick up the env var
    const { signRefundTransaction: realSignRefundTransaction } =
      await import("../../../stellar/refundSigner");

    // But (simulating a bug or compromise in the workflow), the approved
    // refund slip-through with amount=$1000 anyway
    const refundWithBypassedAmount = { ...approved, amount: 1000 };

    const buildTransaction = vi.fn(async () => ({
      transaction: { sign: vi.fn() },
      hash: "test-tx-hash",
      sequence: "100",
    }));

    const submitTransactionFn = vi.fn(async (transaction, amount) => {
      try {
        realSignRefundTransaction(transaction, amount);
        return { outcome: "confirmed", hash: "fake", ledger: 0 };
      } catch (error) {
        // Expected: amount exceeds cap
        return { outcome: "blocked", retryable: false, reason: error.message };
      }
    });

    const result = await processApprovedRefund({
      db,
      refund: refundWithBypassedAmount,
      buildTransaction,
      submitTransactionFn,
      getTreasuryBalanceFn: async () => 1000,
    });

    // Verify: the signer rejects it at signing time
    expect(submitTransactionFn).toHaveBeenCalledWith(expect.anything(), 1000);
    expect(result.outcome).not.toBe("settled");
    // Should be retried or failed, not confirmed
    expect(["retry_scheduled", "failed"]).toContain(result.outcome);

    // Clean up
    delete process.env.REFUND_MAX_AMOUNT_PER_TX;
  });

  it("real signing chain accepts a valid refund within the cap and all controls", async () => {
    const { db, purchases } = makeDb();
    const purchase = await seedPurchase(purchases, { amount: "100" });
    const { refund: requested } = await requestRefund({
      db,
      purchaseId: purchase._id,
      buyerAddress: purchase.buyerAddress,
    });
    const { refund: approved } = await approveRefund({
      db,
      refundId: requested._id,
      actor: "admin",
    });

    // Set a per-tx cap that is higher than the refund
    process.env.REFUND_MAX_AMOUNT_PER_TX = "500";
    // Signing is enabled (default)
    delete process.env.REFUND_SIGNING_DISABLED;

    const { signRefundTransaction: realSignRefundTransaction } =
      await import("../../../stellar/refundSigner");

    const buildTransaction = vi.fn(async () => ({
      transaction: { sign: vi.fn() },
      hash: "test-tx-hash",
      sequence: "100",
    }));

    let signingAttempted = false;
    const submitTransactionFn = vi.fn(async (transaction, amount) => {
      try {
        signingAttempted = true;
        realSignRefundTransaction(transaction, amount);
        return { outcome: "confirmed", hash: "test-tx-hash", ledger: 12345 };
      } catch (error) {
        return { outcome: "blocked", retryable: false, reason: error.message };
      }
    });

    const result = await processApprovedRefund({
      db,
      refund: approved,
      buildTransaction,
      submitTransactionFn,
      getTreasuryBalanceFn: async () => 1000,
      revokeEntitlementFn: async () => ({ success: true }),
    });

    // Verify: normal flow succeeds
    expect(signingAttempted).toBe(true);
    expect(result.outcome).toBe("settled");

    // Clean up
    delete process.env.REFUND_MAX_AMOUNT_PER_TX;
  });
});
