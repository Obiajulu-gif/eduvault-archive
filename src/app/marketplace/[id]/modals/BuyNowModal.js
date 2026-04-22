"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FaTimes } from "react-icons/fa";
import Image from "next/image";
import ConnectWalletModal from "./ConnectWalletModal";
import { createFormState, setFieldState, setSubmitting, validateCheckout } from "@/lib/forms/validation";

export default function BuyNowModal({ isOpen, onClose, price }) {
    const [showWallet, setShowWallet] = useState(false);
    const [formState, setFormState] = useState(
        createFormState({ email: "", agreeTerms: false })
    );
    const [success, setSuccess] = useState(null);

    const handlePay = (e) => {
        e.preventDefault();
        setSuccess(null);
        const errors = validateCheckout(formState.values);
        if (Object.keys(errors).length > 0) {
            setFormState((state) => ({ ...state, errors }));
            return;
        }
        setFormState((state) => setSubmitting(state, true));
        setTimeout(() => {
            setFormState((state) => setSubmitting(state, false));
            setSuccess("Checkout started. Continue with your wallet to complete payment.");
            setShowWallet(true);
        }, 300);
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Overlay */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 0.5 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black backdrop-blur-sm z-40"
                        onClick={onClose}
                    />

                    {/* Modal Content */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 50 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 50 }}
                        className="fixed inset-0 flex items-center justify-center z-50"
                    >
                        <div className="bg-white rounded-2xl shadow-lg w-[90%] max-w-sm p-6 relative">
                            {/* Close Button */}
                            <button
                                onClick={onClose}
                                className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
                            >
                                <FaTimes />
                            </button>

                            {/* Header */}
                            <h2 className="text-lg font-bold text-gray-900 mb-1 text-center">
                                Buy Now
                            </h2>
                            <p className="text-sm text-gray-500 mb-6 text-center">
                                We’ll send the document to your email.
                            </p>

                            {/* Email Input */}
                            <div className="mb-4">
                                <label className="block text-xs font-semibold text-gray-600 mb-2">
                                    EMAIL ADDRESS
                                </label>
                                <input
                                    type="email"
                                    value={formState.values.email}
                                    onChange={(e) =>
                                        setFormState((state) => setFieldState(state, "email", e.target.value))
                                    }
                                    placeholder="Enter your email"
                                    className="w-full border border-gray-300 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                                />
                                {formState.errors.email && (
                                    <p className="text-red-600 text-xs mt-1">{formState.errors.email}</p>
                                )}
                            </div>

                            <div className="flex items-center gap-2 mb-4">
                                <input
                                    id="agree-terms"
                                    type="checkbox"
                                    checked={formState.values.agreeTerms}
                                    onChange={(e) =>
                                        setFormState((state) => setFieldState(state, "agreeTerms", e.target.checked))
                                    }
                                />
                                <label htmlFor="agree-terms" className="text-xs text-gray-600">
                                    I understand this checkout is gated by wallet confirmation.
                                </label>
                            </div>
                            {formState.errors.agreeTerms && (
                                <p className="text-red-600 text-xs mb-3">{formState.errors.agreeTerms}</p>
                            )}

                            {/* Price Display */}
                            <div className="flex justify-between items-center mb-5 text-sm">
                                <span className="text-gray-600">You will pay</span>
                                <div className="flex items-center gap-2 font-semibold text-gray-800">
                                    <Image
                                        src="/images/stellar.png"
                                        alt="Stellar"
                                        width={20}
                                        height={20}
                                    />
                                    {price}
                                </div>
                            </div>

                            {/* Pay Button */}
                            {success && <p className="text-green-600 text-xs mb-3">{success}</p>}
                            <button
                                onClick={handlePay}
                                disabled={formState.isSubmitting}
                                className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-semibold text-sm transition-all disabled:opacity-60"
                            >
                                {formState.isSubmitting ? "Preparing..." : "Pay with Wallet"}
                            </button>
                        </div>
                    </motion.div>

                    {/* Show Wallet Modal */}
                    <ConnectWalletModal
                        isOpen={showWallet}
                        onClose={() => setShowWallet(false)}
                    />
                </>
            )}
        </AnimatePresence>
    );
}
