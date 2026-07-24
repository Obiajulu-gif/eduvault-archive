import { NextResponse } from "next/server"
import { getUserFromCookie } from "@/lib/api/auth"
import { getDb } from "@/lib/mongodb"
import { createUploadSession } from "@/lib/ipfs/uploadSessions"
import { auditLog } from "@/lib/api/audit"
import { withApiHardening } from "@/lib/api/hardening"

export async function POST(request) {
  return withApiHardening(request, { route: "upload-session", rateLimit: { limit: 20, windowMs: 60_000 } }, async () => {
    const user = await getUserFromCookie(request)
    if (!user?.sub) {
      auditLog({ event: "upload_session_rejected", action: "create", resource: "upload-session", method: "POST", status: 401, outcome: "unauthorized" })
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    try {
      const session = await createUploadSession(await getDb(), {
        ownerId: user.sub,
        idempotencyKey: request.headers.get("idempotency-key"),
        ...(await request.json()),
      })
      auditLog({ event: "upload_session_created", action: "create", resource: "upload-session", method: "POST", status: 201, outcome: "success", uploadId: session._id })
      return NextResponse.json({ session }, { status: 201 })
    } catch (error) {
      auditLog({ event: "upload_session_rejected", action: "create", resource: "upload-session", method: "POST", status: 400, outcome: "invalid", reason: error.message })
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
  })
}
