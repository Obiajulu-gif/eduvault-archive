/**
 * Profile Type Definitions
 * 
 * Shared types for user profiles in EduVault
 */

/**
 * User profile as stored in MongoDB
 */
export interface UserProfile {
  _id?: string;
  stellarPublicKey: string;
  displayName: string;
  email?: string | null;
  bio: string | null;
  avatarUrl: string | null;
  onboardingComplete: boolean;
  institution?: string | null;
  country?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Profile creation request body
 */
export interface ProfileCreateBody {
  displayName: string;
  bio?: string;
  avatarUrl?: string;
  email?: string;
}

/**
 * Profile update request body
 */
export interface ProfileUpdateBody {
  displayName?: string;
  bio?: string;
  avatarUrl?: string;
  onboardingComplete?: boolean;
}

/**
 * Stellar account metadata from on-chain data
 */
export interface StellarMeta {
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  accountExists: boolean;
}

/**
 * Response from /api/profile/check
 */
export interface ProfileCheckResponse {
  exists: boolean;
  profile?: {
    displayName: string;
    bio: string | null;
    avatarUrl: string | null;
    onboardingComplete: boolean;
  };
  stellarMeta?: StellarMeta;
}

/**
 * Response from /api/profile/me
 */
export interface ProfileMeResponse {
  profile: UserProfile;
}

/**
 * Response from /api/profile/create or /api/profile/update
 */
export interface ProfileMutationResponse {
  success: boolean;
  profile: UserProfile;
}

/**
 * Sanitized profile for client-side display
 */
export interface SanitizedProfile {
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  onboardingComplete: boolean;
}
