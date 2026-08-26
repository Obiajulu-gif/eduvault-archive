/**
 * Account suspension checks.
 *
 * A suspension has to bite in two places, and missing either one makes it
 * cosmetic:
 *
 *   1. **The session.** A suspended user holds a JWT that is still
 *      cryptographically valid and unexpired, so signature verification alone
 *      keeps letting them in. Suspension state lives in the database, which
 *      means the check costs a lookup — `isSuspendedUser` is applied in
 *      `getFullUserFromCookie` and in the admin guard, both of which already
 *      load the user document, so no extra round trip is added.
 *   2. **Their content.** Hiding the creator's listings is a separate concern
 *      from blocking their login; a suspended creator's material must stop
 *      appearing in discovery even though nobody is authenticating as them.
 */

/**
 * True when a user document represents a suspended account.
 *
 * Reads both the boolean `isSuspended` flag and the pre-existing `status`
 * string. The suspend endpoint wrote only `status: "suspended"` before this
 * field existed, so accounts suspended earlier would otherwise silently regain
 * access the moment the check moved to the new flag.
 */
export function isSuspendedUser(user) {
  if (!user) return false;
  return user.isSuspended === true || user.status === "suspended";
}

/** Standard 403 body for a suspended caller. */
export function suspendedResponseBody(user) {
  return {
    error: "Account suspended",
    reason: user?.suspensionReason || null,
    suspendedAt: user?.suspendedAt || null,
  };
}

/** The `$set` payload applied when suspending an account. */
export function buildSuspensionPatch({ suspendedBy, reason, now = new Date() }) {
  const timestamp = now instanceof Date ? now : new Date(now);
  return {
    isSuspended: true,
    // `status` is kept in step for the existing dashboard queries that read it.
    status: "suspended",
    suspendedAt: timestamp.toISOString(),
    suspensionReason: reason || null,
    suspendedBy: suspendedBy || null,
    updatedAt: timestamp.toISOString(),
  };
}

/** The `$set` payload applied when reactivating an account. */
export function buildReactivationPatch({ reactivatedBy, now = new Date() }) {
  const timestamp = now instanceof Date ? now : new Date(now);
  return {
    isSuspended: false,
    status: "active",
    suspensionReason: null,
    reactivatedAt: timestamp.toISOString(),
    reactivatedBy: reactivatedBy || null,
    updatedAt: timestamp.toISOString(),
  };
}

/**
 * Propagate a creator's suspension onto their listings.
 *
 * The flag is denormalised onto each material so public discovery stays a
 * single indexed query. Resolving it per result would mean a lookup against
 * `users` on every catalog page.
 *
 * Matches on both `userAddress` and `creatorId` because materials in this
 * collection are attributed either way depending on the upload path.
 */
export async function setCreatorSuspendedFlag({ db, user, suspended }) {
  const identifiers = [user?.walletAddress, user?.walletAddressLower, user?._id?.toString()]
    .filter(Boolean)
    .map(String);

  if (identifiers.length === 0) return { matched: 0, modified: 0 };

  const result = await db.collection("materials").updateMany(
    { $or: [{ userAddress: { $in: identifiers } }, { creatorId: { $in: identifiers } }] },
    { $set: { creatorSuspended: suspended === true, updatedAt: new Date().toISOString() } }
  );

  return { matched: result.matchedCount ?? 0, modified: result.modifiedCount ?? 0 };
}
