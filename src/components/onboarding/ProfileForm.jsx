'use client';

import { useState, useCallback, useId } from 'react';
import { motion } from 'framer-motion';

// Validation constants (must match server-side)
const DISPLAY_NAME_MAX = 50;
const BIO_MAX = 500;
const DISPLAY_NAME_PATTERN = /^[a-zA-Z0-9\s\-_.]+$/;

/**
 * Truncates a Stellar public key for display
 */
function truncatePublicKey(key) {
  if (!key || key.length < 12) return key;
  return `${key.slice(0, 6)}...${key.slice(-6)}`;
}

/**
 * Copies text to clipboard
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates display name
 */
function validateDisplayName(value) {
  const trimmed = value.trim();
  
  if (!trimmed) {
    return 'Display name is required';
  }
  
  if (trimmed.length > DISPLAY_NAME_MAX) {
    return `Display name must be ${DISPLAY_NAME_MAX} characters or less`;
  }
  
  if (!DISPLAY_NAME_PATTERN.test(trimmed)) {
    return 'Display name can only contain letters, numbers, spaces, hyphens, underscores, and periods';
  }
  
  return null;
}

/**
 * Validates bio
 */
function validateBio(value) {
  if (!value) return null;
  
  if (value.length > BIO_MAX) {
    return `Bio must be ${BIO_MAX} characters or less`;
  }
  
  return null;
}

/**
 * Validates avatar URL
 */
function validateAvatarUrl(value) {
  if (!value) return null;
  
  const isDev = process.env.NODE_ENV !== 'production';
  const urlPattern = isDev 
    ? /^https?:\/\/.+/i 
    : /^https:\/\/.+/i;
  
  if (!urlPattern.test(value)) {
    return 'Avatar URL must be a valid HTTPS URL';
  }
  
  return null;
}

/**
 * Profile Form Component
 * 
 * Multi-field form for creating/editing profile with:
 * - Display name (required, with character count)
 * - Bio (optional, with character count)
 * - Avatar URL (optional)
 * - Stellar public key display (read-only with copy button)
 * - Inline validation
 */
