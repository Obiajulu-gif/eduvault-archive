"use client";

import { useState, useEffect, useCallback } from "react";
import {
  FaTicketAlt,
  FaEnvelope,
  FaSpinner,
  FaCheckCircle,
  FaExclamationCircle,
  FaComments,
  FaWallet,
  FaUndo,
  FaFileUpload,
  FaPaperPlane,
  FaArrowLeft,
} from "react-icons/fa";

const QUICK_TOPICS = [
  {
    id: "wallet",
    icon: FaWallet,
    label: "Wallet Support",
    description: "Freighter, Albedo, Rabby connection issues",
    color: "indigo",
  },
  {
    id: "refund",
    icon: FaUndo,
    label: "Refund Guide",
    description: "Soroban contract escrow refunds",
    color: "emerald",
  },
  {
    id: "upload",
    icon: FaFileUpload,
    label: "Upload Help",
    description: "IPFS pinning & material upload format",
    color: "amber",
  },
];

const TOPIC_GUIDES = {
  wallet: {
    title: "Wallet Connection Guide",
    color: "indigo",
    steps: [
      "Ensure your Freighter/Albedo extension is unlocked and on the correct network (Futurenet/Testnet/Mainnet).",
      "For EVM wallets, switch your wallet network to the supported chain when purchasing EVM assets.",
      "High Horizon network latency can trigger timeouts. Check the network status bar at the top of the page.",
    ],
    fallbackText: "Still stuck? Submit a support ticket below.",
  },
  refund: {
    title: "Soroban Escrow & Refunds",
    color: "emerald",
    steps: [
      "All material purchases on Soroban contracts include automatic escrow lockup.",
      "Navigate to your Purchases page and click 'Request Refund' before the lockup expires.",
      "Unresolved disputes are verified via the refundVerifier policy automatically.",
    ],
    fallbackText: "Need help with a disputed purchase? Submit a support ticket.",
  },
  upload: {
    title: "IPFS & File Upload Guide",
    color: "amber",
    steps: [
      "Supported formats: PDF, DOCX, ZIP, MP4, and markdown files up to 100MB.",
      "Files are stored on IPFS via Pinata gateway for decentralized persistence.",
      "New uploads undergo automated security scans before indexing.",
    ],
    fallbackText: "Upload failing? Send us the details in a support ticket.",
  },
};

function TicketForm({ onSuccess }) {
  const [form, setForm] = useState({ name: "", email: "", category: "", message: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.email || !form.message) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/support/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error("Failed to submit ticket");
      onSuccess?.();
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <FaExclamationCircle className="flex-shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Your Name</span>
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="John Doe"
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:bg-white"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Email Address</span>
          <input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="you@example.com"
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:bg-white"
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-slate-700">Category</span>
        <select
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:bg-white"
        >
          <option value="">Select a category...</option>
          <option value="wallet">Wallet Connection</option>
          <option value="refund">Refund / Escrow</option>
          <option value="upload">Upload / IPFS</option>
          <option value="billing">Billing</option>
          <option value="other">Other</option>
        </select>
      </label>

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-slate-700">Describe Your Issue</span>
        <textarea
          required
          rows={4}
          value={form.message}
          onChange={(e) => setForm({ ...form, message: e.target.value })}
          placeholder="Please describe what happened, any error messages, and steps to reproduce..."
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:bg-white"
        />
      </label>

      <button
        type="submit"
        disabled={submitting}
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? <FaSpinner className="animate-spin" /> : <FaPaperPlane />}
        {submitting ? "Submitting..." : "Submit Support Ticket"}
      </button>
    </form>
  );
}

