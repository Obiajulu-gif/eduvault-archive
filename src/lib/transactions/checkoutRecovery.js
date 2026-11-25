export const CHECKOUT_RECOVERY_KEY = "eduvault.checkout.recovery.v1";
export const CHECKOUT_RECOVERY_TTL_MS = 30 * 60 * 1000;
export const CHECKOUT_RECOVERY_VERSION = 1;

/**
 * Where an interrupted wallet signing attempt stopped. The stage is the only
 * thing the recovery UX needs to decide whether paying again is safe.
 */
export const SigningStage = Object.freeze({
  AwaitingSignature: "awaiting_signature",
  Signed: "signed",
  Submitted: "submitted",
  Confirmed: "confirmed",
});

/** What the frontend should offer after a reload or a closed wallet. */
export const RecoveryAction = Object.freeze({
  None: "none",
  Resume: "resume",
  Retry: "retry",
  Verify: "verify",
  Discard: "discard",
});

const SIGNING_STAGES = Object.freeze(Object.values(SigningStage));

const ACTION_LABELS = Object.freeze({
  [RecoveryAction.Resume]: "Resume checkout",
  [RecoveryAction.Retry]: "Retry submission",
  [RecoveryAction.Verify]: "Check payment",
  [RecoveryAction.Discard]: "Dismiss",
  [RecoveryAction.None]: "Dismiss",
});

const INTENT_STRING_FIELDS = Object.freeze([
  "materialId",
  "title",
  "amount",
  "asset",
  "quoteId",
  "txHash",
  "signedXdr",
  "email",
]);

function isValidItem(item) {
  return (
    item &&
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.title === "string"
  );
}

function normalizeStringFields(source) {
  return INTENT_STRING_FIELDS.reduce((fields, key) => {
    if (typeof source[key] === "string" && source[key].length > 0) {
      fields[key] = source[key];
    }
    return fields;
  }, {});
}

function normalizeCompletedItemIds(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((id) => typeof id === "string" && id.length > 0);
}

function shortAddress(address) {
  if (typeof address !== "string" || address.length <= 12) return address || "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * The storage the recovery record lives in. A caller may inject one (tests, the
 * hook); otherwise the tab's sessionStorage is used, and null means the page
 * has no storage to recover from at all (server render, storage disabled).
 */
export function resolveCheckoutStorage(target) {
  if (target) return target;
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage || null;
  } catch {
    return null;
  }
}

function normalizeIntent(intent, now) {
  if (intent === undefined || intent === null) return null;
  if (typeof intent !== "object") {
    throw new Error("Invalid checkout recovery details");
  }

  const stage = intent.stage === undefined ? SigningStage.AwaitingSignature : intent.stage;
  if (!SIGNING_STAGES.includes(stage)) {
    throw new Error("Invalid checkout recovery stage");
  }

  // txHash is part of the public decision shape even when no transaction has
  // been submitted, so it is the only string field with an explicit null.
  const txHash =
    typeof intent.txHash === "string" && intent.txHash.length > 0 ? intent.txHash : null;
  const fields = normalizeStringFields(intent);
  delete fields.txHash;

  return {
    stage,
    txHash,
    ...fields,
    completedItemIds: normalizeCompletedItemIds(intent.completedItemIds),
    updatedAt: now,
  };
}

function isValidIntent(intent) {
  if (intent === null || intent === undefined) return true;
  if (typeof intent !== "object" || Array.isArray(intent)) return false;
  if (!SIGNING_STAGES.includes(intent.stage)) return false;
  for (const key of INTENT_STRING_FIELDS) {
    if (intent[key] !== undefined && intent[key] !== null && typeof intent[key] !== "string") {
      return false;
    }
  }
  if (
    intent.completedItemIds !== undefined &&
    (!Array.isArray(intent.completedItemIds) ||
      !intent.completedItemIds.every((id) => typeof id === "string"))
  ) {
    return false;
  }
  if (intent.updatedAt !== undefined && intent.updatedAt !== null && !Number.isFinite(intent.updatedAt)) {
    return false;
  }
  return true;
}

/** Only known, short-lived checkout fields may be written by a stage update. */
function normalizeStagePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return {};
  const normalized = normalizeStringFields(patch);
  const completed = normalizeCompletedItemIds(patch.completedItemIds);
  if (completed.length > 0 || Array.isArray(patch.completedItemIds)) {
    normalized.completedItemIds = completed;
  }
  return normalized;
}

