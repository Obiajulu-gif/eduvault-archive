'use client';

import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FaCheckCircle, FaTimesCircle, FaInfoCircle, FaTimes } from 'react-icons/fa';

export const ToastContext = createContext(null);

let toastIdCounter = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const announcerId = useRef(null);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const announce = useCallback((message) => {
    const id = ++toastIdCounter;
    setAnnouncements((prev) => [...prev, { id, message }]);
    setTimeout(() => {
      setAnnouncements((prev) => prev.filter((a) => a.id !== id));
    }, 3000);
  }, []);

  const show = useCallback(({ id, title, message, type = 'info', duration = 5000 }) => {
    const toastId = id || `toast-${++toastIdCounter}`;

    setToasts((prev) => {
      const index = prev.findIndex((t) => t.id === toastId);
      if (index > -1) {
        const updated = [...prev];
        updated[index] = { ...updated[index], title, message, type, duration };
        return updated;
      }
      return [...prev, { id: toastId, title, message, type, duration }];
    });

    const announcementText = title && message ? `${title}: ${message}` : (title || message || '');
    if (announcementText) {
      announce(announcementText);
    }

    if (duration > 0 && type !== 'loading') {
      setTimeout(() => {
        dismiss(toastId);
      }, duration);
    }

    return toastId;
  }, [dismiss, announce]);

  const update = useCallback((id, updates) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...updates } : t))
    );
    if (updates.type && updates.type !== 'loading') {
      const announcementText = updates.title && updates.message
        ? `${updates.title}: ${updates.message}`
        : (updates.title || updates.message || '');
      if (announcementText) {
        announce(announcementText);
      }
    }
    if (updates.duration > 0 && updates.type !== 'loading') {
      setTimeout(() => {
        dismiss(id);
      }, updates.duration);
    }
  }, [dismiss, announce]);

  const value = { show, update, dismiss, toasts };

  const getToastStyles = (type) => {
    switch (type) {
      case 'success':
        return {
          bg: 'bg-emerald-50/90 dark:bg-emerald-950/40 border-emerald-200/60 dark:border-emerald-800/30 text-emerald-800 dark:text-emerald-300',
          icon: <FaCheckCircle className="text-emerald-500 dark:text-emerald-400 w-5 h-5 shrink-0" aria-hidden="true" />,
        };
      case 'error':
        return {
          bg: 'bg-rose-50/90 dark:bg-rose-950/40 border-rose-200/60 dark:border-rose-800/30 text-rose-800 dark:text-rose-300',
          icon: <FaTimesCircle className="text-rose-500 dark:text-rose-400 w-5 h-5 shrink-0" aria-hidden="true" />,
        };
      case 'loading':
        return {
          bg: 'bg-blue-50/90 dark:bg-slate-900/80 border-blue-200/60 dark:border-slate-800/50 text-blue-800 dark:text-blue-300',
          icon: (
            <svg className="animate-spin h-5 w-5 text-blue-500 dark:text-blue-400 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          ),
        };
      case 'info':
      default:
        return {
          bg: 'bg-sky-50/90 dark:bg-sky-950/40 border-sky-200/60 dark:border-sky-800/30 text-sky-800 dark:text-sky-300',
          icon: <FaInfoCircle className="text-sky-500 dark:text-sky-400 w-5 h-5 shrink-0" aria-hidden="true" />,
        };
    }
  };

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcements.map((a) => (
          <p key={a.id}>{a.message}</p>
        ))}
      </div>

      <div
        className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-3 w-[calc(100vw-3rem)] max-w-sm sm:max-w-md pointer-events-none"
        role="region"
        aria-label="Notifications"
      >
        <AnimatePresence mode="popLayout">
          {toasts.map((toast) => {
            const styles = getToastStyles(toast.type);
            const isLive = toast.type === 'loading' ? 'polite' : 'assertive';
            return (
              <motion.div
                key={toast.id}
                layout
                initial={{ opacity: 0, y: 50, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85, transition: { duration: 0.2 } }}
                transition={{ type: 'spring', stiffness: 350, damping: 25 }}
                className={`pointer-events-auto flex items-start gap-3 p-4 rounded-xl border backdrop-blur-md shadow-lg ${styles.bg} transition-colors duration-300 relative overflow-hidden`}
                role="status"
                aria-live={isLive}
                aria-atomic="true"
                tabIndex={-1}
              >
                {toast.type === 'loading' && (
                  <motion.div
                    initial={{ x: '-100%' }}
                    animate={{ x: '100%' }}
                    transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}
                    className="absolute inset-0 bg-gradient-to-r from-transparent via-blue-500/10 to-transparent pointer-events-none motion-reduce:animate-none motion-reduce:hidden"
                    aria-hidden="true"
                  />
                )}

                <div className="mt-0.5">{styles.icon}</div>

                <div className="flex-1 flex flex-col min-w-0 pr-4">
                  {toast.title && (
                    <span className="text-sm font-bold tracking-tight mb-0.5 leading-tight">
                      {toast.title}
                    </span>
                  )}
                  {toast.message && (
                    <span className="text-xs opacity-90 leading-relaxed font-medium break-words">
                      {toast.message}
                    </span>
                  )}
                </div>

                {toast.type !== 'loading' && (
                  <button
                    onClick={() => dismiss(toast.id)}
                    className="absolute top-3 right-3 opacity-60 hover:opacity-100 transition-opacity p-1 hover:bg-black/5 rounded text-xs focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                    aria-label={`Dismiss ${toast.title || 'notification'}`}
                  >
                    <FaTimes aria-hidden="true" />
                  </button>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
