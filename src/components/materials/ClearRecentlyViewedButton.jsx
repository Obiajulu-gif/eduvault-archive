"use client";

import { useState } from "react";
import { FaTrash } from "react-icons/fa";
import Modal from "@/components/Modal";
import { clearRecentlyViewed } from "@/hooks/useRecentlyViewed";

export default function ClearRecentlyViewedButton({ className = "" }) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  const confirmClear = () => {
    clearRecentlyViewed();
    setIsConfirmOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsConfirmOpen(true)}
        aria-label="Clear recently viewed history"
        className={className}
      >
        <FaTrash aria-hidden="true" />
        <span>Clear history</span>
      </button>

      <Modal
        isOpen={isConfirmOpen}
        onClose={() => setIsConfirmOpen(false)}
        title="Clear recently viewed history?"
      >
        <p className="text-sm leading-6 text-gray-600">
          This removes all recently viewed materials from this browser. This cannot be undone.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => setIsConfirmOpen(false)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmClear}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          >
            Clear history
          </button>
        </div>
      </Modal>
    </>
  );
}
