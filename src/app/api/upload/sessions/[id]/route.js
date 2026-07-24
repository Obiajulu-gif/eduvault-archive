import { NextResponse } from "next/server"
import { getUserFromCookie } from "@/lib/api/auth"
import { getDb } from "@/lib/mongodb"
import { cancelUploadSession, completeUploadSession, recordUploadedPart } from "@/lib/ipfs/uploadSessions"
import { auditLog } from "@/lib/api/audit"
import { withApiHardening } from "@/lib/api/hardening"

async function context(request, params) {
  const user = await getUserFromCookie(request)
  if (!user?.sub) return null
  return { db: await getDb(), ownerId: user.sub, sessionId: (await params).id }
}

export async function GET(request, { params }) {
  return withApiHardening(request, { route: "upload-session", rateLimit: { limit: 60, windowMs: 60_000 } }, async () => {
    const ctx = await context(request, params)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const session = await ctx.db.collection("upload_sessions").findOne({ _id: ctx.sessionId, ownerId: ctx.ownerId })
    auditLog({ event: "upload_session_read", action: "read", resource: "upload-session", method: "GET", status: session ? 200 : 404, outcome: session ? "success" : "not_found", uploadId: ctx.sessionId })
    return session ? NextResponse.json({ session }) : NextResponse.json({ error: "Not found" }, { status: 404 })
  })
}

export async function PATCH(request, { params }) {
  return withApiHardening(request, { route: "upload-session", rateLimit: { limit: 60, windowMs: 60_000 } }, async () => {
    const ctx = await context(request, params)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    let action = "unknown"
    try {
      const body = await request.json()
      action = body.action
      const result =
        action === "record-part" ? await recordUploadedPart(ctx.db, { ...ctx, ...body }) :
        action === "complete" ? await completeUploadSession(ctx.db, { ...ctx, material: body.material || {} }) :
        action === "cancel" ? await cancelUploadSession(ctx.db, ctx) : null
      if (!result) {
        auditLog({ event: "upload_session_rejected", action, resource: "upload-session", method: "PATCH", status: 400, outcome: "invalid", uploadId: ctx.sessionId })
        return NextResponse.json({ error: "Unknown action" }, { status: 400 })
      }
      auditLog({ event: "upload_session_updated", action, resource: "upload-session", method: "PATCH", status: 200, outcome: "success", uploadId: ctx.sessionId })
      return NextResponse.json({ result })
    } catch (error) {
      auditLog({ event: "upload_session_failed", action, resource: "upload-session", method: "PATCH", status: 409, outcome: "conflict", reason: error.message, uploadId: ctx.sessionId })
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
  })
}