function removeRecord(storage, status) {
  storage.removeItem(CHECKOUT_RECOVERY_KEY);
  return { status };
}

export function saveCheckoutRecovery({ items, walletAddress, intent }, now = Date.now(), target) {
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    !items.every(isValidItem) ||
    typeof walletAddress !== "string" ||
    walletAddress.length === 0 ||
    !Number.isFinite(now)
  ) {
    throw new Error("Invalid checkout recovery details");
  }

  const storage = resolveCheckoutStorage(target);
  if (!storage) {
    throw new Error("Checkout recovery is only available in a browser");
  }

  const normalizedIntent = normalizeIntent(intent, now);
  const record = {
    version: CHECKOUT_RECOVERY_VERSION,
    items: items.map(({ id, title, price, asset }) => ({
      id,
      title,
      ...(price !== undefined ? { price } : {}),
      ...(asset !== undefined ? { asset } : {}),
    })),
    walletAddress,
    createdAt: now,
    ...(normalizedIntent ? { intent: normalizedIntent } : {}),
  };
  storage.setItem(CHECKOUT_RECOVERY_KEY, JSON.stringify(record));
  return record;
}

export function readCheckoutRecovery(now = Date.now(), target) {
  const storage = resolveCheckoutStorage(target);
  if (!storage) return { status: "unavailable" };
  if (!Number.isFinite(now)) return removeRecord(storage, "invalid");

  const raw = storage.getItem(CHECKOUT_RECOVERY_KEY);
  if (!raw) return { status: "empty" };

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return removeRecord(storage, "invalid");
  }

  if (
    !record ||
    record.version !== CHECKOUT_RECOVERY_VERSION ||
    !Array.isArray(record.items) ||
    record.items.length === 0 ||
    !record.items.every(isValidItem) ||
    typeof record.walletAddress !== "string" ||
    record.walletAddress.length === 0 ||
    !Number.isFinite(record.createdAt) ||
    !isValidIntent(record.intent)
  ) {
    return removeRecord(storage, "invalid");
  }

  const age = now - record.createdAt;
  if (age < 0 || age > CHECKOUT_RECOVERY_TTL_MS) {
    return removeRecord(storage, "expired");
  }

  return { status: "ready", record };
}

/**
 * Move the stored attempt to a new signing stage without restarting its TTL:
 * createdAt is kept so an attempt cannot be kept alive by polling.
 */
export function recordCheckoutSigningStage(stage, patch = {}, now = Date.now(), target) {
  if (!SIGNING_STAGES.includes(stage)) {
    throw new Error("Invalid checkout recovery stage");
  }

  const result = readCheckoutRecovery(now, target);
  if (result.status !== "ready") return null;

  const storage = resolveCheckoutStorage(target);
  const current = result.record.intent || {};
  const next = {
    ...result.record,
    intent: {
      ...current,
      ...normalizeStagePatch(patch),
      stage,
      updatedAt: now,
    },
  };

  storage.setItem(CHECKOUT_RECOVERY_KEY, JSON.stringify(next));
  return next;
}

export function clearCheckoutRecovery(target) {
  const storage = resolveCheckoutStorage(target);
  if (!storage) return;
  storage.removeItem(CHECKOUT_RECOVERY_KEY);
}

function decision(fields) {
  return {
    action: RecoveryAction.None,
    code: "no_record",
    title: "No interrupted checkout",
    message: "Nothing was left unfinished in this tab.",
    requiresSignature: false,
    requiresVerification: false,
    walletMatches: true,
    stage: null,
    txHash: null,
    record: null,
    ageMs: null,
    expiresAt: null,
    primaryLabel: ACTION_LABELS[RecoveryAction.None],
    ...fields,
  };
}

/**
 * Decide what the UI should offer for a record read by readCheckoutRecovery.
 *
 * The rule that keeps a buyer from paying twice: only a stage that never
 * reached the network can be replayed blindly. Anything past "signed" is
 * verified against the chain first.
 */
