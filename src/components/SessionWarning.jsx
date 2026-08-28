"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FaClock, FaSignOutAlt } from "react-icons/fa";
import { useSessionExpiry } from "@/hooks/useSessionExpiry";

function formatCountdown(msRemaining) {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Global session-timeout countdown. Renders nothing unless the user's JWT
 * session is within its final warning window, then blocks the app with a
 * modal offering to renew the session before the cookie expires.
 */
export default function SessionWarning() {
  const { isWarning, isExpired, expiresAt, keepAlive } = useSessionExpiry();
  const [msRemaining, setMsRemaining] = useState(0);
  const [isRenewing, setIsRenewing] = useState(false);
  const [renewError, setRenewError] = useState(null);

  useEffect(() => {
    if (!isWarning || !expiresAt) return;

    setMsRemaining(expiresAt - Date.now());
    const interval = window.setInterval(() => {
      setMsRemaining(expiresAt - Date.now());
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isWarning, expiresAt]);

  if (isExpired) {
    return (
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="session-expired-heading"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-surface-strong p-6 text-center shadow-xl">
            <FaSignOutAlt className="mx-auto mb-3 text-2xl text-red-500" aria-hidden="true" />
            <h2 id="session-expired-heading" className="mb-1 text-lg font-bold text-gray-900 dark:text-foreground">
              Session expired
            </h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-muted-foreground">
              For your security, you&apos;ve been signed out. Please sign in again to continue.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full min-h-[44px] rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700"
            >
              Sign in again
            </button>
          </div>
        </motion.div>
      </AnimatePresence>
    );
  }

  if (!isWarning) return null;

  const handleKeepAlive = async () => {
    setIsRenewing(true);
    setRenewError(null);
    try {
      const success = await keepAlive();
      if (!success) {
        setRenewError("Unable to renew your session. Please sign in again.");
      }
    } catch {
      setRenewError("Unable to renew your session. Please sign in again.");
    } finally {
      setIsRenewing(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.5 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] bg-black backdrop-blur-sm"
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 30 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 30 }}
        className="fixed inset-0 z-[101] flex items-end justify-center overflow-y-auto p-0 sm:items-center sm:p-4"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-warning-heading"
        aria-describedby="session-warning-description"
      >
        <div className="relative w-full max-w-sm rounded-t-2xl bg-white dark:bg-surface-strong p-6 shadow-lg sm:rounded-2xl">
          <div className="mb-4 flex items-center justify-center gap-2 text-amber-500">
            <FaClock className="text-xl" aria-hidden="true" />
            <span className="text-2xl font-bold tabular-nums" aria-live="polite">
              {formatCountdown(msRemaining)}
            </span>
          </div>

          <h2 id="session-warning-heading" className="mb-1 text-center text-lg font-bold text-gray-900 dark:text-foreground">
            Your session is about to expire
          </h2>
          <p id="session-warning-description" className="mb-5 text-center text-sm text-gray-500 dark:text-muted-foreground">
            You&apos;ll be signed out soon and any unsaved changes may be lost. Stay signed in to keep working.
          </p>

          {renewError && (
            <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-center text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {renewError}
            </p>
          )}

          <button
            type="button"
            onClick={handleKeepAlive}
            disabled={isRenewing}
            className="min-h-[48px] w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRenewing ? "Renewing..." : "Keep me signed in"}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
