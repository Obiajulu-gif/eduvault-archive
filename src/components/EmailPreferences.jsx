"use client";

import { useState, useCallback } from "react";
import { FaEnvelope, FaCheckCircle, FaExclamationTriangle, FaSpinner } from "react-icons/fa";
import { useEmailSubscriptions, useUpdateEmailSubscriptions } from "@/hooks/api/useEmailSubscriptions";
import { useWallet } from "@/hooks/useWallet";

/** Individual preference entries shown in the panel. */
const PREFERENCE_ITEMS = [
  {
    key: "purchaseReceipts",
    label: "Purchase receipts",
    description: "Receive a confirmation email every time you successfully buy a material.",
  },
  {
    key: "buyConfirmations",
    label: "Buy confirmations",
    description: "Get notified when your on-chain purchase transaction is confirmed.",
  },
  {
    key: "weeklyEarnings",
    label: "Weekly earnings digest",
    description: "A weekly summary of your creator earnings and payout activity.",
  },
  {
    key: "productUpdates",
    label: "Product updates",
    description: "News about new EduVault features, improvements, and marketplace changes.",
  },
  {
    key: "materialApproved",
    label: "Material approved",
    description: "Notify me when a material I uploaded passes review and goes live.",
  },
  {
    key: "newFollower",
    label: "New followers",
    description: "Let me know when someone starts following my creator profile.",
  },
];

/** Accessible toggle switch */
function Toggle({ id, checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-stellar-blue/60 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-stellar-blue" : "bg-border-strong"
      }`}
    >
      <span className="sr-only">{checked ? "Enabled" : "Disabled"}</span>
      <span
        aria-hidden="true"
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

/**
 * EmailPreferences panel.
 *
 * Loads current preferences from the API, lets the user toggle each option,
 * and saves changes via PATCH /api/profile/email-subscriptions.
 *
 * @param {{ initialSubscriptions?: Record<string, boolean> }} props
 */
export default function EmailPreferences({ initialSubscriptions }) {
  const { address } = useWallet();

  const {
    data: remoteData,
    isLoading,
    isError,
  } = useEmailSubscriptions({ initialData: initialSubscriptions });

  const { mutateAsync: savePreferences, isPending: isSaving } = useUpdateEmailSubscriptions();

  // Derive current prefs: prefer live query data over server-provided initial.
  const serverPrefs = remoteData?.emailSubscriptions ?? initialSubscriptions ?? {};

  // Local optimistic copy — keyed by ALLOWED_KEYS, defaulting to true.
  const [localPrefs, setLocalPrefs] = useState(null);
  const prefs = localPrefs ?? serverPrefs;

  const [saveStatus, setSaveStatus] = useState(null); // null | 'success' | 'error'
  const [saveError, setSaveError] = useState("");

  // Track in-flight individual toggle saves to give per-row feedback.
  const [pendingKeys, setPendingKeys] = useState(new Set());

  const handleToggle = useCallback(
    async (key, newValue) => {
      // Optimistic update
      setLocalPrefs((prev) => ({ ...(prev ?? serverPrefs), [key]: newValue }));
      setSaveStatus(null);
      setSaveError("");
      setPendingKeys((prev) => new Set([...prev, key]));

      try {
        await savePreferences({ emailSubscriptions: { [key]: newValue } });
        setSaveStatus("success");
        // Clear success banner after 3 s
        setTimeout(() => setSaveStatus((s) => (s === "success" ? null : s)), 3000);
      } catch (err) {
        // Roll back on failure
        setLocalPrefs((prev) => ({ ...(prev ?? serverPrefs), [key]: !newValue }));
        setSaveStatus("error");
        setSaveError(err?.message || "Failed to save preference. Please try again.");
      } finally {
        setPendingKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [savePreferences, serverPrefs],
  );

  if (!address) {
    return null;
  }

  return (
    <section
      aria-labelledby="email-prefs-heading"
      className="rounded-3xl border border-border-subtle bg-surface-strong p-6 shadow-sm sm:p-8"
    >
      {/* Header */}
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-stellar-blue/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-stellar-blue">
            <FaEnvelope />
            Email notifications
          </div>
          <h2
            id="email-prefs-heading"
            className="mt-4 text-2xl font-semibold tracking-tight text-foreground"
          >
            Manage your email subscriptions
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            Choose which emails you&apos;d like to receive. Preferences are saved
            instantly when you flip a toggle.
          </p>
        </div>
      </div>

      {/* Status banners */}
      {saveStatus === "success" && (
        <div
          role="status"
          aria-live="polite"
          className="mb-6 flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          <FaCheckCircle className="shrink-0 text-emerald-500" />
          Preference saved successfully.
        </div>
      )}

      {saveStatus === "error" && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-6 flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <FaExclamationTriangle className="shrink-0 text-red-500" />
          {saveError}
        </div>
      )}

      {/* Loading skeleton */}
      {isLoading && !localPrefs && (
        <div className="space-y-4" aria-busy="true" aria-label="Loading preferences">
          {PREFERENCE_ITEMS.map((item) => (
            <div
              key={item.key}
              className="flex animate-pulse items-center justify-between rounded-2xl border border-border-subtle bg-surface-muted px-4 py-4"
            >
              <div className="space-y-2">
                <div className="h-3 w-40 rounded bg-border-strong" />
                <div className="h-2.5 w-64 rounded bg-border-subtle" />
              </div>
              <div className="h-6 w-11 rounded-full bg-border-strong" />
            </div>
          ))}
        </div>
      )}

      {/* Remote error state */}
      {isError && !localPrefs && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <FaExclamationTriangle className="mr-2 inline-block" />
          Could not load your preferences. Showing defaults — you can still toggle and save.
        </div>
      )}

      {/* Preference rows */}
      {(!isLoading || localPrefs) && (
        <ul className="divide-y divide-border-subtle" role="list">
          {PREFERENCE_ITEMS.map((item) => {
            const isChecked = prefs[item.key] !== false; // default on
            const isPendingKey = pendingKeys.has(item.key);

            return (
              <li
                key={item.key}
                className="flex items-center justify-between gap-6 py-4 first:pt-0 last:pb-0"
              >
                <div className="flex-1 min-w-0">
                  <label
                    htmlFor={`email-pref-${item.key}`}
                    className="block cursor-pointer text-sm font-medium text-foreground"
                  >
                    {item.label}
                    {isPendingKey && (
                      <FaSpinner
                        className="ml-2 inline-block animate-spin text-muted-foreground"
                        aria-hidden="true"
                      />
                    )}
                  </label>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {item.description}
                  </p>
                </div>

                <Toggle
                  id={`email-pref-${item.key}`}
                  checked={isChecked}
                  onChange={(val) => handleToggle(item.key, val)}
                  disabled={isSaving || isPendingKey}
                />
              </li>
            );
          })}
        </ul>
      )}

      {/* Footer note */}
      <p className="mt-6 text-xs text-muted-foreground">
        Transactional emails required for security or account integrity cannot be disabled.
        Toggles here only control optional notification types.
      </p>
    </section>
  );
}
