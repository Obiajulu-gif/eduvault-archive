export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { verifyUnsubscribeToken } from '@/lib/email/unsubscribeToken';
import { errorResponse } from '@/lib/utils/errorResponse';

/**
 * POST /api/email/unsubscribe
 *
 * One-click unsubscribe endpoint for marketing emails.
 * Takes a signed token (no authentication required) and disables the corresponding preference.
 *
 * This allows email recipients to unsubscribe with a single click, as required by CAN-SPAM.
 * The token is cryptographically signed and includes an expiry, so it cannot be forged.
 *
 * Example token payload:
 * { email: "user@example.com", preferenceKey: "productUpdates", issuedAt: <timestamp>, expiry: <timestamp> }
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { token } = body;

    if (!token || typeof token !== 'string') {
      return errorResponse({
        status: 400,
        detail: 'Missing or invalid token',
        instance: '/api/email/unsubscribe',
      });
    }

    const decoded = verifyUnsubscribeToken(token);
    if (!decoded) {
      return errorResponse({
        status: 400,
        detail: 'Invalid or expired unsubscribe token',
        instance: '/api/email/unsubscribe',
      });
    }

    const { email, preferenceKey } = decoded;

    const db = await getDb();
    const users = db.collection('users');

    // Find user by email
    const user = await users.findOne({ email });
    if (!user) {
      // For privacy, don't reveal whether the email exists
      return NextResponse.json({
        success: true,
        message: 'Unsubscribe link processed',
      });
    }

    // Update the preference to false
    const updateResult = await users.updateOne(
      { _id: user._id },
      {
        $set: {
          [`emailSubscriptions.${preferenceKey}`]: false,
          updatedAt: new Date().toISOString(),
        },
      }
    );

    if (updateResult.modifiedCount === 0) {
      // Already unsubscribed or preference doesn't exist
      return NextResponse.json({
        success: true,
        message: 'Unsubscribe link processed',
      });
    }

    return NextResponse.json({
      success: true,
      message: 'You have been unsubscribed from this email type',
    });
  } catch (error) {
    console.error('Unsubscribe failed:', error);
    return errorResponse({
      status: 500,
      detail: 'Server error',
      instance: '/api/email/unsubscribe',
    });
  }
}
