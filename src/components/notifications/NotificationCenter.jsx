"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { FaBell, FaCheckDouble, FaTrash } from "react-icons/fa";
import { useNotifications } from "@/hooks/useNotifications";

export default function NotificationCenter() {
  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);
  const firstFocusableRef = useRef(null);
  const { notifications, unreadCount, markRead, markAllRead, clearAll } =
    useNotifications();

  const recent = notifications.slice(0, 5);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        handleClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        firstFocusableRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        handleClose();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  return (
    <div className="relative" ref={panelRef}>
      <button
        ref={buttonRef}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
        aria-expanded={isOpen}
        aria-haspopup="true"
        className="relative p-2.5 bg-gray-150/40 hover:bg-gray-200/60 active:scale-95 rounded-full text-gray-700 hover:text-stellar-blue transition-all cursor-pointer flex items-center justify-center shrink-0 border border-gray-200/20 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
      >
        <FaBell className="w-4 h-4" aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1.5 bg-red-500 text-white font-extrabold text-[9px] w-4.5 h-4.5 rounded-full flex items-center justify-center border border-white" aria-label={`${unreadCount} unread notifications`}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          className="absolute right-0 mt-3 w-80 bg-white rounded-2xl shadow-xl border border-gray-100 z-50 overflow-hidden"
          role="menu"
          aria-label="Notifications"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <span className="text-sm font-bold text-gray-900">Notifications</span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  ref={firstFocusableRef}
                  onClick={() => { markAllRead(); }}
                  title="Mark all read"
                  className="text-xs text-blue-600 hover:underline flex items-center gap-1 focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <FaCheckDouble className="w-3 h-3" aria-hidden="true" /> All read
                </button>
              )}
              <button
                onClick={() => { clearAll(); handleClose(); }}
                title="Clear all"
                aria-label="Clear all notifications"
                className="text-xs text-gray-400 hover:text-red-500 transition-colors focus-visible:ring-2 focus-visible:ring-red-500"
              >
                <FaTrash className="w-3 h-3" aria-hidden="true" />
              </button>
            </div>
          </div>

          {recent.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400" role="status">
              No notifications
            </div>
          ) : (
            <ul role="listbox" aria-label="Notification list">
              {recent.map((notif, index) => (
                <li
                  key={notif.id}
                  role="option"
                  aria-selected={false}
                  tabIndex={0}
                  onClick={() => markRead(notif.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      markRead(notif.id);
                    }
                  }}
                  className={`px-4 py-3 border-b border-gray-50 cursor-pointer hover:bg-gray-50 transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 focus-visible:outline-none ${
                    !notif.read ? "bg-blue-50/40" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-bold ${notif.read ? "text-gray-700" : "text-gray-900"}`}>
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
                      <span className="w-2 h-2 bg-blue-500 rounded-full shrink-0 mt-1" aria-label="Unread" />
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
