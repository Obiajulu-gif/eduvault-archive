import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { appendAuditRecord } from "../backend/auditLedger.js";
import { COLLECTIONS } from "../backend/schemaContracts.js";
import { SECURITY_EVENT_TYPES, revokeUserSessions } from "./sessionRevocation.js";

/**
 * Deterministic external identity linking and unlinking (#880).
 *
 * An EduVault account signs in with its primary wallet. It may additionally
 * link external identities (other Stellar accounts it controls) after proving
 * control of them. Link state lives in `identity_links`:
 *
 *   (none) ──challenge──▶ pending challenge ──valid proof──▶ linked ──unlink──▶ unlinked
 *                                └─ bad proof / expired ─▶ failed (challenge burned)
 *
 * Guarantees:
 * - **Proof of control.** The identity's key signs a server-issued message
 *   (SEP-53 "Stellar Signed Message", as produced by Freighter/Wallets Kit
 *   `signMessage`). The message names the EduVault account, so a signature
 *   can only ever link to the account that requested it.
 * - **Linked once.** A partial unique index on `(provider, subjectKey)` among
 *   `linked` rows means one identity maps to at most one account, even under
 *   concurrent confirms. Another account's primary wallet can't be linked either.
 * - **Single-use challenges.** A challenge is atomically consumed before its
 *   proof is checked, so a failed or replayed proof cannot be retried.
 * - **No access left behind.** Unlinking flips the row to `unlinked` (history
 *   is kept, the unique slot is freed for relinking), burns any pending
 *   challenge for that identity, and revokes every other session of the
 *   account so nothing established through the identity survives.
 * - **Audited.** Every link, failed verification, unlink and denied unlink
 *   is appended to the tamper-evident audit ledger.
 */

export const IDENTITY_LINK_STATUS = Object.freeze({ LINKED: "linked", UNLINKED: "unlinked" });
export const IDENTITY_CHALLENGE_STATUS = Object.freeze({ PENDING: "pending", CONSUMED: "consumed", FAILED: "failed" });
export const IDENTITY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

// SEP-53: signature = ed25519(sha256("Stellar Signed Message:\n" + message)).
const SEP53_PREFIX = "Stellar Signed Message:\n";
const LINK_MESSAGE_DOMAIN = "EduVault identity link";

export class IdentityLinkError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "IdentityLinkError";
    this.code = code;
    this.status = status;
  }
}

/** Canonical SEP-53 digest of a UTF-8 message. */
export function sep53MessageHash(message) {
  return crypto.createHash("sha256").update(SEP53_PREFIX, "utf8").update(message, "utf8").digest();
}

function decodeSignature(signature) {
  const text = String(signature || "").trim();
  const bytes = /^[0-9a-f]{128}$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  return bytes.length === 64 ? bytes : null;
}

/** Verify a SEP-53 signature (base64, or hex as in the SEP-53 test vectors). */
export function verifySep53Signature({ publicKey, message, signature }) {
  const bytes = decodeSignature(signature);
  if (!bytes) return false;
  try {
    return Keypair.fromPublicKey(publicKey).verify(sep53MessageHash(message), bytes);
  } catch {
    return false;
  }
}

/**
 * Link policy per provider. `normalizeSubject` returns the canonical subject
 * key or null when the value is not a valid identity for the provider.
 */
export const IDENTITY_PROVIDERS = Object.freeze({
  stellar: Object.freeze({
    maxLinksPerUser: 5,
    verificationMethod: "sep53",
    normalizeSubject(subject) {
      const key = String(subject || "").trim().toUpperCase();
      return StrKey.isValidEd25519PublicKey(key) ? key : null;
    },
    verifyProof: ({ subjectKey, message, signature }) =>
      verifySep53Signature({ publicKey: subjectKey, message, signature }),
  }),
});

function userIdOf(user) {
  const id = user?._id ?? user?.sub;
  if (!id) throw new IdentityLinkError("Authenticated user required", "AUTH_REQUIRED", 401);
  return String(id);
}

function resolveProvider(provider) {
  const policy = IDENTITY_PROVIDERS[provider];
  if (!policy) throw new IdentityLinkError("Unsupported identity provider", "UNSUPPORTED_PROVIDER", 400);
  return policy;
}

