import { diffForMaterial } from "./materialSearchProjection.js";

// #977: stale-index and stale-cache detection. Everything here is pure: callers
// pass materials, projections, or cache keys in and get findings out, so the
// same logic runs from the reconcile route, a script, or a test.

// The catalog cache key carries its revision: `market-materials:v<rev>:<query>`
// (see src/lib/cache/redis.js). Anything below the current revision is a
// generation that can no longer be served.
const CATALOG_CACHE_KEY = /^market-materials:v(\d+):/;

// Each finding type maps to one repair. `automated` means the existing repair
// path (reconcile with repair=true, or the projection sync) can fix it without
// an operator. Priority drives whether an operator has to look at it first.
export const REPAIR_RECOMMENDATIONS = Object.freeze({
  missing: {
    action: "reindex_material",
    automated: true,
    priority: "medium",
    detail: "A searchable material has no search projection. Run reconcile with repair=true to project it.",
  },
  stale: {
    action: "reindex_material",
    automated: true,
    priority: "medium",
    detail: "The search projection is behind the material's version. Run reconcile with repair=true to refresh it.",
  },
  unauthorized: {
    action: "remove_projection",
    automated: true,
    priority: "high",
    detail: "The search index still exposes a material that is no longer public. Remove the projection now, then check the material's moderation and visibility history.",
  },
  orphan: {
    action: "remove_projection",
    automated: false,
    priority: "high",
    detail: "The search index has a projection with no source material. Confirm the material was not restored from backup, then delete the projection.",
  },
  cache_generation_behind: {
    action: "let_ttl_expire",
    automated: false,
    priority: "low",
    detail: "A catalog cache key is from an older revision. It is never served, and Redis TTL removes it. No action is needed unless memory is under pressure.",
  },
});

/** Compare every material with its projection. Missing projections for unsearchable materials are not drift. */
export function detectSearchIndexDrift({ materials = [], projections = [] }) {
  const projectionById = new Map(projections.map((p) => [String(p._id ?? p.materialId), p]));
  const materialIds = new Set();
  const findings = [];

  for (const material of materials) {
    const materialId = String(material._id);
    materialIds.add(materialId);
    const diff = diffForMaterial(material, projectionById.get(materialId));
    if (diff) findings.push(diff);
  }

  for (const projection of projections) {
    const materialId = String(projection._id ?? projection.materialId);
    if (materialIds.has(materialId)) continue;
    findings.push({
      type: "orphan",
      materialId,
      expectedVersion: null,
      actualVersion: projection.projectionVersion ?? null,
      reason: "projection_without_material",
    });
  }

  return findings;
}

/**
 * Flags catalog cache keys written under an older revision than the current
 * one. Keys that don't match the catalog format are ignored, not guessed at.
 */
export function detectStaleCacheKeys(keys = [], currentRevision) {
  const current = Number(currentRevision);
  if (!Number.isSafeInteger(current) || current < 0) return [];

  const findings = [];
  for (const key of keys) {
    const match = CATALOG_CACHE_KEY.exec(String(key));
    if (!match) continue;
    const cachedRevision = Number(match[1]);
    if (cachedRevision < current) {
      findings.push({
        type: "cache_generation_behind",
        key: String(key),
        cachedRevision,
        currentRevision: current,
        reason: "cache_revision_behind",
      });
    }
  }
  return findings;
}

/** Adds the repair recommendation to each finding. Unknown types are kept but flagged for review. */
export function recommendRepairs(findings = []) {
  return findings.map((finding) => ({
    ...finding,
    recommendation: REPAIR_RECOMMENDATIONS[finding.type] ?? {
      action: "operator_review",
      automated: false,
      priority: "high",
      detail: "Unrecognised finding type. Review it manually.",
    },
  }));
}

/**
 * Operator-visible rollup: counts per type and action, and whether any finding
 * needs a human before the automated repair runs.
 */
export function summarizeFindings(findings = []) {
  const annotated = recommendRepairs(findings);
  const byType = {};
  const byAction = {};
  let requiresOperator = false;

  for (const finding of annotated) {
    byType[finding.type] = (byType[finding.type] || 0) + 1;
    byAction[finding.recommendation.action] = (byAction[finding.recommendation.action] || 0) + 1;
    if (finding.recommendation.priority === "high" || !finding.recommendation.automated) {
      requiresOperator = true;
    }
  }

  return { total: annotated.length, byType, byAction, requiresOperator };
}
