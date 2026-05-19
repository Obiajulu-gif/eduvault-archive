'use client';

import { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useProfile, ProfileStatus } from '@/hooks/useProfile';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import ProfileForm from './ProfileForm';
import DiscoveryStep from './DiscoveryStep';
import ConfirmationStep from './ConfirmationStep';

/**
 * Onboarding Step Types
 */
const Step = Object.freeze({
  Discovery: 'discovery',
  Profile: 'profile',
  Confirmation: 'confirmation',
});

/**
 * Main Onboarding Flow Component
 * 
 * Multi-step onboarding flow for new users:
 * 1. Discovery - Check for existing Stellar metadata
 * 2. Profile - Edit/display name, bio, avatar
 * 3. Confirmation - Success state and redirect
 */
export default function OnboardingFlow() {
  const { address, isConnected } = useWallet();
  const { 
    status, 
    profile, 
    stellarMeta, 
    error, 
    isLoading, 
    exists,
    createProfile, 
    completeOnboarding,
    checkProfile,
  } = useProfile();
  const router = useRouter();

  const [currentStep, setCurrentStep] = useState(Step.Discovery);
  const [createdProfile, setCreatedProfile] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  // Handle discovery result and advance steps
  useEffect(() => {
    if (status === ProfileStatus.Checking) return;

    // If profile exists and onboarding is complete, redirect to dashboard
    if (exists && profile?.onboardingComplete) {
      router.push('/dashboard');
      return;
    }

    // If profile exists but onboarding not complete, skip to confirmation
    if (exists && profile && !profile.onboardingComplete) {
      setCurrentStep(Step.Confirmation);
      return;
    }

    // If no profile found, move to profile form (with stellar metadata if available)
    if (status === ProfileStatus.NotFound) {
      setCurrentStep(Step.Profile);
    }
  }, [status, exists, profile, router]);

  // Handle retry for discovery errors
  const handleRetry = useCallback(() => {
    setRetryCount(c => c + 1);
    checkProfile();
  }, [checkProfile]);

  // Handle profile form submission
  const handleProfileSubmit = useCallback(async (formData) => {
    if (!address) {
      throw new Error('Wallet not connected');
    }

    try {
      // Include the public key in the form data for server-side verification
      const submitData = {
        ...formData,
        stellarPublicKey: address,
      };

      const newProfile = await createProfile(submitData);
      setCreatedProfile(newProfile);
      setCurrentStep(Step.Confirmation);
      return newProfile;
    } catch (err) {
      // Handle 409 conflict - profile already exists
      if (err.message?.includes('already exists')) {
        // Refresh and check status
        await checkProfile();
        return;
      }
      throw err;
    }
  }, [address, createProfile, checkProfile]);

  // Handle confirmation complete
  const handleConfirmationComplete = useCallback(async () => {
    try {
      await completeOnboarding();
      router.push('/dashboard');
    } catch (err) {
      console.error('Failed to complete onboarding:', err);
      // Still redirect even if update fails
      router.push('/dashboard');
    }
  }, [completeOnboarding, router]);

  // Wallet not connected state
  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md w-full mx-auto p-8 bg-white rounded-xl shadow-sm text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">
            Connect Your Wallet
          </h1>
          <p className="text-gray-600 mb-6">
            Please connect your Stellar wallet to create your EduVault profile.
          </p>
          <button
            onClick={() => router.push('/')}
            className="inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            Return Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto">
        {/* Progress Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-3xl font-bold text-gray-900">
              Welcome to EduVault
            </h1>
            <span className="text-sm text-gray-500">
              Step {currentStep === Step.Discovery ? 1 : currentStep === Step.Profile ? 2 : 3} of 3
            </span>
          </div>
          
          {/* Progress Bar */}
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-500"
              style={{
                width: currentStep === Step.Discovery ? '33%' : 
                       currentStep === Step.Profile ? '66%' : '100%'
              }}
            />
          </div>
        </div>

        {/* Step Content */}
        <AnimatePresence mode="wait">
          <motion.div
            key={currentStep}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
          >
            {currentStep === Step.Discovery && (
              <DiscoveryStep
                status={status}
                error={error}
                isLoading={isLoading}
                onRetry={handleRetry}
                stellarMeta={stellarMeta}
              />
            )}

            {currentStep === Step.Profile && (
              <ProfileForm
                stellarMeta={stellarMeta}
                publicKey={address}
                onSubmit={handleProfileSubmit}
                isSubmitting={status === ProfileStatus.Creating}
              />
            )}

            {currentStep === Step.Confirmation && (
              <ConfirmationStep
                profile={createdProfile || profile}
                onComplete={handleConfirmationComplete}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
