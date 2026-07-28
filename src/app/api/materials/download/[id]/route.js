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
    { route: "material-download", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      try {
        const { id } = await params;
        if (!id || !ObjectId.isValid(id)) {
          auditLog({ event: "download_invalid_id", route: "material-download", method: "GET", status: 400, materialId: id });
          return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
        }

        const user = await getUserFromCookie(req);
        if (!user) {
          auditLog({ event: "download_auth_failed", route: "material-download", method: "GET", status: 401 });
          return NextResponse.json({ error: "Authentication required" }, { status: 401 });
        }

        const userAddress = normalizeBuyerAddress(user.walletAddress || user.address || user.id);
        if (!userAddress) {
          auditLog({ event: "download_no_address", route: "material-download", method: "GET", status: 400, actor: user.sub });
          return NextResponse.json({ error: "No wallet address on account" }, { status: 400 });
        }

        const db = await getDb();
        const material = await db
          .collection("materials")
          .findOne({ _id: new ObjectId(id) });

        if (!material) {
          auditLog({ event: "download_not_found", route: "material-download", method: "GET", status: 404, materialId: id });
          return NextResponse.json({ error: "Material not found" }, { status: 404 });
        }

        const decision = await authorizeMaterialAccess({ db, material, buyerAddress: userAddress });
        const accessSource = decision.source;

        if (!decision.allowed) {
          auditLog({
            event: decision.state === "unavailable" ? "download_unavailable" : "download_access_denied",
            route: "material-download",
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

        const cid = material.ipfsCid ?? material.cid ?? material.fileHash ?? material.storageKey ?? material.fileUrl ?? "";
        if (!cid) {
          auditLog({
            event: "download_no_file",
            route: "material-download",
            method: "GET",
            status: 404,
            actor: user.sub,
            materialId: id,
          });
          return NextResponse.json({ error: "Material has no associated file" }, { status: 404 });
        }

        const downloadUrl = getIpfsUrl(cid);

        auditLog({
          event: "download_granted",
          route: "material-download",
          method: "GET",
          status: 200,
          actor: user.sub,
          walletAddress: userAddress,
          materialId: id,
        });

        return NextResponse.json(
          {
            success: true,
            downloadUrl,
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
      } catch (err) {
        auditLog({ event: "download_error", route: "material-download", method: "GET", status: 500, reason: err?.message });
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
      }
    }
  );
}
