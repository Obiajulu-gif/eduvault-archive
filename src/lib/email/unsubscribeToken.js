import crypto from 'crypto';

const TOKEN_SECRET = process.env.UNSUBSCRIBE_TOKEN_SECRET || 'changeme-in-production';
const TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Generate a signed unsubscribe token for an email address and preference key.
 * Token includes: email, preference key, timestamp, expiry, and HMAC signature.
 * Can be embedded in email links without authentication.
 *
 * @param {string} email
 * @param {string} preferenceKey - e.g., 'weeklyEarnings', 'productUpdates'
 * @returns {string} - Base64-encoded signed token
 */
export function generateUnsubscribeToken(email, preferenceKey) {
  const now = Date.now();
  const expiry = now + TOKEN_EXPIRY_MS;

  const payload = JSON.stringify({ email, preferenceKey, issuedAt: now, expiry });
  const signature = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(payload)
    .digest('hex');

  const tokenData = { payload, signature };
  return Buffer.from(JSON.stringify(tokenData)).toString('base64');
}

/**
 * Verify and decode an unsubscribe token.
 *
 * @param {string} token - Base64-encoded token
 * @returns {{ email: string; preferenceKey: string } | null} - Decoded data or null if invalid/expired
 */
export function verifyUnsubscribeToken(token) {
  try {
    const tokenData = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    const { payload, signature } = tokenData;

    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', TOKEN_SECRET)
      .update(payload)
      .digest('hex');

    if (signature !== expectedSignature) {
      return null; // Signature mismatch
    }

    const data = JSON.parse(payload);

    // Check expiry
    if (Date.now() > data.expiry) {
      return null; // Token expired
    }

    return { email: data.email, preferenceKey: data.preferenceKey };
  } catch (err) {
    return null; // Parsing/validation error
  }
}
