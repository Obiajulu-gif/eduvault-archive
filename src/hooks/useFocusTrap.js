import { useEffect, useRef } from 'react';

export default function useFocusTrap(isActive, onClose) {
    const modalRef = useRef(null);
    const triggerRef = useRef(null);
    const previousFocusRef = useRef(null);

    useEffect(() => {
        if (isActive) {
            previousFocusRef.current = document.activeElement;
            triggerRef.current = document.activeElement;

            const currentModal = modalRef.current;
            if (!currentModal) return;

            const focusableSelectors = 'button, a[href], area[href], input:not([type="hidden"]), select, textarea, iframe, audio[controls], video[controls], [tabindex]:not([tabindex="-1"]), [contenteditable], summary';

            const getFocusableElements = () => {
                const elements = Array.from(
                    currentModal.querySelectorAll(focusableSelectors)
                ).filter((el) => {
                    if (
                        el.disabled ||
                        el.hasAttribute('hidden') ||
                        el.getAttribute('aria-hidden') === 'true'
                    ) {
                        return false;
                    }
                    const { display, visibility } = window.getComputedStyle(el);
                    return display !== 'none' && visibility !== 'hidden';
                });
                return elements;
            };

            const handleKeyDown = (e) => {
                if (e.key === 'Escape') {
                    onClose();
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }

                if (e.key === 'Tab') {
                    const focusableElements = getFocusableElements();
                    if (!focusableElements.length) {
                        e.preventDefault();
                        return;
                    }

                    const firstElement = focusableElements[0];
                    const lastElement = focusableElements[focusableElements.length - 1];

                    if (e.shiftKey) {
                        if (document.activeElement === firstElement || document.activeElement === currentModal) {
                            lastElement.focus();
                            e.preventDefault();
                        }
                    } else {
                        if (document.activeElement === lastElement) {
                            firstElement.focus();
                            e.preventDefault();
                        }
                    }
                }
            };

            document.addEventListener('keydown', handleKeyDown);

            const focusableElements = getFocusableElements();
            if (focusableElements.length > 0) {
                focusableElements[0].focus();
            } else if (currentModal) {
                currentModal.setAttribute('tabindex', '-1');
                currentModal.focus();
            }

            return () => {
                document.removeEventListener('keydown', handleKeyDown);
                if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
                    previousFocusRef.current.focus();
                }
            };
        }
    }, [isActive, onClose]);

    return modalRef;
}
