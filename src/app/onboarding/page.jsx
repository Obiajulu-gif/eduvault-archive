"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useWallet } from "@/hooks/useWallet";
import { useCreateProfile } from "@/hooks/api/useProfile";
import Navbar from "@/components/Navbar";
import {
  FaUser,
  FaWallet,
  FaShieldAlt,
  FaCheckCircle,
  FaRocket,
  FaChevronLeft,
  FaChevronRight,
  FaUpload,
  FaTachometerAlt,
  FaExclamationCircle,
  FaSpinner,
  FaGlobe,
  FaUniversity,
} from "react-icons/fa";

const STEPS = [
  { title: "Welcome", icon: <FaRocket />, num: 1 },
  { title: "Account Type", icon: <FaUser />, num: 2 },
  { title: "Profile Setup", icon: <FaUser />, num: 3 },
  { title: "Wallet Connection", icon: <FaWallet />, num: 4 },
  { title: "Publishing Guide", icon: <FaUpload />, num: 5 },
  { title: "Creator Attribution", icon: <FaShieldAlt />, num: 6 },
  { title: "Complete", icon: <FaCheckCircle />, num: 7 },
];

const containerVariants = {
  enter: { opacity: 0, x: 80 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -80 },
};

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [accountType, setAccountType] = useState(null);
  const [formData, setFormData] = useState({
    fullName: "",
    bio: "",
    institution: "",
    country: "",
    institutionName: "",
    institutionRole: "",
    institutionSize: "",
  });
  const [formErrors, setFormErrors] = useState({});

  const { isConnected, address, state, connect } = useWallet();
  const createProfile = useCreateProfile();

  const isWalletConnecting = state?.status === "connecting";
  const isWalletError = state?.status === "error";

  const handleNext = () => {
    if (step === 1 && !accountType) {
      setFormErrors({ accountType: "Please select an account type" });
      return;
    }
    if (step === 2) {
      const errors = {};
      if (!formData.fullName.trim()) {
        errors.fullName = "Full name is required";
      }
      if (accountType === "institution" && !formData.institutionName.trim()) {
        errors.institutionName = "Institution name is required";
      }
      if (Object.keys(errors).length > 0) {
        setFormErrors(errors);
        return;
      }
      setFormErrors({});
    }
    if (step < 6) setStep((s) => s + 1);
  };

  const handleBack = () => {
    if (step > 0) setStep((s) => s - 1);
  };

  const handleComplete = () => {
    createProfile.mutate({
      fullName: formData.fullName.trim(),
      bio: formData.bio.trim(),
      institution: formData.institution.trim(),
      country: formData.country.trim(),
      walletAddress: address,
    });
    setStep(5);
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (formErrors[name]) {
      setFormErrors((prev) => ({ ...prev, [name]: undefined }));
    }
  };

  const renderStepContent = (stepIndex) => {
    switch (stepIndex) {
      case 0:
        return (
          <div className="space-y-6">
            <div className="text-center space-y-3">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 200, delay: 0.2 }}
                className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-blue-600 text-white text-3xl mx-auto"
              >
                <FaRocket />
              </motion.div>
              <h1 className="text-3xl md:text-4xl font-bold text-gray-900">
                Welcome to EduVault
              </h1>
              <p className="text-lg text-gray-600 max-w-xl mx-auto leading-relaxed">
                Set up your creator profile in a few simple steps. Connect your
                wallet, tell us about yourself, and start sharing your knowledge
                with the world.
              </p>
            </div>

            <div className="grid sm:grid-cols-3 gap-4 max-w-2xl mx-auto">
              {[
                {
                  icon: <FaUser className="w-5 h-5" />,
                  title: "Profile Setup",
                  desc: "Tell learners who you are and what you teach.",
                },
                {
                  icon: <FaWallet className="w-5 h-5" />,
                  title: "Wallet Connection",
                  desc: "Link your Stellar wallet for attribution and payments.",
                },
                {
                  icon: <FaShieldAlt className="w-5 h-5" />,
                  title: "Creator Attribution",
                  desc: "Every material is permanently tied to your identity.",
                },
              ].map((item, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 + i * 0.15 }}
                  className="bg-white/80 border border-gray-100 rounded-xl p-5 text-center shadow-sm"
                >
                  <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-blue-50 text-blue-600 mb-3">
                    {item.icon}
                  </div>
                  <h3 className="font-semibold text-gray-900 mb-1">
                    {item.title}
                  </h3>
                  <p className="text-sm text-gray-500">{item.desc}</p>
                </motion.div>
              ))}
            </div>
          </div>
        );

      case 1:
        return (
          <div className="space-y-6 max-w-lg mx-auto">
            <div className="text-center space-y-2">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-100 text-blue-600 text-2xl mx-auto">
                <FaUser />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold text-gray-900">
                How will you use EduVault?
              </h2>
              <p className="text-gray-500">
                We&apos;ll customize your experience based on your role.
              </p>
            </div>
            <div className="space-y-3">
              {[
                {
                  id: "creator",
                  title: "Individual Creator",
                  desc: "I publish and sell my own educational materials",
                },
                {
                  id: "institution",
                  title: "School or Institution",
                  desc: "We manage cohorts, curriculum, and learner progress",
                },
              ].map((option) => (
                <button
                  key={option.id}
                  onClick={() => {
                    setAccountType(option.id);
                    setFormErrors({});
                  }}
                  className={`w-full text-left p-4 rounded-xl border-2 transition ${
                    accountType === option.id
                      ? "border-blue-600 bg-blue-50"
                      : "border-gray-200 bg-white hover:border-gray-300"
                  }`}
                >
                  <h3 className="font-semibold text-gray-900">
                    {option.title}
                  </h3>
                  <p className="text-sm text-gray-500 mt-1">{option.desc}</p>
                </button>
              ))}
              {formErrors.accountType && (
                <p className="text-sm text-red-500 flex items-center gap-1">
                  <FaExclamationCircle className="w-3 h-3" />
                  {formErrors.accountType}
                </p>
              )}
            </div>
          </div>
        );

      case 2:
        return (
          <div className="space-y-6 max-w-lg mx-auto">
            <div className="text-center space-y-2">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-100 text-blue-600 text-2xl mx-auto">
                <FaUser />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold text-gray-900">
                {accountType === "institution"
                  ? "Institution Setup"
                  : "Tell us about yourself"}
              </h2>
              <p className="text-gray-500">
                {accountType === "institution"
                  ? "Set up your institution profile and team."
                  : "This information will appear on your public creator profile."}
              </p>
            </div>

            <div className="space-y-4">
              {accountType === "institution" ? (
                <>
                  <div>
                    <label
                      htmlFor="institutionName"
                      className="block text-sm font-semibold text-gray-700 mb-1.5"
                    >
                      Institution Name <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400">
                        <FaUniversity className="w-4 h-4" />
                      </div>
                      <input
                        id="institutionName"
                        name="institutionName"
                        type="text"
                        value={formData.institutionName}
                        onChange={handleInputChange}
                        placeholder="University of Knowledge"
                        aria-required="true"
                        aria-invalid={!!formErrors.institutionName}
                        className={`w-full pl-10 pr-4 py-3 rounded-xl border bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition ${
                          formErrors.institutionName
                            ? "border-red-400"
                            : "border-gray-200"
                        }`}
                      />
                    </div>
                    {formErrors.institutionName && (
                      <p className="mt-1 text-sm text-red-500 flex items-center gap-1">
                        <FaExclamationCircle className="w-3 h-3" />
                        {formErrors.institutionName}
                      </p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="institutionRole"
                      className="block text-sm font-semibold text-gray-700 mb-1.5"
                    >
                      Your Role
                    </label>
                    <select
                      id="institutionRole"
                      name="institutionRole"
                      value={formData.institutionRole}
                      onChange={handleInputChange}
                      className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                    >
                      <option value="">Select your role</option>
                      <option value="admin">Administrator</option>
                      <option value="teacher">Teacher/Instructor</option>
                      <option value="cohort">Cohort Manager</option>
                      <option value="other">Other</option>
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="institutionSize"
                      className="block text-sm font-semibold text-gray-700 mb-1.5"
                    >
                      Institution Size
                    </label>
                    <select
                      id="institutionSize"
                      name="institutionSize"
                      value={formData.institutionSize}
                      onChange={handleInputChange}
                      className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                    >
                      <option value="">Select size</option>
                      <option value="small">Small (1-50 students)</option>
                      <option value="medium">Medium (51-500 students)</option>
                      <option value="large">Large (500+ students)</option>
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="country"
                      className="block text-sm font-semibold text-gray-700 mb-1.5"
                    >
                      Country
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400">
                        <FaGlobe className="w-4 h-4" />
                      </div>
                      <input
                        id="country"
                        name="country"
                        type="text"
                        value={formData.country}
                        onChange={handleInputChange}
                        placeholder="Nigeria"
                        className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                      />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label
                      htmlFor="fullName"
                      className="block text-sm font-semibold text-gray-700 mb-1.5"
                    >
                      Full Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="fullName"
                      name="fullName"
                      type="text"
                      value={formData.fullName}
                      onChange={handleInputChange}
                      placeholder="Dr. Jane Smith"
                      aria-required="true"
                      aria-invalid={!!formErrors.fullName}
                      aria-describedby={
                        formErrors.fullName ? "fullName-error" : undefined
                      }
                      className={`w-full px-4 py-3 rounded-xl border bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition ${
                        formErrors.fullName
                          ? "border-red-400"
                          : "border-gray-200"
                      }`}
                    />
                    {formErrors.fullName && (
                      <p
                        id="fullName-error"
                        className="mt-1 text-sm text-red-500 flex items-center gap-1"
                        role="alert"
                      >
                        <FaExclamationCircle className="w-3 h-3" />
                        {formErrors.fullName}
                      </p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="bio"
                      className="block text-sm font-semibold text-gray-700 mb-1.5"
                    >
                      Bio
                    </label>
                    <textarea
                      id="bio"
                      name="bio"
                      rows={3}
                      value={formData.bio}
                      onChange={handleInputChange}
                      placeholder="A passionate educator specializing in..."
                      className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition resize-none"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="institution"
                      className="block text-sm font-semibold text-gray-700 mb-1.5"
                    >
                      Institution (Optional)
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400">
                        <FaUniversity className="w-4 h-4" />
                      </div>
                      <input
                        id="institution"
                        name="institution"
                        type="text"
                        value={formData.institution}
                        onChange={handleInputChange}
                        placeholder="University of Knowledge"
                        className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="country"
                      className="block text-sm font-semibold text-gray-700 mb-1.5"
                    >
                      Country
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400">
                        <FaGlobe className="w-4 h-4" />
                      </div>
                      <input
                        id="country"
                        name="country"
                        type="text"
                        value={formData.country}
                        onChange={handleInputChange}
                        placeholder="Nigeria"
                        className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        );

      case 3:
        return (
          <div className="space-y-6 max-w-lg mx-auto text-center">
            <div className="space-y-2">
              <div
                className={`inline-flex items-center justify-center w-16 h-16 rounded-full text-2xl mx-auto ${
                  isConnected
                    ? "bg-green-100 text-green-600"
                    : "bg-blue-100 text-blue-600"
                }`}
              >
                <FaWallet />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold text-gray-900">
                Connect Your Wallet
              </h2>
              <p className="text-gray-500 leading-relaxed">
                Link your Stellar wallet to receive payments, sign transactions,
                and establish immutable creator attribution for every material
                you publish.
              </p>
            </div>

            <div className="bg-white/80 border border-gray-100 rounded-xl p-6 shadow-sm space-y-4">
              {isConnected ? (
                <div className="space-y-2">
                  <div className="inline-flex items-center gap-2 bg-green-50 text-green-700 px-4 py-2 rounded-full text-sm font-semibold">
                    <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                    Wallet Connected
                  </div>
                  <p className="text-sm text-gray-600 font-mono break-all bg-gray-50 rounded-lg px-4 py-2">
                    {address}
                  </p>
                  <p className="text-xs text-gray-400">
                    This address will be used for creator attribution and
                    receiving payments.
                  </p>
                </div>
              ) : isWalletConnecting ? (
                <div className="flex items-center justify-center gap-3 text-blue-600 py-4">
                  <FaSpinner className="animate-spin w-5 h-5" />
                  <span className="font-semibold">Connecting to wallet...</span>
                </div>
              ) : isWalletError ? (
                <div className="space-y-3">
                  <div
                    className="text-red-600 bg-red-50 rounded-lg px-4 py-3 text-sm flex items-center gap-2"
                    role="alert"
                  >
                    <FaExclamationCircle className="w-4 h-4 shrink-0" />
                    Wallet connection failed. Please try again.
                  </div>
                  <button
                    onClick={connect}
                    className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 transition shadow-sm"
                  >
                    Retry Connection
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <button
                    onClick={connect}
                    className="w-full px-6 py-4 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 transition shadow-sm flex items-center justify-center gap-2"
                  >
                    <FaWallet className="w-4 h-4" />
                    Connect Stellar Wallet
                  </button>
                  <p className="text-xs text-gray-400">
                    Securely sign in with your preferred Stellar wallet
                    provider.
                  </p>
                </div>
              )}

              {!isConnected && !isWalletConnecting && !isWalletError && (
                <div className="text-left space-y-2 border-t border-gray-100 pt-4">
                  <p className="text-sm font-semibold text-gray-700">
                    Why connect a wallet?
                  </p>
                  <ul className="text-sm text-gray-500 space-y-1.5 list-disc list-inside">
                    <li>Receive XLM payments for your materials</li>
                    <li>Immutable proof of authorship on-chain</li>
                    <li>Sign and verify your uploaded content</li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        );

      case 4:
        return (
          <div className="space-y-6 max-w-lg mx-auto">
            <div className="text-center space-y-2">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-100 text-blue-600 text-2xl mx-auto">
                <FaUpload />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold text-gray-900">
                {accountType === "institution"
                  ? "Using the Platform"
                  : "Publishing Your Resources"}
              </h2>
              <p className="text-gray-500 leading-relaxed">
                Learn how to publish and manage your educational materials on
                EduVault.
              </p>
            </div>

            <div className="space-y-4">
              {[
                {
                  step: "1",
                  title: "Upload Your Material",
                  desc: 'Go to your Dashboard and click "Upload Material." Add a title, description, subject, and attach your file (PDF, DOCX, or PPTX up to 50MB).',
                },
                {
                  step: "2",
                  title: "Set Your Price",
                  desc: "Choose a price in XLM for your material, or make it free. You receive payments directly to your connected Stellar wallet.",
                },
                {
                  step: "3",
                  title: "Publish & Share",
                  desc: "Once published, your resource appears on the Marketplace. Share the link with students and track performance from your Analytics dashboard.",
                },
                {
                  step: "4",
                  title: "Manage Listings",
                  desc: 'Edit titles, update prices, or unpublish materials anytime from the "My Materials" section in your dashboard.',
                },
              ].map((item) => (
                <div
                  key={item.step}
                  className="flex items-start gap-4 bg-white/80 border border-gray-100 rounded-xl p-4 shadow-sm"
                >
                  <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold shrink-0">
                    {item.step}
                  </div>
                  <div>
                    <h4 className="font-semibold text-gray-900 text-sm">
                      {item.title}
                    </h4>
                    <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                      {item.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );

      case 5:
        return (
          <div className="space-y-6 max-w-lg mx-auto text-center">
            <div className="space-y-2">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-100 text-blue-600 text-2xl mx-auto">
                <FaShieldAlt />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold text-gray-900">
                {accountType === "institution"
                  ? "Account Security"
                  : "Creator Attribution"}
              </h2>
              <p className="text-gray-500 leading-relaxed">
                Every material you upload to EduVault is permanently linked to
                your identity through your wallet address and display name.
              </p>
              {accountType !== "institution" && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-left text-sm text-amber-900">
                  Wallet access is required to manage your creator profile. You
                  may register an optional verified recovery contact in account
                  settings; without one, losing your wallet may permanently
                  prevent access to your profile and earnings history.
                </p>
              )}
            </div>

            <div className="bg-white/80 border border-gray-100 rounded-xl p-6 shadow-sm space-y-5 text-left">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 mt-0.5">
                  <FaWallet className="w-3.5 h-3.5" />
                </div>
                <div>
                  <h4 className="font-semibold text-gray-900 text-sm">
                    Wallet Address
                  </h4>
                  <p className="text-sm text-gray-500">
                    {address || "Not yet connected"}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Serves as your immutable creator ID on the Stellar network.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 mt-0.5">
                  <FaUser className="w-3.5 h-3.5" />
                </div>
                <div>
                  <h4 className="font-semibold text-gray-900 text-sm">
                    Display Name
                  </h4>
                  <p className="text-sm text-gray-500">
                    {formData.fullName || "Not yet set"}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Shown publicly on your materials and creator profile.
                  </p>
                </div>
              </div>

              <div className="border-t border-gray-100 pt-4 space-y-3">
                <h4 className="font-semibold text-gray-900 text-sm text-center">
                  Trust &amp; Transparency
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    {
                      icon: <FaShieldAlt className="w-4 h-4" />,
                      title: "Immutable",
                      desc: "On-chain proof of authorship",
                    },
                    {
                      icon: <FaCheckCircle className="w-4 h-4" />,
                      title: "Verifiable",
                      desc: "Content linked to your wallet",
                    },
                    {
                      icon: <FaRocket className="w-4 h-4" />,
                      title: "Reputable",
                      desc: "Build your creator brand",
                    },
                    {
                      icon: <FaWallet className="w-4 h-4" />,
                      title: "Monetizable",
                      desc: "Earn XLM for your work",
                    },
                  ].map((item, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 bg-gray-50 rounded-lg p-3"
                    >
                      <div className="text-blue-600 shrink-0 mt-0.5">
                        {item.icon}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-gray-800">
                          {item.title}
                        </p>
                        <p className="text-xs text-gray-500">{item.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );

      case 6:
        return (
          <div className="space-y-6 max-w-lg mx-auto text-center">
            <div className="space-y-3">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 150, delay: 0.1 }}
                className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-100 text-green-600 text-3xl mx-auto"
              >
                {createProfile.isPending ? (
                  <FaSpinner className="animate-spin" />
                ) : createProfile.isError ? (
                  <FaExclamationCircle />
                ) : (
                  <FaCheckCircle />
                )}
              </motion.div>
              <h2 className="text-2xl md:text-3xl font-bold text-gray-900">
                {createProfile.isPending
                  ? "Saving your profile..."
                  : createProfile.isError
                    ? "Something went wrong"
                    : "You're all set!"}
              </h2>
              <p className="text-gray-500 leading-relaxed">
                {createProfile.isPending
                  ? `Just a moment while we set up your ${accountType === "institution" ? "institution" : "creator"} account.`
                  : createProfile.isError
                    ? createProfile.error?.message ||
                      "Failed to create your profile. Please try again."
                    : accountType === "institution"
                      ? "Your institution is ready. Start managing cohorts and materials."
                      : "Your creator profile is ready. Start uploading materials and build your reputation on EduVault."}
              </p>
            </div>

            {createProfile.isError && (
              <button
                onClick={handleComplete}
                className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 transition shadow-sm"
              >
                Try Again
              </button>
            )}

            {!createProfile.isPending && !createProfile.isError && (
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-4">
                <Link
                  href="/dashboard/upload"
                  className="w-full sm:w-auto px-6 py-3.5 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 transition shadow-sm inline-flex items-center justify-center gap-2"
                >
                  <FaUpload className="w-4 h-4" />
                  Upload Your First Material
                </Link>
                <Link
                  href="/dashboard"
                  className="w-full sm:w-auto px-6 py-3.5 bg-white border border-gray-200 text-gray-700 font-semibold rounded-xl hover:bg-gray-50 transition shadow-sm inline-flex items-center justify-center gap-2"
                >
                  <FaTachometerAlt className="w-4 h-4" />
                  Go to Dashboard
                </Link>
              </div>
            )}

            {!createProfile.isPending && !createProfile.isError && (
              <p className="text-xs text-gray-400 pt-2">
                You can update your profile and settings anytime from your
                dashboard.
              </p>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  const isLastStep = step === 6;
  const isFirstStep = step === 0;
  const canProceed =
    step === 3
      ? isConnected
      : step === 2
        ? accountType === "institution"
          ? formData.institutionName.trim().length > 0
          : formData.fullName.trim().length > 0
        : step === 1
          ? accountType
          : true;

  return (
    <div className="min-h-screen bg-[#fffaf6]">
      <Navbar />

      <main className="pt-28 pb-16 px-4">
        <div className="max-w-2xl mx-auto">
          {/* Progress indicator */}
          <div
            className="mb-10"
            role="progressbar"
            aria-valuenow={step + 1}
            aria-valuemin={1}
            aria-valuemax={6}
            aria-label={`Step ${step + 1} of 6: ${STEPS[step].title}`}
          >
            <div className="flex items-center justify-between mb-3">
              {STEPS.map((s, i) => (
                <div key={i} className="flex items-center">
                  <button
                    className={`flex flex-col items-center gap-1 group ${
                      i > step ? "pointer-events-none opacity-40" : ""
                    }`}
                    onClick={() => {
                      if (i < step) setStep(i);
                    }}
                    aria-current={i === step ? "step" : undefined}
                    aria-label={`Step ${s.num}: ${s.title}${i <= step ? "" : " (locked)"}`}
                    disabled={i > step}
                  >
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                        i < step
                          ? "bg-blue-600 text-white"
                          : i === step
                            ? "bg-blue-600 text-white ring-4 ring-blue-100"
                            : "bg-gray-200 text-gray-400"
                      }`}
                    >
                      {i < step ? <FaCheckCircle className="w-4 h-4" /> : s.num}
                    </div>
                    <span
                      className={`text-xs font-semibold hidden sm:block ${
                        i <= step ? "text-gray-700" : "text-gray-400"
                      }`}
                    >
                      {s.title}
                    </span>
                  </button>
                  {i < STEPS.length - 1 && (
                    <div
                      className={`w-8 sm:w-16 h-0.5 mx-1 mt-[-14px] ${
                        i < step ? "bg-blue-600" : "bg-gray-200"
                      }`}
                    />
                  )}
                </div>
              ))}
            </div>
            <p className="text-center text-sm font-medium text-gray-500">
              Step {step + 1} of 6 &mdash; {STEPS[step].title}
            </p>
          </div>

          {/* Step content */}
          <div className="bg-white/90 backdrop-blur border border-gray-100 rounded-2xl shadow-sm p-8 md:p-10 min-h-[360px] flex flex-col">
            <div className="flex-1 flex items-center">
              <AnimatePresence mode="wait">
                <motion.div
                  key={step}
                  variants={containerVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.35, ease: "easeInOut" }}
                  className="w-full"
                >
                  {renderStepContent(step)}
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Navigation */}
            {!isLastStep && (
              <div className="flex items-center justify-between pt-8 border-t border-gray-100 mt-6">
                <button
                  onClick={handleBack}
                  disabled={isFirstStep}
                  className={`inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold transition ${
                    isFirstStep
                      ? "text-gray-300 cursor-not-allowed"
                      : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                  }`}
                  aria-label="Go back to previous step"
                >
                  <FaChevronLeft className="w-3.5 h-3.5" />
                  Back
                </button>

                <button
                  onClick={step === 5 ? handleComplete : handleNext}
                  disabled={
                    (step === 3 && !isConnected) ||
                    (step === 5 && createProfile.isPending) ||
                    !canProceed
                  }
                  className={`inline-flex items-center gap-1.5 px-6 py-3 rounded-xl text-sm font-semibold transition shadow-sm ${
                    (step === 3 && !isConnected) ||
                    (step === 5 && createProfile.isPending) ||
                    !canProceed
                      ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                      : "bg-blue-600 text-white hover:bg-blue-700"
                  }`}
                  aria-label={
                    step === 5 ? "Complete onboarding" : "Go to next step"
                  }
                >
                  {step === 5 ? (
                    createProfile.isPending ? (
                      <>
                        <FaSpinner className="animate-spin w-3.5 h-3.5" />
                        Creating Profile...
                      </>
                    ) : (
                      "Complete"
                    )
                  ) : (
                    <>
                      {step === 3 && !isConnected ? "Connect First" : "Next"}
                      <FaChevronRight className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