function TicketHistory() {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/support/tickets");
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setTickets(Array.isArray(data) ? data : data.tickets || []);
        }
      } catch {
        // Silent — tickets endpoint may not exist yet
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 bg-slate-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (tickets.length === 0) {
    return (
      <div className="text-center py-8">
        <FaTicketAlt className="text-3xl text-slate-300 mx-auto mb-3" />
        <p className="text-sm text-slate-500">No support tickets yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tickets.map((ticket) => (
        <div
          key={ticket.id || ticket._id}
          className="flex items-center justify-between p-4 rounded-xl border border-slate-200 bg-white"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-800 truncate">
              {ticket.subject || ticket.message?.slice(0, 80) || "Support ticket"}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              {ticket.createdAt ? new Date(ticket.createdAt).toLocaleDateString() : "—"}
            </p>
          </div>
          <span
            className={`ml-4 px-2.5 py-0.5 text-xs font-semibold rounded-full ${
              ticket.status === "resolved"
                ? "bg-green-100 text-green-700"
                : ticket.status === "open"
                ? "bg-blue-100 text-blue-700"
                : "bg-slate-100 text-slate-600"
            }`}
          >
            {ticket.status || "open"}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function SupportPage() {
  const [activeView, setActiveView] = useState("home");
  const [submitted, setSubmitted] = useState(false);

  const handleSuccess = useCallback(() => {
    setSubmitted(true);
    setActiveView("submitted");
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Help & Support</h1>
        <p className="text-sm text-gray-500">
          Find answers to common questions or contact our support team.
        </p>
      </div>

      <div className="max-w-3xl space-y-8">
        {/* Quick Topics */}
        {activeView === "home" && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
              Quick Help
            </h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {QUICK_TOPICS.map(({ id, icon: Icon, label, description, color }) => (
                <button
                  key={id}
                  onClick={() => setActiveView(id)}
                  className="flex flex-col items-center gap-3 p-5 rounded-2xl border border-slate-200 bg-white hover:border-blue-300 hover:shadow-md transition text-center group"
                >
                  <div className={`p-3 rounded-xl bg-${color}-100 text-${color}-600 group-hover:scale-110 transition-transform`}>
                    <Icon size={20} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-800">{label}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{description}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Topic Guide */}
        {TOPIC_GUIDES[activeView] && (
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setActiveView("home")}
                className="p-1.5 rounded-lg hover:bg-slate-100 transition"
              >
                <FaArrowLeft className="text-sm text-slate-500" />
              </button>
              <h2 className={`text-lg font-bold text-${TOPIC_GUIDES[activeView].color}-600`}>
                {TOPIC_GUIDES[activeView].title}
              </h2>
            </div>
            <ol className="space-y-3 list-decimal list-inside text-sm text-slate-600 leading-relaxed">
              {TOPIC_GUIDES[activeView].steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            <button
              onClick={() => setActiveView("contact")}
              className="text-sm font-semibold text-blue-600 underline hover:text-blue-800 transition"
            >
              {TOPIC_GUIDES[activeView].fallbackText}
            </button>
          </div>
        )}

        {/* Contact Form */}
        {activeView === "contact" && (
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setActiveView("home")}
                className="p-1.5 rounded-lg hover:bg-slate-100 transition"
              >
                <FaArrowLeft className="text-sm text-slate-500" />
              </button>
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <FaEnvelope className="text-blue-600" /> Contact Support
                </h2>
                <p className="text-xs text-slate-500">Our team typically responds within 24 hours.</p>
              </div>
            </div>
            <TicketForm onSuccess={handleSuccess} />
          </div>
        )}

        {/* Success State */}
        {activeView === "submitted" && (
          <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center space-y-4">
            <FaCheckCircle className="text-5xl text-green-500 mx-auto" />
            <h2 className="text-xl font-bold text-slate-900">Ticket Submitted!</h2>
            <p className="text-sm text-slate-500 max-w-sm mx-auto">
              Thank you for reaching out. Our support team will review your inquiry and reply via email within 24 hours.
            </p>
            <button
              onClick={() => { setActiveView("home"); setSubmitted(false); }}
              className="mt-2 px-6 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition"
            >
              Back to Support
            </button>
          </div>
        )}

        {/* Ticket History */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <FaComments className="text-slate-400" /> Your Tickets
          </h2>
          <TicketHistory />
        </div>
      </div>
    </div>
  );
}
