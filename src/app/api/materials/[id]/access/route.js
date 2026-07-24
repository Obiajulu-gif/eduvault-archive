import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getPurchaseStatus } from "@/lib/indexer";
import { resolveAuthenticatedWallet } from "@/lib/auth/walletIdentity";

export const runtime = "nodejs";

export async function GET(request, { params }) {
  try {
    const identity = await resolveAuthenticatedWallet(request);
    if (!identity.ok) {
      return NextResponse.json({ error: identity.error }, { status: identity.status });
    }
    const walletAddress = identity.walletAddress;

    const id = params.id;
    const db = await getDb();

    const material = await db.collection("materials").findOne({ _id: id });
    if (!material) {
      return NextResponse.json({ error: 'Material not found' }, { status: 404 });
    }

    // Call our mocked Soroban indexer to verify on-chain entitlement
    const status = await getPurchaseStatus(walletAddress, id);

    if (status === 'available') {
      return NextResponse.json({
        status: 'available',
        accessGranted: true,
        downloadUrl: `https://eduvault.test/downloads/signed/${id}`
      }, { status: 200 });
    }

    return NextResponse.json({ status, accessGranted: false }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
