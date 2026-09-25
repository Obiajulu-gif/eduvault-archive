"use client";

import { useState } from "react";
import FaqAccordion from "@/components/FaqAccordion";
import { FaSearch } from "react-icons/fa";

const ALL_FAQS = [
  {
    category: "Getting Started",
    question: "How do I start selling my materials?",
    answer: "First, complete your profile onboarding by adding a bio, uploading a profile picture, providing a website, and setting your target pricing wallet. Then, navigate to the Upload page to submit your first material. Once approved, it will be listed in the marketplace.",
  },
  {
    category: "Getting Started",
    question: "What is Stellar and why do I need a wallet?",
    answer: "Stellar is the blockchain network we use to process fast, low-cost payments and distribute payouts to creators. You need a Stellar wallet (like Freighter) to receive your earnings securely without intermediaries.",
  },
  {
    category: "Fees & Payouts",
    question: "What are the checkout fees?",
    answer: "Our platform charges a minimal 2% network fee on every transaction to cover Stellar operation costs and infrastructure maintenance. Creators receive 98% of the listed price directly to their target wallet.",
  },
  {
    category: "Fees & Payouts",
    question: "How and when do I get paid?",
    answer: "Payouts are processed instantly via smart contracts on the Stellar network. When a buyer completes a purchase, your share of the payment is routed directly to your connected wallet in real-time.",
  },
  {
    category: "Support & Claims",
    question: "How do I claim a refund?",
    answer: "If the material you downloaded is corrupted, incomplete, or significantly different from its description, you can claim a refund within 7 days of purchase. Go to your Dashboard > Purchases, select the item, and click 'Request Refund'. Our support team will review the claim.",
  },
  {
    category: "Support & Claims",
    question: "What happens if a file violates copyright?",
    answer: "We take intellectual property rights seriously. If you find your copyrighted material on our platform, please use the 'Report' button on the listing page. Our moderation team will quarantine the material and investigate the claim.",
  }
];

export default function HelpCenterPage() {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredFaqs = ALL_FAQS.filter((faq) => {
    const query = searchQuery.toLowerCase();
    return (
      faq.question.toLowerCase().includes(query) ||
      faq.answer.toLowerCase().includes(query) ||
      faq.category.toLowerCase().includes(query)
    );
  });

  const faqsByCategory = filteredFaqs.reduce((acc, faq) => {
    if (!acc[faq.category]) {
      acc[faq.category] = [];
    }
    acc[faq.category].push(faq);
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 py-12">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h1 className="text-3xl font-extrabold text-gray-900 sm:text-4xl">Help Center & FAQ</h1>
          <p className="mt-4 text-lg text-gray-500 max-w-2xl mx-auto">
            Find answers to common questions about onboarding, payments, and using the platform.
          </p>
        </div>

        <div className="relative mb-10 max-w-xl mx-auto">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <FaSearch className="text-gray-400" />
          </div>
          <input
            type="text"
            className="block w-full pl-10 pr-3 py-3 border border-gray-300 rounded-xl leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 sm:text-sm shadow-sm transition-shadow"
            placeholder="Search for answers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="space-y-10">
          {Object.keys(faqsByCategory).length === 0 ? (
            <div className="text-center py-10 bg-white rounded-xl border border-gray-200">
              <p className="text-gray-500 text-lg">No results found for "{searchQuery}"</p>
              <button
                onClick={() => setSearchQuery("")}
                className="mt-4 text-blue-600 hover:text-blue-800 font-medium"
              >
                Clear search
              </button>
            </div>
          ) : (
            Object.entries(faqsByCategory).map(([category, faqs]) => (
              <section key={category}>
                <h2 className="text-xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
                  {category}
                </h2>
                <FaqAccordion faqs={faqs} />
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
