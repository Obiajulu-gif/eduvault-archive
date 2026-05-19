import { NextResponse } from "next/server";
import { isProtectedDashboardPath, verifyDashboardToken } from "@/lib/auth/session";

export async function middleware(req) {
  const token = req.cookies.get("auth_token")?.value;
  const { pathname } = req.nextUrl;

  // Allow onboarding route without complete check
  if (pathname === "/onboarding" || pathname.startsWith("/onboarding/")) {
    return NextResponse.next();
  }

  if (!isProtectedDashboardPath(pathname)) {
    return NextResponse.next();
  }

  const secret = process.env.JWT_SECRET;
  if (!token || !secret) {
    const url = new URL("/", req.url);
    return NextResponse.redirect(url);
  }

  const verification = await verifyDashboardToken(token, secret);
  if (!verification.valid) {
    const url = new URL("/", req.url);
    return NextResponse.redirect(url);
  }

  // Check if onboarding is complete
  // The JWT payload contains onboardingComplete flag from profile
  const onboardingComplete = verification.payload?.onboardingComplete ?? false;
  
  if (!onboardingComplete) {
    // Redirect to onboarding if profile is not complete
    const url = new URL("/onboarding", req.url);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
