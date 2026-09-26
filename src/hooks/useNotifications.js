"use client";

import { useState, useCallback, useEffect } from "react";

// Server-backed (#794): notifications live in the `notifications` collection
// so they follow the user across devices and are created once per event.
// Signed-out visitors get a 401 and simply see an empty list.
export function useNotifications() {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      setNotifications(data.notifications || []);
      setUnreadCount(data.unreadCount || 0);
    } catch {
      // Network failure: keep whatever is already shown
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const patchRead = useCallback(async (body) => {
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } finally {
      refresh();
    }
  }, [refresh]);

  const markRead = useCallback((id) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    return patchRead({ ids: [id] });
  }, [patchRead]);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    return patchRead({ all: true });
  }, [patchRead]);

  return {
    notifications,
    unreadCount,
    markRead,
    markAllRead,
    refresh,
  };
}
