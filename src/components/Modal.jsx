"use client";

import { useId, useEffect, useRef } from 'react';
import useFocusTrap from '@/hooks/useFocusTrap';

export default function Modal({ isOpen, onClose, title, ariaLabel, children }) {
  const modalRef = useFocusTrap(isOpen, onClose);
  const idBase = useId();
  const previousActiveElement = useRef(null);

  if (isOpen && !title && !ariaLabel) {
    console.warn('Modal component lacks an accessible name. Please provide either a `title` or an `ariaLabel`.');
  }

  const titleId = title ? `${idBase}-title` : undefined;

  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement;
      document.body.style.overflow = 'hidden';

      const handleBackdropKeyDown = (e) => {
        if (e.key === 'Escape' && onClose) {
          onClose();
        }
      };

      document.addEventListener('keydown', handleBackdropKeyDown);
      return () => {
        document.body.style.overflow = '';
        document.removeEventListener('keydown', handleBackdropKeyDown);
      };
    }
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen && previousActiveElement.current) {
      previousActiveElement.current.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm motion-safe:transition-opacity motion-reduce:transition-none"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && onClose) {
          onClose();
        }
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={!title ? ariaLabel : undefined}
        className="relative bg-white rounded-2xl shadow-xl w-[90%] max-w-md p-6 motion-safe:transform motion-safe:transition-all motion-safe:duration-300 motion-reduce:transition-none"
      >
        <div className="flex justify-between items-start mb-4">
          {title && (
            <h2 id={titleId} className="text-xl font-semibold text-gray-900">
              {title}
            </h2>
          )}
          <button
            onClick={onClose}
            type="button"
            aria-label="Close modal"
            className="text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 rounded-full p-1 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="text-gray-700">
          {children}
        </div>
      </div>
    </div>
  );
}
