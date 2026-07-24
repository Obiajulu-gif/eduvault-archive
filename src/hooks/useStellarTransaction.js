/**
 * useStellarTransaction - Issue #62
 *
 * Shared Stellar transaction state machine used by wallet-driven flows.
 * The hook now feeds the global transaction provider so route-level screens
 * can show the same lifecycle copy and retry actions.
 */

"use client";

import { useCallback, useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import { useTransactionCenter } from "@/providers/TransactionProvider";
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

async function sendTransaction(signedXdr) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "sendTransaction",
    params: { transaction: signedXdr },
  };

  const res = await fetch(STELLAR_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = await res.json();
  if (payload.error) {
    throw new Error(payload.error.message ?? "sendTransaction failed");
  }

  const { status, hash, errorResultXdr } = payload.result ?? {};
  if (status === "ERROR") {
    throw new Error(`Transaction rejected: ${errorResultXdr ?? "unknown error"}`);
  }

  return { hash, status };
}

async function pollTransaction(hash, { maxAttempts = 15, delayMs = 2_000 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: { hash },
    };

    const res = await fetch(STELLAR_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    const payload = await res.json();
    if (payload.error) continue;

    const { status, resultXdr } = payload.result ?? {};

    if (status === "SUCCESS") return { hash, status, resultXdr };
    if (status === "FAILED") {
      throw new Error(`Transaction failed on-chain: ${resultXdr ?? "no detail"}`);
    }
  }

  throw new Error("Transaction confirmation timed out");
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

  const execute = useCallback(
    async (unsignedXdr, { description = "Transaction", explorerBaseUrl, intent } = {}) => {
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
        setState({ status: TxStatus.Signing, description });
        markStatus(TransactionStatus.Signing, {
          title: `${description} - waiting for wallet`,
          message: "Approve the transaction in your wallet to continue.",
          explorerBaseUrl,
        });

        let signedXdr;
        try {
          signedXdr = await signTransaction(unsignedXdr, { intent });
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
          failTransaction(walletError, {
            status: isDismissal ? TransactionStatus.NeedsRetry : TransactionStatus.Failed,
            title: isDismissal ? "Signature rejected" : "Transaction failed",
            message: isDismissal
              ? "The wallet request was cancelled before approval."
              : msg,
            retryable: true,
            explorerBaseUrl,
          });
          throw walletError;
        }

        setState({ status: TxStatus.Submitting, description });
        markStatus(TransactionStatus.Submitting, {
          title: `${description} - submitting`,
          message: "Broadcasting the signed transaction to the network.",
          explorerBaseUrl,
        });

        const { hash } = await sendTransaction(signedXdr);
        markStatus(TransactionStatus.PendingConfirmation, {
          txHash: hash,
          title: `${description} - pending confirmation`,
          message:
            "The transaction was submitted. Waiting for network confirmation.",
          explorerBaseUrl,
        });
        setState({
          status: TxStatus.PendingConfirmation,
          description,
          hash,
        });

        const confirmed = await pollTransaction(hash);

        setState({ status: TxStatus.Success, hash: confirmed.hash, description });
        confirmTransaction({
          txHash: confirmed.hash,
          title: `${description} confirmed`,
          message: "The network confirmed the transaction.",
          explorerBaseUrl,
        });

        return { hash: confirmed.hash };
      } catch (err) {
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
        throw err;
      }
    },
    [
      beginTransaction,
      confirmTransaction,
      failTransaction,
      isConnected,
      markStatus,
      signTransaction,
    ],
  );

  return { execute, state, reset, retry: retryTransaction, buildExplorerUrl };
}
