import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { getUserFromCookie } from '@/lib/api/auth';
import { auditLog } from '@/lib/api/audit';

export async function POST(request) {
  try {
    const user = await getUserFromCookie(request);
    
    // Even if user isn't found, we'll try to clear the cookie
    const response = NextResponse.json({ success: true });

    // Expire the cookies by setting maxAge to 0
    response.cookies.set('auth_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 0,
    });

    response.cookies.set('refresh_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth/refresh',
      maxAge: 0,
    });

    if (user) {
      const db = await getDb();
      const userId = String(user._id || user.id || user.sub || user.walletAddress);
      
      try {
        const { revokeUserSessions, SECURITY_EVENT_TYPES } = await import('@/lib/auth/sessionRevocation');
        await revokeUserSessions(db, userId, {
          eventType: SECURITY_EVENT_TYPES.MANUAL_LOGOUT_ALL,
          reason: "User explicit logout",
          actor: user.walletAddress || user.sub || userId,
        });
      } catch {
        await db.collection('refresh_tokens').deleteMany({ userId });
      }
      
      auditLog({
        event: "auth_logout_success",
        route: "auth/logout",
        method: "POST",
        status: 200,
        address: user.walletAddress,
      });
    }

    return response;
  } catch (error) {
    console.error('POST /api/auth/logout error:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
