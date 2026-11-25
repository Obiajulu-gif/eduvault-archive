import { describe, expect, it } from "vitest";

import {
  CHECKOUT_RECOVERY_KEY,
  CHECKOUT_RECOVERY_TTL_MS,
  RecoveryAction,
  SigningStage,
  classifyCheckoutRecovery,
  formatRecoveryAge,
  readCheckoutRecovery,
  recordCheckoutSigningStage,
  saveCheckoutRecovery,
} from "./checkoutRecovery";

const NOW = 1_700_000_000_000;
const WALLET = "GCUSTOMER...";

function makeStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
    keys: () => [...entries.keys()],
  };
}

function seed(storage, intent = { stage: SigningStage.AwaitingSignature, materialId: "mat-1" }) {
  return saveCheckoutRecovery(
    {
      items: [{ id: "mat-1", title: "Lecture notes", price: 4 }],
      walletAddress: WALLET,
      intent,
    },
    NOW,
    storage,
  );
}

describe("checkout recovery model", () => {
  it("offers Resume for an attempt that never reached the wallet", () => {
    const storage = makeStorage();
    seed(storage);

    const decision = classifyCheckoutRecovery(readCheckoutRecovery(NOW, storage), {
      now: NOW,
      walletAddress: WALLET,
    });

    expect(decision.action).toBe(RecoveryAction.Resume);
    expect(decision.code).toBe("resume_signing");
    expect(decision.requiresSignature).toBe(true);
    expect(decision.requiresVerification).toBe(false);
    expect(decision.record.items[0].title).toBe("Lecture notes");
  });

  it("offers Retry without another signature once a signature was captured", () => {
    const storage = makeStorage();
    seed(storage);
    recordCheckoutSigningStage(
      SigningStage.Signed,
      { signedXdr: "AAAAAgAAAAB..." },
      NOW + 1_000,
      storage,
    );

    const decision = classifyCheckoutRecovery(readCheckoutRecovery(NOW + 2_000, storage), {
      now: NOW + 2_000,
      walletAddress: WALLET,
    });

    expect(decision.action).toBe(RecoveryAction.Retry);
    expect(decision.requiresSignature).toBe(false);
    expect(decision.record.intent.signedXdr).toBe("AAAAAgAAAAB...");
    expect(decision.record.createdAt).toBe(NOW);
  });

  it("requires verification before any resubmission once payment was sent", () => {
    const storage = makeStorage();
    seed(storage);
    recordCheckoutSigningStage(
      SigningStage.Submitted,
      { txHash: "abc123" },
      NOW + 1_000,
      storage,
    );

    const decision = classifyCheckoutRecovery(readCheckoutRecovery(NOW + 2_000, storage), {
      now: NOW + 2_000,
      walletAddress: WALLET,
    });

    expect(decision.action).toBe(RecoveryAction.Verify);
    expect(decision.code).toBe("verify_submission");
    expect(decision.requiresVerification).toBe(true);
    expect(decision.requiresSignature).toBe(false);
    expect(decision.txHash).toBe("abc123");
  });

  it("refuses to resume a checkout belonging to another wallet", () => {
    const storage = makeStorage();
    seed(storage);

    const decision = classifyCheckoutRecovery(readCheckoutRecovery(NOW, storage), {
      now: NOW,
      walletAddress: "GDIFFERENTWALLET",
    });

    expect(decision.action).toBe(RecoveryAction.Discard);
    expect(decision.code).toBe("wallet_mismatch");
    expect(decision.walletMatches).toBe(false);
    expect(decision.requiresSignature).toBe(false);
    // The record is kept so reconnecting the original wallet can still resume.
    expect(storage.getItem(CHECKOUT_RECOVERY_KEY)).toBeTruthy();
  });

  it("clears expired and corrupt records instead of replaying them", () => {
    const expired = makeStorage();
    seed(expired);
    expect(readCheckoutRecovery(NOW + CHECKOUT_RECOVERY_TTL_MS + 1, expired).status).toBe("expired");
    expect(expired.getItem(CHECKOUT_RECOVERY_KEY)).toBeNull();

    const corrupt = makeStorage({ [CHECKOUT_RECOVERY_KEY]: "{not-json" });
    expect(readCheckoutRecovery(NOW, corrupt).status).toBe("invalid");
    expect(corrupt.getItem(CHECKOUT_RECOVERY_KEY)).toBeNull();
  });

  it("flags a record timestamped ahead of the device clock", () => {
    const storage = makeStorage();
    seed(storage);

    const decision = classifyCheckoutRecovery(readCheckoutRecovery(NOW - 1, storage), {
      now: NOW - 1,
      walletAddress: WALLET,
    });

    expect(decision.code).toBe("clock_skew");
    expect(decision.action).toBe(RecoveryAction.Discard);
  });

  it("rejects invalid stage patches so a stage update cannot corrupt the record", () => {
    const storage = makeStorage();
    seed(storage);

    expect(() =>
      recordCheckoutSigningStage("not-a-stage", {}, NOW + 1, storage),
    ).toThrow("Invalid checkout recovery stage");
    expect(readCheckoutRecovery(NOW, storage).status).toBe("ready");
  });

  it("formats ages without inventing precision", () => {
    expect(formatRecoveryAge(0)).toBe("just now");
    expect(formatRecoveryAge(90_000)).toBe("1 minute ago");
    expect(formatRecoveryAge(9 * 60_000)).toBe("9 minutes ago");
    expect(formatRecoveryAge(90 * 60_000)).toBe("1 hour ago");
    expect(formatRecoveryAge(-1)).toBe("just now");
  });
});
