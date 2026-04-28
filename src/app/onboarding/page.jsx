'use client';

import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { ProfileProvider } from '@/hooks/useProfile';
import { useWallet } from '@/hooks/useWallet';

// Dynamic import to avoid SSR issues with wallet/browser APIs
const OnboardingFlow = dynamic(
  () => import('@/components/onboarding/OnboardingFlow'),
  { ssr: false }
);

/**
 * Onboarding Page Loading Skeleton
 */
function OnboardingSkeleton() {
  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto">
        {/* Header Skeleton */}
        <div className="mb-8">
          <div className="h-8 bg-gray-200 rounded w-1/3 mb-4 animate-pulse" />
          <div className="w-full bg-gray-200 rounded-full h-2 animate-pulse" />
        </div>

        {/* Content Skeleton */}
        <div className="bg-white rounded-xl shadow-sm p-8">
          <div className="flex flex-col items-center space-y-6">
            <div className="w-16 h-16 bg-gray-200 rounded-full animate-pulse" />
            <div className="h-6 bg-gray-200 rounded w-3/4 animate-pulse" />
            <div className="h-4 bg-gray-200 rounded w-1/2 animate-pulse" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Onboarding Page Component
 * 
 * Entry point for new user onboarding flow.
 * Wraps OnboardingFlow with ProfileProvider for state management.
 */
function OnboardingContent() {
  const { address } = useWallet();

  return (
    <ProfileProvider publicKey={address}>
      <OnboardingFlow />
    </ProfileProvider>
  );
}

/**
 * Onboarding Page
 */
export default function OnboardingPage() {
  return (
    <Suspense fallback={<OnboardingSkeleton />}>
      <OnboardingContent />
    </Suspense>
  );
}
