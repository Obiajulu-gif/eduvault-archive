"use client";

import { FaHistory, FaPause, FaPlay } from "react-icons/fa";
import ClearRecentlyViewedButton from "@/components/materials/ClearRecentlyViewedButton";
import { useRecentlyViewed } from "@/hooks/useRecentlyViewed";

export default function RecentlyViewedSettings() {
  const { isTrackingPaused, setRecentlyViewedPaused } = useRecentlyViewed();
  const paused = isTrackingPaused;

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-indigo-700">
        <FaHistory />
        Recently viewed
      </div>
      <h2 className="mt-4 text-2xl font-semibold tracking-tight text-slate-950">
        Browsing history
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
        Control which materials are remembered in this browser. Pausing keeps your existing
        history but stops new materials from being added. Clearing removes it permanently.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setRecentlyViewedPaused(!paused)}
          aria-pressed={paused}
          aria-label={paused ? "Resume recently viewed tracking" : "Pause recently viewed tracking"}
          className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60"
        >
          {paused ? <FaPlay aria-hidden="true" /> : <FaPause aria-hidden="true" />}
          {paused ? "Resume tracking" : "Pause tracking"}
        </button>
        <ClearRecentlyViewedButton className="inline-flex items-center gap-2 rounded-2xl border border-red-200 bg-white px-5 py-3 text-sm font-semibold text-red-600 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500" />
      </div>
      <p className="mt-3 text-xs text-slate-500" aria-live="polite">
        {paused
          ? "Tracking is paused. No new recently viewed entries are being saved."
          : "Tracking is active. Opened materials are added to your history."}
      </p>
    </section>
  );
}
