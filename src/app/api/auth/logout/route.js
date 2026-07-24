import { NextResponse } from 'next/server';
import { getUserFromCookie } from '@/lib/api/auth';
import { revokeRefreshTokenFamilyByToken, revokeRefreshTokensForUser } from '@/lib/auth/tokenService';
import { auditLog } from '@/lib/api/audit';

function getRefreshTokenFromCookie(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/refresh_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function POST(request) {
  try {
    const user = await getUserFromCookie(request);
    const refreshToken = getRefreshTokenFromCookie(request);

    const response = NextResponse.json({ success: true });

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

    if (refreshToken) {
      await revokeRefreshTokenFamilyByToken(refreshToken, user?.sub);
    } else if (user?.sub) {
      await revokeRefreshTokensForUser(user.sub);
    }

    auditLog({
      event: "auth_logout_success",
      route: "auth/logout",
      method: "POST",
      status: 200,
      address: user?.walletAddress,
    });

    return response;
  } catch (error) {
    console.error('POST /api/auth/logout error:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
