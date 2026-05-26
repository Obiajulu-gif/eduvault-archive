import { NextResponse } from "next/server";
import { isProtectedDashboardPath, verifyDashboardToken } from "@/lib/auth/session";

export async function middleware(req) {
  const token = req.cookies.get("auth_token")?.value;
  const { pathname } = req.nextUrl;

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

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
