"use client";

import React, { useState, useEffect } from "react";
import { FaCopy, FaCheck, FaTimes, FaShareAlt, FaLink } from "react-icons/fa";

/**
 * ShareModal component for generating custom share links with tracking parameters.
 * Meets requirements for Issue #356.
 */
export default function ShareModal({ isOpen, onClose, materialTitle, baseUrl }) {
  const [source, setSource] = useState("twitter");
  const [customSource, setCustomSource] = useState("");
  const [campaign, setCampaign] = useState("");
  const [medium, setMedium] = useState("social");
  const [generatedUrl, setGeneratedUrl] = useState("");
  const [copied, setCopied] = useState(false);

  // Compute base URL if not passed explicitly
  const effectiveBaseUrl = baseUrl || (typeof window !== "undefined" ? window.location.href.split('?')[0] : "");

  useEffect(() => {
    try {
      const url = new URL(effectiveBaseUrl || "https://eduvault.app");
      const activeSource = source === "custom" ? customSource.trim() : source;
      
      if (activeSource) {
        url.searchParams.set("track_source", activeSource);
        url.searchParams.set("utm_source", activeSource);
      }
      if (campaign.trim()) {
        url.searchParams.set("track_campaign", campaign.trim());
        url.searchParams.set("utm_campaign", campaign.trim());
      }
      if (medium.trim()) {
        url.searchParams.set("utm_medium", medium.trim());
      }

      setGeneratedUrl(url.toString());
    } catch {
      setGeneratedUrl(effectiveBaseUrl);
    }
  }, [effectiveBaseUrl, source, customSource, campaign, medium]);

  if (!isOpen) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(generatedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      console.error("Failed to copy share URL", err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn">
      <div 
        className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl transition-all dark:bg-slate-900 dark:text-white border border-slate-200 dark:border-slate-800"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-modal-title"
      >
        <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400">
            <FaShareAlt className="text-xl" />
            <h2 id="share-modal-title" className="text-xl font-bold">
              Generate Trackable Share Link
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition"
            aria-label="Close modal"
          >
            <FaTimes />
          </button>
        </div>

        {materialTitle && (
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-400 font-medium">
            Sharing: <span className="text-slate-900 dark:text-slate-100 italic font-semibold">&ldquo;{materialTitle}&rdquo;</span>
          </p>
        )}

        <div className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              Traffic Source (track_source)
            </label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="twitter">Twitter / X</option>
              <option value="linkedin">LinkedIn</option>
              <option value="facebook">Facebook</option>
              <option value="email">Email Newsletter</option>
              <option value="telegram">Telegram</option>
              <option value="custom">Custom Source...</option>
            </select>
          </div>

          {source === "custom" && (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Custom Source Name
              </label>
              <input
                type="text"
                value={customSource}
                onChange={(e) => setCustomSource(e.target.value)}
                placeholder="e.g. reddit, blog, youtube"
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              Campaign Name (optional)
            </label>
            <input
              type="text"
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
              placeholder="e.g. spring_launch, promo_2026"
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              Medium / Channel
            </label>
            <select
              value={medium}
              onChange={(e) => setMedium(e.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="social">Social Media</option>
              <option value="email">Email</option>
              <option value="cpc">CPC / Paid Ad</option>
              <option value="referral">Referral</option>
            </select>
          </div>

          <div className="pt-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              Generated Share URL
            </label>
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 p-2">
              <FaLink className="ml-2 text-slate-400 flex-shrink-0" />
              <input
                type="text"
                readOnly
                value={generatedUrl}
                className="w-full bg-transparent text-xs font-mono text-slate-800 dark:text-slate-200 outline-none truncate"
              />
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 text-xs font-semibold transition flex-shrink-0"
              >
                {copied ? <FaCheck className="text-green-300" /> : <FaCopy />}
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-xl border border-slate-300 dark:border-slate-700 px-4 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
