import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { getAuthenticatedSession } from "@/lib/api/session";
import {
  createDownloadResponseHeaders,
  fetchProtectedMaterialStream,
  ProtectedDownloadError,
  resolveProtectedMaterialDownload,
} from "@/lib/api/protectedDownload";
import { getDb } from "@/lib/mongodb";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SIGNED_DOWNLOAD_TTL_SECONDS = 5 * 60;

function jsonError(error) {
  return NextResponse.json(
    {
      error: error.message,
      code: error.code,
      details: error.details || undefined,
    },
    { status: error.status }
  );
}

function buildSignedDownloadUrl(request, { materialId, buyerAddress }) {
  if (!process.env.JWT_SECRET) {
    throw new ProtectedDownloadError(503, "storage_failure", "Download signing is unavailable");
  }

  const token = jwt.sign(
    {
      typ: "material_download",
      materialId,
      buyerAddress,
    },
    process.env.JWT_SECRET,
    { expiresIn: `${SIGNED_DOWNLOAD_TTL_SECONDS}s` }
  );

  const url = new URL(request.url);
  url.searchParams.set("access", token);
  return url.toString();
}

async function verifySignedDownload(signedToken, materialId) {
  if (!process.env.JWT_SECRET) {
    throw new ProtectedDownloadError(503, "storage_failure", "Download signing is unavailable");
  }

  try {
    const payload = jwt.verify(signedToken, process.env.JWT_SECRET);
    if (payload?.typ !== "material_download" || payload?.materialId !== materialId) {
      throw new Error("Invalid signed download token");
    }
    return payload;
  } catch {
    throw new ProtectedDownloadError(403, "unauthorized", "Your download link is invalid or expired");
  }
}

export async function GET(request, { params }) {
  return withApiHardening(
    request,
    { route: "materials-download", rateLimit: { limit: 25, windowMs: 60_000 } },
    async () => {
      try {
        const db = await getDb();
        const materialId = params?.id;
        const accessToken = new URL(request.url).searchParams.get("access");

        if (accessToken) {
          const payload = await verifySignedDownload(accessToken, materialId);
          const materialQuery = [{ materialId }, { _id: materialId }];
          if (ObjectId.isValid(materialId)) {
            materialQuery.push({ _id: new ObjectId(materialId) });
          }
          const material = await db.collection("materials").findOne({
            $or: materialQuery,
          });

          if (!material) {
            throw new ProtectedDownloadError(404, "material_not_found", "Material not found");
          }

          const { response: storageResponse } = await fetchProtectedMaterialStream(material.fileUrl);
          const headers = new Headers(
            createDownloadResponseHeaders({
              material,
              contentType: storageResponse.headers.get("content-type"),
              fileName: material.title,
            })
          );

          const contentLength = storageResponse.headers.get("content-length");
          if (contentLength) {
            headers.set("Content-Length", contentLength);
          }

          auditLog({
            event: "material_download_streamed",
            route: "materials-download",
            method: "GET",
            status: 200,
            reason: payload.buyerAddress || "signed",
          });

          return new Response(storageResponse.body, {
            status: 200,
            headers,
          });
        }

        const session = await getAuthenticatedSession(request, { db });
        const access = await resolveProtectedMaterialDownload({
          db,
          materialId,
          buyerAddress: session?.walletAddress || null,
        });
        const downloadUrl = buildSignedDownloadUrl(request, {
          materialId,
          buyerAddress: session.walletAddress.toLowerCase(),
        });

        auditLog({
          event: "material_download_authorized",
          route: "materials-download",
          method: "GET",
          status: 200,
          reason: access.source,
        });

        return NextResponse.json(
          {
            success: true,
            downloadUrl,
            title: access.material.title,
          },
          { status: 200 }
        );
      } catch (error) {
        if (error instanceof ProtectedDownloadError) {
          auditLog({
            event: "material_download_denied",
            route: "materials-download",
            method: "GET",
            status: error.status,
            reason: error.code,
          });
          return jsonError(error);
        }

        auditLog({
          event: "material_download_failed",
          route: "materials-download",
          method: "GET",
          status: 500,
          reason: error.message,
        });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
