"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import {
  FaCheckCircle,
  FaExclamationTriangle,
  FaSyncAlt,
  FaTimes,
} from "react-icons/fa";
import { useAccount } from "wagmi";
import { useWallet } from "@/hooks/useWallet";
import CheckoutReceiptModal from "../../../../../components/modals/CheckoutReceiptModal";
import ConnectWalletModal from "./ConnectWalletModal";
import TransactionStatusPanel from "@/components/transactions/TransactionStatusPanel";
import { useCreatePurchase, useStartAccessRequest } from "@/hooks/api/usePurchases";
import { getExplorerTxUrl } from "@/lib/config/chain";
import { getSupportedPaymentAssets } from "@/lib/config/assets";
import { TransactionStatus } from "@/lib/transactions/transaction";
import { useTransactionCenter } from "@/providers/TransactionProvider";
import { purchaseService } from "@/services/purchaseService";
import {
  DEFAULT_SIGNING_BUFFER_MS,
  evaluateClientQuoteFreshness,
  formatStaleQuoteMessage,
  verifyQuoteBeforeSigning,
} from "@/lib/checkout/staleQuoteGuard";

const SUPPORTED_ASSETS = getSupportedPaymentAssets();

function formatFeeForAsset(assetCode) {
  return assetCode === "XLM" ? "0.10" : "0.05";
}

function formatQuotePayload(serverQuote, fallbackAssetCode) {
  const assetCode = serverQuote?.asset || fallbackAssetCode || "XLM";
  const numericPrice = Number.parseFloat(serverQuote?.price ?? 0);
  return {
    quoteId: serverQuote?.quoteId || null,
    materialId: serverQuote?.materialId || null,
    buyerAddress: serverQuote?.buyerAddress || null,
    price: Number.isFinite(numericPrice) ? numericPrice : 0,
    amount: Number.isFinite(numericPrice) ? numericPrice.toFixed(2) : "0.00",
    asset: assetCode,
    fee: formatFeeForAsset(assetCode),
    creatorAddress: serverQuote?.creatorAddress || null,
    materialVersion: serverQuote?.materialVersion || 1,
    expiresAt: serverQuote?.expiresAt || null,
  };
}

