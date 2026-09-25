"use client";

import { useState, useCallback } from "react";
import { FaCopy, FaCheck } from "react-icons/fa";

export default function CopyButton({ text, className = "" }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for browsers without clipboard API
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silent failure — clipboard access may be denied
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy to clipboard"}
      className={`inline-flex items-center gap-1 text-xs text-gray-500 hover:text-stellar-blue transition-colors ${className}`}
    >
      {copied ? (
        <>
          <FaCheck size={12} className="text-green-500" />
          <span>Copied!</span>
        </>
      ) : (
        <>
          <FaCopy size={12} />
          <span>Copy</span>
        </>
      )}
    </button>
  );
}
