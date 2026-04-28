'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

/**
 * Confirmation Step Component
 * 
 * Shows success state with checkmark animation.
 * Auto-transitions to dashboard after 2 seconds or on CTA click.
 */
export default function ConfirmationStep({ profile, onComplete }) {
  const [countdown, setCountdown] = useState(2);

  // Auto-transition countdown
  useEffect(() => {
    if (countdown <= 0) {
      onComplete();
      return;
    }

    const timer = setTimeout(() => {
      setCountdown(c => c - 1);
    }, 1000);

    return () => clearTimeout(timer);
  }, [countdown, onComplete]);

  const displayName = profile?.displayName || 'there';

  return (
    <div className="bg-white rounded-xl shadow-sm p-8 text-center">
      {/* Checkmark Animation */}
      <div className="mx-auto flex items-center justify-center h-24 w-24 rounded-full bg-green-100 mb-6">
        <motion.svg
          className="h-12 w-12 text-green-600"
          fill="none"
          viewBox="0 0 24 24"
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ 
            type: "spring",
            stiffness: 200,
            damping: 15,
            delay: 0.2 
          }}
        >
          <motion.path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={3}
            stroke="currentColor"
            d="M5 13l4 4L19 7"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.5, delay: 0.4 }}
          />
        </motion.svg>
      </div>

      {/* Welcome Message */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6 }}
      >
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          Welcome to EduVault, {displayName}!
        </h2>
        <p className="text-gray-600 mb-6">
          Your profile has been created successfully. You&apos;re all set to start exploring and sharing educational materials.
        </p>
      </motion.div>

      {/* Profile Summary */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.8 }}
        className="mb-8"
      >
        <div className="inline-flex items-center space-x-4 bg-gray-50 rounded-lg px-6 py-4">
          {profile?.avatarUrl ? (
            <img
              src={profile.avatarUrl}
              alt={displayName}
              className="h-12 w-12 rounded-full object-cover border border-gray-200"
            />
          ) : (
            <div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center">
              <span className="text-blue-600 font-medium text-lg">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className="text-left">
            <p className="font-medium text-gray-900">{profile?.displayName}</p>
            {profile?.bio && (
              <p className="text-sm text-gray-500 truncate max-w-xs">
                {profile.bio}
              </p>
            )}
          </div>
        </div>
      </motion.div>

      {/* CTA Button */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1 }}
      >
        <button
          onClick={onComplete}
          className="inline-flex items-center justify-center px-8 py-3 border border-transparent text-base font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
        >
          Get Started
          <svg
            className="ml-2 -mr-1 h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 7l5 5m0 0l-5 5m5-5H6"
            />
          </svg>
        </button>
        
        {/* Auto-redirect notice */}
        <p className="mt-4 text-sm text-gray-500">
          Redirecting to dashboard in {countdown} second{countdown !== 1 ? 's' : ''}...
        </p>
      </motion.div>
    </div>
  );
}
