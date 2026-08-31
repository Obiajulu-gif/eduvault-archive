// Resolves: Implement the endpoint to retrieve and paginate the list of available educational materials.

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { parsePagination } from "@/lib/api/validation";
import { applyOwnershipRanking, buildMarketplaceDiscoveryQuery, buildMarketplaceSort } from "@/lib/backend/marketplaceDiscovery";
import { MATERIAL_SEARCH_COLLECTION } from "@/lib/backend/materialSearchProjection";
import { getOwnedMaterialIds } from "@/lib/entitlement";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { cacheGet, cacheSet } from "@/lib/cache/redis";

export const runtime = "nodejs";

function sanitizeMaterial(doc) {
  if (!doc) return doc;
  const { storageKey, fileUrl, metadataUrl, ...safe } = doc;
  const averageScore = Number(safe.averageScore ?? safe.rating ?? 0) || 0;
  const feedbackCount = Number(safe.feedbackCount ?? safe.reviewsCount ?? 0) || 0;

  return {
    ...safe,
    averageScore,
    rating: averageScore,
    feedbackCount,
    reviewsCount: feedbackCount,
    userAddress: safe.userAddress ?? safe.ownerAddress ?? null,
  };
}

// GET /api/market-materials
// Returns all public materials across users, newest first
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "market-materials", rateLimit: { limit: 120, windowMs: 60_000 } },
    async () => {
  try {
    const db = await getDb();

    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    // 1️⃣ Handle single material fetch
    if (id) {
      if (!ObjectId.isValid(id)) {
        return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
      }
      
      const item = await db.collection("materials").findOne({
        _id: new ObjectId(id),
        visibility: "public",
        moderationStatus: { $ne: "suspended" },
        // Same catalog rules as the list query: retired listings and listings
        // by a suspended creator are not publicly reachable. Buyers who
        // already own the material reach it through the download route, which
        // authorizes on entitlement and deliberately skips these filters.
        isDeleted: { $ne: true },
        archived: { $ne: true },
        creatorSuspended: { $ne: true },
        legalTombstone: { $ne: true },
        legalRemovedAt: { $exists: false },
      });

      if (!item) {
        return NextResponse.json({ error: "Material not found" }, { status: 404 });
      }

      return NextResponse.json(sanitizeMaterial(item));
    }

    // 2️⃣ Handle list fetch
    const pagination = parsePagination(url.searchParams);
    const { pageSize, paginationType } = pagination;

    // Entitlement-aware ranking (#707): when the viewing wallet is supplied,
    // results are personalized (owned materials marked/reranked), so the
    // shared anonymous-browse cache is bypassed for this request.
    const buyerAddress = (url.searchParams.get("buyerAddress") || "").trim() || null;

    const cacheKey = `market-materials:${url.searchParams.toString()}`;
    const cached = buyerAddress ? null : await cacheGet(cacheKey);
    if (cached) {
      return NextResponse.json(cached, { status: 200 });
    }

    const query = buildMarketplaceDiscoveryQuery(url.searchParams);
    const sort = buildMarketplaceSort(url.searchParams.get("sortBy"));

    let items;
    let hasNextPage = false;
    let nextCursor = null;
    let totalPages = null;
    let total = null;

    if (paginationType === "cursor") {
      // Cursor-based pagination
      const { cursor } = pagination;
      
      // Add cursor filter to query if provided
      if (cursor) {
        try {
          // Decode the cursor - it contains the _id and sort field values
          const cursorData = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
          
          // Build cursor query based on sort field
          if (sort.createdAt) {
            // For createdAt sort (newest first), we want documents older than cursor
            if (sort.createdAt === -1) {
              query.$and = query.$and || [];
              query.$and.push({
                $or: [
                  { createdAt: { $lt: new Date(cursorData.createdAt) } },
                  { 
                    createdAt: new Date(cursorData.createdAt),
                    _id: { $lt: new ObjectId(cursorData._id) }
                  }
                ]
              });
            }
          } else if (sort.price) {
            // For price sort, handle price + _id compound cursor
            const priceOperator = sort.price === 1 ? '$gt' : '$lt';
            const idOperator = sort.price === 1 ? '$gt' : '$lt';
            
            query.$and = query.$and || [];
            query.$and.push({
              $or: [
                { price: { [priceOperator]: cursorData.price } },
                { 
                  price: cursorData.price,
                  _id: { [idOperator]: new ObjectId(cursorData._id) }
                }
              ]
            });
          } else if (sort.rating || sort.likes) {
            // For rating/popularity sort
            const sortField = sort.rating ? 'rating' : 'likes';
            const sortOrder = sort[sortField];
            const operator = sortOrder === -1 ? '$lt' : '$gt';
            const idOperator = sortOrder === -1 ? '$lt' : '$gt';
            
            query.$and = query.$and || [];
            query.$and.push({
              $or: [
                { [sortField]: { [operator]: cursorData[sortField] } },
                { 
                  [sortField]: cursorData[sortField],
                  _id: { [idOperator]: new ObjectId(cursorData._id) }
                }
              ]
            });
          }
        } catch (e) {
          // Invalid cursor - ignore and start from beginning
          console.warn('Invalid cursor provided:', cursor);
        }
      }

      // Fetch pageSize + 1 to determine if there's a next page
      items = await db
        .collection(MATERIAL_SEARCH_COLLECTION)
        .find(query)
        .sort(sort)
        .limit(pageSize + 1)
        .toArray();

      // Check if there's a next page
      hasNextPage = items.length > pageSize;
      if (hasNextPage) {
        items = items.slice(0, pageSize); // Remove the extra item
      }

      // Generate next cursor if there are more items
      if (hasNextPage && items.length > 0) {
        const lastItem = items[items.length - 1];
        const cursorData = { _id: lastItem._id.toString() };
        
        // Add sort field to cursor
        if (sort.createdAt) {
          cursorData.createdAt = lastItem.createdAt.toISOString();
        } else if (sort.price) {
          cursorData.price = lastItem.price;
        } else if (sort.rating) {
          cursorData.rating = lastItem.rating || lastItem.averageScore || 0;
        } else if (sort.likes) {
          cursorData.likes = lastItem.likes || 0;
        }
        
        nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
      }
    } else {
      // Legacy offset-based pagination
      const { page } = pagination;
      
      total = await db.collection(MATERIAL_SEARCH_COLLECTION).countDocuments(query);
      items = await db
        .collection(MATERIAL_SEARCH_COLLECTION)
        .find(query)
        .sort(sort)
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();

      totalPages = Math.max(1, Math.ceil(total / pageSize));
    }

    let normalized = items.map(sanitizeMaterial);

    // Entitlement-aware ranking (#707): mark and rerank this page's results
    // by whether the viewing wallet already owns each material. Best-effort
    // — a lookup failure just leaves the page unranked, never blocks it.
    if (buyerAddress) {
      const materialIds = normalized
        .map((item) => String(item.materialId ?? item._id ?? ""))
        .filter(Boolean);
      const ownedIds = await getOwnedMaterialIds({ db, buyerAddress, materialIds });
      normalized = applyOwnershipRanking(normalized, ownedIds);
    }

    const payload = paginationType === "cursor"
      ? {
          items: normalized,
          pageSize,
          hasNextPage,
          nextCursor,
          paginationType: "cursor"
        }
      : {
          items: normalized,
          page: pagination.page,
          pageSize,
          total,
          totalPages,
          paginationType: "offset"
        };

    if (!buyerAddress) {
      await cacheSet(cacheKey, payload, 600);
    }

    return NextResponse.json(payload, { status: 200 });
  } catch (err) {
    if (err.name === "ValidationError") throw err;
    auditLog({ event: "market_materials_failed", route: "market-materials", method: "GET", status: 500, reason: err.message });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
    }
  );
}
