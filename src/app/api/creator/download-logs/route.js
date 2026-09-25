export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { auditLog } from "@/lib/api/audit";
import { errorResponse } from "@/lib/utils/errorResponse";

/**
 * Completed purchase statuses that represent a successful download entitlement.
 * "pending" / "indexing" are excluded — the buyer hasn't confirmed payment yet.
 */
const DOWNLOAD_STATUSES = ["confirmed", "settled", "completed"];

function parsePage(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function parseLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
}

/**
 * Derive a human-readable download status label from a purchase record.
 * Maps internal statuses to the three states shown in the UI.
 */
function deriveDownloadStatus(status) {
  if (["confirmed", "completed", "settled"].includes(status)) return "completed";
  if (["pending", "indexing"].includes(status)) return "pending";
  return "failed";
}

/**
 * Rough country estimation from Stellar account address prefix.
 * This is intentionally minimal — a full geo-IP lookup would require a
 * separate service. We surface "N/A" unless the data already exists on
 * the purchase record itself.
 */
function deriveBuyerCountry(purchase) {
  // If the purchase record already stores a country field, use it.
  if (purchase.buyerCountry && typeof purchase.buyerCountry === "string") {
    return purchase.buyerCountry;
  }
  // Otherwise surface N/A so the UI doesn't show misleading data.
  return "N/A";
}

/**
 * GET /api/creator/download-logs
 *
 * Returns a paginated list of download events for the authenticated creator.
 * Each event is derived from a confirmed purchase of one of their materials.
 *
 * Query params:
 *   page    (number, default 1)
 *   limit   (number, default 20, max 100)
 *   status  ("completed" | "pending" | "failed" | "all", default "all")
 *   search  (string — filters by material title prefix, optional)
 */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "creator-download-logs", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        if (!user) {
          return errorResponse({ status: 401, detail: "Unauthorized", instance: "/api/creator/download-logs" });
        }

        const creatorAddress = user.walletAddress || user.address || user.id;
        if (!creatorAddress) {
          return errorResponse({ status: 400, detail: "No wallet address on account", instance: "/api/creator/download-logs" });
        }

        const { searchParams } = new URL(request.url);
        const page = parsePage(searchParams.get("page"));
        const limit = parseLimit(searchParams.get("limit"));
        const statusFilter = searchParams.get("status") || "all";
        const searchTerm = (searchParams.get("search") || "").trim().slice(0, 100);

        const db = await getDb();

        // ── 1. Resolve creator's materials ─────────────────────────────────
        const materialProjection = { _id: 1, materialId: 1, title: 1, category: 1 };
        const creatorMaterials = await db
          .collection("materials")
          .find({ userAddress: creatorAddress }, { projection: materialProjection })
          .toArray();

        if (creatorMaterials.length === 0) {
          return NextResponse.json({
            page,
            limit,
            total: 0,
            totalPages: 0,
            hasMore: false,
            logs: [],
          });
        }

        // Build a materialId → title map for quick lookup.
        const materialMap = new Map();
        const materialIds = [];

        for (const mat of creatorMaterials) {
          const idStr = String(mat._id);
          const altId = mat.materialId ? String(mat.materialId) : null;
          const title = mat.title || "Untitled material";
          const category = mat.category || null;

          materialMap.set(idStr, { title, category });
          materialIds.push(idStr);

          if (altId && altId !== idStr) {
            materialMap.set(altId, { title, category });
            materialIds.push(altId);
          }
        }

        // Apply optional title search — filter material IDs first.
        let filteredMaterialIds = materialIds;
        if (searchTerm) {
          const lower = searchTerm.toLowerCase();
          filteredMaterialIds = materialIds.filter((id) => {
            const entry = materialMap.get(id);
            return entry?.title?.toLowerCase().includes(lower);
          });
          if (filteredMaterialIds.length === 0) {
            return NextResponse.json({
              page,
              limit,
              total: 0,
              totalPages: 0,
              hasMore: false,
              logs: [],
            });
          }
        }

        // ── 2. Build purchase filter ────────────────────────────────────────
        const purchaseStatusFilter =
          statusFilter === "all"
            ? { $in: DOWNLOAD_STATUSES }
            : statusFilter === "completed"
              ? { $in: ["confirmed", "completed", "settled"] }
              : statusFilter === "pending"
                ? { $in: ["pending", "indexing"] }
                : { $nin: [...DOWNLOAD_STATUSES, "pending", "indexing"] };

        const purchaseFilter = {
          materialId: { $in: filteredMaterialIds },
          status: purchaseStatusFilter,
        };

        // ── 3. Count + paginate ─────────────────────────────────────────────
        const skip = (page - 1) * limit;
        const [total, purchaseDocs] = await Promise.all([
          db.collection("purchases").countDocuments(purchaseFilter),
          db
            .collection("purchases")
            .find(purchaseFilter, {
              projection: {
                _id: 1,
                materialId: 1,
                buyerAddress: 1,
                buyerCountry: 1,
                status: 1,
                transactionHash: 1,
                purchasedAt: 1,
                confirmedAt: 1,
                createdAt: 1,
                amount: 1,
                asset: 1,
              },
            })
            .sort({ purchasedAt: -1, confirmedAt: -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),
        ]);

        // ── 4. Shape response records ───────────────────────────────────────
        const logs = purchaseDocs.map((purchase) => {
          const matId = String(purchase.materialId);
          const matInfo = materialMap.get(matId) ?? { title: "Unknown material", category: null };

          return {
            id: String(purchase._id),
            date:
              purchase.purchasedAt ?? purchase.confirmedAt ?? purchase.createdAt ?? null,
            materialId: matId,
            materialName: matInfo.title,
            category: matInfo.category,
            buyerAddress: purchase.buyerAddress || "Unknown",
            buyerCountry: deriveBuyerCountry(purchase),
            downloadStatus: deriveDownloadStatus(purchase.status),
            rawStatus: purchase.status,
            transactionHash: purchase.transactionHash || null,
            amount: purchase.amount ?? null,
            asset: purchase.asset || "XLM",
          };
        });

        const totalPages = Math.ceil(total / limit);

        auditLog({
          event: "download_logs_fetched",
          route: "creator-download-logs",
          method: "GET",
          status: 200,
          actor: user.sub,
        });

        return NextResponse.json({
          page,
          limit,
          total,
          totalPages,
          hasMore: page < totalPages,
          logs,
        });
      } catch (error) {
        auditLog({
          event: "download_logs_error",
          route: "creator-download-logs",
          method: "GET",
          status: 500,
          reason: error.message,
        });
        return errorResponse({ status: 500, detail: "Server error", instance: "/api/creator/download-logs" });
      }
    }
  );
}
