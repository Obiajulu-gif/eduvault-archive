"use client";

import { useEffect, useState, useCallback } from "react";
import {
  FaExclamationTriangle,
  FaCheckCircle,
  FaSpinner,
  FaTimesCircle,
  FaTrashAlt,
  FaShieldAlt,
  FaClock,
  FaLock,
} from "react-icons/fa";

const COOLING_OFF_DAYS = 14;

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const diff = new Date(dateStr) - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// ─── Phase-specific sub-views ──────────────────────────────────────────────

function ConfirmationGate({ onConfirm, onBack }) {
  const [checked, setChecked] = useState(false);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
          <FaExclamationTriangle aria-hidden="true" />
          Before you continue
        </h3>
        <ul className="mt-2 space-y-1 text-sm text-amber-700 dark:text-amber-400 list-disc list-inside">
          <li>All your materials, purchases, and profile data will be permanently removed.</li>
          <li>Financial records are kept for up to 7 years as required by law, but your name and wallet address will be anonymized.</li>
          <li>You have <strong>{COOLING_OFF_DAYS} days</strong> to change your mind after confirming.</li>
          <li>This action cannot be undone once the cooling-off period ends.</li>
        </ul>
      </div>
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
        />
        <span className="text-sm text-gray-700 dark:text-gray-300">
          I understand that deleting my account is permanent and cannot be reversed.
        </span>
      </label>
      <div className="flex gap-3">
        <button
          onClick={onConfirm}
          disabled={!checked}
          className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <FaTrashAlt className="h-4 w-4" aria-hidden="true" />
          Request Account Deletion
        </button>
        <button
          onClick={onBack}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ReauthView({ reauthToken, requestId, onConfirmed, onCancel }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/privacy/deletion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm_reauth", requestId, reauthToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Confirmation failed");
      onConfirmed(data.coolingOffEndsAt);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-blue-800 dark:text-blue-300">
          <FaLock aria-hidden="true" />
          Re-authentication required
        </h3>
        <p className="mt-1 text-sm text-blue-700 dark:text-blue-400">
          Click the button below to confirm your identity and start the {COOLING_OFF_DAYS}-day cooling-off window.
        </p>
      </div>
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
      )}
      <div className="flex gap-3">
        <button
          onClick={handleConfirm}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          aria-busy={loading}
        >
          {loading ? <FaSpinner className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FaShieldAlt className="h-4 w-4" aria-hidden="true" />}
          {loading ? "Confirming…" : "Confirm Identity"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 transition-colors"
        >
          Cancel Request
        </button>
      </div>
    </div>
  );
}

function CoolingOffView({ coolingOffEndsAt, requestId, onCancelled }) {
  const daysLeft = daysUntil(coolingOffEndsAt);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(null);

  async function handleCancel() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/privacy/deletion/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, reason: "user_cancelled_during_cooling_off" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not cancel");
      onCancelled();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
          <FaClock aria-hidden="true" />
          Cooling-off period active
        </h3>
        <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
          Your deletion request is confirmed. You have{" "}
          <strong>{daysLeft !== null ? `${daysLeft} day${daysLeft !== 1 ? "s" : ""}` : "some time"}</strong>{" "}
          to cancel. After{" "}
          <time dateTime={coolingOffEndsAt}>{coolingOffEndsAt ? new Date(coolingOffEndsAt).toLocaleDateString() : "—"}</time>,
          your account will be permanently deleted.
        </p>
      </div>
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
      )}
      <button
        onClick={handleCancel}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 disabled:opacity-60 transition-colors"
        aria-busy={loading}
      >
        {loading ? <FaSpinner className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FaTimesCircle className="h-4 w-4" aria-hidden="true" />}
        {loading ? "Cancelling…" : "Cancel Deletion Request"}
      </button>
    </div>
  );
}

function BlockedView({ reasons }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-400">
        <FaExclamationTriangle aria-hidden="true" />
        Deletion blocked
      </h3>
      <p className="mt-1 text-sm text-red-600 dark:text-red-300">
        Your account cannot be deleted yet. Resolve the following before proceeding:
      </p>
      <ul className="mt-2 space-y-1 text-sm text-red-700 dark:text-red-400 list-disc list-inside">
        {reasons.map((r, i) => <li key={i}>{r}</li>)}
      </ul>
    </div>
  );
}