export function classifyCheckoutRecovery(
  result,
  { now = Date.now(), ttlMs = CHECKOUT_RECOVERY_TTL_MS, walletAddress = null } = {},
) {
  const status = result && result.status;

  if (status === "empty" || status === "unavailable") {
    return decision({
      code: status === "unavailable" ? "storage_unavailable" : "no_record",
      title: status === "unavailable" ? "Recovery unavailable" : "No interrupted checkout",
      message:
        status === "unavailable"
          ? "This browser has no session storage, so an interrupted checkout cannot be restored."
          : "Nothing was left unfinished in this tab.",
    });
  }

  if (status === "invalid") {
    return decision({
      action: RecoveryAction.Discard,
      code: "corrupt_record",
      title: "Saved checkout was unreadable",
      message: "The saved checkout could not be read and has been cleared. Start the purchase again.",
      primaryLabel: ACTION_LABELS[RecoveryAction.Discard],
    });
  }

  if (status === "expired") {
    return decision({
      action: RecoveryAction.Discard,
      code: "expired_record",
      title: "Saved checkout expired",
      message: "The saved checkout is older than 30 minutes and has been cleared.",
      primaryLabel: ACTION_LABELS[RecoveryAction.Discard],
    });
  }

  if (status !== "ready" || !result.record) {
    return decision({});
  }

  const record = result.record;
  const ageMs = now - record.createdAt;
  const base = {
    record,
    ageMs,
    expiresAt: record.createdAt + ttlMs,
    stage: record.intent ? record.intent.stage : null,
    txHash: record.intent ? record.intent.txHash || null : null,
  };

  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return decision({
      ...base,
      action: RecoveryAction.Discard,
      code: "clock_skew",
      title: "Saved checkout is from the future",
      message:
        "The saved checkout was timestamped ahead of this device's clock and has been cleared to avoid resuming the wrong attempt.",
      primaryLabel: ACTION_LABELS[RecoveryAction.Discard],
    });
  }

  if (ageMs > ttlMs) {
    return decision({
      ...base,
      action: RecoveryAction.Discard,
      code: "expired_record",
      title: "Saved checkout expired",
      message: "The saved checkout is older than 30 minutes and has been cleared.",
      primaryLabel: ACTION_LABELS[RecoveryAction.Discard],
    });
  }

  if (walletAddress && record.walletAddress !== walletAddress) {
    return decision({
      ...base,
      action: RecoveryAction.Discard,
      code: "wallet_mismatch",
      walletMatches: false,
      title: "Saved checkout used another wallet",
      message: `This checkout was started with ${shortAddress(
        record.walletAddress,
      )}. Reconnect that wallet to resume it, or dismiss it to pay from this one.`,
      primaryLabel: ACTION_LABELS[RecoveryAction.Discard],
    });
  }

  if (!record.intent) {
    return decision({
      ...base,
      action: RecoveryAction.Resume,
      code: "resume_checkout",
      title: "Unfinished checkout",
      message: "You started a purchase here and it never finished. Resume it to pay and unlock access.",
      requiresSignature: true,
      primaryLabel: ACTION_LABELS[RecoveryAction.Resume],
    });
  }

  switch (record.intent.stage) {
    case SigningStage.AwaitingSignature:
      return decision({
        ...base,
        action: RecoveryAction.Resume,
        code: "resume_signing",
        title: "Wallet signature was interrupted",
        message:
          "Your wallet request closed before you signed, so nothing was charged. Resume to approve it again.",
        requiresSignature: true,
        primaryLabel: ACTION_LABELS[RecoveryAction.Resume],
      });
    case SigningStage.Signed:
      return decision({
        ...base,
        action: RecoveryAction.Retry,
        code: "resubmit_signed",
        title: "Signature captured, submission interrupted",
        message:
          "Your signature is saved, so you can submit it again without approving a second time in your wallet.",
        requiresSignature: false,
        primaryLabel: ACTION_LABELS[RecoveryAction.Retry],
      });
    case SigningStage.Submitted:
      return decision({
        ...base,
        action: RecoveryAction.Verify,
        code: "verify_submission",
        title: "Payment may already be on its way",
        message:
          "The transaction was submitted before the page closed. Check it before paying again so you are not charged twice.",
        requiresVerification: true,
        primaryLabel: ACTION_LABELS[RecoveryAction.Verify],
      });
    case SigningStage.Confirmed:
      return decision({
        ...base,
        action: RecoveryAction.Verify,
        code: "verify_confirmed",
        title: "Purchase already confirmed",
        message:
          "This purchase was confirmed. Check your access before buying the same material again.",
        requiresVerification: true,
        primaryLabel: ACTION_LABELS[RecoveryAction.Verify],
      });
    default:
      return decision({ ...base });
  }
}

/** A short, human age for the recovery banner. */
export function formatRecoveryAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "just now";
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}
