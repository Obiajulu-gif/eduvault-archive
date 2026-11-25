import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import useCheckoutRecovery, { RecoveryStatus } from "../useCheckoutRecovery";
import {
  CHECKOUT_RECOVERY_KEY,
  RecoveryAction,
  SigningStage,
} from "@/lib/transactions/checkoutRecovery";

const NOW = 1_700_000_000_000;
const WALLET = "GCUSTOMER...";

const ITEMS = [{ id: "mat-1", title: "Lecture notes", price: 4 }];

function makeStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
}

function renderRecovery(storage, walletAddress = WALLET) {
  return renderHook(
    ({ wallet }) =>
      useCheckoutRecovery({ storage, walletAddress: wallet, now: () => NOW }),
    { initialProps: { wallet: walletAddress } },
  );
}

describe("useCheckoutRecovery", () => {
  it("starts idle and becomes available after a checkout begins", () => {
    const storage = makeStorage();
    const { result } = renderRecovery(storage);

    expect(result.current.status).toBe(RecoveryStatus.Idle);
    expect(result.current.isAvailable).toBe(false);

    act(() => {
      result.current.begin({
        items: ITEMS,
        walletAddress: WALLET,
        intent: { stage: SigningStage.AwaitingSignature, materialId: "mat-1" },
      });
    });

    expect(result.current.status).toBe(RecoveryStatus.Available);
    expect(result.current.decision.action).toBe(RecoveryAction.Resume);
    expect(storage.getItem(CHECKOUT_RECOVERY_KEY)).toBeTruthy();
  });

  it("switches from Resume to Retry after a signature is captured", () => {
    const storage = makeStorage();
    const { result } = renderRecovery(storage);

    act(() => {
      result.current.begin({
        items: ITEMS,
        walletAddress: WALLET,
        intent: { stage: SigningStage.AwaitingSignature },
      });
      result.current.trackStage(SigningStage.Signed, { signedXdr: "AAAAAg..." });
    });

    expect(result.current.decision.action).toBe(RecoveryAction.Retry);
    expect(result.current.decision.requiresSignature).toBe(false);
    expect(result.current.decision.record.intent.signedXdr).toBe("AAAAAg...");
  });

  it("asks for attention when the connected wallet changes", async () => {
    const storage = makeStorage();
    const { result, rerender } = renderRecovery(storage);

    act(() => {
      result.current.begin({
        items: ITEMS,
        walletAddress: WALLET,
        intent: { stage: SigningStage.AwaitingSignature },
      });
    });

    rerender({ wallet: "GDIFFERENTWALLET" });

    await waitFor(() => expect(result.current.status).toBe(RecoveryStatus.Attention));
    expect(result.current.decision.code).toBe("wallet_mismatch");
    expect(result.current.decision.walletMatches).toBe(false);
    expect(result.current.isAvailable).toBe(false);
  });

  it("clears the record when dismissed", () => {
    const storage = makeStorage();
    const { result } = renderRecovery(storage);

    act(() => {
      result.current.begin({
        items: ITEMS,
        walletAddress: WALLET,
        intent: { stage: SigningStage.AwaitingSignature },
      });
    });
    act(() => result.current.dismiss());

    expect(storage.getItem(CHECKOUT_RECOVERY_KEY)).toBeNull();
    expect(result.current.decision).toBeNull();
    expect(result.current.status).toBe(RecoveryStatus.Idle);
  });

  it("never throws when storage refuses to write", () => {
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {},
    };
    const { result } = renderRecovery(blocked);

    act(() => {
      expect(
        result.current.begin({
          items: ITEMS,
          walletAddress: WALLET,
          intent: { stage: SigningStage.AwaitingSignature },
        }),
      ).toBeNull();
    });

    expect(result.current.status).toBe(RecoveryStatus.Idle);
  });
});
