"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CHECKOUT_RECOVERY_TTL_MS,
  RecoveryAction,
  classifyCheckoutRecovery,
  clearCheckoutRecovery,
  readCheckoutRecovery,
  recordCheckoutSigningStage,
  resolveCheckoutStorage,
  saveCheckoutRecovery,
} from "@/lib/transactions/checkoutRecovery";

const RESUME_ACTIONS = Object.freeze([
  RecoveryAction.Resume,
  RecoveryAction.Retry,
  RecoveryAction.Verify,
]);

export const RecoveryStatus = Object.freeze({
  Idle: "idle",
  Available: "available",
  Attention: "attention",
  Unavailable: "unavailable",
});

function clock(now) {
  return typeof now === "function" ? now() : Date.now();
}

/**
 * Reads the checkout attempt this tab left behind and exposes the one decision
 * the UI needs: resume it, verify it, reconnect, or forget it.
 */
export function useCheckoutRecovery({ walletAddress = null, storage, ttlMs, now } = {}) {
  const [status, setStatus] = useState(RecoveryStatus.Idle);
  const [decision, setDecision] = useState(null);
  const storageRef = useMemo(() => resolveCheckoutStorage(storage), [storage]);
  const readAt = useRef(clock);

  readAt.current = () => clock(now);

  const refresh = useCallback(() => {
    if (!storageRef) {
      setStatus(RecoveryStatus.Unavailable);
      setDecision(
        classifyCheckoutRecovery(
          { status: "unavailable" },
          { now: readAt.current(), ttlMs: ttlMs ?? CHECKOUT_RECOVERY_TTL_MS, walletAddress },
        ),
      );
      return null;
    }

    const at = readAt.current();
    const result = readCheckoutRecovery(at, storageRef);
    const next = classifyCheckoutRecovery(result, {
      now: at,
      ttlMs: ttlMs ?? CHECKOUT_RECOVERY_TTL_MS,
      walletAddress,
    });

    setDecision(next);

    if (RESUME_ACTIONS.includes(next.action)) {
      setStatus(RecoveryStatus.Available);
    } else if (next.action === RecoveryAction.Discard && result.status !== "empty") {
      // Corrupt, expired, clock-skewed and wallet-mismatched records still
      // deserve a one-time explanation instead of silently disappearing.
      setStatus(RecoveryStatus.Attention);
    } else {
      setStatus(RecoveryStatus.Idle);
    }

    return next;
  }, [storageRef, ttlMs, walletAddress]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const begin = useCallback(
    ({ items, walletAddress: attemptWallet, intent }) => {
      if (!storageRef) return null;
      try {
        const record = saveCheckoutRecovery(
          { items, walletAddress: attemptWallet, intent },
          readAt.current(),
          storageRef,
        );
        refresh();
        return record;
      } catch {
        // A blocked storage must never stop the checkout itself.
        return null;
      }
    },
    [refresh, storageRef],
  );

  const trackStage = useCallback(
    (stage, patch = {}) => {
      if (!storageRef) return null;
      try {
        const record = recordCheckoutSigningStage(stage, patch, readAt.current(), storageRef);
        refresh();
        return record;
      } catch {
        return null;
      }
    },
    [refresh, storageRef],
  );

  const forget = useCallback(() => {
    if (storageRef) {
      try {
        clearCheckoutRecovery(storageRef);
      } catch {
        // Ignore blocked storage; the in-memory decision still clears.
      }
    }
    setDecision(null);
    setStatus(storageRef ? RecoveryStatus.Idle : RecoveryStatus.Unavailable);
  }, [storageRef]);

  const complete = useCallback(() => {
    forget();
  }, [forget]);

  return {
    status,
    decision,
    isAvailable: status === RecoveryStatus.Available,
    isAttention: status === RecoveryStatus.Attention,
    begin,
    trackStage,
    refresh,
    dismiss: forget,
    complete,
  };
}

export default useCheckoutRecovery;
