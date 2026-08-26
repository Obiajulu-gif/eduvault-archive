import { verifyDashboardToken } from "@/lib/auth/session";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { isSuspendedUser } from "@/lib/auth/suspension";

export async function getUserFromCookie(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookieMatch = cookieHeader.match(/auth_token=([^;]+)/);
  const token = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  if (!token) return null;
  const verification = await verifyDashboardToken(token, process.env.JWT_SECRET);
  if (!verification.valid) {
    return null;
  }
  return verification.payload;
}

export async function getFullUserFromCookie(request) {
  const payload = await getUserFromCookie(request);
  if (!payload || !payload.sub) return null;

  try {
    const db = await getDb();
    const users = db.collection("users");
    return users.findOne({ _id: new ObjectId(payload.sub) });
  } catch {
    return null;
  }
}

/**
 * Resolve the caller and reject suspended accounts.
 *
 * A suspension has to be checked against the database, not the token: the JWT a
 * suspended user already holds stays cryptographically valid until it expires,
 * so signature verification alone would keep letting them in for the rest of
 * the token's lifetime.
 *
 * Returns a discriminated result rather than throwing so handlers can map it
 * straight onto 401 vs 403:
 *
 *   { ok: true,  user }
 *   { ok: false, status: 401 }            — no session
 *   { ok: false, status: 403, user }      — suspended
 */
export async function requireActiveUser(request) {
  const user = await getFullUserFromCookie(request);
  if (!user) return { ok: false, status: 401 };
  if (isSuspendedUser(user)) return { ok: false, status: 403, user };
  return { ok: true, user };
}

/**
 * Shared admin-route guard — resolves the session and requires `role === "admin"`.
 * Returns the session payload on success, or `null` if the caller is missing
 * or not an admin, so route handlers can respond with a consistent 401/403.
 */
export async function requireAdmin(request) {
  const payload = await getUserFromCookie(request);
  if (!payload || payload.role !== "admin") return null;

  // A suspended admin is still an admin as far as the token is concerned, so
  // the flag has to be read from the database before granting the privilege.
  try {
    const db = await getDb();
    const user = await db
      .collection("users")
      .findOne({ _id: new ObjectId(payload.sub) });
    if (isSuspendedUser(user)) return null;
  } catch {
    // A lookup failure must not silently upgrade a suspended admin, so fail
    // closed rather than falling through to the token payload.
    return null;
  }

  return payload;
}

export function sanitizeString(value, { maxLength = 5000 } = {}) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}
