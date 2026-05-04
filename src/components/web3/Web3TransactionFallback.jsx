"use client";

import { FaExclamationTriangle } from "react-icons/fa";

const guidanceRules = [
  {
    pattern: /(insufficient|underfunded|fee|balance|lumens|xlm)/i,
    title: "Insufficient XLM for network fees",
    hint: "Add a small amount of XLM to your wallet, then retry the transaction.",
  },
  {
    pattern: /(rpc|network|timeout|503|unavailable|failed to fetch|gateway)/i,
    title: "Network or RPC service unavailable",
    hint: "The Stellar RPC endpoint is temporarily unavailable. Please retry in a few moments.",
  },
  {
    pattern: /(reject|cancel|denied|declined|dismiss)/i,
    title: "Transaction was rejected",
    hint: "You may have cancelled in your wallet. Review transaction details and try again.",
  },
];

export function deriveWeb3Guidance(error) {
  const message = error?.message ?? "Unknown blockchain error";
  const match = guidanceRules.find((item) => item.pattern.test(message));

  return {
    title: match?.title ?? "Blockchain transaction failed",
    hint:
      match?.hint ??
      "Please verify your wallet connection, network status, and transaction details before retrying.",
    details: message,
  };
}

export default function Web3TransactionFallback({ error, onRetry, compact = false }) {
  const guidance = deriveWeb3Guidance(error);

  return (
    <div className={`rounded-xl border border-red-200 bg-red-50 p-4 ${compact ? "" : "mt-4"}`} role="alert">
      <div className="flex items-start gap-3">
        <FaExclamationTriangle className="text-red-600 mt-0.5" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-red-800">{guidance.title}</p>
          <p className="text-sm text-red-700 mt-1">{guidance.hint}</p>
          <p className="text-xs text-red-600 mt-2 break-words">Technical details: {guidance.details}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-3 inline-flex items-center rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
