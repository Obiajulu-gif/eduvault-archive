"use client";

import { useState, useCallback, useEffect, useRef } from "react";

const STORAGE_KEY = "eduvault_notifications";

const WELCOME = {
  id: "welcome-1",
  type: "info",
  title: "Welcome to EduVault",
  message: "Explore the marketplace and discover academic materials.",
  read: false,
  createdAt: new Date(0).toISOString(),
};

function loadFromStorage() {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveToStorage(notifications) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
  } catch {
    // Silently fail if storage is unavailable
  }
}

function getInitialNotifications() {
  const stored = loadFromStorage();
  if (stored && Array.isArray(stored) && stored.length > 0) {
    return stored;
  }
  const initial = [WELCOME];
  saveToStorage(initial);
  return initial;
}

export function useNotifications() {
  const [notifications, setNotifications] = useState(getInitialNotifications);
  const isInitialized = useRef(false);

  // Mark as initialized after mount so the sync effect skips the initial render
  useEffect(() => {
    isInitialized.current = true;
  }, []);

  // Sync back to storage only after initial mount initialization has occurred
  useEffect(() => {
    if (isInitialized.current && notifications.length > 0) {
      saveToStorage(notifications);
    }
  }, [notifications]);

  const addNotification = useCallback(({ type = "info", title, message }) => {
    const newNotif = {
      id: `notif-${Date.now()}`,
      type,
      title,
      message,
      read: false,
      createdAt: new Date().toISOString(),
    };
    setNotifications((prev) => [newNotif, ...prev]);
  }, []);

  const markRead = useCallback((id) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clearAll = useCallback(() => {
    saveToStorage([]);
    setNotifications([]);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return {
    notifications,
    unreadCount,
    addNotification,
    markRead,
    markAllRead,
    clearAll,
  };
}
