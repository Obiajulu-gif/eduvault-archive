import { FaCheckCircle, FaClock, FaExclamationTriangle } from "react-icons/fa";

export const FALLBACK_IMAGE = "/images/image2.jpg";

export function getPreviewImage(material) {
  return material.coverImageUrl || material.thumbnailUrl || material.image || FALLBACK_IMAGE;
}

export function getPreviewCounts(material) {
  return {
    outcomes: Array.isArray(material.learningOutcomes) ? material.learningOutcomes.length : 0,
    sections: Array.isArray(material.tableOfContents) ? material.tableOfContents.length : 0,
    notes: Array.isArray(material.sampleNotes) ? material.sampleNotes.length : 0,
  };
}

export function hasCoverImage(material) {
  return Boolean(material.coverImageUrl || material.thumbnailUrl || material.image);
}

export function getAverageScore(material) {
  const score = Number(material.averageScore ?? material.rating);
  return Number.isFinite(score) && score > 0 ? score.toFixed(1) : "New";
}

export function getFeedbackCount(material) {
  return Number(material.feedbackCount ?? material.reviewsCount ?? 0) || 0;
}

export function getAccessCopy(status, isLoading) {
  if (isLoading) {
    return {
      label: "Checking access",
      message: "We are checking your payment and entitlement status.",
      className: "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-slate-700 dark:text-slate-300",
      icon: FaClock,
    };
  }
  switch (status) {
    case "active":
      return {
        label: "Access granted",
        message: "Payment is complete. This material is unlocked for your wallet.",
        className: "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300",
        icon: FaCheckCircle,
      };
    case "pending":
      return {
        label: "Payment pending",
        message: "Your access request started, but payment still needs to be completed.",
        className: "border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300",
        icon: FaClock,
      };
    case "payment_failed":
      return {
        label: "Payment incomplete",
        message: "The previous payment attempt did not complete, so access is still locked.",
        className: "border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/30 text-rose-800 dark:text-rose-300",
        icon: FaExclamationTriangle,
      };
    case "wallet_required":
      return {
        label: "Wallet required",
        message: "Connect your wallet to request access and complete payment.",
        className: "border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300",
        icon: FaClock,
      };
    default:
      return {
        label: "Payment required",
        message: "Start an access request from this page, then complete payment to unlock the file.",
        className: "border-slate-200 dark:border-slate-700 bg-white dark:bg-surface-strong text-slate-700 dark:text-slate-300",
        icon: FaClock,
      };
  }
}
