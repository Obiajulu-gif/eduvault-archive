'use client';

import { useCallback, useContext, useEffect, useState, createContext } from 'react';

/**
 * Profile Context for managing profile state across the app
 */
export const ProfileContext = createContext(null);

/**
 * Hook for accessing profile context
 */
export function useProfile() {
  const ctx = useContext(ProfileContext);
  if (!ctx) {
    throw new Error('useProfile must be used inside <ProfileProvider>');
  }
  return ctx;
}

// Profile status states
export const ProfileStatus = Object.freeze({
  Idle: 'idle',
  Loading: 'loading',
  Checking: 'checking',
  Exists: 'exists',
  NotFound: 'not-found',
  Creating: 'creating',
  Updating: 'updating',
  Error: 'error',
});

/**
 * Profile Provider Component
 * 
 * Manages profile state and provides methods for checking, creating, and updating profiles.
 */
export function ProfileProvider({ children, publicKey }) {
  const [state, setState] = useState({
    status: ProfileStatus.Idle,
    profile: null,
    stellarMeta: null,
    error: null,
  });

  /**
   * Check if profile exists for the given public key
   */
  const checkProfile = useCallback(async (address) => {
    const targetAddress = address || publicKey;
    if (!targetAddress) {
      setState({ status: ProfileStatus.Error, error: 'No public key provided' });
      return null;
    }

    setState(prev => ({ ...prev, status: ProfileStatus.Checking, error: null }));

    try {
      const response = await fetch(
        `/api/profile/check?publicKey=${encodeURIComponent(targetAddress)}`,
        { method: 'GET', headers: { Accept: 'application/json' } }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to check profile');
      }

      const data = await response.json();

      if (data.exists && data.profile) {
        setState({
          status: ProfileStatus.Exists,
          profile: data.profile,
          stellarMeta: null,
          error: null,
        });
        return { exists: true, profile: data.profile };
      } else {
        setState({
          status: ProfileStatus.NotFound,
          profile: null,
          stellarMeta: data.stellarMeta || null,
          error: null,
        });
        return { exists: false, stellarMeta: data.stellarMeta };
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setState(prev => ({ ...prev, status: ProfileStatus.Error, error }));
      return null;
    }
  }, [publicKey]);

  /**
   * Create a new profile
   * Requires wallet connection (stellarPublicKey in body for verification)
   */
  const createProfile = useCallback(async (profileData) => {
    setState(prev => ({ ...prev, status: ProfileStatus.Creating, error: null }));

    try {
      const response = await fetch('/api/profile/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(profileData),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        
        if (response.status === 409) {
          // Profile already exists - trigger a check to get current state
          await checkProfile();
          throw new Error('Profile already exists');
        }
        
        throw new Error(errorData.error || 'Failed to create profile');
      }

      const data = await response.json();
      
      setState({
        status: ProfileStatus.Exists,
        profile: data.profile,
        stellarMeta: null,
        error: null,
      });

      return data.profile;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setState(prev => ({ ...prev, status: ProfileStatus.Error, error }));
      throw error;
    }
  }, [checkProfile]);

  /**
   * Update existing profile
   * Requires authentication (JWT cookie)
   */
  const updateProfile = useCallback(async (updates) => {
    setState(prev => ({ ...prev, status: ProfileStatus.Updating, error: null }));

    try {
      const response = await fetch('/api/profile/update', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to update profile');
      }

      const data = await response.json();
      
      setState(prev => ({
        ...prev,
        status: ProfileStatus.Exists,
        profile: data.profile,
        error: null,
      }));

      return data.profile;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setState(prev => ({ ...prev, status: ProfileStatus.Error, error }));
      throw error;
    }
  }, []);

  /**
   * Fetch current profile (for authenticated users)
   */
  const fetchMyProfile = useCallback(async () => {
    setState(prev => ({ ...prev, status: ProfileStatus.Loading, error: null }));

    try {
      const response = await fetch('/api/profile/me', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        if (response.status === 401) {
          setState({
            status: ProfileStatus.NotFound,
            profile: null,
            stellarMeta: null,
            error: null,
          });
          return null;
        }
        
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to fetch profile');
      }

      const data = await response.json();
      
      setState({
        status: ProfileStatus.Exists,
        profile: data.profile,
        stellarMeta: null,
        error: null,
      });

      return data.profile;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setState(prev => ({ ...prev, status: ProfileStatus.Error, error }));
      return null;
    }
  }, []);

  /**
   * Mark onboarding as complete
   */
  const completeOnboarding = useCallback(async () => {
    const profile = await updateProfile({ onboardingComplete: true });
    return profile;
  }, [updateProfile]);

  /**
   * Clear profile state (e.g., on disconnect)
   */
  const clearProfile = useCallback(() => {
    setState({
      status: ProfileStatus.Idle,
      profile: null,
      stellarMeta: null,
      error: null,
    });
  }, []);

  // Auto-check profile when publicKey changes
  useEffect(() => {
    if (publicKey) {
      checkProfile(publicKey);
    } else {
      clearProfile();
    }
  }, [publicKey, checkProfile, clearProfile]);

  const value = {
    // State
    status: state.status,
    profile: state.profile,
    stellarMeta: state.stellarMeta,
    error: state.error,
    isLoading: 
      state.status === ProfileStatus.Loading ||
      state.status === ProfileStatus.Checking ||
      state.status === ProfileStatus.Creating ||
      state.status === ProfileStatus.Updating,
    exists: state.status === ProfileStatus.Exists,
    needsOnboarding: 
      state.status === ProfileStatus.NotFound ||
      (state.status === ProfileStatus.Exists && !state.profile?.onboardingComplete),

    // Actions
    checkProfile,
    createProfile,
    updateProfile,
    fetchMyProfile,
    completeOnboarding,
    clearProfile,
  };

  return (
    <ProfileContext.Provider value={value}>
      {children}
    </ProfileContext.Provider>
  );
}
