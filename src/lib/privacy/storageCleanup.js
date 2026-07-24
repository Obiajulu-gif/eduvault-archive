/**
 * Storage Cleanup — Pinata / IPFS unpin
 *
 * Unpins avatar and material files from Pinata for a user who is being deleted.
 *
 * Rules:
 *   - Avatar: always unpin (it's personal data)
 *   - Material files: only unpin if NO other buyer has an entitlement to
 *     that material (the CID is still in use).
 *   - If Pinata credentials are not configured, this step is skipped gracefully.
 */

import { getDb } from "@/lib/mongodb.js";

async function getPinataClient() {
  const { PinataSDK } = await import("pinata");
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return null;
  return new PinataSDK({ pinataJwt: jwt });
}

/**
 * Unpin IPFS objects owned by the user.
 * Returns a summary of what was unpinned / skipped.
 */
export async function unpinUserObjects(userId, wallet) {
  const db = await getDb();
  const pinata = await getPinataClient();

  const results = { avatar: null, materials: [] };

  // ── Avatar ────────────────────────────────────────────────────────────────
  if (wallet) {
    const user = await db.collection("users").findOne(
      { $or: [{ walletAddress: wallet }, { walletAddressLower: wallet.toLowerCase() }] },
      { projection: { avatarCid: 1 } }
    );
    if (user?.avatarCid) {
      results.avatar = await safeUnpin(pinata, user.avatarCid, "avatar");
    }
  }

  // ── Material files ────────────────────────────────────────────────────────
  if (wallet) {
    const materials = await db
      .collection("materials")
      .find(
        { $or: [{ userAddress: wallet }, { walletAddress: wallet }] },
        { projection: { _id: 1, cid: 1, title: 1 } }
      )
      .toArray();

    for (const mat of materials) {
      if (!mat.cid) continue;

      // Check if any other buyer holds an entitlement to this material
      const otherBuyers = await db.collection("entitlement_cache").countDocuments({
        materialId: String(mat._id),
        buyerAddress: { $ne: wallet },
        active: true,
      });

      if (otherBuyers > 0) {
        results.materials.push({ cid: mat.cid, status: "skipped_has_buyers", buyers: otherBuyers });
        continue;
      }

      const unpinResult = await safeUnpin(pinata, mat.cid, `material:${mat._id}`);
      results.materials.push({ cid: mat.cid, ...unpinResult });
    }
  }

  return results;
}

async function safeUnpin(pinata, cid, label) {
  if (!pinata) {
    return { status: "skipped_no_pinata_config", label };
  }
  try {
    await pinata.unpin([cid]);
    return { status: "unpinned", label };
  } catch (err) {
    // 404 = already unpinned; treat as success
    if (err?.status === 404 || err?.message?.includes("not found")) {
      return { status: "already_unpinned", label };
    }
    return { status: "error", label, error: err.message };
  }
}
