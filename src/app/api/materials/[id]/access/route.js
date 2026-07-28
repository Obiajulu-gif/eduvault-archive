import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { authorizeMaterialAccess } from "@/lib/entitlement";

export const runtime = "nodejs";

// Maps a denied authorization decision's source/state onto this route's
// historical status vocabulary, so existing clients keep working while the
// decision itself now flows through the single entitlement policy boundary.
function statusForDeniedDecision(decision) {
  if (decision.state === "unavailable") return "unavailable";
  switch (decision.source) {
    case "not-found":
      return "not_purchased";
    case "purchases-db-incomplete":
      return "pending";
    case "buyer-suspended":
      return "suspended";
    default:
      return "revoked";
  }
}

export async function GET(request, { params }) {
  try {
    // Extract the wallet address (mocked via header for tests; normally via cookie/session)
    const walletAddress = request.headers.get('x-user-wallet');
    if (!walletAddress) {
      return NextResponse.json({ error: 'Unauthorized: Wallet connection required' }, { status: 401 });
    }

    const id = params.id;
    const db = await getDb();

    const material = await db.collection("materials").findOne({ _id: id });
    if (!material) {
      return NextResponse.json({ error: 'Material not found' }, { status: 404 });
    }

    const decision = await authorizeMaterialAccess({ db, material, buyerAddress: walletAddress });

    if (decision.allowed) {
      return NextResponse.json({
        status: 'available',
        accessGranted: true,
        downloadUrl: `https://eduvault.test/downloads/signed/${id}`
      }, { status: 200 });
    }

    return NextResponse.json({ status: statusForDeniedDecision(decision), accessGranted: false }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
