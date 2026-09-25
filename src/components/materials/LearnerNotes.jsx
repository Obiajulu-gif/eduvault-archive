"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * LearnerNotes — personal notes saved per user per resource.
 * Notes are persisted via /api/materials/[id]/notes.
 */
export default function LearnerNotes({ materialId, walletAddress }) {
  const [note, setNote] = useState("");
  const [savedNote, setSavedNote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const fetchNote = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/materials/${materialId}/notes`);
      if (res.ok) {
        const data = await res.json();
        setNote(data.note ?? "");
        setSavedNote(data.note ?? "");
      } else if (res.status !== 404) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to load notes.");
      }
    } catch {
      setError("Failed to load notes.");
    } finally {
      setLoading(false);
    }
  }, [materialId]);

  useEffect(() => {
    if (walletAddress) fetchNote();
  }, [walletAddress, fetchNote]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/materials/${materialId}/notes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save note.");
      setSavedNote(data.note ?? note);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section
        aria-label="Your notes"
        className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm mt-10 animate-pulse h-40"
      />
    );
  }

  return (
    <section
      aria-label="Your notes"
      className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm mt-10"
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Your Notes</h2>
        {savedNote !== null && (
          <p className="text-xs text-gray-400">
            {savedNote.trim() ? "Notes saved" : "No notes yet"}
          </p>
        )}
      </div>

      {savedNote === null && !note.trim() ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-sm text-gray-500 text-center mb-4">
          You haven&apos;t added any notes for this resource yet. Use the area below to jot down
          key takeaways or reminders.
        </div>
      ) : null}

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Write your personal notes here…"
        rows={5}
        aria-label="Personal notes for this resource"
        className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 placeholder:text-gray-400 resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <div className="mt-3 flex items-center justify-between">
        <button
          onClick={handleSave}
          disabled={saving || note === savedNote}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          {saving ? "Saving…" : "Save Notes"}
        </button>
        {savedNote && savedNote.trim() && (
          <p className="text-xs text-gray-400">Auto-saved per resource</p>
        )}
      </div>
    </section>
  );
}
