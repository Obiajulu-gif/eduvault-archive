"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useWallet } from "@/hooks/useWallet";
import { formatAddress } from "@/utils/formatAddress";
import { validateWalletProfile } from "@/lib/forms/validation";

export default function WalletModal({ isOpen, onClose }) {
  const [step, setStep] = useState(1);
  const [connectionError, setConnectionError] = useState(null);
  const [selectedConnector, setSelectedConnector] = useState(null);
  const router = useRouter();

  const {
    address,
    isConnected,
    isConnecting,
    connectWallet,
    connectors,
    error: walletError,
    connectorName,
  } = useWallet();

  const [formData, setFormData] = useState({
    fullName: "",
    email: "",
    institution: "",
    country: "",
    bio: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState({});
  const [success, setSuccess] = useState(false);

  const validate = () => {
    const nextErrors = validateWalletProfile(formData);
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleNext = () => setStep((prev) => prev + 1);
  const handleBack = () => setStep((prev) => prev - 1);

  // When wallet connects, check if a profile already exists; redirect if it does
  useEffect(() => {
    let cancelled = false;
    const checkExistingProfile = async () => {
      if (isConnected && address) {
        try {
          const res = await fetch(`/api/profile?address=${address}`);
          const data = await res.json();
          if (!cancelled && res.ok && data.exists) {
            // keep user on current page; cookie is set via API
          } else if (!cancelled && step === 2) {
            setTimeout(() => setStep(3), 600);
          }
        } catch (e) {
          if (!cancelled && step === 2) {
            setStep(3);
          }
        }
      }
    };
    checkExistingProfile();
    return () => {
      cancelled = true;
    };
  }, [isConnected, address, step, router, onClose]);

  // Handle wallet connection errors
  useEffect(() => {
    if (walletError) {
      setConnectionError(walletError.message || "Failed to connect wallet");
    }
  }, [walletError]);

  // Reset modal state when closed
  useEffect(() => {
    if (!isOpen) {
      setConnectionError(null);
      setSelectedConnector(null);
      if (!isConnected) {
        setStep(1);
      }
    }
  }, [isOpen, isConnected]);

  const handleWalletConnect = async (connector) => {
    setConnectionError(null);
    setSelectedConnector(connector.id);
    try {
      await connectWallet(connector);
    } catch (err) {
      console.error("Connection error:", err);
      setConnectionError(
        err.message || "Failed to connect wallet. Please try again."
      );
      setSelectedConnector(null);
    }
  };

  const handleProfileSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...formData, walletAddress: address }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Profile creation failed");
      setSuccess(true);
      setTimeout(() => {
        onClose();
        router.push("/dashboard");
      }, 900);
    } catch (err) {
      console.error(err);
      const message =
        err?.message || "Could not create profile. Please try again.";
      setErrors({ submit: message });
    } finally {
      setSubmitting(false);
    }
  };

  const getConnectorInfo = (connector) => {
    const connectorMap = {
      "io.metamask": { name: "MetaMask", icon: "/metamask.svg" },
      metaMask: { name: "MetaMask", icon: "/metamask.svg" },
      injected: { name: "MetaMask", icon: "/metamask.svg" },
      walletConnect: { name: "WalletConnect", icon: "/wallets.svg" },
      coinbaseWalletSDK: { name: "Coinbase Wallet", icon: "/coinbase.svg" },
    };

    if (!connectorMap[connector.id] && connector.name) {
      if (connector.name.toLowerCase().includes("metamask")) {
        return { name: "MetaMask", icon: "/metamask.svg" };
      }
      if (connector.name.toLowerCase().includes("coinbase")) {
        return { name: "Coinbase Wallet", icon: "/coinbase.svg" };
      }
      if (connector.name.toLowerCase().includes("walletconnect")) {
        return { name: "WalletConnect", icon: "/wallets.svg" };
      }
    }

    return connectorMap[connector.id] || {
      name: connector.name,
      icon: "/wallets.svg",
    };
  };

  const modalVariants = {
    hidden: { opacity: 0, y: 50 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.4, ease: "easeOut" },
    },
    exit: { opacity: 0, y: -30, transition: { duration: 0.3, ease: "easeIn" } },
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm z-50">
      <motion.div
        variants={modalVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        className="relative bg-white rounded-2xl shadow-xl w-[90%] max-w-md p-6"
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
        >
          ✕
        </button>

        {/* Steps */}
        <AnimatePresence mode="wait">
          {/* Step 1: Get a Wallet */}
          {step === 1 && (
            <motion.div
              key="step1"
              variants={modalVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <h2 className="text-lg font-semibold text-gray-900 mb-1">
                Get a Wallet
              </h2>
              <p className="text-sm text-gray-500 mb-8">
                Start exploring Web3 — your wallet is your gateway to the world
                of decentralized apps and crypto.
              </p>

              <div className="flex items-end justify-center gap-6 mb-8">
                <Image src="/metaflow.png" width={53} height={53} alt="MetaMask" />
                <Image src="/phantflow.png" width={53} height={53} alt="Phantom" />
                <Image src="/coinflow.png" width={53} height={53} alt="Coinbase" />
                <Image src="/walletsflow.png" width={53} height={53} alt="Other" />
              </div>

              <button
                onClick={handleNext}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-full font-semibold transition-all"
              >
                Choose Your First Wallet →
              </button>
            </motion.div>
          )}

          {/* Step 2: Connect Wallet */}
          {step === 2 && (
            <motion.div
              key="step2"
              variants={modalVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <h2 className="text-lg font-semibold text-gray-900 mb-1">
                Connect Wallet
              </h2>
              <p className="text-sm text-gray-500 mb-6">
                {isConnected && address
                  ? `Connected: ${formatAddress(address)}`
                  : "Get started by connecting your preferred wallet below"}
              </p>

              {/* Connection Error Display */}
              {connectionError && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-xs text-red-600">{connectionError}</p>
                </div>
              )}

              {/* Connected State */}
              {isConnected && address ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-center gap-3 p-4 bg-green-50 border border-green-200 rounded-xl">
                    <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
                    <span className="text-sm font-medium text-green-700">
                      Wallet Connected Successfully!
                    </span>
                  </div>
                  <div className="text-center text-sm text-gray-600">
                    <p>
                      Wallet: <span className="font-mono font-semibold">{formatAddress(address)}</span>
                    </p>
                    {connectorName && (
                      <p className="mt-1">
                        Provider: <span className="font-semibold">{connectorName}</span>
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {connectors.map((connector) => {
                    const connectorInfo = getConnectorInfo(connector);
                    const isCurrentlyConnecting =
                      isConnecting && selectedConnector === connector.id;
                    const isReady = connector.ready !== false;

                    return (
                      <button
                        key={connector.id}
                        onClick={() => handleWalletConnect(connector)}
                        disabled={isConnecting}
                        className="flex items-center justify-between w-full bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-xl py-3 px-4 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <div className="flex items-center gap-3">
                          <Image
                            src={connectorInfo.icon}
                            alt={connectorInfo.name}
                            width={24}
                            height={24}
                          />
                          <span className="text-gray-800 text-sm font-medium">
                            {connectorInfo.name}
                          </span>
                          {!isReady && (
                            <span className="text-xs text-gray-400">(Not installed)</span>
                          )}
                        </div>
                        {isCurrentlyConnecting ? (
                          <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                        ) : (
                          <span className="text-gray-400 text-lg">→</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="flex items-center gap-2 mt-5">
                <input type="checkbox" className="w-4 h-4 rounded" />
                <button
                  onClick={() => setStep(1)}
                  className="text-xs text-gray-500 hover:text-gray-700 underline"
                >
                  I don't have a wallet
                </button>
              </div>
            </motion.div>
          )}

          {/* Step 3: Set Up Your Profile */}
          {step === 3 && (
            <motion.div
              key="step3"
              variants={modalVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <h2 className="text-lg font-semibold text-gray-900 mb-1">
                Set Up Your Profile
              </h2>
              <p className="text-sm text-gray-500 mb-2">
                We'll personalize your dashboard and link uploads to your
                student ID.
              </p>

              {isConnected && address && (
                <div className="mb-4 p-2 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-xs text-blue-700">
                    ✓ Wallet: <span className="font-mono font-semibold">{formatAddress(address)}</span>
                  </p>
                </div>
              )}

              {!isConnected && (
                <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <p className="text-xs text-yellow-700">
                    ⚠️ Please connect your wallet first before setting up your profile.
                  </p>
                  <button
                    onClick={() => setStep(2)}
                    className="mt-2 text-xs text-blue-600 hover:text-blue-700 underline font-medium"
                  >
                    Go back to connect wallet
                  </button>
                </div>
              )}

              <form className="space-y-3" onSubmit={handleProfileSubmit}>
                <input
                  type="text"
                  placeholder="Full Name"
                  value={formData.fullName}
                  onChange={(e) =>
                    setFormData({ ...formData, fullName: e.target.value })
                  }
                  required
                  className="w-full text-[#98A2B3] border border-gray-200 rounded-lg py-2.5 px-3 text-sm focus:outline-none focus:border-blue-500"
                />
                {errors.fullName && (
                  <p className="text-red-500 text-xs">{errors.fullName}</p>
                )}
                <input
                  type="email"
                  placeholder="Email Address"
                  value={formData.email}
                  onChange={(e) =>
                    setFormData({ ...formData, email: e.target.value })
                  }
                  required
                  className="w-full text-[#98A2B3] border border-gray-200 rounded-lg py-2.5 px-3 text-sm focus:outline-none focus:border-blue-500"
                />
                {errors.email && (
                  <p className="text-red-500 text-xs">{errors.email}</p>
                )}
                <input
                  type="text"
                  placeholder="University / Institution"
                  value={formData.institution}
                  onChange={(e) =>
                    setFormData({ ...formData, institution: e.target.value })
                  }
                  className="w-full text-[#98A2B3] border border-gray-200 rounded-lg py-2.5 px-3 text-sm focus:outline-none focus:border-blue-500"
                />
                <input
                  type="text"
                  placeholder="Country"
                  value={formData.country}
                  onChange={(e) =>
                    setFormData({ ...formData, country: e.target.value })
                  }
                  className="w-full text-[#98A2B3] border border-gray-200 rounded-lg py-2.5 px-3 text-sm focus:outline-none focus:border-blue-500"
                />
                <textarea
                  placeholder="Short Bio"
                  value={formData.bio}
                  onChange={(e) =>
                    setFormData({ ...formData, bio: e.target.value })
                  }
                  className="w-full text-[#98A2B3] border border-gray-200 rounded-lg py-2.5 px-3 text-sm focus:outline-none focus:border-blue-500"
                  rows={3}
                />
                {errors.bio && (
                  <p className="text-red-500 text-xs">{errors.bio}</p>
                )}

                {errors.submit && (
                  <p className="text-red-500 text-xs">{errors.submit}</p>
                )}

                <button
                  type="submit"
                  disabled={submitting || !isConnected}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-full transition-all disabled:opacity-60"
                >
                  {submitting
                    ? "Creating..."
                    : isConnected
                    ? "Create My Student Profile"
                    : "Connect Wallet First"}
                </button>
              </form>

              {success && (
                <div className="mt-3 text-green-600 text-sm font-medium">
                  Profile created! Redirecting…
                </div>
              )}

              <div className="flex items-start gap-2 mt-4">
                <input type="checkbox" className="mt-1" />
                <p className="text-xs text-gray-500">
                  By continuing, you agree to EduVault’s {" "}
                  <span className="text-blue-500 underline cursor-pointer">
                    Terms
                  </span>{" "}
                  and {" "}
                  <span className="text-blue-500 underline cursor-pointer">
                    Privacy Policy
                  </span>
                  .
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