function CompletedView({ receiptId, completedAt }) {
  return (
    <div className="rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-green-800 dark:text-green-300">
        <FaCheckCircle aria-hidden="true" />
        Account deleted
      </h3>
      <p className="mt-1 text-sm text-green-700 dark:text-green-400">
        Your account has been permanently deleted.
        {receiptId && (
          <> Receipt ID: <code className="font-mono">{receiptId}</code>.</>
        )}
        {completedAt && (
          <> Completed on <time dateTime={completedAt}>{new Date(completedAt).toLocaleString()}</time>.</>
        )}
      </p>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export default function PrivacyAccountDeletionPanel() {
  const [phase, setPhase] = useState("loading"); // loading | idle | confirming | reauth | cooling_off | executing | blocked | completed | failed
  const [deletionState, setDeletionState] = useState(null);

  const loadStatus = useCallback(async () => {
    try {
      const res  = await fetch("/api/privacy/deletion");
      const data = await res.json();
      if (!data.active) {
        setPhase("idle");
        return;
      }
      setDeletionState(data);
      switch (data.status) {
        case "pending_reauth": setPhase("reauth"); break;
        case "cooling_off":    setPhase("cooling_off"); break;
        case "executing":      setPhase("executing"); break;
        case "completed":      setPhase("completed"); break;
        case "failed":         setPhase("failed"); break;
        default:               setPhase("idle");
      }
    } catch {
      setPhase("idle");
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  async function handleRequestDeletion() {
    setPhase("confirming");
  }

  async function handleConfirmed() {
    setPhase("loading");
    try {
      const res  = await fetch("/api/privacy/deletion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setDeletionState(data);
      setPhase("reauth");
    } catch (err) {
      setDeletionState({ failureReason: err.message });
      setPhase("failed");
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <section
      aria-labelledby="deletion-heading"
      className="rounded-2xl border border-red-200 bg-white p-6 shadow-sm dark:border-red-900 dark:bg-gray-900"
    >
      <div className="flex items-start gap-4">
        <div className="rounded-xl bg-red-50 p-3 dark:bg-red-950">
          <FaTrashAlt className="h-5 w-5 text-red-600 dark:text-red-400" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 id="deletion-heading" className="text-base font-semibold text-gray-900 dark:text-white">
            Delete Account
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Permanently delete your EduVault account and all associated personal data.
            Financial records required by law will be anonymized but retained.
          </p>
        </div>
      </div>

      <div className="mt-5">
        {phase === "loading" && (
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <FaSpinner className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading…
          </div>
        )}

        {phase === "idle" && (
          <button
            onClick={handleRequestDeletion}
            className="inline-flex items-center gap-2 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 shadow-sm hover:bg-red-50 dark:border-red-700 dark:bg-gray-900 dark:text-red-400 dark:hover:bg-red-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 transition-colors"
          >
            <FaTrashAlt className="h-4 w-4" aria-hidden="true" />
            Request Account Deletion
          </button>
        )}

        {phase === "confirming" && (
          <ConfirmationGate
            onConfirm={handleConfirmed}
            onBack={() => setPhase("idle")}
          />
        )}

        {phase === "reauth" && deletionState && (
          <ReauthView
            reauthToken={deletionState.reauthToken}
            requestId={deletionState.requestId}
            onConfirmed={(coolingOffEndsAt) => {
              setDeletionState((s) => ({ ...s, coolingOffEndsAt }));
              setPhase("cooling_off");
            }}
            onCancel={async () => {
              if (!deletionState.requestId) { setPhase("idle"); return; }
              await fetch("/api/privacy/deletion/cancel", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ requestId: deletionState.requestId }),
              });
              setDeletionState(null);
              setPhase("idle");
            }}
          />
        )}

        {phase === "cooling_off" && deletionState && (
          <CoolingOffView
            coolingOffEndsAt={deletionState.coolingOffEndsAt}
            requestId={deletionState.requestId}
            onCancelled={() => { setDeletionState(null); setPhase("idle"); }}
          />
        )}

        {phase === "executing" && (
          <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <FaSpinner className="h-4 w-4 animate-spin text-red-500" aria-hidden="true" />
            Your account is being deleted. This may take a few moments.
          </div>
        )}

        {phase === "blocked" && deletionState?.obligationBlockReasons && (
          <BlockedView reasons={deletionState.obligationBlockReasons} />
        )}

        {phase === "completed" && deletionState && (
          <CompletedView receiptId={deletionState.receiptId} completedAt={deletionState.completedAt} />
        )}

        {phase === "failed" && (
          <div className="space-y-3">
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
              <p className="flex items-center gap-2 text-sm text-red-700 dark:text-red-400">
                <FaExclamationTriangle aria-hidden="true" />
                {deletionState?.failureReason ?? "An error occurred. Please try again or contact support."}
              </p>
            </div>
            <button
              onClick={() => { setDeletionState(null); setPhase("idle"); }}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              Back
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
