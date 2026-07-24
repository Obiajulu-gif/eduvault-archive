const STATUS_ALIASES = Object.freeze({
  open: "pending",
  awaiting: "pending",
  in_review: "submitted",
  submitted: "submitted",
  approved: "approved",
  accepted: "approved",
  rejected: "rejected",
  declined: "rejected",
  done: "completed",
  complete: "completed",
  completed: "completed",
  paid: "paid",
  released: "paid",
});

const VALID_STATUSES = new Set([
  "pending",
  "submitted",
  "approved",
  "rejected",
  "completed",
  "paid",
]);

function stableString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function cleanString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function normalizeStatus(value) {
  const normalized = cleanString(value)?.toLowerCase() || "pending";
  const aliased = STATUS_ALIASES[normalized] || normalized;
  return VALID_STATUSES.has(aliased) ? aliased : "pending";
}

function normalizeAmount(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return String(value);
  }
  if (typeof value === "bigint") {
    return value >= 0n ? value.toString() : null;
  }
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return text;
}

function normalizeCurrency(value, fallback) {
  const currency = cleanString(value) || cleanString(fallback);
  return currency ? currency.toUpperCase() : null;
}

function normalizeDate(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractMilestoneArray(payload) {
  if (payload == null) {
    return {
      items: [],
      exceptions: [],
    };
  }

  if (Array.isArray(payload)) {
    return {
      items: payload,
      exceptions: [],
    };
  }

  if (typeof payload === "object" && Array.isArray(payload.milestones)) {
    return {
      items: payload.milestones,
      exceptions: [],
    };
  }

  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) {
      return {
        items: [],
        exceptions: [],
      };
    }

    try {
      return extractMilestoneArray(JSON.parse(trimmed));
    } catch {
      return {
        items: [],
        exceptions: [
          {
            milestoneIndex: null,
            reason: "malformed_json",
            rawValue: payload,
          },
        ],
      };
    }
  }

  return {
    items: [],
    exceptions: [
      {
        milestoneIndex: null,
        reason: "unsupported_payload_shape",
        rawValue: payload,
      },
    ],
  };
}

function normalizeEvidence(rawEvidence, { payoutId, milestoneId, now }) {
  const values = Array.isArray(rawEvidence)
    ? rawEvidence
    : rawEvidence == null
      ? []
      : [rawEvidence];

  return values.flatMap((entry, index) => {
    if (entry == null || entry === "") return [];

    const objectEntry =
      typeof entry === "object" && !Array.isArray(entry)
        ? entry
        : { uri: entry };

    const uri = cleanString(
      objectEntry.uri ||
        objectEntry.url ||
        objectEntry.href ||
        objectEntry.cid ||
        objectEntry.txHash,
    );

    const metadata = { ...objectEntry };
    delete metadata.uri;
    delete metadata.url;
    delete metadata.href;
    delete metadata.cid;
    delete metadata.txHash;
    delete metadata.label;
    delete metadata.name;
    delete metadata.type;

    return [
      {
        evidenceId: `${milestoneId}:evidence:${index}`,
        milestoneId,
        payoutId,
        type: cleanString(objectEntry.type) || (uri ? "link" : "note"),
        uri,
        label: cleanString(objectEntry.label || objectEntry.name),
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
        createdAt: normalizeDate(objectEntry.createdAt) || now,
        updatedAt: now,
      },
    ];
  });
}

function normalizeMilestone(raw, index, { payout, now }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      milestone: null,
      evidence: [],
      exception: {
        milestoneIndex: index,
        reason: "malformed_milestone",
        rawValue: raw,
      },
    };
  }

  const payoutId = cleanString(payout.payoutId || payout._id);
  const escrowId = cleanString(payout.escrowId) || payoutId;
  const position = Number.isInteger(raw.position)
    ? raw.position
    : Number.isInteger(raw.order)
      ? raw.order
      : index;

  const milestoneId = cleanString(raw.milestoneId || raw.id)
    ? `${payoutId}:${cleanString(raw.milestoneId || raw.id)}`
    : `${payoutId}:${position}`;

  const amount = normalizeAmount(
    raw.amount ?? raw.value ?? raw.releaseAmount,
  );

  const milestone = {
    milestoneId,
    payoutId,
    escrowId,
    position,
    status: normalizeStatus(raw.status),
    title: cleanString(raw.title || raw.name),
    description: cleanString(raw.description || raw.summary),
    amount,
    currency: normalizeCurrency(raw.currency || raw.asset, payout.asset || payout.currency),
    dueAt: normalizeDate(raw.dueAt || raw.dueDate || raw.deadline),
    feedback: cleanString(raw.feedback || raw.rejectionReason || raw.notes),
    onChainMilestoneId: cleanString(
      raw.onChainMilestoneId || raw.chainMilestoneId || raw.trustlessWorkMilestoneId,
    ),
    chainTxHash: cleanString(raw.chainTxHash || raw.transactionHash || raw.txHash),
    version: 1,
    legacyDigest: stableString(raw),
    createdAt: normalizeDate(raw.createdAt) || payout.createdAt || now,
    updatedAt: normalizeDate(raw.updatedAt) || now,
  };

  const evidence = normalizeEvidence(
    raw.evidence || raw.evidenceUrl || raw.evidenceUrls || raw.attachments,
    {
      payoutId,
      milestoneId,
      now,
    },
  );

  return {
    milestone,
    evidence,
    exception: amount == null && raw.amount != null
      ? {
          milestoneIndex: index,
          reason: "invalid_amount",
          rawValue: raw.amount,
        }
      : null,
  };
}

export function normalizeLegacyPayoutMilestones(payout, { now = new Date() } = {}) {
  const payoutId = cleanString(payout?.payoutId || payout?._id);

  if (!payoutId) {
    throw new Error("Cannot normalize milestones for payout without payoutId or _id");
  }

  const extracted = extractMilestoneArray(payout?.milestones);
  const milestones = [];
  const evidence = [];
  const exceptions = [...extracted.exceptions];

  extracted.items.forEach((item, index) => {
    const result = normalizeMilestone(item, index, {
      payout,
      now,
    });

    if (result.milestone) milestones.push(result.milestone);
    evidence.push(...result.evidence);
    if (result.exception) exceptions.push(result.exception);
  });

  return {
    payoutId,
    sourceCount: extracted.items.length,
    milestones,
    evidence,
    exceptions,
  };
}

export function sumMilestoneAmounts(milestones) {
  return milestones.reduce((total, milestone) => {
    if (milestone.amount == null) return total;
    return total + Number(milestone.amount);
  }, 0);
}
