export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { verifyDashboardToken } from "@/lib/auth/session";

async function getAdminUser(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookieMatch = cookieHeader.match(/auth_token=([^;]+)/);
  const token = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  if (!token) return null;
  const verification = await verifyDashboardToken(token, process.env.JWT_SECRET);
  if (!verification.valid) return null;
  // Extend this check once a role field is added to the users collection
  return verification.payload;
}

const SEVERITY_WEIGHTS = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const SENSITIVE_FIELDS = [
  "email",
  "emailAddress",
  "phone",
  "phoneNumber",
  "address",
  "ipAddress",
  "ip",
  "ssn",
  "nationalId",
  "walletAddress",
  "wallet",
  "privateKey",
  "token",
  "password",
  "fullName",
  "name",
];

function normalizeSeverity(severity) {
  if (typeof severity !== "string") return "low";
  const normalized = severity.toLowerCase();
  return Object.prototype.hasOwnProperty.call(SEVERITY_WEIGHTS, normalized)
    ? normalized
    : "low";
}

function toTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function withinWindow(timestamp, start, end) {
  if (timestamp === null) return false;
  if (start !== null && timestamp < start) return false;
  if (end !== null && timestamp > end) return false;
  return true;
}

function redactValue(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(() => "[REDACTED]");
  if (typeof value === "object") return "[REDACTED]";
  return "[REDACTED]";
}

function redactRecord(record) {
  if (!record || typeof record !== "object") return record;
  const redacted = {};
  for (const [key, value] of Object.entries(record)) {
    if (SENSITIVE_FIELDS.includes(key)) {
      redacted[key] = redactValue(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      redacted[key] = redactRecord(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export function calculateIncidentImpact(input = {}) {
  const {
    incident = {},
    users = [],
    records = [],
    operations = [],
    window = {},
  } = input;

  const severity = normalizeSeverity(incident.severity);
  const severityWeight = SEVERITY_WEIGHTS[severity];
  const start = toTimestamp(window.start);
  const end = toTimestamp(window.end);

  const affectedUsers = users.filter((user) => {
    const ts = toTimestamp(user.affectedAt || user.timestamp || user.createdAt);
    return withinWindow(ts, start, end);
  });

  const affectedRecords = records.filter((record) => {
    const ts = toTimestamp(record.affectedAt || record.timestamp || record.createdAt);
    return withinWindow(ts, start, end);
  });

  const affectedOperations = operations.filter((operation) => {
    const ts = toTimestamp(operation.affectedAt || operation.timestamp || operation.createdAt);
    return withinWindow(ts, start, end);
  });

  const impactScore =
    (affectedUsers.length + affectedRecords.length + affectedOperations.length) *
    severityWeight;

  const internal = {
    incidentId: incident.id ?? null,
    severity,
    severityWeight,
    window: { start: window.start ?? null, end: window.end ?? null },
    affectedUsers,
    affectedRecords,
    affectedOperations,
    impactScore,
  };

  const shareable = {
    incidentId: incident.id ?? null,
    severity,
    window: { start: window.start ?? null, end: window.end ?? null },
    affectedUserCount: affectedUsers.length,
    affectedRecordCount: affectedRecords.length,
    affectedOperationCount: affectedOperations.length,
    impactScore,
    affectedUsers: affectedUsers.map(redactRecord),
    affectedRecords: affectedRecords.map(redactRecord),
    affectedOperations: affectedOperations.map(redactRecord),
  };

  return { internal, shareable };
}

export async function GET(request) {
  try {
    const user = await getAdminUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const disputes = await db
      .collection("disputes")
      .find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    return NextResponse.json({ disputes });
  } catch (error) {
    console.error("[admin/disputes] GET error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const user = await getAdminUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { disputeId, status, resolution } = await request.json();
    if (!disputeId || !status) {
      return NextResponse.json({ error: "disputeId and status are required" }, { status: 400 });
    }

    const db = await getDb();
    const result = await db.collection("disputes").updateOne(
      { _id: disputeId },
      {
        $set: {}
      }
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[admin/disputes] PATCH error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