function useQuote({ isOpen, materialId, asset, price, buyerAddress }) {
  const [state, setState] = useState({
    requestKey: null,
    quote: null,
    error: null,
  });
  const [refreshKey, setRefreshKey] = useState(0);

  const previewResult = useMemo(() => {
    if (!isOpen || !materialId || !asset || buyerAddress) {
      return { quote: null, error: null };
    }
    const parsedPrice = Number.parseFloat(price || 0);
    if (Number.isNaN(parsedPrice)) {
      return { quote: null, error: new Error("Invalid material price") };
    }
    return {
      quote: {
        quoteId: null,
        materialId: String(materialId),
        buyerAddress: null,
        price: parsedPrice,
        amount: parsedPrice.toFixed(2),
        asset: asset.code,
        fee: formatFeeForAsset(asset.code),
        expiresAt: null,
      },
      error: null,
    };
  }, [isOpen, materialId, asset, price, buyerAddress]);

  const activeRequestKey =
    isOpen && materialId && asset && buyerAddress
      ? `${materialId}:${asset.code}:${buyerAddress}:${refreshKey}`
      : null;

  useEffect(() => {
    if (!activeRequestKey) return;

    let cancelled = false;

    purchaseService
      .requestQuote({ materialId, buyerAddress })
      .then((serverQuote) => {
        if (cancelled) return;
        setState({
          requestKey: activeRequestKey,
          quote: formatQuotePayload(serverQuote, asset.code),
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          requestKey: activeRequestKey,
          quote: null,
          error: err instanceof Error ? err : new Error("Unable to load checkout quote"),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [activeRequestKey, materialId, asset, buyerAddress]);

  const refresh = useCallback(() => {
    setRefreshKey((current) => current + 1);
  }, []);

  if (!activeRequestKey) {
    return {
      loading: false,
      error: previewResult.error,
      quote: previewResult.quote,
      refresh,
    };
  }

  const isCurrent = state.requestKey === activeRequestKey;
  return {
    loading: !isCurrent,
    error: isCurrent ? state.error : null,
    quote: isCurrent ? state.quote : null,
    refresh,
  };
}

function createLocalTxHash() {
  return `eduvault_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export default function BuyNowModal({
  isOpen,
  onClose,
  price,
  materialId,
  materialTitle,
  materialCreator,
  onAccessUpdated,
}) {
  const { address: evmAddress } = useAccount();
  const { state: stellarState } = useWallet();
  const stellarAddress = stellarState.status === "Connected" ? stellarState.session.address : null;
  const address = stellarAddress || evmAddress;
  const {
    activeTransaction,
    beginTransaction,
    markStatus,
    confirmTransaction,
    failTransaction,
    clearTransaction,
  } = useTransactionCenter();

  const createPurchaseMutation = useCreatePurchase();
  const startAccessRequestMutation = useStartAccessRequest();
  const [showWallet, setShowWallet] = useState(false);
  const [email, setEmail] = useState("");
  const [selectedAsset, setSelectedAsset] = useState(SUPPORTED_ASSETS[0]);
  const [receiptStatus, setReceiptStatus] = useState("idle");
  const [receipt, setReceipt] = useState(null);
  const [checkoutError, setCheckoutError] = useState(null);
  const [downloadError, setDownloadError] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isVerifyingQuote, setIsVerifyingQuote] = useState(false);
  const [quoteAlert, setQuoteAlert] = useState(null);

  const {
    loading: quoteLoading,
    error: quoteError,
    quote,
    refresh: refreshQuoteState,
  } = useQuote({
    isOpen,
    materialId,
    asset: selectedAsset,
    price,
    buyerAddress: address,
  });

  const handleRefreshQuote = useCallback(() => {
    setQuoteAlert(null);
    setCheckoutError(null);
    refreshQuoteState();
  }, [refreshQuoteState]);

  useEffect(() => {
    if (!isOpen || !quote?.quoteId || !quote?.expiresAt) return;

    const checkExpiry = () => {
      const freshness = evaluateClientQuoteFreshness({
        quote,
        materialId,
        buyerAddress: address,
        expectedPrice: price,
        signingBufferMs: DEFAULT_SIGNING_BUFFER_MS,
      });

      if (!freshness.fresh) {
        const formatted = formatStaleQuoteMessage(freshness);
        setQuoteAlert({
          ok: false,
          kind: "stale",
          source: "client",
          reason: freshness.reason,
          canRefresh: formatted.canRefresh,
          title: formatted.title,
          message: formatted.message,
          changedFields: freshness.changedFields || [],
          quoteTerms: freshness.quoteTerms || null,
          currentTerms: freshness.currentTerms || null,
        });
      }
    };

    const expiresAtMs = new Date(quote.expiresAt).getTime();
    const delayMs = Math.max(0, expiresAtMs - DEFAULT_SIGNING_BUFFER_MS - Date.now());
    const timer = window.setTimeout(checkExpiry, delayMs + 50);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isOpen, quote, materialId, address, price]);

  const isReceiptVisible = receiptStatus !== "idle";
  const isQuoteBlocked = Boolean(
    quoteAlert && (quoteAlert.kind === "stale" || quoteAlert.kind === "auth")
  );
  const explorerHint = useMemo(
    () => (receipt?.transactionHash ? getExplorerTxUrl(receipt.transactionHash) : activeTransaction.explorerUrl),
    [activeTransaction.explorerUrl, receipt?.transactionHash],
  );

  const resetCheckout = () => {
    setShowWallet(false);
    setReceiptStatus("idle");
    setReceipt(null);
    setCheckoutError(null);
    setDownloadError(null);
    setIsDownloading(false);
    setIsVerifyingQuote(false);
    setQuoteAlert(null);
    clearTransaction();
  };

  const handleClose = () => {
    resetCheckout();
    onClose();
  };

  const handleDownload = async () => {
    if (!materialId || !address) return;

    setIsDownloading(true);
    setDownloadError(null);

    try {
      const params = new URLSearchParams({ materialId, buyerAddress: address });
      const response = await fetch(`/api/download?${params.toString()}`);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || "Unable to request file decryption.");
      }

      if (payload.fileUrl) {
        window.open(payload.fileUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Unable to request file decryption.");
    } finally {
      setIsDownloading(false);
    }
  };

  const handlePay = async () => {
    if (!address) {
      setShowWallet(true);
      beginTransaction({
        scope: "purchase",
        title: "Wallet required",
        message: "Connect your wallet to request access and complete payment.",
      });
      return;
    }

    setCheckoutError(null);
    setDownloadError(null);
    setQuoteAlert(null);
    setIsVerifyingQuote(true);

    let verifiedQuote;
    try {
      const verification = await verifyQuoteBeforeSigning({
        quote,
        materialId,
        buyerAddress: address,
        expectedPrice: price,
        validateQuoteFn: purchaseService.validateQuote,
      });

      if (!verification.ok) {
        setQuoteAlert(verification);
        return;
      }

      verifiedQuote = verification.quote;
    } finally {
      setIsVerifyingQuote(false);
    }

    const txHash = createLocalTxHash();
    const purchasedAt = new Date().toISOString();
    const amount = verifiedQuote?.amount || quote?.amount || price;
    const asset = verifiedQuote?.asset || quote?.asset || selectedAsset.code;
    const activeQuoteId = verifiedQuote?.quoteId || quote?.quoteId || null;

    setReceipt({
      itemName: materialTitle || `Material #${materialId}`,
      creator: materialCreator,
      transactionHash: txHash,
      totalAmount: amount,
      currency: asset,
      totalFee: quote?.fee || "0.00",
      purchasedAt,
    });
    setReceiptStatus("signing");

    try {
      await startAccessRequestMutation.mutateAsync({
        materialId,
        buyerAddress: address,
        email,
        amount,
        asset,
      });
      onAccessUpdated?.();

      beginTransaction({
        scope: "purchase",
        title: "Signing checkout",
        message: "Approve the Stellar checkout in your wallet.",
      });

      markStatus(TransactionStatus.Signing, {
        title: "Signing checkout",
        message: "Waiting for wallet approval before submitting payment.",
      });

      await new Promise((resolve) => window.setTimeout(resolve, 500));
      setReceiptStatus("confirming");

      markStatus(TransactionStatus.PendingConfirmation, {
        txHash,
        title: "Confirming checkout",
        message: "The payment is being confirmed before access is granted.",
        explorerUrl: getExplorerTxUrl(txHash),
      });

      const result = await createPurchaseMutation.mutateAsync({
        materialId,
        buyerAddress: address,
        transactionHash: txHash,
        signedXdr: null,
        quoteId: activeQuoteId,
        email,
        amount,
        asset,
      });

      const confirmedHash = result?.purchase?.transactionHash || result?.transactionHash || txHash;
      const confirmedAt = result?.purchase?.confirmedAt || result?.purchase?.createdAt || purchasedAt;

      await new Promise((resolve) => window.setTimeout(resolve, 600));

      setReceipt((current) => ({
        ...current,
        transactionHash: confirmedHash,
        purchasedAt: confirmedAt,
      }));
      setReceiptStatus("success");
      onAccessUpdated?.();

      confirmTransaction({
        txHash: confirmedHash,
        explorerUrl: getExplorerTxUrl(confirmedHash),
        title: "Purchase confirmed",
        message: "Your receipt is ready and your encrypted material can be downloaded.",
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Purchase failed. Please try again.");
      const errorCode = err?.data?.code || err?.code;
      if (errorCode === "SETTLEMENT_QUOTE_EXPIRED" || errorCode === "CONFLICT_STATE") {
        const formatted = formatStaleQuoteMessage({
          reason: errorCode === "SETTLEMENT_QUOTE_EXPIRED" ? "QUOTE_EXPIRED" : "QUOTE_NOT_FOUND",
          fallbackMessage: error.message,
        });
        setQuoteAlert({
          ok: false,
          kind: "stale",
          source: "settlement",
          reason: errorCode,
          canRefresh: true,
          title: formatted.title,
          message: formatted.message,
        });
      }
      setCheckoutError(error);
      setReceiptStatus("error");
      onAccessUpdated?.();
      failTransaction(error, {
        title: "Purchase incomplete",
        message: error.message || "Payment did not complete, so access was not granted.",
        retryable: true,
      });
    }
  };

  return (
    <>
      <AnimatePresence>
        {isOpen && !isReceiptVisible ? (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.5 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black backdrop-blur-sm"
              onClick={handleClose}
            />

            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 50 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 50 }}
              className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto p-0 sm:items-center sm:p-4"
            >
              <div className="relative w-full max-w-lg rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-2xl">
                <button
                  type="button"
                  onClick={handleClose}
                  className="absolute right-4 top-4 rounded-full p-2 text-slate-400 transition hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200"
                  aria-label="Close checkout"
                >
                  <FaTimes />
                </button>

                <div className="mb-6">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400 dark:text-slate-500">
                    Access request
                  </p>
                  <h2 className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-50">Complete payment to unlock</h2>
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
                    We will create a pending access request first. The material unlocks only after payment is confirmed.
                  </p>
                </div>

                {address ? (
                  <div className="mb-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 px-4 py-3">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Connected as</p>
                    <p className="mt-0.5 font-mono text-sm text-slate-900 dark:text-slate-100 break-all">{address}</p>
                  </div>
                ) : null}

                {materialTitle ? (
                  <div className="mb-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 px-4 py-3">
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{materialTitle}</p>
                    {materialCreator ? (
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">by {materialCreator}</p>
                    ) : null}
                  </div>
                ) : null}

                <div className="mb-4">
                  <label className="mb-2 block text-xs font-semibold text-slate-600 dark:text-slate-400">
                    EMAIL ADDRESS
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="Enter your email"
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-900/40"
                  />
                </div>

                <div className="mb-4">
                  <label className="mb-2 block text-xs font-semibold text-slate-600 dark:text-slate-400">
                    PAYMENT ASSET
                  </label>
                  <div role="radiogroup" aria-label="Payment asset" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {SUPPORTED_ASSETS.map((assetOption) => {
                      const isSelected = assetOption.code === selectedAsset.code;
                      return (
                        <button
                          key={assetOption.code}
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          onClick={() => setSelectedAsset(assetOption)}
                          className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition focus-visible:ring-2 focus-visible:ring-blue-500 ${
                            isSelected
                              ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300"
                              : "border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                          }`}
                        >
                          <Image src="/images/stellar.png" alt="" width={18} height={18} aria-hidden="true" />
                          <span className="flex-1 font-medium">{assetOption.label}</span>
                          {isSelected ? <FaCheckCircle className="text-blue-500" /> : null}
                        </button>
                      );
                    })}
                  </div>
                  {selectedAsset.requiresTrustline ? (
                    <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                      Requires an active {selectedAsset.code} trustline in your wallet before payment can be submitted.
                    </p>
                  ) : null}
                </div>

                <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-slate-600 dark:text-slate-400">You will pay</span>
                  {quoteLoading ? (
                    <span className="text-slate-400 dark:text-slate-500">Loading quote...</span>
                  ) : quoteError ? (
                    <span className="text-rose-500 dark:text-rose-400">
                      {quoteError.message || "Error loading quote"}
                    </span>
                  ) : quote ? (
                    <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
                      <Image src="/images/stellar.png" alt={selectedAsset.label} width={20} height={20} />
                      {quote.amount} {quote.asset}
                      {quote.fee ? <span className="text-xs text-slate-400 dark:text-slate-500">+{quote.fee} fee</span> : null}
                    </div>
                  ) : (
                    <span className="text-slate-400 dark:text-slate-500">No quote available</span>
                  )}
                  <button
                    type="button"
                    onClick={handleRefreshQuote}
                    disabled={quoteLoading || isVerifyingQuote}
                    className="text-left text-xs font-medium text-blue-600 dark:text-blue-400 underline disabled:opacity-50 sm:text-right"
                  >
                    Refresh
                  </button>
                </div>

                {quoteAlert ? (
                  <div
                    role="alert"
                    data-testid="stale-quote-alert"
                    className={`mb-4 rounded-2xl border px-4 py-3 text-sm ${
                      quoteAlert.kind === "auth"
                        ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200"
                        : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <FaExclamationTriangle className="mt-0.5 shrink-0" aria-hidden="true" />
                      <div className="flex-1">
                        <p className="font-semibold">{quoteAlert.title}</p>
                        <p className="mt-1 text-xs leading-5 opacity-90">{quoteAlert.message}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {quoteAlert.canRefresh ? (
                            <button
                              type="button"
                              onClick={handleRefreshQuote}
                              disabled={quoteLoading}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:opacity-60"
                            >
                              <FaSyncAlt aria-hidden="true" />
                              Refresh quote
                            </button>
                          ) : null}
                          {quoteAlert.kind === "error" ? (
                            <button
                              type="button"
                              onClick={handlePay}
                              disabled={isVerifyingQuote}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900"
                            >
                              Retry verification
                            </button>
                          ) : null}
                          {quoteAlert.kind === "auth" ? (
                            <button
                              type="button"
                              onClick={() => setShowWallet(true)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-700"
                            >
                              Reconnect wallet
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                <TransactionStatusPanel
                  transaction={activeTransaction}
                  onRetry={handlePay}
                  onClear={clearTransaction}
                />

                <button
                  type="button"
                  onClick={handlePay}
                  disabled={
                    createPurchaseMutation.isPending ||
                    startAccessRequestMutation.isPending ||
                    quoteLoading ||
                    isVerifyingQuote ||
                    !quote ||
                    isQuoteBlocked
                  }
                  className="mt-5 w-full rounded-2xl bg-blue-600 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"
                >
                  {isVerifyingQuote
                    ? "Verifying quote..."
                    : createPurchaseMutation.isPending || startAccessRequestMutation.isPending
                      ? "Processing..."
                      : "Pay and unlock access"}
                </button>
              </div>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      <CheckoutReceiptModal
        isOpen={isOpen && isReceiptVisible}
        status={receiptStatus === "idle" ? "success" : receiptStatus}
        itemName={receipt?.itemName || materialTitle}
        transactionHash={receipt?.transactionHash}
        explorerUrl={explorerHint}
        totalFee={receipt?.totalFee || quote?.fee}
        totalAmount={receipt?.totalAmount || quote?.amount || price}
        currency={receipt?.currency || quote?.asset || selectedAsset.code}
        purchasedAt={receipt?.purchasedAt}
        errorMessage={checkoutError?.message}
        onClose={handleClose}
        onRetry={handlePay}
        onDownload={handleDownload}
        isDownloading={isDownloading}
        downloadError={downloadError}
      />

      <ConnectWalletModal
        isOpen={showWallet}
        onClose={() => {
          setShowWallet(false);
          if (!address && activeTransaction.status === TransactionStatus.WaitingWallet) {
            failTransaction(new Error("Wallet connection required"), {
              title: "Wallet connection required",
              message: "Connect your wallet to complete this purchase.",
              retryable: true,
            });
          }
        }}
      />
    </>
  );
}
