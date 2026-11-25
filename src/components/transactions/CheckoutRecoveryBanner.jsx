"use client";

import { useId } from "react";

import { RecoveryAction, formatRecoveryAge } from "@/lib/transactions/checkoutRecovery";
import { RecoveryStatus } from "@/hooks/useCheckoutRecovery";

const RESUME_ACTIONS = Object.freeze([
  RecoveryAction.Resume,
  RecoveryAction.Retry,
  RecoveryAction.Verify,
]);

function shortHash(hash) {
  if (typeof hash !== "string" || hash.length <= 14) return hash || "";
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

/**
 * The single visible surface for an interrupted Stellar checkout. It never
 * starts a payment on its own: every action is delegated to the caller so the
 * decision to sign, resubmit, verify or reconnect stays explicit.
 */
export default function CheckoutRecoveryBanner({
  decision,
  status,
  busy = false,
  error = null,
  onPrimary,
  onDismiss,
  onReconnect,
}) {
  const headingId = useId();
  const messageId = useId();

  if (
    !decision ||
    decision.action === RecoveryAction.None ||
    status === RecoveryStatus.Idle ||
    status === RecoveryStatus.Unavailable
  ) {
    return null;
  }

  const needsReconnect = decision.walletMatches === false;
  const isAttention = status === RecoveryStatus.Attention;
  const canResume = RESUME_ACTIONS.includes(decision.action);
  const isWarning = needsReconnect || decision.requiresVerification || isAttention;
  const role = isWarning ? "alert" : "status";
  const primaryLabel = needsReconnect ? "Reconnect wallet" : decision.primaryLabel || "Continue";
  const handlePrimary = needsReconnect && onReconnect ? onReconnect : onPrimary;
  const titles = (decision.record?.items || [])
    .map((item) => item.title)
    .filter((title) => typeof title === "string" && title.length > 0);
  const age = Number.isFinite(decision.ageMs) ? formatRecoveryAge(decision.ageMs) : null;

  return (
    <section
      role={role}
      aria-live={isWarning ? "assertive" : "polite"}
      aria-labelledby={headingId}
      aria-describedby={messageId}
      aria-busy={busy || undefined}
      data-testid="checkout-recovery-banner"
      className={`fixed inset-x-4 top-4 z-[60] mx-auto max-w-lg rounded-xl border bg-white p-4 dark:bg-slate-900 ${
        isWarning
          ? "border-amber-300 dark:border-amber-700"
          : "border-blue-200 dark:border-blue-800"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
            isWarning ? "bg-amber-500" : "bg-blue-600"
          }`}
        />
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-sm font-bold text-slate-900 dark:text-slate-50">
            {decision.title}
          </h2>
          <p
            id={messageId}
            className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300"
          >
            {decision.message}
          </p>

          {titles.length > 0 ? (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {titles.join(", ")}
              {age ? ` - ${age}` : ""}
            </p>
          ) : null}

          {decision.txHash ? (
            <p className="mt-1 break-all font-mono text-[11px] text-slate-500 dark:text-slate-400">
              Transaction {shortHash(decision.txHash)}
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="mt-2 text-xs font-semibold text-rose-600 dark:text-rose-400">
              {error}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(canResume || needsReconnect) && typeof handlePrimary === "function" ? (
              <button
                type="button"
                onClick={handlePrimary}
                disabled={busy}
                className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "Working..." : primaryLabel}
              </button>
            ) : null}

            <button
              type="button"
              onClick={onDismiss}
              disabled={busy}
              className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
