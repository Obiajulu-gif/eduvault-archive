/**
 * Privacy-preserving wallet recovery state machine.
 *
 * It never stores a recovery secret or email value. Persistence layers should
 * store only a normalized contact hash, request metadata, and audit events.
 */

export const RECOVERY_DELAY_MS = 72 * 60 * 60 * 1000;
export const RECOVERY_STATES = Object.freeze([
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);

export function createRecoveryRequest({
  profileId,
  oldWallet,
  newWallet,
  verifiedContactHash,
  now = Date.now(),
}) {
  if (!profileId || !oldWallet || !newWallet || !verifiedContactHash) {
    throw new Error("recovery_requirements_missing");
  }
  if (oldWallet === newWallet) throw new Error("recovery_wallet_unchanged");
  return {
    version: 1,
    profileId,
    oldWallet,
    newWallet,
    verifiedContactHash,
    state: "pending",
    requestedAt: now,
    eligibleAt: now + RECOVERY_DELAY_MS,
    approvedAt: null,
    audit: [{ action: "requested", at: now }],
  };
}

export function approveRecovery(request, { now = Date.now(), reviewerId } = {}) {
  if (request.state !== "pending") throw new Error("recovery_not_pending");
  if (!reviewerId) throw new Error("recovery_reviewer_required");
  if (now < request.eligibleAt) throw new Error("recovery_delay_active");
  return {
    ...request,
    state: "approved",
    approvedAt: now,
    audit: [...request.audit, { action: "approved", at: now, reviewerId }],
  };
}

export function cancelRecovery(request, { now = Date.now(), actor } = {}) {
  if (request.state !== "pending") throw new Error("recovery_not_pending");
  return {
    ...request,
    state: "cancelled",
    audit: [...request.audit, { action: "cancelled", at: now, actor: actor || "system" }],
  };
}
