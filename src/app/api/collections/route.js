import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import jwt from "jsonswebtoken";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";

const COLLECTION_NAME = "collections";

/**
 * Unique index on `{ creatorId, idempotencyKey }` guarantees that concurrent
 * submissions of the same collection by the same creator collapse to a single
 * document. Requests without an idempotency key are not constrained (the
 * index is sparse), so the existing create-only behaviour is preserved.
 */
async function ensureCollectionIndexes(db) {
  await db
    .collection(COLLECTION_NAME)
    .createIndex(
      { creatorId: 1, idempotencyKey: 1 },
      { unique: true, sparse: true, name: "collections_creator_idempotency" }
    );
}

async function getUserFromCookie(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookieMatch = cookieHeader.match(/auth_token=([^;]+)/);
  const token = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload;
  } catch {
    return null;
  }
}

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "collections", rateLimit: { limit: 40, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        if (!user) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const payload = await request.json();
        const db = await getDb();
        await ensureCollectionIndexes(db);

        const idempotencyKey =
          payload.idempotencyKey || request.headers.get("x-idempotency-key") || null;

        if (idempotencyKey) {
          const existing = await db
            .collection(COLLECTION_NAME)
            .findOne({ creatorId: user.sub, idempotencyKey });
          if (existing) {
            return NextResponse.json({ ...existing, id: existing._id, duplicate: true }, { status: 200 });
          }
        }

        const now = new Date();
        const doc = {
          title: payload.title,
          description: payload.description,
          creatorId: user.sub,
          idempotencyKey,
          materialIds: payload.materialIds || [], // Array of material ObjectId strings or similar
          createdAt: now,
          updatedAt: now,
        };

        try {
          const result = await db.collection(COLLECTION_NAME).insertOne(doc);
          return NextResponse.json({ id: result.insertedId, ...doc, duplicate: false }, { status: 201 });
        } catch (err) {
          if (err && err.code === 11000 && idempotencyKey) {
            const existing = await db
              .collection(COLLECTION_NAME)
              .findOne({ creatorId: user.sub, idempotencyKey });
            if (existing) {
              return NextResponse.json({ ...existing, id: existing._id, duplicate: true }, { status: 200 });
            }
          }
          throw err;
        }
      } catch (err) {
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "collections", rateLimit: { limit: 80, windowMs: 60_000 } },
    async () => {
      try {
        const db = await getDb();
        const items = await db
          .collection(COLLECTION_NAME)
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        return NextResponse.json(items);
      } catch (err) {
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
