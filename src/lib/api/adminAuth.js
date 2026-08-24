import { timingSafeEqual } from "crypto";

function safeEqual(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isAdminRequest(request) {
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected) {
    return false;
  }

  const authorization = request.headers.get("authorization") || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  const provided = bearer?.trim() || request.headers.get("x-admin-token")?.trim();

  if (!provided) {
    return false;
  }

  return safeEqual(provided, expected);
}
