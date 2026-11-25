/**
 * useStellarTransaction - Issue #62
 *
 * Shared Stellar transaction state machine used by wallet-driven flows.
 * The hook now feeds the global transaction provider so route-level screens
 * can show the same lifecycle copy and retry actions. Issue #1190 adds a
 * stage callback so interrupted checkouts can persist where they stopped,
 * plus a signed-transaction resubmit path that does not ask for a second
 * wallet approval.
 */

"use client";

import { useCallback, useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import { useTransactionCenter } from "@/providers/TransactionProvider";
import { SigningStage } from "@/lib/transactions/checkoutRecovery";
import {
  buildExplorerUrl,
  classifyTransactionError,
  TransactionStatus,
} from "@/lib/transactions/transaction";
import { STELLAR_RPC_URL } from "@/lib/config/chain";

export const TxStatus = Object.freeze({
  Idle: "idle",
  WaitingWallet: "waiting_wallet",
  Signing: "signing",
  Submitting: "submitting",
  PendingConfirmation: "pending_confirmation",
  Success: "success",
  Error: "error",
  NeedsRetry: "needs_retry",
});

function notifyStage(onStage, stage, patch) {
  if (typeof onStage !== "function") return;
  try {
    onStage(stage, patch);
  } catch {
    // Recovery bookkeeping is best-effort; it must never fail a payment.
  }
}

async function rpcCall(method, params, timeoutMs) {
  const res = await fetch(STELLAR_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

async function sendTransaction(signedXdr) {
  const payload = await rpcCall("sendTransaction", { transaction: signedXdr }, 15_000);
  if (payload.error) {
    throw new Error(payload.error.message ?? "sendTransaction failed");
  }

  const { status, hash, errorResultXdr } = payload.result ?? {};
  if (status === "ERROR") {
    throw new Error(`Transaction rejected: ${errorResultXdr ?? "unknown error"}`);
  }
  if (!hash) {
    throw new Error("Transaction was submitted without a hash");
  }

  return { hash, status };
}

async function pollTransaction(hash, { maxAttempts = 15, delayMs = 2_000 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const payload = await rpcCall("getTransaction", { hash }, 10_000);
    if (payload.error) continue;

    const { status, resultXdr } = payload.result ?? {};

    if (status === "SUCCESS") return { hash, status, resultXdr };
    if (status === "FAILED") {
      throw new Error(`Transaction failed on-chain: ${resultXdr ?? "no detail"}`);
    }
  }

  throw new Error("Transaction confirmation timed out");
}

/**
 * One-shot chain lookup used by recovery's Verify action. It never signs or
 * submits anything, so it is safe to call for a hash left by a closed tab.
 */
export async function readTransactionStatus(hash) {
  if (typeof hash !== "string" || hash.length === 0) {
    throw new Error("A transaction hash is required to verify payment");
  }

  const payload = await rpcCall("getTransaction", { hash }, 10_000);
  if (payload.error) {
    return { status: "NOT_FOUND", message: payload.error.message ?? "Transaction not found" };
  }

  const result = payload.result ?? {};
  return {
    status: result.status ?? "NOT_FOUND",
    resultXdr: result.resultXdr ?? null,
  };
}

export function useStellarTransaction() {
  const { signTransaction, isConnected } = useWallet();
  const {
    beginTransaction,
    markStatus,
    confirmTransaction,
    failTransaction,
    retryTransaction,
    clearTransaction,
  } = useTransactionCenter();
  const [state, setState] = useState({ status: TxStatus.Idle });

  const reset = useCallback(() => {
    setState({ status: TxStatus.Idle });
    clearTransaction();
  }, [clearTransaction]);

  const submitAndConfirm = useCallback(
    async ({ signedXdr, description, explorerBaseUrl, onStage }) => {
      setState({ status: TxStatus.Submitting, description });
      markStatus(TransactionStatus.Submitting, {
        title: `${description} - submitting`,
        message: "Broadcasting the signed transaction to the network.",
        explorerBaseUrl,
      });

      const { hash } = await sendTransaction(signedXdr);
      notifyStage(onStage, SigningStage.Submitted, { hash });
      markStatus(TransactionStatus.PendingConfirmation, {
        txHash: hash,
        title: `${description} - pending confirmation`,
        message: "The transaction was submitted. Waiting for network confirmation.",
        explorerBaseUrl,
      });
      setState({
        status: TxStatus.PendingConfirmation,
        description,
        hash,
      });

      const confirmed = await pollTransaction(hash);

      notifyStage(onStage, SigningStage.Confirmed, { hash: confirmed.hash });
      setState({ status: TxStatus.Success, hash: confirmed.hash, description });
      confirmTransaction({
        txHash: confirmed.hash,
        title: `${description} confirmed`,
        message: "The network confirmed the transaction.",
        explorerBaseUrl,
      });

      return { hash: confirmed.hash, signedXdr };
    },
    [confirmTransaction, markStatus],
  );

  const handleFailure = useCallback(
    (err, { description, explorerBaseUrl }) => {
      const failure = classifyTransactionError(err);
      setState({
        status:
          failure.status === TransactionStatus.NeedsRetry
            ? TxStatus.NeedsRetry
            : TxStatus.Error,
        error: err instanceof Error ? err : new Error(String(err)),
        description,
      });
      failTransaction(err, {
        status: failure.status,
        title: failure.title,
        message: failure.message,
        retryable: failure.retryable,
        explorerBaseUrl,
      });
    },
    [failTransaction],
  );

  const execute = useCallback(
    async (
      unsignedXdr,
      { description = "Transaction", explorerBaseUrl, onStage } = {},
    ) => {
      if (!isConnected) {
        const error = new Error(
          "Wallet not connected. Please connect your Stellar wallet first.",
        );
        setState({
          status: TxStatus.WaitingWallet,
          error,
          description,
        });
        beginTransaction({
          scope: "stellar",
          title: description,
          message: "Connect your wallet to continue.",
          explorerBaseUrl,
        });
        failTransaction(error, {
          status: TransactionStatus.NeedsRetry,
          title: "Wallet connection required",
          message: "Connect your Stellar wallet to approve this transaction.",
          retryable: true,
        });
        throw error;
      }

      try {
        notifyStage(onStage, SigningStage.AwaitingSignature);
        setState({ status: TxStatus.Signing, description });
        markStatus(TransactionStatus.Signing, {
          title: `${description} - waiting for wallet`,
          message: "Approve the transaction in your wallet to continue.",
          explorerBaseUrl,
        });

        let signedXdr;
        try {
          signedXdr = await signTransaction(unsignedXdr);
        } catch (err) {
          const msg = err?.message ?? String(err);
          const isDismissal = /clos|cancel|reject|dismiss/i.test(msg);
          const walletError = Object.assign(
            new Error(isDismissal ? "Transaction cancelled in wallet" : msg),
            { dismissed: isDismissal },
          );
          setState({
            status: isDismissal ? TxStatus.NeedsRetry : TxStatus.Error,
            error: walletError,
            description,
          });
          throw walletError;
        }

        notifyStage(onStage, SigningStage.Signed, { signedXdr });
        return await submitAndConfirm({ signedXdr, description, explorerBaseUrl, onStage });
      } catch (err) {
        handleFailure(err, { description, explorerBaseUrl });
        throw err;
      }
    },
    [beginTransaction, failTransaction, handleFailure, isConnected, markStatus, signTransaction, submitAndConfirm],
  );

  /**
   * Resubmit a signature that was captured before the tab closed. No wallet
   * prompt is involved: the signed XDR already exists in the recovery record.
   */
  const submitSignedTransaction = useCallback(
    async (signedXdr, { description = "Transaction", explorerBaseUrl, onStage } = {}) => {
      if (typeof signedXdr !== "string" || signedXdr.length === 0) {
        throw new Error("A saved signature is required to retry submission");
      }

      beginTransaction({
        scope: "stellar",
        title: description,
        message: "Resubmitting the signature captured before checkout was interrupted.",
        explorerBaseUrl,
      });

      try {
        return await submitAndConfirm({ signedXdr, description, explorerBaseUrl, onStage });
      } catch (err) {
        handleFailure(err, { description, explorerBaseUrl });
        throw err;
      }
    },
    [beginTransaction, handleFailure, submitAndConfirm],
  );

  return {
    execute,
    submitSignedTransaction,
    state,
    reset,
    retry: retryTransaction,
    buildExplorerUrl,
  };
}
