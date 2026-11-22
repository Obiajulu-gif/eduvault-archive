export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import { getOperationReceipt, verifyOperationReceipt } from "@/lib/receipts/operationReceipts";

export const runtime = "nodejs";

export async function GET(request, { params }) {
  return withApiHardening(
    request,
    { route: "receipts-get", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user?.sub) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const receipt = await getOperationReceipt(await getDb(), params.id);
      if (!receipt) return NextResponse.json({ error: "Not found" }, { status: 404 });

      const isAdmin = user.role === "admin" || user.role === "service";
      if (receipt.actor !== user.sub && !isAdmin) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }

      return NextResponse.json({ receipt, verified: verifyOperationReceipt(receipt) });
    }
  );
}
