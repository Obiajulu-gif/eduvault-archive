"use client";

import { useState } from "react";
import { FaCheckCircle, FaFlag, FaTimes } from "react-icons/fa";

const REPORT_REASONS = [
  "Copyright violation",
  "Broken link",
  "Incorrect metadata",
  "Inappropriate content",
  "Low quality / Unreadable",
  "Spam / Advertising",
  "Other",
];

/**
 * ReportModal — overlay form for reporting a material for quality or policy issues.
 *
 * Props:
 *  isOpen        {boolean}  Whether the modal is visible.
 *  onClose       {function} Called when the modal should close.
 *  materialId    {string}   The ID of the material being reported.
 *  materialTitle {string}   Display name shown in the modal heading.
 */
export default function ReportModal({ isOpen, onClose, materialId, materialTitle }) {
  const [reason, setReason] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  if (!isOpen) return null;

  function resetAndClose() {
    setSubmitted(false);
    setReason("");
    setDescription("");
    setError("");
    onClose();
  }

  async function handleSubmit(e) {
    e.preventDefault();

    if (!reason) {
      setError("Please select a reason for reporting.");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ materialId, reason, description }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Failed to submit report. Please try again.");
      }

      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) resetAndClose();
      }}
    >
      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-modal-title"
        className="bg-white dark:bg-surface-strong rounded-3xl p-6 max-w-md w-full shadow-xl border border-gray-100 dark:border-border-subtle"
      >
        {submitted ? (
          /* ── Success state ── */
          <div className="text-center py-6 space-y-4">
            <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600">
              <FaCheckCircle className="h-6 w-6" aria-hidden="true" />
            </div>

            <h3 className="text-lg font-bold text-gray-900 dark:text-foreground">Report Submitted</h3>

            <p className="text-sm text-gray-500 dark:text-muted-foreground leading-relaxed">
              Thank you for your report. The listing has been flagged and is currently under admin
              review. We will investigate the issue.
            </p>

            <div className="mt-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl p-3 border border-slate-100 dark:border-slate-700 text-left">
              <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 dark:text-slate-500 block">
                Moderation Queue
              </span>
              <p className="text-xs text-slate-600 dark:text-slate-300 mt-1">
                Status:{" "}
                <span className="font-semibold text-amber-600">Pending Review</span>
              </p>
            </div>

            <button
              type="button"
              onClick={resetAndClose}
              className="mt-6 w-full py-2 bg-gray-100 dark:bg-surface-muted hover:bg-gray-200 dark:hover:bg-surface-strong text-gray-700 dark:text-foreground/80 font-semibold rounded-xl transition focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              Close
            </button>
          </div>
        ) : (
          /* ── Form state ── */
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-border-subtle pb-3">
              <div className="flex items-center gap-2">
                <FaFlag className="text-red-500 text-sm" aria-hidden="true" />
                <h3
                  id="report-modal-title"
                  className="text-lg font-bold text-gray-950 dark:text-foreground"
                >
                  Report Resource
                </h3>
              </div>
              <button
                type="button"
                onClick={resetAndClose}
                aria-label="Close report modal"
                className="text-gray-400 dark:text-muted-foreground hover:text-gray-600 rounded-full p-1 transition focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <FaTimes aria-hidden="true" />
              </button>
            </div>

            {materialTitle ? (
              <p className="text-xs text-gray-500 dark:text-muted-foreground bg-gray-50 dark:bg-surface-muted rounded-xl px-3 py-2 border border-gray-100 dark:border-border-subtle truncate">
                {materialTitle}
              </p>
            ) : null}

            <p className="text-xs text-gray-500 dark:text-muted-foreground">
              Help us keep EduVault clean and reliable. Please tell us why you are flagging this
              listing:
            </p>

            {/* Reason select */}
            <div className="space-y-1.5">
              <label
                htmlFor="report-reason"
                className="block text-xs font-bold text-gray-700 dark:text-foreground/80 uppercase tracking-wider"
              >
                Reason for flagging <span aria-hidden="true" className="text-red-500">*</span>
              </label>
              <select
                id="report-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                aria-required="true"
                aria-describedby={error ? "report-error" : undefined}
                className="w-full border border-gray-300 dark:border-border-strong rounded-xl px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 text-gray-800 dark:text-foreground bg-white dark:bg-surface-strong"
              >
                <option value="">Select a reason...</option>
                {REPORT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            {/* Description textarea */}
            <div className="space-y-1.5">
              <label
                htmlFor="report-description"
                className="block text-xs font-bold text-gray-700 dark:text-foreground/80 uppercase tracking-wider"
              >
                Additional information{" "}
                <span className="text-gray-400 dark:text-muted-foreground font-normal normal-case">(optional)</span>
              </label>
              <textarea
                id="report-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Please provide any details that may help our review team..."
                rows={4}
                className="w-full border border-gray-300 dark:border-border-strong rounded-xl px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 text-gray-800 dark:text-foreground bg-white dark:bg-surface-strong resize-none"
              />
            </div>

            {/* Error message */}
            {error ? (
              <p
                id="report-error"
                role="alert"
                className="text-xs text-red-600 font-medium"
              >
                {error}
              </p>
            ) : null}

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={resetAndClose}
                className="flex-1 py-2 border border-gray-200 dark:border-border-strong text-gray-600 dark:text-muted-foreground hover:bg-gray-50 dark:hover:bg-surface-muted font-semibold rounded-xl transition focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-xl transition disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-red-500"
              >
                {submitting ? "Submitting..." : "Submit Report"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
