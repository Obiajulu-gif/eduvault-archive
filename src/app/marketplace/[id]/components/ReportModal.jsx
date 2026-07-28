"use client";

import { useState } from "react";
import { FaCheckCircle } from "react-icons/fa";

const REASONS = [
  "Inappropriate content",
  "Copyright violation",
  "Low quality / Unreadable",
  "Spam / Advertising",
  "Incorrect information",
  "Other",
];

function ReportModal({ isOpen, onClose, materialId, materialTitle }) {
  const [reason, setReason] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!reason) {
      setError("Please select a reason for reporting.");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const res = await fetch(`/api/materials/${materialId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, description }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to submit report");
      }

      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setSubmitted(false);
    setReason("");
    setDescription("");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="bg-white dark:bg-surface-strong rounded-3xl p-6 max-w-md w-full shadow-xl border border-gray-100 dark:border-border-subtle">
        {submitted ? (
          <div className="text-center py-6 space-y-4">
            <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600">
              <FaCheckCircle className="h-6 w-6" />
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
                Status: <span className="font-semibold text-amber-600">Pending Review</span>
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Placeholder: Admin review will process this flag shortly.
              </p>
            </div>
            <button
              onClick={handleClose}
              className="mt-6 w-full py-2 bg-gray-100 dark:bg-surface-muted hover:bg-gray-200 dark:hover:bg-surface-strong text-gray-700 dark:text-foreground/80 font-semibold rounded-xl transition"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-border-subtle pb-3">
              <h3 className="text-lg font-bold text-gray-950 dark:text-foreground">Report Resource</h3>
              <button
                type="button"
                onClick={onClose}
                className="text-gray-400 dark:text-muted-foreground hover:text-gray-600 font-semibold text-lg"
              >
                &times;
              </button>
            </div>

            <p className="text-xs text-gray-500 dark:text-muted-foreground">
              Help us keep EduVault clean and reliable. Please tell us why you are flagging this
              listing:
            </p>

            <div className="space-y-2">
              <label className="block text-xs font-bold text-gray-700 dark:text-foreground/80 uppercase tracking-wider">
                Reason for Flagging
              </label>
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full border border-gray-300 dark:border-border-strong rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-800 dark:text-foreground bg-white dark:bg-surface-strong"
                required
              >
                <option value="">Select a reason...</option>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-bold text-gray-700 dark:text-foreground/80 uppercase tracking-wider">
                Additional Information
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Please provide details about the issue..."
                rows={4}
                className="w-full border border-gray-300 dark:border-border-strong rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-800 dark:text-foreground bg-white dark:bg-surface-strong"
              />
            </div>

            {error && <p className="text-xs text-red-600 font-medium">{error}</p>}

            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2 border border-gray-200 dark:border-border-strong text-gray-600 dark:text-muted-foreground hover:bg-gray-50 dark:hover:bg-surface-muted font-semibold rounded-xl transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-xl transition disabled:opacity-60"
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

export default ReportModal;
