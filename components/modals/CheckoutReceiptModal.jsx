"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  FaCheckCircle,
  FaCloudDownloadAlt,
  FaExclamationTriangle,
  FaExternalLinkAlt,
  FaLockOpen,
  FaReceipt,
  FaSpinner,
  FaTimes,
} from "react-icons/fa";
import useFocusTrap from "@/hooks/useFocusTrap";

const STATE_COPY = {
  signing: {
    eyebrow: "Wallet signature",
    title: "Approve your Stellar checkout",
    message: "Your wallet is preparing the signed transaction for this encrypted material.",
    tone: "blue",
    icon: FaSpinner,
  },
  confirming: {
    eyebrow: "Network confirmation",
    title: "Confirming on Stellar",
    message: "We submitted your checkout and are waiting for the network to finalize access.",
    tone: "amber",
    icon: FaSpinner,
  },
  success: {
    eyebrow: "Receipt ready",
    title: "Purchase confirmed",
    message: "Your entitlement is active. Download now to request file decryption.",
    tone: "emerald",
    icon: FaCheckCircle,
  },
  error: {
    eyebrow: "Checkout interrupted",
    title: "We could not complete checkout",
    message: "Review the error below, then retry the Stellar checkout when you are ready.",
    tone: "rose",
    icon: FaExclamationTriangle,
  },
};

const toneClasses = {
  blue: {
    ring: "from-blue-500/20 via-sky-400/10 to-indigo-500/20",
    badge: "bg-blue-50 text-blue-700 border-blue-100",
    icon: "bg-blue-600 text-white shadow-blue-500/30",
    progress: "bg-blue-600",
  },
  amber: {
    ring: "from-amber-500/20 via-orange-400/10 to-yellow-500/20",
    badge: "bg-amber-50 text-amber-700 border-amber-100",
    icon: "bg-amber-500 text-white shadow-amber-500/30",
    progress: "bg-amber-500",
  },
  emerald: {
    ring: "from-emerald-500/20 via-teal-400/10 to-cyan-500/20",
    badge: "bg-emerald-50 text-emerald-700 border-emerald-100",
    icon: "bg-emerald-500 text-white shadow-emerald-500/30",
    progress: "bg-emerald-500",
  },
  rose: {
    ring: "from-rose-500/20 via-red-400/10 to-orange-500/20",
    badge: "bg-rose-50 text-rose-700 border-rose-100",
    icon: "bg-rose-500 text-white shadow-rose-500/30",
    progress: "bg-rose-500",
  },
};

function shortenHash(hash) {
  if (!hash) return "Pending Stellar hash";
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function ReceiptRow({ label, children }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-slate-100 bg-white/80 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
        {label}
      </span>
      <div className="text-sm font-semibold text-slate-900 sm:text-right">{children}</div>
    </div>
  );
}

