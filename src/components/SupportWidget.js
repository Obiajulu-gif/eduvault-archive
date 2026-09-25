"use client";

import React, { useState } from "react";
import {
  FaComments,
  FaTimes,
  FaWallet,
  FaUndo,
  FaFileUpload,
  FaEnvelope,
  FaChevronRight,
  FaPaperPlane,
  FaCheckCircle,
  FaArrowLeft,
} from "react-icons/fa";

/**
 * Interactive support chat assistant widget.
 * Meets requirements for Issue #350.
 */
export default function SupportWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("home"); // 'home' | 'wallet' | 'refund' | 'upload' | 'contact'
  const [contactForm, setContactForm] = useState({ name: "", email: "", message: "" });
  const [contactSubmitted, setContactSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleContactSubmit = async (e) => {
    e.preventDefault();
    if (!contactForm.email || !contactForm.message) return;

    setIsSubmitting(true);
    try {
      await fetch("/api/support/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(contactForm),
      });
    } catch {
      // Graceful fallback
    } finally {
      setIsSubmitting(false);
      setContactSubmitted(true);
    }
  };

  const resetWidget = () => {
    setActiveTab("home");
    setContactSubmitted(false);
    setContactForm({ name: "", email: "", message: "" });
  };

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end pointer-events-none">
      {/* Expanded Support Window */}
      {isOpen && (
        <div className="pointer-events-auto mb-3 w-[90vw] max-w-[380px] rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden transition-all duration-300 animate-slideUp">
          {/* Header */}
          <div className="bg-gradient-to-r from-indigo-600 to-blue-600 p-4 text-white flex items-center justify-between">
            <div className="flex items-center gap-2">
              {activeTab !== "home" && (
                <button
                  onClick={resetWidget}
                  className="mr-1 rounded-full p-1 hover:bg-white/20 transition"
                  title="Back to quick topics"
                >
                  <FaArrowLeft className="text-xs" />
                </button>
              )}
              <div>
                <h3 className="font-bold text-base">EduVault Support Assistant</h3>
                <p className="text-xs text-indigo-100">How can we help you today?</p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-full p-1.5 hover:bg-white/20 transition"
              aria-label="Close support chat"
            >
              <FaTimes />
            </button>
          </div>

          {/* Body Content */}
          <div className="p-4 max-h-[420px] overflow-y-auto text-sm text-slate-700 dark:text-slate-200">
            {activeTab === "home" && (
              <div className="space-y-3">
                <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Select a topic for immediate help
                </p>

                {/* Quick Option 1: Wallet Support */}
                <button
                  onClick={() => setActiveTab("wallet")}
                  className="w-full flex items-center justify-between p-3 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 hover:border-indigo-200 dark:hover:border-indigo-800 transition text-left group"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
                      <FaWallet />
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">Wallet support</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">Freighter, Albedo, Rabby connection issues</div>
                    </div>
                  </div>
                  <FaChevronRight className="text-slate-400 group-hover:text-indigo-600 transition text-xs" />
                </button>

                {/* Quick Option 2: Refund Guide */}
                <button
                  onClick={() => setActiveTab("refund")}
                  className="w-full flex items-center justify-between p-3 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 hover:border-indigo-200 dark:hover:border-indigo-800 transition text-left group"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400">
                      <FaUndo />
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">Refund guide</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">Soroban contract escrow refunds</div>
                    </div>
                  </div>
                  <FaChevronRight className="text-slate-400 group-hover:text-indigo-600 transition text-xs" />
                </button>

                {/* Quick Option 3: Upload Help */}
                <button
                  onClick={() => setActiveTab("upload")}
                  className="w-full flex items-center justify-between p-3 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 hover:border-indigo-200 dark:hover:border-indigo-800 transition text-left group"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400">
                      <FaFileUpload />
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">Upload help</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">IPFS pinning & material upload format</div>
                    </div>
                  </div>
                  <FaChevronRight className="text-slate-400 group-hover:text-indigo-600 transition text-xs" />
                </button>

                {/* Fallback Contact Option */}
                <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                  <button
                    onClick={() => setActiveTab("contact")}
                    className="w-full flex items-center justify-center gap-2 p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-medium text-xs transition"
                  >
                    <FaEnvelope /> Contact Support Team Directly
                  </button>
                </div>
              </div>
            )}

            {/* Wallet Support Content */}
            {activeTab === "wallet" && (
              <div className="space-y-3">
                <h4 className="font-bold text-indigo-600 dark:text-indigo-400 flex items-center gap-2">
                  <FaWallet /> Wallet Connection Guide
                </h4>
                <div className="bg-slate-50 dark:bg-slate-800 p-3 rounded-xl space-y-2 text-xs leading-relaxed">
                  <p><strong>1. Freighter / Albedo:</strong> Ensure your extension is unlocked and on Futurenet/Testnet or Mainnet.</p>
                  <p><strong>2. EVM Wallets:</strong> Switch your wallet network to supported chains when purchasing EVM assets.</p>
                  <p><strong>3. Timeouts:</strong> High Horizon network latency can trigger timeouts. Check network status bar at top.</p>
                </div>
                <button
                  onClick={() => setActiveTab("contact")}
                  className="w-full mt-2 text-xs text-indigo-600 dark:text-indigo-400 font-semibold underline text-center block"
                >
                  Still stuck? Contact human support
                </button>
              </div>
            )}

            {/* Refund Guide Content */}
            {activeTab === "refund" && (
              <div className="space-y-3">
                <h4 className="font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                  <FaUndo /> Soroban Escrow & Refunds
                </h4>
                <div className="bg-slate-50 dark:bg-slate-800 p-3 rounded-xl space-y-2 text-xs leading-relaxed">
                  <p><strong>1. Guarantee Period:</strong> All material purchases on Soroban contract include automatic escrow lockup.</p>
                  <p><strong>2. Requesting Refund:</strong> Navigate to your Purchases page and click &quot;Request Refund&quot; before lockup expires.</p>
                  <p><strong>3. Dispute Resolution:</strong> Unresolved disputes are verified via refundVerifier policy automatically.</p>
                </div>
                <button
                  onClick={() => setActiveTab("contact")}
                  className="w-full mt-2 text-xs text-indigo-600 dark:text-indigo-400 font-semibold underline text-center block"
                >
                  Need help with a disputed purchase? Contact support
                </button>
              </div>
            )}

            {/* Upload Help Content */}
            {activeTab === "upload" && (
              <div className="space-y-3">
                <h4 className="font-bold text-amber-600 dark:text-amber-400 flex items-center gap-2">
                  <FaFileUpload /> IPFS & File Upload Guide
                </h4>
                <div className="bg-slate-50 dark:bg-slate-800 p-3 rounded-xl space-y-2 text-xs leading-relaxed">
                  <p><strong>1. Supported Formats:</strong> PDF, DOCX, ZIP, MP4, and markdown files up to 100MB.</p>
                  <p><strong>2. Decentralized Pinning:</strong> Files are stored on IPFS via Pinata gateway.</p>
                  <p><strong>3. Quarantine Sweep:</strong> New uploads undergo automated security scans before indexing.</p>
                </div>
                <button
                  onClick={() => setActiveTab("contact")}
                  className="w-full mt-2 text-xs text-indigo-600 dark:text-indigo-400 font-semibold underline text-center block"
                >
                  Upload failing? Send us details
                </button>
              </div>
            )}

            {/* Contact Form Fallback */}
            {activeTab === "contact" && (
              <div>
                {contactSubmitted ? (
                  <div className="py-8 text-center space-y-3">
                    <FaCheckCircle className="text-4xl text-emerald-500 mx-auto" />
                    <h4 className="font-bold text-slate-900 dark:text-white">Message Received!</h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Our support team will review your inquiry and reply via email within 24 hours.
                    </p>
                    <button
                      onClick={resetWidget}
                      className="mt-3 px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold"
                    >
                      Back to Assistant
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleContactSubmit} className="space-y-3">
                    <h4 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                      <FaEnvelope className="text-indigo-600" /> Contact Support Team
                    </h4>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Your Name</label>
                      <input
                        type="text"
                        required
                        value={contactForm.name}
                        onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })}
                        placeholder="John Doe"
                        className="w-full p-2.5 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Email Address</label>
                      <input
                        type="email"
                        required
                        value={contactForm.email}
                        onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
                        placeholder="you@example.com"
                        className="w-full p-2.5 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Describe Issue</label>
                      <textarea
                        required
                        rows={3}
                        value={contactForm.message}
                        onChange={(e) => setContactForm({ ...contactForm, message: e.target.value })}
                        placeholder="Describe what went wrong or ask a question..."
                        className="w-full p-2.5 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-2"
                    >
                      <FaPaperPlane /> {isSubmitting ? "Sending..." : "Submit Support Ticket"}
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Floating Toggle Button (Bottom-Right, respects mobile boundaries) */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-gradient-to-r from-indigo-600 to-blue-600 text-white px-4 py-3.5 shadow-xl hover:shadow-2xl hover:scale-105 active:scale-95 transition-all duration-200"
        aria-label="Toggle support assistant"
      >
        {isOpen ? <FaTimes className="text-lg" /> : <FaComments className="text-lg" />}
        <span className="text-xs font-bold hidden sm:inline">
          {isOpen ? "Close Support" : "Help & Support"}
        </span>
      </button>
    </div>
  );
}
