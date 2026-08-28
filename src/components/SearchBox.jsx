"use client";

import { useEffect, useRef, useState } from "react";
import { FaHistory, FaSearch, FaTimes } from "react-icons/fa";

const STORAGE_KEY = "eduvault.searchHistory";
const MAX_HISTORY = 8;

export function readSearchHistory() {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((q) => typeof q === "string") : [];
  } catch {
    return [];
  }
}

function writeSearchHistory(entries) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable — history simply won't persist.
  }
}

/**
 * SearchBox — search input with a saved-query history dropdown.
 *
 * Each history item carries its own remove button so users can delete
 * individual entries (privacy control) without clearing the whole list.
 * Removal updates both the visible list and localStorage, preserves the
 * order of the remaining items, and never closes the dropdown.
 */
export default function SearchBox({ onSearch, placeholder = "Search materials…" }) {
  const [value, setValue] = useState("");
  // Lazy init is SSR-safe (readSearchHistory returns [] without window) and
  // cannot cause a hydration mismatch: nothing history-dependent renders
  // until the user focuses the input.
  const [history, setHistory] = useState(() => readSearchHistory());
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function submit(query) {
    const q = query.trim();
    if (!q) return;
    const next = [q, ...history.filter((h) => h !== q)].slice(0, MAX_HISTORY);
    setHistory(next);
    writeSearchHistory(next);
    setValue(q);
    setOpen(false);
    onSearch?.(q);
  }

  function removeEntry(e, entry) {
    // A delete click must remove its entry only — not select it, and not
    // close the dropdown.
    e.preventDefault();
    e.stopPropagation();
    const next = history.filter((h) => h !== entry);
    setHistory(next);
    writeSearchHistory(next);
  }

  function clearHistory() {
    setHistory([]);
    writeSearchHistory([]);
  }

  return (
    <div ref={rootRef} className="relative w-full max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(value);
        }}
      >
        <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs pointer-events-none" />
        <input
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          aria-label="Search"
          className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </form>

      {open && history.length > 0 && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
            <span className="flex items-center gap-2 text-xs font-semibold text-gray-500"><FaHistory /> Recent searches</span>
            <button type="button" onClick={clearHistory} className="text-xs font-semibold text-blue-600 hover:text-blue-700">Clear history</button>
          </div>
          <ul role="listbox" aria-label="Recent searches" className="max-h-56 overflow-auto py-1">
          {history.map((entry) => (
            <li
              key={entry}
              className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 cursor-pointer"
              onMouseDown={(e) => {
                // Keep focus on the input so the dropdown doesn't flicker shut
                e.preventDefault();
              }}
              onClick={() => submit(entry)}
            >
              <span className="truncate">{entry}</span>
              <button
                type="button"
                aria-label={`Remove "${entry}" from search history`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => removeEntry(e, entry)}
                className="shrink-0 p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100"
              >
                <FaTimes size={10} />
              </button>
            </li>
          ))}
          </ul>
        </div>
      )}
    </div>
  );
}
