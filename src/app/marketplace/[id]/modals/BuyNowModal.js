"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import { FaTimes } from "react-icons/fa";
import { useAccount } from "wagmi";
import CheckoutReceiptModal from "../../../../../components/modals/CheckoutReceiptModal";
import ConnectWalletModal from "./ConnectWalletModal";
import TransactionStatusPanel from "@/components/transactions/TransactionStatusPanel";
import { useCreatePurchase, useStartAccessRequest } from "@/hooks/api/usePurchases";
import { ACCEPTED_ASSET, getExplorerTxUrl } from "@/lib/config/chain";
import { TransactionStatus } from "@/lib/transactions/transaction";
import { useTransactionCenter } from "@/providers/TransactionProvider";
import useFocusTrap from "@/hooks/useFocusTrap";

const SUPPORTED_ASSETS = [
  { code: ACCEPTED_ASSET, issuer: null, label: `Stellar ${ACCEPTED_ASSET}` },
];

function useQuote(materialId, asset, price) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [quote, setQuote] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!materialId || !asset) return undefined;

    const loadingTimer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
    }, 0);

    const timeout = window.setTimeout(() => {
      const parsedPrice = Number.parseFloat(price || 0);

      if (Number.isNaN(parsedPrice)) {
        setError(new Error("Invalid material price"));
        setQuote(null);
      } else {
        setQuote({
          amount: parsedPrice.toFixed(2),
          asset: asset.code,
          fee: asset.code === "XLM" ? "0.10" : "0.05",
        });
      }

      setLoading(false);
    }, 350);

    return () => {
      window.clearTimeout(loadingTimer);
      window.clearTimeout(timeout);
    };
  }, [materialId, asset, price, refreshKey]);

  return {
    loading,
    error,
    quote,
    refresh: () => setRefreshKey((current) => current + 1),
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
  const { address } = useAccount();
  const createPurchaseMutation = useCreatePurchase();
  const startAccessRequestMutation = useStartAccessRequest();
  const [showWallet, setShowWallet] = useState(false);
  const [email, setEmail] = useState("");
  const [selectedAsset, setSelectedAsset] = useState(SUPPORTED_ASSETS[0]);
  const [receiptStatus, setReceiptStatus] = useState("idle");
  const [receipt, setReceipt] = useState(null);
  const [checkoutIntent, setCheckoutIntent] = useState(null);
  const [checkoutError, setCheckoutError] = useState(null);
  const [downloadError, setDownloadError] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const { loading: quoteLoading, error: quoteError, quote, refresh } = useQuote(
    materialId,
    selectedAsset,
    price,
  );
  const {
    activeTransaction,
    beginTransaction,
    markStatus,
    confirmTransaction,
    failTransaction,
    clearTransaction,
  } = useTransactionCenter();

  const isReceiptVisible = receiptStatus !== "idle";
  const explorerHint = useMemo(
    () => (receipt?.transactionHash ? getExplorerTxUrl(receipt.transactionHash) : activeTransaction.explorerUrl),
    [activeTransaction.explorerUrl, receipt?.transactionHash],
  );

  const resetCheckout = () => {
    setShowWallet(false);
    setReceiptStatus("idle");
    setReceipt(null);
    setCheckoutIntent(null);
    setCheckoutError(null);
    setDownloadError(null);
    setIsDownloading(false);
    clearTransaction();
  };

  const handleClose = () => {
    resetCheckout();
    onClose();
  };

  const modalRef = useFocusTrap(isOpen && !isReceiptVisible, handleClose);

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

  const createCheckoutIntent = async () => {
    const response = await fetch("/api/checkout/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        materialId,
        asset: selectedAsset,
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      const error = new Error(payload?.message || payload?.error || "Unable to prepare checkout terms.");
      error.code = payload?.code;
      throw error;
    }

    setCheckoutIntent(payload.checkout);
    return payload.checkout;
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

    try {
      const lockedCheckout = await createCheckoutIntent();
      const terms = lockedCheckout.terms;
      const txHash = createLocalTxHash();
      const purchasedAt = new Date().toISOString();
      const amount = terms.amount.units;
      const amountDisplay = terms.amount.display;
      const asset = terms.asset.contract || terms.asset.code;

      setReceipt({
        itemName: materialTitle || `Material #${materialId}`,
        creator: materialCreator,
        transactionHash: txHash,
        totalAmount: amountDisplay,
        currency: terms.asset.code,
        totalFee: terms.feeBreakdown.platformFeeUnits,
        purchasedAt,
        checkoutTerms: terms,
        checkoutIntentHash: lockedCheckout.intentHash,
      });
      setReceiptStatus("signing");

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
        email,
        amount,
        asset,
        checkoutIntentId: lockedCheckout.checkoutId,
        checkoutIntentSignature: lockedCheckout.signature,
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
        title: "Access granted",
        message: "Payment is complete and this material is now unlocked.",
        explorerUrl: getExplorerTxUrl(confirmedHash),
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Purchase failed. Please try again.");
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
              ref={modalRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="checkout-dialog-title"
              initial={{ opacity: 0, scale: 0.92, y: 50 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 50 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
            >
              <div className="relative w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
                <button
                  type="button"
                  onClick={handleClose}
                  className="absolute right-4 top-4 rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                  aria-label="Close checkout"
                >
                  <FaTimes />
                </button>

                <div className="mb-6">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">
                    Access request
                  </p>
                  <h2 id="checkout-dialog-title" className="mt-1 text-2xl font-bold text-slate-900">Complete payment to unlock</h2>
                  <p className="mt-2 text-sm text-slate-600">
                    We will create a pending access request first. The material unlocks only after payment is confirmed.
                  </p>
                </div>

                {materialTitle ? (
                  <div className="mb-4 rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3">
                    <p className="text-sm font-semibold text-slate-900">{materialTitle}</p>
                    {materialCreator ? (
                      <p className="mt-1 text-xs text-slate-500">by {materialCreator}</p>
                    ) : null}
                  </div>
                ) : null}

                <div className="mb-4">
                  <label htmlFor="checkout-email" className="mb-2 block text-xs font-semibold text-slate-600">
                    EMAIL ADDRESS
                  </label>
                  <input
                    id="checkout-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="Enter your email"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                  />
                </div>

                <div className="mb-4">
                  <label htmlFor="checkout-asset" className="mb-2 block text-xs font-semibold text-slate-600">
                    PAYMENT ASSET
                  </label>
                  <select
                    id="checkout-asset"
                    value={selectedAsset.code}
                    onChange={(event) =>
                      setSelectedAsset(
                        SUPPORTED_ASSETS.find((assetOption) => assetOption.code === event.target.value) ||
                          SUPPORTED_ASSETS[0],
                      )
                    }
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                  >
                    {SUPPORTED_ASSETS.map((assetOption) => (
                      <option key={assetOption.code} value={assetOption.code}>
                        {assetOption.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-slate-600">You will pay</span>
                  {quoteLoading ? (
                    <span className="text-slate-400">Loading quote...</span>
                  ) : quoteError ? (
                    <span className="text-rose-500">Error loading quote</span>
                  ) : quote ? (
                    <div className="flex items-center gap-2 font-semibold text-slate-900">
                      <Image src="/images/stellar.png" alt={selectedAsset.label} width={20} height={20} />
                      {quote.amount} {quote.asset}
                      {quote.fee ? <span className="text-xs text-slate-400">+{quote.fee} fee</span> : null}
                    </div>
                  ) : (
                    <span className="text-slate-400">No quote available</span>
                  )}
                  <button
                    type="button"
                    onClick={refresh}
                    className="text-left text-xs font-medium text-blue-600 underline sm:text-right"
                  >
                    Refresh
                  </button>
                </div>

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
                    !quote
                  }
                  className="mt-5 w-full rounded-2xl bg-blue-600 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"
                >
                  {createPurchaseMutation.isPending || startAccessRequestMutation.isPending
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
        checkoutTerms={receipt?.checkoutTerms || checkoutIntent?.terms}
        checkoutIntentHash={receipt?.checkoutIntentHash || checkoutIntent?.intentHash}
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
