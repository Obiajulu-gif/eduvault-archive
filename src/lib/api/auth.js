import { verifyDashboardToken } from "@/lib/auth/session";
import { ObjectId } from "mongodb";
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/mongodb";
import { isSuspendedUser } from "@/lib/auth/suspension";
import { hasPermission } from "@/lib/auth/permissions";
import { isSessionRevoked } from "@/lib/auth/sessionRevocation";

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
    let user = null;
    try {
      user = await users.findOne({ _id: new ObjectId(payload.sub) });
    } catch {
      user = await users.findOne({ walletAddress: payload.sub });
    }
    if (!user) return null;
    if (isSuspendedUser(user)) return null;
    if (isSessionRevoked(payload, user).revoked) return null;
    return user;
  } catch {
    return null;
  }
}

/**
 * Resolve the caller and reject suspended or revoked accounts.
 *
 * A suspension or security revocation has to be checked against the database,
 * not just the token: the JWT an affected user already holds stays cryptographically
 * valid until it expires, so signature verification alone would keep letting them in.
 *
 * Returns a discriminated result rather than throwing so handlers can map it
 * straight onto 401 vs 403:
 *
 *   { ok: true,  user }
 *   { ok: false, status: 401, code: "SESSION_REVOKED" } — no session or revoked
 *   { ok: false, status: 403, user }                    — suspended
 */
export async function requireActiveUser(request) {
  const payload = await getUserFromCookie(request);
  if (!payload?.sub) return { ok: false, status: 401 };

  try {
    const db = await getDb();
    let user = null;
    try {
      user = await db.collection("users").findOne({ _id: new ObjectId(payload.sub) });
    } catch {
      user = await db.collection("users").findOne({ walletAddress: payload.sub });
    }
    if (!user) return { ok: false, status: 401 };
    const currentUser = { ...payload, ...user, sub: payload.sub, role: user.role };
    if (isSuspendedUser(currentUser)) return { ok: false, status: 403, user: currentUser };

    const revocation = isSessionRevoked(payload, currentUser);
    if (revocation.revoked) {
      return {
        ok: false,
        status: 401,
        code: revocation.code || "SESSION_REVOKED",
        reason: revocation.reason,
      };
    }

    return { ok: true, user: currentUser };
  } catch {
    return { ok: false, status: 401 };
  }
}

function matchesServiceToken(request) {
  const supplied = request.headers.get("x-admin-token") || "";
  const configured = process.env.ADMIN_API_TOKEN || "";
  if (!supplied || !configured) return false;

  const suppliedBytes = Buffer.from(supplied);
  const configuredBytes = Buffer.from(configured);
  return suppliedBytes.length === configuredBytes.length &&
    timingSafeEqual(suppliedBytes, configuredBytes);
}

export async function requirePermission(request, permission, { allowService = false } = {}) {
  if (allowService && matchesServiceToken(request)) {
    const service = { sub: "service:admin-api", role: "service" };
    return hasPermission(service, permission)
      ? { ok: true, user: service }
      : { ok: false, status: 403 };
  }

  const result = await requireActiveUser(request);
  if (!result.ok) return result;
  if (!hasPermission(result.user, permission)) return { ok: false, status: 403, user: result.user };
  return result;
}

/**
 * Shared admin-route guard — resolves the session and requires `role === "admin"`.
 * Returns the session payload on success, or `null` if the caller is missing
 * or not an admin, so route handlers can respond with a consistent 401/403.
 */
export async function requireAdmin(request) {
  const result = await requirePermission(request, "admin:access");
  return result.ok ? result.user : null;
}

export function sanitizeString(value, { maxLength = 5000 } = {}) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}
