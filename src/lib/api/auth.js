import { verifyDashboardToken } from "../auth/session.js";
import { ObjectId } from "mongodb";
import { getDb } from "../mongodb.js";

export async function getUserFromCookie(request) {
  try {
    const secret = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET || "";
    if (!secret || typeof secret !== "string" || secret.trim().length === 0) {
      return null;
    }

    const cookieHeader = request?.headers?.get?.("cookie") || "";
    if (!cookieHeader) return null;

    const cookieMatch = cookieHeader.match(/(?:^|;\s*)(?:auth_token|dashboard_token)=([^;]+)/);
    if (!cookieMatch) return null;

    let token = null;
    try {
      token = decodeURIComponent(cookieMatch[1].trim());
    } catch {
      return null;
    }

    if (!token) return null;

    const verification = await verifyDashboardToken(token, secret);
    if (!verification?.valid || !verification?.payload) {
      return null;
    }

    return verification.payload;
  } catch {
    return null;
  }
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

export function sanitizeString(value, { maxLength = 5000 } = {}) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}
