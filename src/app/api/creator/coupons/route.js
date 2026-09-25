import { NextResponse } from "next/server";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function creatorId(user) {
  return user?.walletAddress || user?.address || user?.id || user?.sub;
}

function error(message, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function validateCoupon(payload) {
  const code = String(payload.code || "").trim().toUpperCase();
  const discountPercent = Number(payload.discountPercent);
  const maxRedemptions = Number(payload.maxRedemptions);
  const expiresAt = new Date(`${payload.expiresAt}T23:59:59.999Z`);
  const tomorrow = new Date();
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return { error: "Code must contain 3–32 letters, numbers, hyphens, or underscores." };
  if (!Number.isInteger(discountPercent) || discountPercent < 1 || discountPercent > 100) return { error: "Discount must be a whole number from 1 to 100." };
  if (Number.isNaN(expiresAt.getTime()) || expiresAt < tomorrow) return { error: "Expiration must be after today." };
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) return { error: "Maximum redemptions must be at least 1." };
  return { coupon: { code, discountPercent, maxRedemptions, expiresAt, redemptions: 0 } };
}

export async function GET(request) {
  return withApiHardening(request, { route: "creator-coupons", rateLimit: { limit: 60, windowMs: 60_000 } }, async () => {
    const ownerId = creatorId(await getUserFromCookie(request));
    if (!ownerId) return error("Authentication required.", 401);
    try {
      const coupons = await (await getDb()).collection("creatorCoupons").find({ ownerId }).sort({ createdAt: -1 }).toArray();
      return NextResponse.json({ coupons: coupons.map(({ _id, ...coupon }) => ({ id: String(_id), ...coupon })) });
    } catch {
      return error("Unable to load coupons.", 500);
    }
  });
}

export async function POST(request) {
  return withApiHardening(request, { route: "creator-coupons", rateLimit: { limit: 20, windowMs: 60_000 } }, async () => {
    const ownerId = creatorId(await getUserFromCookie(request));
    if (!ownerId) return error("Authentication required.", 401);
    let payload;
    try { payload = await request.json(); } catch { return error("Invalid JSON body."); }
    const result = validateCoupon(payload);
    if (result.error) return error(result.error);
    try {
      const collection = (await getDb()).collection("creatorCoupons");
      if (await collection.findOne({ ownerId, code: result.coupon.code })) return error("You already have a coupon with this code.", 409);
      const now = new Date();
      const document = { ...result.coupon, ownerId, createdAt: now, updatedAt: now };
      const inserted = await collection.insertOne(document);
      return NextResponse.json({ coupon: { id: String(inserted.insertedId), ...document } }, { status: 201 });
    } catch {
      return error("Unable to create the coupon.", 500);
    }
  });
}