export default function CheckoutReceiptModal({
  isOpen,
  status = "success",
  itemName,
  transactionHash,
  explorerUrl,
  checkoutTerms,
  checkoutIntentHash,
  totalFee,
  totalAmount,
  currency = "XLM",
  purchasedAt,
  errorMessage,
  onClose,
  onRetry,
  onDownload,
  isDownloading = false,
  downloadError,
}) {
  const copy = STATE_COPY[status] || STATE_COPY.success;
  const classes = toneClasses[copy.tone];
  const StatusIcon = copy.icon;
  const isBusy = status === "signing" || status === "confirming";
  const isSuccess = status === "success";
  const isError = status === "error";
  const formattedDate = purchasedAt
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(purchasedAt))
    : "Just now";
  const formattedIntentExpiry = checkoutTerms?.expiry
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(checkoutTerms.expiry))
    : null;

  return (
    <AnimatePresence>
      {isOpen ? (
        <>
          <motion.div
            className="fixed inset-0 z-[80] bg-slate-950/70 backdrop-blur-md"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={isBusy ? undefined : onClose}
          />

          <motion.div
            className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto p-4 sm:p-6"
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.97 }}
            transition={{ type: "spring", damping: 24, stiffness: 260 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="checkout-receipt-title"
          >
            <div className="relative w-full max-w-2xl overflow-hidden rounded-[2rem] border border-white/70 bg-white shadow-2xl shadow-slate-950/20">
              <div className={`absolute inset-x-0 top-0 h-40 bg-gradient-to-br ${classes.ring}`} />
              <div className="absolute -right-16 -top-20 h-48 w-48 rounded-full bg-white/40 blur-3xl" />
              <div className="absolute -left-20 top-16 h-56 w-56 rounded-full bg-blue-100/40 blur-3xl" />

              <div className="relative p-5 sm:p-8">
                <div className="mb-6 flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-14 w-14 items-center justify-center rounded-2xl shadow-lg ${classes.icon}`}>
                      <StatusIcon className={isBusy ? "animate-spin text-2xl" : "text-2xl"} />
                    </div>
                    <div>
                      <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-[0.2em] ${classes.badge}`}>
                        {copy.eyebrow}
                      </span>
                      <h2 id="checkout-receipt-title" className="mt-2 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">
                        {copy.title}
                      </h2>
                    </div>
                  </div>

                  {!isBusy ? (
                    <button
                      type="button"
                      onClick={onClose}
                      className="rounded-full p-2 text-slate-400 transition hover:bg-white hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-200"
                      aria-label="Close checkout receipt"
                    >
                      <FaTimes />
                    </button>
                  ) : null}
                </div>

                <p className="max-w-xl text-sm leading-6 text-slate-600 sm:text-base">
                  {copy.message}
                </p>

                <div className="my-6 grid grid-cols-3 gap-2" aria-label="Checkout progress">
                  {["Signing", "Confirming", "Receipt"].map((step, index) => {
                    const activeIndex = status === "signing" ? 0 : status === "confirming" ? 1 : isSuccess ? 2 : 0;
                    const isActiveStep = index <= activeIndex && !isError;

                    return (
                      <div key={step}>
                        <div className={`h-2 rounded-full ${isActiveStep ? classes.progress : "bg-slate-200"}`} />
                        <p className={`mt-2 text-center text-[11px] font-bold uppercase tracking-[0.18em] ${isActiveStep ? "text-slate-800" : "text-slate-400"}`}>
                          {step}
                        </p>
                      </div>
                    );
                  })}
                </div>

                <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50/80 p-3 shadow-inner shadow-slate-200/70 sm:p-4">
                  <div className="mb-3 flex items-center gap-2 px-1 text-sm font-bold text-slate-900">
                    <FaReceipt className="text-blue-600" /> Transaction receipt
                  </div>
                  <div className="space-y-3">
                    <ReceiptRow label="Item name">{itemName || "EduVault learning material"}</ReceiptRow>
                    <ReceiptRow label="Transaction hash">
                      {explorerUrl && transactionHash ? (
                        <a
                          href={explorerUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-2 text-blue-700 hover:text-blue-800"
                        >
                          {shortenHash(transactionHash)} <FaExternalLinkAlt className="text-xs" />
                        </a>
                      ) : (
                        <span className="font-mono text-slate-500">{shortenHash(transactionHash)}</span>
                      )}
                    </ReceiptRow>
                    <ReceiptRow label="Total paid">
                      {totalAmount || "—"} {currency}
                    </ReceiptRow>
                    {checkoutTerms ? (
                      <>
                        <ReceiptRow label="Locked amount">
                          <span className="font-mono">{checkoutTerms.amount.units}</span> atomic units
                        </ReceiptRow>
                        <ReceiptRow label="Policy">
                          {checkoutTerms.policyVersion}
                        </ReceiptRow>
                        <ReceiptRow label="Intent hash">
                          <span className="font-mono">{shortenHash(checkoutIntentHash)}</span>
                        </ReceiptRow>
                        <ReceiptRow label="Bound buyer">
                          <span className="font-mono">{shortenHash(checkoutTerms.buyer)}</span>
                        </ReceiptRow>
                        <ReceiptRow label="Material version">
                          {checkoutTerms.material.version || "Current listing"}
                        </ReceiptRow>
                        <ReceiptRow label="Intent expires">
                          {formattedIntentExpiry}
                        </ReceiptRow>
                      </>
                    ) : null}
                    <ReceiptRow label={checkoutTerms ? "Platform fee" : "Network fee"}>
                      {checkoutTerms
                        ? `${checkoutTerms.feeBreakdown?.platformFeeUnits ?? "0"} atomic units`
                        : `${totalFee ?? "Calculating"} ${currency}`}
                    </ReceiptRow>
                    <ReceiptRow label="Completed">{formattedDate}</ReceiptRow>
                  </div>
                </div>

                {isError ? (
                  <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                    <p className="font-bold">Checkout error</p>
                    <p className="mt-1 leading-6">{errorMessage || "The checkout could not be confirmed."}</p>
                  </div>
                ) : null}

                {downloadError ? (
                  <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    <p className="font-bold">Download request failed</p>
                    <p className="mt-1 leading-6">{downloadError}</p>
                  </div>
                ) : null}

                <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                  {isSuccess ? (
                    <button
                      type="button"
                      onClick={onDownload}
                      disabled={isDownloading}
                      className="inline-flex flex-1 items-center justify-center gap-3 rounded-2xl bg-slate-950 px-5 py-3.5 text-sm font-bold text-white shadow-xl shadow-slate-950/20 transition hover:-translate-y-0.5 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isDownloading ? <FaSpinner className="animate-spin" /> : <FaCloudDownloadAlt />}
                      {isDownloading ? "Requesting decryption..." : "Download Now"}
                    </button>
                  ) : null}

                  {isError ? (
                    <button
                      type="button"
                      onClick={onRetry}
                      className="inline-flex flex-1 items-center justify-center gap-3 rounded-2xl bg-blue-600 px-5 py-3.5 text-sm font-bold text-white shadow-xl shadow-blue-500/20 transition hover:-translate-y-0.5 hover:bg-blue-700"
                    >
                      Retry checkout
                    </button>
                  ) : null}

                  <div className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 py-3 text-center text-sm font-semibold text-slate-600">
                    <FaLockOpen className="text-emerald-500" /> Entitlement-backed file decryption
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );
}