function buildLinkMessage({ userId, provider, subjectKey, nonce, expiresAt }) {
  return [
    LINK_MESSAGE_DOMAIN,
    `Account: ${userId}`,
    `Provider: ${provider}`,
    `Identity: ${subjectKey}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join("\n");
}

async function isPrimaryWalletOfAnotherUser(db, userId, subjectKey) {
  const owner = await db.collection(COLLECTIONS.users).findOne(
    { $or: [{ walletAddress: subjectKey }, { walletAddressLower: subjectKey.toLowerCase() }] },
    { projection: { _id: 1 } },
  );
  return Boolean(owner) && String(owner._id) !== userId;
}

/**
 * Step 1: issue a single-use challenge the identity's key must sign.
 * @returns {Promise<{challengeId: string, provider: string, subject: string, message: string, expiresAt: string}>}
 */
export async function createIdentityLinkChallenge({ db, user, provider, subject, now = new Date() }) {
  const userId = userIdOf(user);
  const policy = resolveProvider(provider);
  const subjectKey = policy.normalizeSubject(subject);
  if (!subjectKey) throw new IdentityLinkError("Invalid identity for provider", "INVALID_SUBJECT", 400);

  if (policy.normalizeSubject(user.walletAddress) === subjectKey) {
    throw new IdentityLinkError("This is already the account's primary wallet", "PRIMARY_IDENTITY", 409);
  }

  const links = db.collection(COLLECTIONS.identityLinks);
  const existing = await links.findOne(
    { provider, subjectKey, status: IDENTITY_LINK_STATUS.LINKED },
    { projection: { userId: 1 } },
  );
  if (existing?.userId === userId) {
    throw new IdentityLinkError("Identity is already linked to this account", "DUPLICATE_LINK", 409);
  }
  // Same response whether a link or a primary wallet owns it: never reveal which account.
  if (existing || (await isPrimaryWalletOfAnotherUser(db, userId, subjectKey))) {
    throw new IdentityLinkError("Identity is linked to another account", "IDENTITY_ALREADY_LINKED", 409);
  }

  const activeCount = await links.countDocuments({ userId, provider, status: IDENTITY_LINK_STATUS.LINKED });
  if (activeCount >= policy.maxLinksPerUser) {
    throw new IdentityLinkError("Identity link limit reached for provider", "LINK_LIMIT_REACHED", 409);
  }

  const challengeId = crypto.randomBytes(16).toString("hex");
  const expiresAt = new Date(now.getTime() + IDENTITY_CHALLENGE_TTL_MS);
  const message = buildLinkMessage({ userId, provider, subjectKey, nonce: crypto.randomBytes(16).toString("hex"), expiresAt });

  await db.collection(COLLECTIONS.identityLinkChallenges).insertOne({
    challengeId,
    userId,
    provider,
    subjectKey,
    message,
    status: IDENTITY_CHALLENGE_STATUS.PENDING,
    createdAt: now,
    expiresAt,
  });

  return { challengeId, provider, subject: subjectKey, message, expiresAt: expiresAt.toISOString() };
}

/**
 * Step 2: verify the signed challenge and create the link.
 * @returns {Promise<{linkId: string, provider: string, subject: string, linkedAt: string}>}
 */
export async function confirmIdentityLink({ db, user, challengeId, signature, now = new Date(), audit = appendAuditRecord }) {
  const userId = userIdOf(user);
  const challenges = db.collection(COLLECTIONS.identityLinkChallenges);

  // Consume first: whatever the proof's outcome, this challenge is spent.
  const challenge = await challenges.findOneAndUpdate(
    { challengeId: String(challengeId || ""), userId, status: IDENTITY_CHALLENGE_STATUS.PENDING, expiresAt: { $gt: now } },
    { $set: { status: IDENTITY_CHALLENGE_STATUS.CONSUMED, consumedAt: now } },
    { returnDocument: "after" },
  );
  if (!challenge) {
    throw new IdentityLinkError("Challenge not found, expired or already used", "CHALLENGE_INVALID", 409);
  }

  const policy = resolveProvider(challenge.provider);
  const target = { type: "user", id: userId };

  if (!policy.verifyProof({ subjectKey: challenge.subjectKey, message: challenge.message, signature })) {
    await challenges.updateOne({ challengeId: challenge.challengeId }, { $set: { status: IDENTITY_CHALLENGE_STATUS.FAILED } });
    await audit({
      db,
      operationId: `identity.link_failed:${challenge.challengeId}`,
      actor: userId,
      action: "identity.link_failed",
      target,
      result: { status: "rejected", provider: challenge.provider, reason: "verification_failed" },
    });
    throw new IdentityLinkError("Identity verification failed", "VERIFICATION_FAILED", 422);
  }

  const links = db.collection(COLLECTIONS.identityLinks);
  const activeCount = await links.countDocuments({ userId, provider: challenge.provider, status: IDENTITY_LINK_STATUS.LINKED });
  if (activeCount >= policy.maxLinksPerUser) {
    throw new IdentityLinkError("Identity link limit reached for provider", "LINK_LIMIT_REACHED", 409);
  }

  const link = {
    linkId: crypto.randomUUID(),
    userId,
    provider: challenge.provider,
    subjectKey: challenge.subjectKey,
    status: IDENTITY_LINK_STATUS.LINKED,
    linkedAt: now,
    verification: { method: policy.verificationMethod, challengeId: challenge.challengeId, verifiedAt: now },
  };

  try {
    await links.insertOne(link);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    throw new IdentityLinkError("Identity is linked to another account", "IDENTITY_ALREADY_LINKED", 409);
  }

  await audit({
    db,
    operationId: `identity.linked:${link.linkId}`,
    actor: userId,
    action: "identity.linked",
    target,
    result: { status: IDENTITY_LINK_STATUS.LINKED, provider: link.provider, linkId: link.linkId },
  });

  return { linkId: link.linkId, provider: link.provider, subject: link.subjectKey, linkedAt: now.toISOString() };
}

function sessionUserKey(userId) {
  return ObjectId.isValid(userId) && String(new ObjectId(userId)) === userId ? new ObjectId(userId) : userId;
}

/**
 * Unlink an identity owned by `user`. A link owned by another account is
 * reported as not found (no existence oracle) and the attempt is audited.
 * @returns {Promise<{linkId: string, status: string, unlinkedAt: string, sessionsRevoked: boolean}>}
 */
export async function unlinkIdentity({
  db,
  user,
  linkId,
  sessionFamilyId = null,
  now = new Date(),
  audit = appendAuditRecord,
  revokeSessions = revokeUserSessions,
}) {
  const userId = userIdOf(user);
  const links = db.collection(COLLECTIONS.identityLinks);

  const unlinked = await links.findOneAndUpdate(
    { linkId: String(linkId || ""), userId, status: IDENTITY_LINK_STATUS.LINKED },
    { $set: { status: IDENTITY_LINK_STATUS.UNLINKED, unlinkedAt: now, unlinkedBy: userId } },
    { returnDocument: "after" },
  );

  if (!unlinked) {
    const foreign = await links.findOne({ linkId: String(linkId || ""), userId: { $ne: userId } }, { projection: { _id: 1 } });
    if (foreign) {
      await audit({
        db,
        operationId: `identity.unlink_denied:${linkId}:${userId}:${now.getTime()}`,
        actor: userId,
        action: "identity.unlink_denied",
        target: { type: "identity_link", id: String(linkId) },
        result: { status: "denied", reason: "not_owner" },
      });
    }
    throw new IdentityLinkError("Identity link not found", "LINK_NOT_FOUND", 404);
  }

  // A challenge issued before the unlink must not silently relink the identity.
  await db.collection(COLLECTIONS.identityLinkChallenges).updateMany(
    { userId, provider: unlinked.provider, subjectKey: unlinked.subjectKey, status: IDENTITY_CHALLENGE_STATUS.PENDING },
    { $set: { status: IDENTITY_CHALLENGE_STATUS.FAILED } },
  );

  try {
    await revokeSessions(db, sessionUserKey(userId), {
      eventType: SECURITY_EVENT_TYPES.CREDENTIALS_CHANGED,
      reason: "External identity unlinked",
      actor: userId,
      preserveFamilyId: sessionFamilyId,
      now,
    });
  } catch (error) {
    // Never report an unlink whose sessions survived: restore it so a retry re-runs revocation.
    await links.updateOne(
      { linkId: unlinked.linkId, status: IDENTITY_LINK_STATUS.UNLINKED },
      { $set: { status: IDENTITY_LINK_STATUS.LINKED }, $unset: { unlinkedAt: "", unlinkedBy: "" } },
    );
    throw error;
  }

  await audit({
    db,
    operationId: `identity.unlinked:${unlinked.linkId}`,
    actor: userId,
    action: "identity.unlinked",
    target: { type: "user", id: userId },
    result: { status: IDENTITY_LINK_STATUS.UNLINKED, provider: unlinked.provider, linkId: unlinked.linkId },
  });

  return { linkId: unlinked.linkId, status: IDENTITY_LINK_STATUS.UNLINKED, unlinkedAt: now.toISOString(), sessionsRevoked: true };
}

/** Active links of `user`, newest first. */
export async function listIdentityLinks({ db, user }) {
  const userId = userIdOf(user);
  const rows = await db
    .collection(COLLECTIONS.identityLinks)
    .find({ userId, status: IDENTITY_LINK_STATUS.LINKED }, { projection: { _id: 0, linkId: 1, provider: 1, subjectKey: 1, linkedAt: 1 } })
    .sort({ linkedAt: -1 })
    .toArray();
  return rows.map((row) => ({ linkId: row.linkId, provider: row.provider, subject: row.subjectKey, linkedAt: row.linkedAt.toISOString() }));
}

/**
 * The only read path for authorization decisions: resolves an identity to its
 * account while the link is active, and to null once it has been unlinked.
 */
export async function findLinkedAccountId({ db, provider, subject }) {
  const policy = IDENTITY_PROVIDERS[provider];
  const subjectKey = policy?.normalizeSubject(subject);
  if (!subjectKey) return null;
  const link = await db
    .collection(COLLECTIONS.identityLinks)
    .findOne({ provider, subjectKey, status: IDENTITY_LINK_STATUS.LINKED }, { projection: { userId: 1 } });
  return link?.userId ?? null;
}
