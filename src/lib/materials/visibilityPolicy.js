import { hasPermission } from "@/lib/auth/permissions.js";

export function canViewHiddenMaterial({ viewer, ownerWallet }) {
  if (!viewer) return false;
  if (hasPermission(viewer, "*") || viewer.role === "admin") return true;
  const viewerWallet = String(viewer.walletAddress || viewer.address || "").toLowerCase();
  const owner = String(ownerWallet || "").toLowerCase();
  return Boolean(viewerWallet && owner && viewerWallet === owner);
}

export function buildMaterialVisibilityFilter({ viewer, ownerWallet = null, includeHidden = false } = {}) {
  if (includeHidden && canViewHiddenMaterial({ viewer, ownerWallet })) {
    return ownerWallet ? { userAddress: ownerWallet } : {};
  }
  return {
    $or: [
      { visibility: "public" },
      { visibility: { $exists: false } },
      { isHidden: { $ne: true }, hidden: { $ne: true } },
    ],
  };
}

export function assertCanChangeVisibility({ viewer, ownerWallet }) {
  if (canViewHiddenMaterial({ viewer, ownerWallet })) return;
  const err = new Error("Forbidden: cannot change material visibility");
  err.status = 403;
  throw err;
}
