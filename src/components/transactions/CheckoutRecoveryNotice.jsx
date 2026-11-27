"use client";

import { useCallback, useState } from "react";

import { useCart } from "@/hooks/useCart";
import { useWallet } from "@/hooks/useWallet";
import useCheckoutRecovery from "@/hooks/useCheckoutRecovery";
import CheckoutRecoveryBanner from "@/components/transactions/CheckoutRecoveryBanner";

/**
 * Mounted once in the root layout so an interrupted checkout is visible even
 * after a reload empties the in-memory cart.
 */
export default function CheckoutRecoveryNotice() {
  const { address, connect } = useWallet();
  const { resumeCheckout, dismissRecovery, setIsCartOpen } = useCart();
  const { decision, status, complete, dismiss, refresh } = useCheckoutRecovery({
    walletAddress: address || null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handlePrimary = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      const outcome = await resumeCheckout();

      if (outcome?.error) {
        setError(outcome.error.message || "The interrupted checkout could not be resumed.");
      } else if (outcome?.status === "complete") {
        complete();
        setIsCartOpen(false);
        return;
      }

      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The interrupted checkout could not be resumed.");
      refresh();
    } finally {
      setBusy(false);
    }
  }, [complete, refresh, resumeCheckout, setIsCartOpen]);

  const handleDismiss = useCallback(() => {
    dismissRecovery();
    dismiss();
    setError(null);
  }, [dismiss, dismissRecovery]);

  const handleReconnect = useCallback(() => {
    setError(null);
    connect();
  }, [connect]);

  return (
    <CheckoutRecoveryBanner
      decision={decision}
      status={status}
      busy={busy}
      error={error}
      onPrimary={handlePrimary}
      onDismiss={handleDismiss}
      onReconnect={handleReconnect}
    />
  );
}
