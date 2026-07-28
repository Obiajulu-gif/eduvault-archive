"use client";

import { useState, useRef, useEffect } from "react";
import { FaBell, FaCheckDouble, FaTrash } from "react-icons/fa";
import { useNotifications } from "@/hooks/useNotifications";

export default function NotificationCenter() {
  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef(null);
  const { notifications, unreadCount, markRead, markAllRead, clearAll } =
    useNotifications();

  const recent = notifications.slice(0, 5);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
        aria-expanded={isOpen}
        className="relative p-2.5 bg-gray-150/40 dark:bg-gray-800/40 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 active:scale-95 rounded-full text-gray-700 dark:text-gray-300 hover:text-stellar-blue transition-all cursor-pointer flex items-center justify-center shrink-0 border border-gray-200/20 dark:border-gray-700/20"
      >
        <FaBell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1.5 bg-red-500 text-white font-extrabold text-[9px] w-4.5 h-4.5 rounded-full flex items-center justify-center border border-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-3 w-80 bg-white dark:bg-gray-900 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-800 z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
            <span className="text-sm font-bold text-gray-900 dark:text-gray-100">Notifications</span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  title="Mark all read"
                  className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                >
                  <FaCheckDouble className="w-3 h-3" /> All read
                </button>
              )}
              <button
                onClick={clearAll}
                title="Clear all"
                className="text-xs text-gray-400 hover:text-red-500 transition-colors"
              >
                <FaTrash className="w-3 h-3" />
              </button>
            </div>
          </div>

          {recent.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
              No notifications
            </div>
          ) : (
            <ul role="list">
              {recent.map((notif) => (
                <li
                  key={notif.id}
                  role="listitem"
                  onClick={() => markRead(notif.id)}
                  className={`px-4 py-3 border-b border-gray-50 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${
                    !notif.read ? "bg-blue-50/40 dark:bg-blue-950/30" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-bold ${notif.read ? "text-gray-700 dark:text-gray-300" : "text-gray-900 dark:text-gray-100"}`}>
                        {notif.title}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                        {notif.message}
                      </p>
                      <p className="text-[10px] text-gray-400 mt-1">
                        {new Date(notif.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    {!notif.read && (
                      <span className="w-2 h-2 bg-blue-500 rounded-full shrink-0 mt-1" aria-hidden="true" />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
