'use client';

import { useState, useCallback } from 'react';
import { FaTag, FaSpinner, FaCheck, FaTimes } from 'react-icons/fa';

/**
 * PromoInput — campaign code entry field for checkout views.
 *
 * Props:
 *   onApply   – (promoData) => void   called when a valid promo is verified
 *   onRemove  – () => void            called when the user clears the applied promo
 *   disabled  – boolean               disables interaction (e.g. during checkout)
 */
export default function PromoInput({ onApply, onRemove, disabled = false }) {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | success | error
  const [message, setMessage] = useState('');
  const [appliedPromo, setAppliedPromo] = useState(null);

  const handleApply = useCallback(async () => {
    const trimmed = code.trim();
    if (!trimmed || disabled) return;

    setStatus('loading');
    setMessage('');

    try {
      const res = await fetch('/api/checkout/verify-promo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });

      const data = await res.json();

      if (data.valid) {
        setStatus('success');
        setMessage(data.discountLabel || `${data.discountPercent}% off`);
        setAppliedPromo(data);
        onApply?.(data);
      } else {
        setStatus('error');
        setMessage(data.message || 'Invalid code');
        setAppliedPromo(null);
      }
    } catch {
      setStatus('error');
      setMessage('Network error — try again');
      setAppliedPromo(null);
    }
  }, [code, disabled, onApply]);

  const handleRemove = useCallback(() => {
    setCode('');
    setStatus('idle');
    setMessage('');
    setAppliedPromo(null);
    onRemove?.();
  }, [onRemove]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApply();
    }
  }, [handleApply]);

  if (status === 'success' && appliedPromo) {
    return (
      <div className="flex items-center gap-2 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-xl px-3 py-2">
        <FaCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
            {appliedPromo.code}
          </span>
          <span className="text-[10px] text-emerald-600 dark:text-emerald-400 ml-1.5">
            — {message}
          </span>
        </div>
        <button
          onClick={handleRemove}
          disabled={disabled}
          className="p-1 text-emerald-500 hover:text-rose-500 transition-colors shrink-0"
          title="Remove promo code"
        >
          <FaTimes className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
        PROMO CODE
      </label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-400 pointer-events-none">
            <FaTag className="w-3 h-3" />
          </span>
          <input
            type="text"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              if (status === 'error') {
                setStatus('idle');
                setMessage('');
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder="Enter code"
            disabled={disabled || status === 'loading'}
            className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 pl-8 pr-3 py-2 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 text-slate-800 dark:text-slate-100 transition-all font-medium placeholder:text-slate-300 dark:placeholder:text-slate-600 disabled:opacity-50"
          />
        </div>
        <button
          onClick={handleApply}
          disabled={disabled || !code.trim() || status === 'loading'}
          className="px-4 py-2 bg-slate-800 dark:bg-slate-700 hover:bg-slate-900 dark:hover:bg-slate-600 disabled:opacity-40 text-white text-[11px] font-bold rounded-xl transition-all shrink-0"
        >
          {status === 'loading' ? (
            <FaSpinner className="w-3 h-3 animate-spin" />
          ) : (
            'Apply'
          )}
        </button>
      </div>
      {status === 'error' && message && (
        <p className="text-[10px] font-semibold text-rose-500 dark:text-rose-400 flex items-center gap-1">
          <FaTimes className="w-2.5 h-2.5" />
          {message}
        </p>
      )}
    </div>
  );
}
