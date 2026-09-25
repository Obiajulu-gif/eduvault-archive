"use client";

import { useState } from "react";
import { FaSpinner, FaTimes, FaPaperclip } from "react-icons/fa";

export default function RefundForm({ item, onClose, onSubmit }) {
  const [reason, setReason] = useState("");
  const [proofDetails, setProofDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const purchaseDate = new Date(item.purchasedAt);
  const now = new Date();
  const hoursSincePurchase = (now - purchaseDate) / (1000 * 60 * 60);
  const isEligible = hoursSincePurchase <= 48;

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!isEligible) {
      setError("This item is no longer eligible for refund (purchased more than 48 hours ago).");
      return;
    }

    if (!reason.trim() || !proofDetails.trim()) {
      setError("Please fill in all fields.");
      return;
    }

    try {
      setSubmitting(true);
      setError(null);

      const res = await fetch("/api/checkout/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          materialId: item.materialId,
          purchaseId: item.purchaseId,
          reason,
          proofDetails,
          transactionHash: item.transactionHash,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Refund request failed");
      }

      onSubmit?.();
      onClose?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Request Refund</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <FaTimes />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <p className="text-sm font-medium text-gray-900 mb-2">{item.material?.title}</p>
            <p className="text-xs text-gray-500">
              Purchased {purchaseDate.toLocaleDateString()}
            </p>
          </div>

          {!isEligible && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-700">
                This item is no longer eligible for refund. Refunds must be requested within 48 hours of purchase.
              </p>
            </div>
          )}

          {isEligible && (
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <p className="text-sm text-blue-700">
                Refund eligible for {Math.ceil(48 - hoursSincePurchase)} hours
              </p>
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">
              Refund Reason
            </label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={!isEligible || submitting}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
            >
              <option value="">Select a reason...</option>
              <option value="broken_file">File is broken or corrupted</option>
              <option value="not_as_described">Not as described</option>
              <option value="duplicate">Duplicate purchase</option>
              <option value="wrong_item">Wrong item purchased</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">
              Proof Details
            </label>
            <textarea
              value={proofDetails}
              onChange={(e) => setProofDetails(e.target.value)}
              disabled={!isEligible || submitting}
              placeholder="Describe the issue in detail..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 resize-none h-24"
            />
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!isEligible || submitting}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {submitting ? (
                <FaSpinner className="animate-spin" size={14} />
              ) : (
                "Submit Request"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
