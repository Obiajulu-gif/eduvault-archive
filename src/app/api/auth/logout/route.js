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
      await db.collection('refresh_tokens').deleteMany({
        userId: String(user._id || user.id || user.walletAddress)
      });
      
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
