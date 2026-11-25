import crypto from "node:crypto";
import { AppError } from "../errors/AppError.js";

export const DEFAULT_IPFS_GATEWAYS = Object.freeze([
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
]);

export const IPFS_REPAIR_AUDIT_COLLECTION = "ipfs_repair_audit";
export const IPFS_REPAIR_QUARANTINE_COLLECTION = "ipfs_repair_quarantine";

export const QuorumStatus = Object.freeze({
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  UNREACHABLE: "unreachable",
});

/**
 * Validates that the operator has administrative or storage repair permissions.
 */
export function validateIpfsRepairAuthorization(actor) {
  if (!actor) {
    throw new AppError("AUTH_UNAUTHENTICATED", {
      message: "Authentication required to execute IPFS content repair.",
      statusCode: 401,
    });
  }

  if (actor.isCli === true || actor.role === "system") {
    return true;
  }

  const role = String(actor.role || "").toLowerCase();
  if (role === "admin" || role === "deployer" || role === "maintainer") {
    return true;
  }

  const permissions = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (
    permissions.includes("storage:manage") ||
    permissions.includes("system:repair") ||
    permissions.includes("admin:manage")
  ) {
    return true;
  }

  throw new AppError("AUTH_FORBIDDEN", {
    message: "Forbidden: Storage management privileges required.",
    statusCode: 403,
  });
}

/**
 * Normalizes gateway URL to ensure standard trailing slash formatting.
 */
function normalizeGatewayUrl(baseUrl, cid) {
  const cleanBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${cleanBase}${cid}`;
}

/**
 * Executes a HEAD/GET probe against a specific gateway for a CID with timeout.
 */
async function probeGateway(gatewayBase, cid, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const url = normalizeGatewayUrl(gatewayBase, cid);
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  const start = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "HEAD",
      signal: controller?.signal,
    });

    const elapsed = Date.now() - start;
    const ok = res.ok;
    return {
      gateway: gatewayBase,
      url,
      ok,
      status: res.status,
      latencyMs: elapsed,
      contentLength: res.headers?.get ? Number(res.headers.get("content-length")) || null : null,
      error: ok ? null : `HTTP_${res.status}`,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const isTimeout = err.name === "AbortError";
    return {
      gateway: gatewayBase,
      url,
      ok: false,
      status: isTimeout ? 408 : 503,
      latencyMs: elapsed,
      error: isTimeout ? "GATEWAY_TIMEOUT" : err.message || "GATEWAY_ERROR",
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Dispatches concurrent probes across configured gateways and computes quorum consensus.
 */
export async function checkGatewayQuorum(cid, {
  gateways = DEFAULT_IPFS_GATEWAYS,
  requiredQuorum = 2,
  timeoutMs = 5000,
  fetchImpl = fetch,
} = {}) {
  if (!cid) throw new Error("checkGatewayQuorum requires a CID string");

  const results = await Promise.all(
    gateways.map((gw) => probeGateway(gw, cid, { timeoutMs, fetchImpl }))
  );

  const healthyGateways = results.filter((r) => r.ok);
  const healthyCount = healthyGateways.length;

  let status = QuorumStatus.HEALTHY;
  if (healthyCount === 0) {
    status = QuorumStatus.UNREACHABLE;
  } else if (healthyCount < requiredQuorum) {
    status = QuorumStatus.DEGRADED;
  }

  return {
    cid,
    status,
    healthy: status === QuorumStatus.HEALTHY,
    healthyCount,
    requiredQuorum,
    totalGateways: gateways.length,
    gatewayResults: results,
    healthyGateways: healthyGateways.map((g) => g.gateway),
  };
}

/**
 * Repins a CID to pinning providers using healthy content retrieved from an accessible gateway.
 */
export async function rePinFromGateway(cid, {
  healthyGatewayUrl,
  providers = [],
  fetchImpl = fetch,
} = {}) {
  if (!healthyGatewayUrl) throw new Error("rePinFromGateway requires a healthy gateway URL");
  if (!providers.length) return { rePinned: false, reason: "no_pinning_providers" };

  // Fetch content bytes from the healthy gateway
  const response = await fetchImpl(healthyGatewayUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch content from healthy gateway: ${response.status}`);
  }

  let blob;
  if (typeof response.blob === "function") {
    blob = await response.blob();
  } else if (typeof response.arrayBuffer === "function") {
    blob = await response.arrayBuffer();
  } else {
    blob = Buffer.from(response.data || "");
  }

  let file;
  if (typeof File !== "undefined") {
    file = new File([blob], cid, {
      type: (typeof response.headers?.get === "function" && response.headers.get("content-type")) || "application/octet-stream",
    });
  } else {
    file = {
      name: cid,
      data: blob,
      type: (typeof response.headers?.get === "function" && response.headers.get("content-type")) || "application/octet-stream",
    };
  }

  const pinResults = await Promise.allSettled(
    providers.map((p) => (typeof p.pinFile === "function" ? p.pinFile(file) : null))
  );

  const successes = pinResults.filter((r) => r.status === "fulfilled" && r.value?.cid);
  return {
    rePinned: successes.length > 0,
    successfulProviders: successes.length,
  };
}

