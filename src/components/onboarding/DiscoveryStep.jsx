'use client';

import { motion } from 'framer-motion';

/**
 * Discovery Step Component
 * 
 * Shows loading state while checking Stellar account metadata.
 * Displays any error with retry option.
 */
export default function DiscoveryStep({ status, error, isLoading, onRetry, stellarMeta }) {
  // Show loading state
  if (isLoading) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-8 text-center">
        <div className="flex flex-col items-center space-y-4">
          {/* Animated Spinner */}
          <div className="relative">
            <motion.div
              className="w-16 h-16 border-4 border-blue-200 rounded-full"
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            />
            <motion.div
              className="absolute inset-0 w-16 h-16 border-4 border-blue-600 rounded-full border-t-transparent"
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            />
          </div>
          
          <div>
            <h2 className="text-xl font-semibold text-gray-900">
              Checking your Stellar account...
            </h2>
            <p className="text-gray-500 mt-2">
              Looking up your on-chain metadata
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Show error state with retry
  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-8">
        <div className="text-center">
          {/* Error Icon */}
          <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-red-100 mb-4">
            <svg
              className="h-8 w-8 text-red-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>

          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            Couldn&apos;t Connect
          </h2>
          <p className="text-gray-500 mb-6">
            {error.message || "We couldn't check your Stellar account. Please try again."}
          </p>

          <button
            onClick={onRetry}
            className="inline-flex items-center px-6 py-3 border border-gray-300 shadow-sm text-base font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            <svg
              className="mr-2 -ml-1 h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Show found metadata notice (transient - will auto-advance)
  if (stellarMeta?.displayName || stellarMeta?.bio || stellarMeta?.avatarUrl) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-8">
        <div className="flex items-start space-x-4">
          <div className="flex-shrink-0">
            <div className="flex items-center justify-center h-12 w-12 rounded-full bg-green-100">
              <svg
                className="h-6 w-6 text-green-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
          </div>
          <div>
            <h3 className="text-lg font-medium text-gray-900">
              Stellar Account Found
            </h3>
            <p className="mt-1 text-gray-500">
              We found your Stellar account details. You can review and edit them on the next step.
            </p>
            {stellarMeta.displayName && (
              <div className="mt-3 flex items-center text-sm text-gray-600">
                <span className="font-medium mr-2">Name:</span>
                {stellarMeta.displayName}
              </div>
            )}
            {stellarMeta.accountExists === false && (
              <p className="mt-2 text-sm text-amber-600">
                Note: Your Stellar account is not yet funded. You can still create a profile, but you&apos;ll need to fund your account to use certain features.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Default state - no metadata found
  return (
    <div className="bg-white rounded-xl shadow-sm p-8">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">
          No Stellar Metadata Found
        </h2>
        <p className="text-gray-500">
          Your Stellar account doesn&apos;t have any profile data stored on-chain. 
          You can create a fresh profile below.
        </p>
        {stellarMeta?.accountExists === false && (
          <p className="mt-4 text-sm text-amber-600">
            Note: Your Stellar account is not yet funded. You can still create a profile, but you&apos;ll need to fund your account to use certain features.
          </p>
        )}
      </div>
    </div>
  );
}
