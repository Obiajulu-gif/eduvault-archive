import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import CheckoutRecoveryBanner from "../transactions/CheckoutRecoveryBanner";
import { RecoveryStatus } from "@/hooks/useCheckoutRecovery";
import {
  RecoveryAction,
  SigningStage,
  classifyCheckoutRecovery,
  readCheckoutRecovery,
  recordCheckoutSigningStage,
  saveCheckoutRecovery,
} from "@/lib/transactions/checkoutRecovery";

const NOW = 1_700_000_000_000;
const WALLET = "GCUSTOMER...";

function makeDecision(stage, patch = {}, walletAddress = WALLET) {
  const entries = new Map();
  const storage = {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };

  saveCheckoutRecovery(
    {
      items: [{ id: "mat-1", title: "Lecture notes", price: 4 }],
      walletAddress: WALLET,
      intent: { stage, materialId: "mat-1" },
    },
    NOW,
    storage,
  );

  if (patch.signedXdr || patch.txHash) {
    recordCheckoutSigningStage(stage, patch, NOW + 1_000, storage);
  }

  return classifyCheckoutRecovery(readCheckoutRecovery(NOW + 1_000, storage), {
    now: NOW + 1_000,
    walletAddress,
  });
}

function renderBanner(decision, overrides = {}) {
  const onPrimary = vi.fn();
  const onDismiss = vi.fn();
  const onReconnect = vi.fn();

  render(
    <CheckoutRecoveryBanner
      decision={decision}
      status={overrides.status ?? RecoveryStatus.Available}
      onPrimary={onPrimary}
      onDismiss={onDismiss}
      onReconnect={onReconnect}
      {...overrides}
    />,
  );

  return { onPrimary, onDismiss, onReconnect };
}

describe("CheckoutRecoveryBanner", () => {
  it("offers a resumable signature with a polite status region", () => {
    const decision = makeDecision(SigningStage.AwaitingSignature);
    const { onPrimary, onDismiss } = renderBanner(decision);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Wallet signature was interrupted")).toBeTruthy();
    expect(screen.getByText(/nothing was charged/i)).toBeTruthy();
    expect(screen.getByText("Lecture notes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Resume checkout" }));
    expect(onPrimary).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("offers Retry when a signature is saved and no second approval is needed", () => {
    const decision = makeDecision(SigningStage.Signed, { signedXdr: "AAAAAg..." });
    expect(decision.action).toBe(RecoveryAction.Retry);

    renderBanner(decision);

    expect(screen.getByRole("button", { name: "Retry submission" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume checkout" })).toBeNull();
  });

  it("uses an assertive alert and check-first copy after submission", () => {
    const decision = makeDecision(SigningStage.Submitted, { txHash: "abc123def456" });
    expect(decision.action).toBe(RecoveryAction.Verify);

    renderBanner(decision);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check payment" })).toBeTruthy();
    expect(screen.getByText(/not charged twice/i)).toBeTruthy();
  });

  it("asks for reconnection instead of resuming another wallet's checkout", () => {
    const decision = makeDecision(
      SigningStage.AwaitingSignature,
      {},
      "GDIFFERENTWALLET",
    );
    const { onPrimary, onReconnect } = renderBanner(decision, {
      status: RecoveryStatus.Attention,
    });

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/another wallet/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect wallet" }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onPrimary).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Resume checkout" })).toBeNull();
  });

  it("shows a dismiss-only notice for a record that can no longer be used", () => {
    const decision = classifyCheckoutRecovery({ status: "invalid" }, { now: NOW });
    renderBanner(decision, { status: RecoveryStatus.Attention });

    expect(screen.getByText("Saved checkout was unreadable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume checkout" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("renders nothing for an idle checkout", () => {
    const decision = classifyCheckoutRecovery({ status: "empty" }, { now: NOW });
    const { container } = render(
      <CheckoutRecoveryBanner
        decision={decision}
        status={RecoveryStatus.Idle}
        onPrimary={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });
});
