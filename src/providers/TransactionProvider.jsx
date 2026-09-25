"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  buildExplorerUrl,
  createIdleTransaction,
  createTransactionId,
  classifyTransactionError,
  TransactionStatus,
  TransactionTone,
} from "@/lib/transactions/transaction";
import TransactionModal from "@/components/TransactionModal";

const TransactionContext = createContext(null);

function buildToastId() {
  return createTransactionId();
}

function ToastViewport({ toasts, dismissToast }) {
  if (!toasts.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[70] flex w-[min(92vw,24rem)] flex-col gap-3">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`rounded-2xl border bg-white p-4 shadow-xl backdrop-blur ${
            toast.tone === TransactionTone.Success
              ? "border-emerald-200"
              : toast.tone === TransactionTone.Warning
                ? "border-amber-200"
                : toast.tone === TransactionTone.Danger
                  ? "border-rose-200"
                  : "border-slate-200"
          }`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`mt-0.5 h-2.5 w-2.5 rounded-full ${
                toast.tone === TransactionTone.Success
                  ? "bg-emerald-500"
                  : toast.tone === TransactionTone.Warning
                    ? "bg-amber-500"
                    : toast.tone === TransactionTone.Danger
                      ? "bg-rose-500"
                      : "bg-slate-400"
              }`}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900">{toast.title}</p>
              {toast.message ? (
                <p className="mt-1 text-sm leading-6 text-slate-600">{toast.message}</p>
              ) : null}
              {toast.actionLabel && toast.actionHref ? (
                <a
                  href={toast.actionHref}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  {toast.actionLabel}
                </a>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              className="rounded-full px-2 py-1 text-xs font-semibold text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function TransactionProvider({ children }) {
  const [activeTransaction, setActiveTransaction] = useState(() =>
    createIdleTransaction(),
  );
  const [toasts, setToasts] = useState([]);

  const dismissToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((toast) => {
    const id = toast.id || buildToastId();
    setToasts((current) => [
      ...current,
      {
        id,
        tone: TransactionTone.Info,
        title: "Transaction update",
        message: null,
        actionLabel: null,
        actionHref: null,
        ...toast,
      },
    ]);

    if (toast.autoDismiss !== false) {
      window.setTimeout(() => dismissToast(id), toast.durationMs || 4500);
    }

    return id;
  }, [dismissToast]);

  const clearTransaction = useCallback(() => {
    setActiveTransaction(createIdleTransaction());
  }, []);

  const setTransaction = useCallback((updater) => {
    setActiveTransaction((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      return {
        ...current,
        ...next,
        updatedAt: new Date().toISOString(),
      };
    });
  }, []);

  const beginTransaction = useCallback(({
    scope = "general",
    title,
    message,
    detail,
    explorerBaseUrl,
    context = {},
  } = {}) => {
    const startedAt = new Date().toISOString();
    const id = createTransactionId();
    setActiveTransaction({
      ...createIdleTransaction(scope),
      id,
      scope,
      title: title || null,
      status: TransactionStatus.WaitingWallet,
      tone: TransactionTone.Info,
      message: message || null,
      detail: detail || null,
      explorerUrl: null,
      txHash: null,
      retryable: true,
      error: null,
      startedAt,
      updatedAt: startedAt,
      context,
      explorerBaseUrl: explorerBaseUrl || null,
    });
    return id;
  }, []);

  const markStatus = useCallback((status, patch = {}) => {
    setTransaction((current) => {
      const explorerUrl =
        patch.explorerUrl ?? buildExplorerUrl(patch.txHash ?? current.txHash, patch.explorerBaseUrl ?? current.explorerBaseUrl);

      return {
        ...current,
        status,
        tone:
          patch.tone ||
          (status === TransactionStatus.Confirmed
            ? TransactionTone.Success
            : status === TransactionStatus.Failed
              ? TransactionTone.Danger
              : status === TransactionStatus.NeedsRetry
                ? TransactionTone.Warning
                : TransactionTone.Info),
        title: patch.title ?? current.title,
        message: patch.message ?? current.message,
        detail: patch.detail ?? current.detail,
        txHash: patch.txHash ?? current.txHash,
        explorerUrl,
        retryable: patch.retryable ?? current.retryable,
        error: patch.error ?? current.error,
        context: patch.context ? { ...current.context, ...patch.context } : current.context,
        explorerBaseUrl: patch.explorerBaseUrl ?? current.explorerBaseUrl ?? null,
      };
    });
  }, [setTransaction]);

  const failTransaction = useCallback((error, patch = {}) => {
    const failure = classifyTransactionError(error);
    setTransaction((current) => ({
      ...current,
      id: current.id || createTransactionId(),
      status: patch.status || failure.status,
      tone: patch.tone || failure.tone,
      title: patch.title || failure.title,
      message: patch.message || failure.message,
      detail: patch.detail ?? current.detail,
      txHash: patch.txHash ?? current.txHash,
      explorerUrl: patch.explorerUrl ?? current.explorerUrl,
      retryable: patch.retryable ?? failure.retryable,
      error: error instanceof Error ? error : new Error(String(error)),
      updatedAt: new Date().toISOString(),
      context: patch.context ? { ...current.context, ...patch.context } : current.context,
    }));

    if (patch.notify !== false) {
      pushToast({
        tone: patch.tone || failure.tone,
        title: patch.toastTitle || failure.title,
        message: patch.toastMessage || failure.message,
        actionLabel: patch.actionLabel || (patch.retryable ?? failure.retryable ? "Retry" : null),
        actionHref: patch.actionHref || null,
      });
    }
  }, [pushToast, setTransaction]);

  const confirmTransaction = useCallback((patch = {}) => {
    setTransaction((current) => ({
      ...current,
      status: TransactionStatus.Confirmed,
      tone: TransactionTone.Success,
      title: patch.title || current.title || "Transaction confirmed",
      message: patch.message || current.message || "The network confirmed the transaction.",
      detail: patch.detail ?? current.detail,
      txHash: patch.txHash ?? current.txHash,
      explorerUrl: patch.explorerUrl ?? buildExplorerUrl(patch.txHash ?? current.txHash, patch.explorerBaseUrl ?? current.explorerBaseUrl),
      retryable: false,
      error: null,
      updatedAt: new Date().toISOString(),
      context: patch.context ? { ...current.context, ...patch.context } : current.context,
    }));

    if (patch.notify !== false) {
      pushToast({
        tone: TransactionTone.Success,
        title: patch.toastTitle || "Transaction confirmed",
        message: patch.toastMessage || "The network confirmed your action.",
        actionLabel: patch.txHash ? "View transaction" : null,
        actionHref:
          patch.actionHref ??
          buildExplorerUrl(patch.txHash, patch.explorerBaseUrl ?? activeTransaction.explorerBaseUrl),
      });
    }
  }, [activeTransaction.explorerBaseUrl, pushToast, setTransaction]);

  const retryTransaction = useCallback((patch = {}) => {
    setTransaction((current) => ({
      ...current,
      status: TransactionStatus.WaitingWallet,
      tone: TransactionTone.Info,
      message: patch.message ?? current.message,
      detail: patch.detail ?? current.detail,
      retryable: true,
      error: null,
      updatedAt: new Date().toISOString(),
      context: patch.context ? { ...current.context, ...patch.context } : current.context,
    }));
  }, [setTransaction]);

  const value = useMemo(() => ({
    activeTransaction,
    beginTransaction,
    markStatus,
    confirmTransaction,
    failTransaction,
    retryTransaction,
    clearTransaction,
    pushToast,
    dismissToast,
  }), [
    activeTransaction,
    beginTransaction,
    markStatus,
    confirmTransaction,
    failTransaction,
    retryTransaction,
    clearTransaction,
    pushToast,
    dismissToast,
  ]);

  return (
    <TransactionContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} dismissToast={dismissToast} />
      <TransactionModal />
    </TransactionContext.Provider>
  );
}

export function useTransactionCenter() {
  const context = useContext(TransactionContext);
  if (!context) {
    throw new Error("useTransactionCenter must be used within a TransactionProvider");
  }
  return context;
}
