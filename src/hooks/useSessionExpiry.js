"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Show the countdown warning this long before the access token actually expires.
export const SESSION_WARNING_LEAD_MS = 2 * 60 * 1000;

const IDLE = "idle";
const ACTIVE = "active";
const WARNING = "warning";
const EXPIRED = "expired";
const SIGNED_OUT = "signed-out";

async function fetchSessionExpiry() {
  const response = await fetch("/api/auth/session", { credentials: "same-origin" });
  if (!response.ok) return null;
  const data = await response.json();
  return data?.authenticated ? data.expiresAt : null;
}

/**
 * Tracks the current JWT session's expiry and flips into a "warning" state
 * `SESSION_WARNING_LEAD_MS` before the cookie expires, so the UI can prompt
 * the user to refresh their session before their connection closes.
 */
export function useSessionExpiry() {
  const [status, setStatus] = useState(IDLE);
  const [expiresAt, setExpiresAt] = useState(null);
  const warningTimerRef = useRef(null);
  const expiryTimerRef = useRef(null);

  const clearTimers = useCallback(() => {
    if (warningTimerRef.current) window.clearTimeout(warningTimerRef.current);
    if (expiryTimerRef.current) window.clearTimeout(expiryTimerRef.current);
    warningTimerRef.current = null;
    expiryTimerRef.current = null;
  }, []);

  const scheduleFrom = useCallback(
    (expiryMs) => {
      clearTimers();
      setExpiresAt(expiryMs);

      const now = Date.now();
      const msUntilWarning = expiryMs - SESSION_WARNING_LEAD_MS - now;
      const msUntilExpiry = expiryMs - now;

      if (msUntilExpiry <= 0) {
        setStatus(EXPIRED);
        return;
      }

      if (msUntilWarning <= 0) {
        setStatus(WARNING);
      } else {
        setStatus(ACTIVE);
        warningTimerRef.current = window.setTimeout(() => setStatus(WARNING), msUntilWarning);
      }

      expiryTimerRef.current = window.setTimeout(() => setStatus(EXPIRED), msUntilExpiry);
    },
    [clearTimers]
  );

  const refreshSchedule = useCallback(async () => {
    const nextExpiresAt = await fetchSessionExpiry();
    if (nextExpiresAt) {
      scheduleFrom(nextExpiresAt);
    } else {
      clearTimers();
      setExpiresAt(null);
      setStatus(SIGNED_OUT);
    }
    return nextExpiresAt;
  }, [clearTimers, scheduleFrom]);

  useEffect(() => {
    refreshSchedule();
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const keepAlive = useCallback(async () => {
    const response = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
    });

    if (!response.ok) {
      clearTimers();
      setStatus(EXPIRED);
      return false;
    }

    await refreshSchedule();
    return true;
  }, [clearTimers, refreshSchedule]);

  return {
    status,
    expiresAt,
    isWarning: status === WARNING,
    isExpired: status === EXPIRED,
    keepAlive,
  };
}
