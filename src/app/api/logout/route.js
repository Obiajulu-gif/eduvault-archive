import { NextResponse } from "next/server";

export async function POST(request) {
  // Clear the auth_token cookie using the same attributes as when it was set
  const response = NextResponse.json({ success: true });
  response.cookies.set("auth_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return response;
}

export async function GET(request) {
  return new NextResponse(null, {
    status: 405,
    headers: {
      Allow: "POST",
    },
  });
}
