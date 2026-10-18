export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { requireActiveUser, hasPermission } from "@/lib/api/auth";
import { revokeUserSessions, SECURITY_EVENT_TYPES } from "@/lib/auth/sessionRevocation";
import { auditLog } from "@/lib/api/audit";
import { errorResponse } from "@/lib/utils/errorResponse";

/**
 * POST /api/auth/revoke
 *
 * Explicit session revocation endpoint supporting:
 *   - scope: "all" — Revokes all access and refresh tokens across all devices.
 *   - scope: "others" — Revokes all other sessions, sparing the current session family.
 *   - targetUserId: (optional) Admin-only target user revocation.
 */
export async function POST(request) {
  try {
    const authResult = await requireActiveUser(request);
    if (!authResult.ok) {
      auditLog({
        event: "auth_revoke_unauthorized",
        route: "auth/revoke",
        method: "POST",
        status: authResult.status || 401,
      });
      return errorResponse({
        status: authResult.status || 401,
        detail: authResult.reason || "Authentication required",
        instance: "/api/auth/revoke",
      });
    }

    const caller = authResult.user;
    let body = {};
    try {
      body = await request.json();
    } catch {
      // Body may be empty, defaults to scope: "all"
    }

    const scope = body.scope === "others" ? "others" : "all";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "Explicit user session revocation";
    const requestedTargetUserId = body.targetUserId ? String(body.targetUserId).trim() : null;

    let targetUserId = caller.sub || caller._id?.toString() || caller.walletAddress;

    // Check authorization if targetUserId is explicitly provided
    if (requestedTargetUserId && requestedTargetUserId !== targetUserId) {
      const isAdmin = hasPermission(caller, "admin:access");
      if (!isAdmin) {
        auditLog({
          event: "auth_revoke_forbidden",
          route: "auth/revoke",
          method: "POST",
          status: 403,
          actor: targetUserId,
          targetUser: requestedTargetUserId,
        });
        return errorResponse({
          status: 403,
          detail: "Only administrators can revoke sessions for other accounts.",
          instance: "/api/auth/revoke",
        });
      }
      targetUserId = requestedTargetUserId;
    }

    const db = await getDb();
    const users = db.collection("users");

    let targetUserDoc = null;
    try {
      if (ObjectId.isValid(targetUserId) && targetUserId.length === 24) {
        targetUserDoc = await users.findOne({ _id: new ObjectId(targetUserId) });
      }
    } catch {
      targetUserDoc = null;
    }

    if (!targetUserDoc) {
      targetUserDoc = await users.findOne({ walletAddress: targetUserId });
    }

    if (!targetUserDoc) {
      return errorResponse({
        status: 404,
        detail: "Target user not found",
        instance: "/api/auth/revoke",
      });
    }

    const preserveFamilyId = scope === "others" ? caller.sessionFamilyId : null;

    const revocationResult = await revokeUserSessions(db, targetUserId, {
      eventType: SECURITY_EVENT_TYPES.ALL_SESSIONS_REVOKED,
      reason,
      actor: caller.walletAddress || caller.sub,
      preserveFamilyId,
    });

    const isSelfRevocationAll = scope === "all" && targetUserId === (caller.sub || caller._id?.toString() || caller.walletAddress);

    const response = NextResponse.json({
      success: true,
      scope,
      targetUserId,
      revokedAt: revocationResult.revokedAt,
      sessionVersion: revocationResult.sessionVersion,
      refreshTokensRevoked: revocationResult.refreshTokensRevoked,
      preservedCurrentSession: scope === "others",
    });

    // If caller revoked all of their own sessions, expire the cookies in the response
    if (isSelfRevocationAll) {
      response.cookies.set("auth_token", "", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: 0,
      });

      response.cookies.set("refresh_token", "", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/api/auth/refresh",
        maxAge: 0,
      });
    }

    auditLog({
      event: "auth_revoke_success",
      route: "auth/revoke",
      method: "POST",
      status: 200,
      actor: caller.sub,
      targetUser: targetUserId,
      scope,
      refreshTokensRevoked: revocationResult.refreshTokensRevoked,
    });

    return response;
  } catch (error) {
    auditLog({
      event: "auth_revoke_error",
      route: "auth/revoke",
      method: "POST",
      status: 500,
      reason: error.message,
    });
    return errorResponse({
      status: 500,
      detail: "Failed to revoke sessions: " + error.message,
      instance: "/api/auth/revoke",
    });
  }
}
