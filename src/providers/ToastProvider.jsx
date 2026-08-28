'use client';

import { createContext, useContext, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FaCheckCircle, FaExclamationTriangle, FaTimesCircle, FaInfoCircle, FaTimes } from 'react-icons/fa';

export const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(({ id, title, message, type = 'info', duration = 4000 }) => {
    const toastId = id || Math.random().toString(36).substring(7);
    
    setToasts((prev) => {
      // If a toast with this id already exists, update it. Otherwise, add new.
      const index = prev.findIndex((t) => t.id === toastId);
      if (index > -1) {
        const updated = [...prev];
        updated[index] = { ...updated[index], title, message, type, duration };
        return updated;
      }
      return [...prev, { id: toastId, title, message, type, duration }];
    });

    if (duration > 0 && type !== 'loading') {
      setTimeout(() => {
        dismiss(toastId);
      }, duration);
    }

    return toastId;
  }, [dismiss]);

  const update = useCallback((id, updates) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...updates } : t))
    );
    if (updates.duration > 0 && updates.type !== 'loading') {
      setTimeout(() => {
        dismiss(id);
      }, updates.duration);
    }
  }, [dismiss]);

  const value = { show, showToast: show, update, dismiss, toasts };

  const getToastStyles = (type) => {
    switch (type) {
      case 'success':
        return {
          bg: 'bg-emerald-50/90 dark:bg-emerald-950/40 border-emerald-200/60 dark:border-emerald-800/30 text-emerald-800 dark:text-emerald-300',
          icon: <FaCheckCircle className="text-emerald-500 dark:text-emerald-400 w-5 h-5 shrink-0" />,
        };
      case 'error':
        return {
          bg: 'bg-rose-50/90 dark:bg-rose-950/40 border-rose-200/60 dark:border-rose-800/30 text-rose-800 dark:text-rose-300',
          icon: <FaTimesCircle className="text-rose-500 dark:text-rose-400 w-5 h-5 shrink-0" />,
        };
      case 'warning':
        return {
          bg: 'bg-amber-50/90 dark:bg-amber-950/40 border-amber-200/60 dark:border-amber-800/30 text-amber-800 dark:text-amber-300',
          icon: <FaExclamationTriangle className="text-amber-500 dark:text-amber-400 w-5 h-5 shrink-0" />,
        };
      case 'loading':
        return {
          bg: 'bg-blue-50/90 dark:bg-slate-900/80 border-blue-200/60 dark:border-slate-800/50 text-blue-800 dark:text-blue-300',
          icon: (
            <svg className="animate-spin h-5 w-5 text-blue-500 dark:text-blue-400 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          ),
        };
      case 'info':
      default:
        return {
          bg: 'bg-sky-50/90 dark:bg-sky-950/40 border-sky-200/60 dark:border-sky-800/30 text-sky-800 dark:text-sky-300',
          icon: <FaInfoCircle className="text-sky-500 dark:text-sky-400 w-5 h-5 shrink-0" />,
        };
    }
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Toast container floating layer */}
      <div 
        className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-3 w-[calc(100vw-3rem)] max-w-sm sm:max-w-md pointer-events-none"
        aria-live="assertive"
      >
        <AnimatePresence mode="popLayout">
          {toasts.map((toast) => {
            const styles = getToastStyles(toast.type);
            return (
              <motion.div
                key={toast.id}
                layout
                initial={{ opacity: 0, y: 50, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85, transition: { duration: 0.2 } }}
                transition={{ type: 'spring', stiffness: 350, damping: 25 }}
                className={`pointer-events-auto flex items-start gap-3 p-4 rounded-xl border backdrop-blur-md shadow-lg ${styles.bg} transition-colors duration-300 relative overflow-hidden`}
              >
                {/* Active loading state background pulse animation */}
                {toast.type === 'loading' && (
                  <motion.div 
                    initial={{ x: '-100%' }}
                    animate={{ x: '100%' }}
                    transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}
                    className="absolute inset-0 bg-gradient-to-r from-transparent via-blue-500/10 to-transparent pointer-events-none"
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
                    className="absolute top-3 right-3 opacity-60 hover:opacity-100 transition-opacity p-1 hover:bg-black/5 rounded text-xs"
                    aria-label="Dismiss notification"
                  >
                    <FaTimes />
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
