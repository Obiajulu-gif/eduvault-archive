"use client";

import { useState } from "react";
import { FaShareAlt, FaCheck } from "react-icons/fa";
import ShareModal from "@/components/ShareModal";

export default function ShareMaterialButton({ material, className = "" }) {
  const [copied, setCopied] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleShare = async () => {
    setIsModalOpen(true);

    console.log("[Analytics] Tracked Share Interaction for material:", material._id || material.id);
    try {
      await fetch('/api/analytics/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'share_material', materialId: material._id || material.id })
      });
    } catch (e) {
      // silently ignore tracking errors
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleShare}
        className={`flex items-center justify-center gap-2 border border-gray-300 text-gray-700 font-semibold rounded-md hover:bg-gray-100 transition focus-visible:ring-2 focus-visible:ring-blue-500 ${className}`}
        title="Share this material"
      >
        <FaShareAlt />
        Share
      </button>

      <ShareModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        materialTitle={material?.title}
      />
    </>
    <button
      type="button"
      onClick={handleShare}
      className={`flex items-center justify-center gap-2 border border-gray-300 dark:border-border-strong text-gray-700 dark:text-foreground/80 font-semibold rounded-md hover:bg-gray-100 dark:hover:bg-surface-muted transition focus-visible:ring-2 focus-visible:ring-blue-500 ${className}`}
      title="Share this material"
    >
      {copied ? <FaCheck className="text-green-600" /> : <FaShareAlt />}
      {copied ? "Shared!" : "Share"}
    </button>
  );
}

