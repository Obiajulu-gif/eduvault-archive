"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FaTimes, FaCheckCircle } from "react-icons/fa";
import Web3TransactionFallback from "@/components/web3/Web3TransactionFallback";
import Image from "next/image";
import ConnectWalletModal from "./ConnectWalletModal";
import { useCreatePurchase } from "@/hooks/api/usePurchases";
import { useAccount } from "wagmi";

const SUPPORTED_ASSETS = [
    { code: "XLM", issuer: null, label: "Stellar XLM" },
    { code: "USDC", issuer: "G...USDCISSUER", label: "USDC (Stellar)" },
];

function useQuote(materialId, asset, price) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [quote, setQuote] = useState(null);

    useEffect(() => {
        if (!materialId || !asset) return;
        setLoading(true);
        setError(null);
        setTimeout(() => {
            if (asset.code === "XLM") setQuote({ amount: price, asset: "XLM", fee: 0.1 });
            else if (asset.code === "USDC") setQuote({ amount: (parseFloat(price) * 0.5).toFixed(2), asset: "USDC", fee: 0.05 });
            else setQuote(null);
            setLoading(false);
        }, 700);
    }, [materialId, asset, price]);

    return { loading, error, quote, refresh: () => setQuote(null) };
}

export default function BuyNowModal({ isOpen, onClose, price, materialId }) {
    const { address } = useAccount();
    const createPurchaseMutation = useCreatePurchase();
    const [showWallet, setShowWallet] = useState(false);
    const [email, setEmail] = useState("");
    const [purchased, setPurchased] = useState(false);
    const [web3Error, setWeb3Error] = useState(null);
    const [selectedAsset, setSelectedAsset] = useState(SUPPORTED_ASSETS[0]);
    const { loading: quoteLoading, error: quoteError, quote, refresh } = useQuote(materialId, selectedAsset, price);

    const handlePay = async () => {
        if (!address) {
            setShowWallet(true);
            return;
        }

        try {
            setWeb3Error(null);
            const simulatedHash = "simulated_hash_" + Math.random().toString(36).substring(7);
            
            await createPurchaseMutation.mutateAsync({
                buyerAddress: address,
                materialId,
                transactionHash: simulatedHash,
                email, // Optional, depending on API support
            });

            setPurchased(true);
            setTimeout(() => {
                setPurchased(false);
                onClose();
            }, 3000);
        } catch (err) {
            console.error("Purchase failed:", err);
            setWeb3Error(err instanceof Error ? err : new Error("Purchase failed. Please try again."));
        }
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

                            {purchased ? (
                                <div className="py-8 text-center">
                                    <FaCheckCircle className="text-5xl text-green-500 mx-auto mb-4" />
                                    <h2 className="text-xl font-bold text-gray-900 mb-2">Purchase Successful!</h2>
                                    <p className="text-sm text-gray-600">The document has been added to your dashboard and access granted.</p>
                                </div>
                            ) : (
                                <>
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
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            placeholder="Enter your email"
                                            className="w-full border border-gray-300 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                                        />
                                    </div>

                                    {/* Asset Selector */}
                                    <div className="mb-4">
                                        <label className="block text-xs font-semibold text-gray-600 mb-2">PAYMENT ASSET</label>
                                        <select
                                            value={selectedAsset.code}
                                            onChange={e => setSelectedAsset(SUPPORTED_ASSETS.find(a => a.code === e.target.value))}
                                            className="w-full border border-gray-300 rounded-lg py-2 px-3 text-sm focus:outline-none"
                                        >
                                            {SUPPORTED_ASSETS.map(asset => (
                                                <option key={asset.code} value={asset.code}>{asset.label}</option>
                                            ))}
                                        </select>
                                    </div>

                                    {/* Quote Display */}
                                    <div className="flex justify-between items-center mb-5 text-sm">
                                        <span className="text-gray-600">You will pay</span>
                                        {quoteLoading ? (
                                            <span className="text-gray-400">Loading quote…</span>
                                        ) : quoteError ? (
                                            <span className="text-red-500">Error loading quote</span>
                                        ) : quote ? (
                                            <div className="flex items-center gap-2 font-semibold text-gray-800">
                                                <Image src={selectedAsset.code === "XLM" ? "/images/stellar.png" : "/images/celo.png"} alt={selectedAsset.label} width={20} height={20} />
                                                {quote.amount} {quote.asset}
                                                {quote.fee && <span className="text-xs text-gray-400">+{quote.fee} fee</span>}
                                            </div>
                                        ) : (
                                            <span className="text-gray-400">No quote available</span>
                                        )}
                                        <button onClick={refresh} className="ml-2 text-xs text-blue-600 underline">Refresh</button>
                                    </div>



                                    {web3Error && (
                                        <Web3TransactionFallback
                                            error={web3Error}
                                            compact
                                            onRetry={() => {
                                                setWeb3Error(null);
                                                handlePay();
                                            }}
                                        />
                                    )}

                                    {/* Pay Button */}
                                    <button
                                        onClick={handlePay}
                                        disabled={createPurchaseMutation.isPending || quoteLoading || !quote}
                                        className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-semibold text-sm transition-all disabled:opacity-60"
                                    >
                                        {createPurchaseMutation.isPending ? "Processing..." : "Pay with Wallet"}
                                    </button>
                                </>
                            )}
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
