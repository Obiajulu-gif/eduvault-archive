"use client";

import { FaCheckCircle, FaHeart, FaFlag } from "react-icons/fa";
import SaveMaterialButton from "@/components/materials/SaveMaterialButton";
import ShareMaterialButton from "@/components/materials/ShareMaterialButton";
import PriceLine from "./PriceLine";
import AccessStatusPanel from "./AccessStatusPanel";
import { getAverageScore, getFeedbackCount } from "./utils";

function PurchaseCard({
  material,
  accessStatus,
  entitlementQuery,
  address,
  isOwned,
  isDownloading,
  downloadError,
  onDownload,
  onRequestAccess,
  onAddToCart,
  onReport,
}) {
  return (
    <aside className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-5 sm:p-6 shadow-sm space-y-5 lg:sticky lg:top-24">
      <div className="space-y-3">
        <PriceLine
          price={material.price}
          currency={material.currency}
          rating={getAverageScore(material)}
          reviewsCount={getFeedbackCount(material)}
        />
        <AccessStatusPanel
          status={accessStatus}
          isLoading={Boolean(address && entitlementQuery.isLoading)}
        />
      </div>

      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:justify-start items-stretch sm:items-center gap-3 w-full">
        <div className="w-full sm:w-auto sm:flex-1 flex gap-2">
          <SaveMaterialButton material={material} variant="detail" className="flex-1" />
          <ShareMaterialButton material={material} className="flex-1" />
        </div>
        {isOwned ? (
          <button
            type="button"
            className="w-full sm:w-auto sm:flex-1 px-6 sm:px-8 py-2.5 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-md transition flex items-center justify-center gap-2 shadow-sm focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 disabled:cursor-not-allowed"
            onClick={onDownload}
            disabled={isDownloading}
          >
            <FaCheckCircle aria-hidden="true" />
            {isDownloading ? "Preparing..." : "Download material"}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="w-full sm:w-auto sm:flex-1 px-6 py-2 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-semibold rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition focus-visible:ring-2 focus-visible:ring-blue-500"
              onClick={onAddToCart}
            >
              Buy now
            </button>
            <button
              type="button"
              className="w-full sm:w-auto sm:flex-1 px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-md transition focus-visible:ring-2 focus-visible:ring-blue-500"
              onClick={onRequestAccess}
            >
              {accessStatus === "pending" ? "Complete payment" : "Request access"}
            </button>
          </>
        )}
      </div>

      {downloadError ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {downloadError}
        </p>
      ) : null}

      <div className="flex items-center justify-between text-sm text-gray-500 dark:text-gray-400 pt-3 border-t border-gray-100 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <FaHeart className="text-pink-500" aria-hidden="true" />
          <span>{material.likes || 0} likes</span>
        </div>
        <button
          type="button"
          onClick={onReport}
          className="flex items-center gap-1.5 text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 transition duration-150 font-medium"
        >
          <FaFlag className="text-xs" aria-hidden="true" />
          <span>Report quality issue</span>
        </button>
      </div>
    </aside>
  );
}

export default PurchaseCard;