/**
 * Main IPFS Content Repair Job.
 * Scans materials with storageKeys, validates gateway quorum, repairs degraded pins,
 * and quarantines unreachable content with audit trails.
 */
export async function runIpfsContentRepairJob(db, {
  dryRun = true,
  requiredQuorum = 2,
  limit = 100,
  targetCid = null,
  targetMaterialId = null,
  gateways = DEFAULT_IPFS_GATEWAYS,
  providers = [],
  actor = { role: "system", isCli: true },
  timeoutMs = 5000,
  maxRetries = 2,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  validateIpfsRepairAuthorization(actor);

  const startTime = Date.now();
  const runId = `ipfs-repair-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  const materialsColl = db.collection("materials");
  const auditColl = db.collection(IPFS_REPAIR_AUDIT_COLLECTION);
  const quarantineColl = db.collection(IPFS_REPAIR_QUARANTINE_COLLECTION);

  // Build target query
  const query = { storageKey: { $exists: true, $ne: null } };
  if (targetCid) {
    query.storageKey = targetCid;
  }
  if (targetMaterialId) {
    query._id = targetMaterialId;
  }

  const materials = await materialsColl.find(query).limit(limit).toArray();

  const summary = {
    runId,
    actor: { id: actor.id || actor.sub || "system", role: actor.role || "system" },
    dryRun,
    scanned: materials.length,
    healthy: 0,
    degraded: 0,
    unreachable: 0,
    repaired: 0,
    quarantined: 0,
    failures: [],
    actions: [],
    durationMs: 0,
  };

  for (const material of materials) {
    const cid = material.storageKey;
    if (!cid) continue;

    try {
      const quorumResult = await checkGatewayQuorum(cid, {
        gateways,
        requiredQuorum,
        timeoutMs,
        fetchImpl,
      });

      if (quorumResult.status === QuorumStatus.HEALTHY) {
        summary.healthy++;
        continue;
      }

      if (quorumResult.status === QuorumStatus.DEGRADED) {
        summary.degraded++;

        if (dryRun) {
          summary.actions.push({
            materialId: String(material._id),
            cid,
            plannedAction: "repin_to_secondary_gateways",
            currentHealthyCount: quorumResult.healthyCount,
          });
          continue;
        }

        // Apply mode: Attempt repair by fetching from healthy gateway and re-pinning
        const healthyUrl = quorumResult.gatewayResults.find((g) => g.ok)?.url;
        let repairSuccess = false;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const rePin = await rePinFromGateway(cid, {
              healthyGatewayUrl: healthyUrl,
              providers,
              fetchImpl,
            });

            if (rePin.rePinned) {
              repairSuccess = true;
              break;
            }
          } catch (pinErr) {
            if (attempt === maxRetries) {
              summary.failures.push({
                materialId: String(material._id),
                cid,
                error: pinErr.message,
              });
            }
          }
        }

        if (repairSuccess) {
          summary.repaired++;
          summary.actions.push({
            materialId: String(material._id),
            cid,
            action: "repaired_quorum",
            sourceGateway: healthyUrl,
          });
        }
      } else if (quorumResult.status === QuorumStatus.UNREACHABLE) {
        summary.unreachable++;

        if (dryRun) {
          summary.actions.push({
            materialId: String(material._id),
            cid,
            plannedAction: "quarantine_unreachable",
            reason: "no_healthy_gateways",
          });
          continue;
        }

        // Record to quarantine for maintainer intervention
        summary.quarantined++;
        const quarantineRecord = {
          runId,
          materialId: String(material._id),
          cid,
          status: "unreachable",
          gatewayResults: quorumResult.gatewayResults,
          quarantinedAt: now,
          resolved: false,
        };

        summary.actions.push({
          materialId: String(material._id),
          cid,
          action: "quarantined",
          reason: "zero_gateways_responding",
        });

        await quarantineColl.updateOne(
          { cid },
          { $set: quarantineRecord },
          { upsert: true }
        );
      }
    } catch (err) {
      summary.failures.push({
        materialId: String(material._id),
        cid,
        error: err.message,
      });
    }
  }

  summary.durationMs = Date.now() - startTime;

  if (!dryRun) {
    await auditColl.insertOne({
      ...summary,
      createdAt: now,
    });
  }

  return summary;
}
