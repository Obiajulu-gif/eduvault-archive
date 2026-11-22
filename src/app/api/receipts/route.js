export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import { createOrGetOperationReceipt } from "@/lib/receipts/operationReceipts";

export const runtime = "nodejs";

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "receipts-create", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user?.sub) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const body = await request.json().catch(() => null);
      const operation = typeof body?.operation === "string" ? body.operation : null;
      const status = typeof body?.status === "string" ? body.status : null;
      if (!operation || !status) {
        return NextResponse.json({ error: "operation and status are required" }, { status: 400 });
      }

      const dedupeKey = typeof body?.dedupeKey === "string" && body.dedupeKey
        ? body.dedupeKey
        : `${user.sub}:${operation}:${status}:${JSON.stringify(body?.externalRefs || {})}:${JSON.stringify(body?.payload || {})}`;

      const { receipt, created } = await createOrGetOperationReceipt(await getDb(), {
        actor: user.sub,
        operation,
        status,
        payload: body?.payload && typeof body.payload === "object" ? body.payload : {},
        externalRefs: body?.externalRefs && typeof body.externalRefs === "object" ? body.externalRefs : {},
        dedupeKey,
      });

      return NextResponse.json({ receipt }, { status: created ? 201 : 200 });
    }
  );
}