export default function ProfileForm({ stellarMeta, publicKey, onSubmit, isSubmitting }) {
  const [formData, setFormData] = useState({
    displayName: stellarMeta?.displayName || '',
    bio: stellarMeta?.bio || '',
    avatarUrl: stellarMeta?.avatarUrl || '',
  });
  
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [copySuccess, setCopySuccess] = useState(false);
  
  const formId = useId();

  // Handle field change
  const handleChange = useCallback((field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: null }));
    }
  }, [errors]);

  // Handle field blur (validate)
  const handleBlur = useCallback((field) => {
    setTouched(prev => ({ ...prev, [field]: true }));
    
    let error = null;
    if (field === 'displayName') {
      error = validateDisplayName(formData.displayName);
    } else if (field === 'bio') {
      error = validateBio(formData.bio);
    } else if (field === 'avatarUrl') {
      error = validateAvatarUrl(formData.avatarUrl);
    }
    
    if (error) {
      setErrors(prev => ({ ...prev, [field]: error }));
    }
  }, [formData]);

  // Handle form submission
  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    
    // Validate all fields
    const displayNameError = validateDisplayName(formData.displayName);
    const bioError = validateBio(formData.bio);
    const avatarUrlError = validateAvatarUrl(formData.avatarUrl);
    
    const newErrors = {
      displayName: displayNameError,
      bio: bioError,
      avatarUrl: avatarUrlError,
    };
    
    setErrors(newErrors);
    setTouched({ displayName: true, bio: true, avatarUrl: true });
    
    // Check if any errors exist
    if (displayNameError || bioError || avatarUrlError) {
      return;
    }
    
    // Submit clean data
    const submitData = {
      displayName: formData.displayName.trim(),
      bio: formData.bio?.trim() || null,
      avatarUrl: formData.avatarUrl?.trim() || null,
    };
    
    await onSubmit(submitData);
  }, [formData, onSubmit]);

  // Handle copy public key
  const handleCopy = useCallback(async () => {
    const success = await copyToClipboard(publicKey);
    if (success) {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }
  }, [publicKey]);

  // Show pre-fill notice if we have stellar metadata
  const hasStellarMeta = stellarMeta?.displayName || stellarMeta?.bio || stellarMeta?.avatarUrl;

  return (
    <div className="bg-white rounded-xl shadow-sm p-8">
      {/* Pre-fill Notice */}
      {hasStellarMeta && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg"
        >
          <p className="text-sm text-blue-800">
            <span className="font-medium">We found your Stellar account details.</span>{' '}
            Review and confirm below.
          </p>
        </motion.div>
      )}

      <form onSubmit={handleSubmit} id={formId} noValidate>
        {/* Stellar Address (Read-only) */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Your Stellar Address
          </label>
          <div className="flex items-center space-x-2">
            <div className="flex-1 px-4 py-2 bg-gray-100 border border-gray-300 rounded-md text-gray-600 font-mono text-sm truncate">
              {truncatePublicKey(publicKey)}
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              {copySuccess ? (
                <>
                  <svg className="h-4 w-4 mr-1 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Copy
                </>
              )}
            </button>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            This is your unique Stellar address and cannot be changed.
          </p>
        </div>

        {/* Display Name */}
        <div className="mb-6">
          <label 
            htmlFor={`${formId}-displayName`}
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Display Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            id={`${formId}-displayName`}
            value={formData.displayName}
            onChange={(e) => handleChange('displayName', e.target.value)}
            onBlur={() => handleBlur('displayName')}
            maxLength={DISPLAY_NAME_MAX + 10} // Allow typing but show validation
            className={`w-full px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-offset-1 ${
              errors.displayName && touched.displayName
                ? 'border-red-500 focus:ring-red-500'
                : 'border-gray-300 focus:ring-blue-500'
            }`}
            placeholder="Enter your display name"
            aria-invalid={!!errors.displayName && touched.displayName}
            aria-describedby={errors.displayName && touched.displayName ? `${formId}-displayName-error` : undefined}
          />
          <div className="flex justify-between mt-1">
            {errors.displayName && touched.displayName ? (
              <p id={`${formId}-displayName-error`} className="text-xs text-red-600">
                {errors.displayName}
              </p>
            ) : (
              <span />
            )}
            <span className={`text-xs ${formData.displayName.length > DISPLAY_NAME_MAX ? 'text-red-500' : 'text-gray-500'}`}>
              {formData.displayName.length}/{DISPLAY_NAME_MAX}
            </span>
          </div>
        </div>

        {/* Bio */}
        <div className="mb-6">
          <label 
            htmlFor={`${formId}-bio`}
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Bio <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            id={`${formId}-bio`}
            value={formData.bio}
            onChange={(e) => handleChange('bio', e.target.value)}
            onBlur={() => handleBlur('bio')}
            rows={4}
            maxLength={BIO_MAX + 50} // Allow typing but show validation
            className={`w-full px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-offset-1 resize-none ${
              errors.bio && touched.bio
                ? 'border-red-500 focus:ring-red-500'
                : 'border-gray-300 focus:ring-blue-500'
            }`}
            placeholder="Tell us about yourself..."
            aria-invalid={!!errors.bio && touched.bio}
            aria-describedby={errors.bio && touched.bio ? `${formId}-bio-error` : undefined}
          />
          <div className="flex justify-between mt-1">
            {errors.bio && touched.bio ? (
              <p id={`${formId}-bio-error`} className="text-xs text-red-600">
                {errors.bio}
              </p>
            ) : (
              <span />
            )}
            <span className={`text-xs ${formData.bio.length > BIO_MAX ? 'text-red-500' : 'text-gray-500'}`}>
              {formData.bio.length}/{BIO_MAX}
            </span>
          </div>
        </div>

        {/* Avatar URL */}
        <div className="mb-8">
          <label 
            htmlFor={`${formId}-avatarUrl`}
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Avatar URL <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            type="url"
            id={`${formId}-avatarUrl`}
            value={formData.avatarUrl}
            onChange={(e) => handleChange('avatarUrl', e.target.value)}
            onBlur={() => handleBlur('avatarUrl')}
            className={`w-full px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-offset-1 ${
              errors.avatarUrl && touched.avatarUrl
                ? 'border-red-500 focus:ring-red-500'
                : 'border-gray-300 focus:ring-blue-500'
            }`}
            placeholder="https://example.com/avatar.jpg"
            aria-invalid={!!errors.avatarUrl && touched.avatarUrl}
            aria-describedby={errors.avatarUrl && touched.avatarUrl ? `${formId}-avatarUrl-error` : undefined}
          />
          {errors.avatarUrl && touched.avatarUrl && (
            <p id={`${formId}-avatarUrl-error`} className="mt-1 text-xs text-red-600">
              {errors.avatarUrl}
            </p>
          )}
          <p className="mt-1 text-xs text-gray-500">
            Enter a direct URL to an image (JPG, PNG, WebP). Must use HTTPS.
          </p>
          
          {/* Avatar Preview */}
          {formData.avatarUrl && !errors.avatarUrl && (
            <div className="mt-3">
              <p className="text-xs text-gray-500 mb-2">Preview:</p>
              <img
                src={formData.avatarUrl}
                alt="Avatar preview"
                className="h-20 w-20 rounded-full object-cover border border-gray-200"
                onError={(e) => {
                  e.target.style.display = 'none';
                }}
              />
            </div>
          )}
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full flex justify-center items-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? (
            <>
              <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Saving...
            </>
          ) : (
            'Save Profile'
          )}
        </button>
      </form>
    </div>
  );
}
