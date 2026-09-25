export const dynamic = "force-dynamic";

import { getDb } from "@/lib/mongodb";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { auditLog } from "@/lib/api/audit";
import { authorizeMaterialAccess } from "@/lib/entitlement";
import { getIpfsUrl } from "@/lib/config/chain";
import { normalizeBuyerAddress } from "@/lib/purchases/access";

export async function GET(req, { params }) {
  return withApiHardening(
    req,
    { route: "material-deliver", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const { id } = await params;

      // ── 1. Validate material ID format ─────────────────────────────────
      if (!id || !ObjectId.isValid(id)) {
        auditLog({ event: "deliver_invalid_id", route: "material-deliver", method: "GET", status: 400, materialId: id });
        return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
      }

      // ── 2. Authenticate ────────────────────────────────────────────────
      const user = await getUserFromCookie(req);
      if (!user) {
        auditLog({ event: "deliver_auth_failed", route: "material-deliver", method: "GET", status: 401 });
        return NextResponse.json({ error: "Authentication required" }, { status: 401 });
      }

      const userAddress = normalizeBuyerAddress(user.walletAddress || user.address || user.id);
      if (!userAddress) {
        auditLog({ event: "deliver_no_address", route: "material-deliver", method: "GET", status: 400, actor: user.sub });
        return NextResponse.json({ error: "No wallet address on account" }, { status: 400 });
      }

      // ── 3. Resolve material ────────────────────────────────────────────
      const db = await getDb();
      let material;
      try {
        material = await db.collection("materials").findOne({ _id: new ObjectId(id) });
      } catch (err) {
        auditLog({ event: "deliver_db_error", route: "material-deliver", method: "GET", status: 500, materialId: id });
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
      }

      if (!material) {
        auditLog({ event: "deliver_not_found", route: "material-deliver", method: "GET", status: 404, materialId: id });
        return NextResponse.json({ error: "Material not found" }, { status: 404 });
      }

      // ── 4. Verify access via the single entitlement policy boundary ─────
      const decision = await authorizeMaterialAccess({ db, material, buyerAddress: userAddress });
      const accessSource = decision.source;

      if (!decision.allowed) {
        auditLog({
          event: decision.state === "unavailable" ? "deliver_unavailable" : "deliver_access_denied",
          route: "material-deliver",
          method: "GET",
          status: decision.httpStatus,
          actor: user.sub,
          walletAddress: userAddress,
          materialId: id,
        });
        return NextResponse.json(
          decision.state === "unavailable"
            ? { error: "Could not confirm your entitlement right now. Please try again shortly." }
            : { error: "Access denied. You do not have permission to access this material." },
          { status: decision.httpStatus }
        );
      }

      // ── 5. Resolve file reference ──────────────────────────────────────
      const cid = material.ipfsCid ?? material.cid ?? material.fileHash ?? material.storageKey ?? material.fileUrl ?? "";
      if (!cid) {
        auditLog({
          event: "deliver_no_file",
          route: "material-deliver",
          method: "GET",
          status: 404,
          actor: user.sub,
          materialId: id,
        });
        return NextResponse.json({ error: "Material has no associated file" }, { status: 404 });
      }

      const fileUrl = getIpfsUrl(cid);

      // ── 6. Log and return ─────────────────────────────────────────────
      auditLog({
        event: "deliver_granted",
        route: "material-deliver",
        method: "GET",
        status: 200,
        actor: user.sub,
        walletAddress: userAddress,
        materialId: id,
      });

      return NextResponse.json(
        {
          success: true,
          downloadUrl: fileUrl,
          fileName: material.fileName ?? material.title ?? id,
          contentType: material.contentType ?? "application/octet-stream",
          source: accessSource,
        },
        {
          headers: {
            "Cache-Control": "private, max-age=60",
            "X-Access-Source": accessSource,
          },
        }
      );
    }
  );
}
