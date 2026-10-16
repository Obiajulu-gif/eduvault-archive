/**
 * Provenance tracking for imported and derived material records (#888).
 *
 * When a record enters the catalog through a bulk import, or is created as a
 * derivative of another record, it must keep a durable trail of where it came
 * from and how it was transformed. Maintainers use that trail to answer:
 *
 *   - which import batch produced this listing, and from what source file
 *   - which transform version shaped it, so a re-run can be told apart
 *   - who (wallet + user id) acted on it
 *   - for a derivative, which source record it descends from — and whether
 *     that source has since been deleted
 *
 * The trail lives in the material document under `provenance`. Import/derived
 * writers attach it on create; `recordProvenanceRevision` keeps the origin
 * intact and appends an entry when an update is allowed to touch the record.
 *
 * This module is deliberately pure (no database access) so the routing layer
 * owns reads/writes and the tests can exercise every case in memory.
 */

export const PROVENANCE_SCHEMA_VERSION = 1;

export const PROVENANCE_KINDS = Object.freeze({
  IMPORT: "import",
  DERIVED: "derived",
});

// Bump a transform version whenever a pipeline changes the shape or meaning of
// the data it emits. A stored version is what lets a maintainer tell a record
// written by the old import/derive pipeline from one written by the new one.
export const TRANSFORM_VERSIONS = Object.freeze({
  import: "import@1",
  derived: "derived@1",
});

// A record can be revisited many times; keep the most recent revisions rather
// than growing the document without bound.
const MAX_REVISIONS = 50;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function clean(value, maxLength = 256) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(CONTROL_CHARS, "").trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function toIso(now) {
  const date = now instanceof Date ? now : now ? new Date(now) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function actorMeta({ actorAddress, actorUserId } = {}) {
  return {
    walletAddress: clean(actorAddress, 120),
    userId: clean(actorUserId, 120),
  };
}

/**
 * Provenance for a record created by a bulk import. `importBatchId` is
 * required: it is the handle maintainers use to find every record a single
 * import produced.
 */
export function buildImportProvenance({
  importBatchId,
  format,
  sourceName,
  recordIndex,
  externalId,
  transformVersion,
  actorAddress,
  actorUserId,
  now,
} = {}) {
  const batchId = clean(importBatchId, 128);
  if (!batchId) throw new Error("import provenance requires an importBatchId");

  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    kind: PROVENANCE_KINDS.IMPORT,
    origin: {
      type: PROVENANCE_KINDS.IMPORT,
      importBatchId: batchId,
      format: clean(format, 10),
      name: clean(sourceName, 256),
      externalId: clean(externalId, 128),
      recordIndex: Number.isInteger(recordIndex) ? recordIndex : null,
      // Derived-only fields stay null on an import record so the shape is
      // uniform and a query never has to guess which keys exist.
      materialId: null,
      sourceExternalId: null,
      relation: null,
    },
    transform: {
      version: clean(transformVersion, 40) || TRANSFORM_VERSIONS.import,
      step: "import",
    },
    actor: actorMeta({ actorAddress, actorUserId }),
    recordedAt: toIso(now),
    revisions: [],
  };
}

/**
 * Provenance for a record derived from another catalog record. The source id
 * is stored so the chain can be walked later, even if the source is deleted
 * after the derivative is created.
 */
export function buildDerivedProvenance({
  sourceMaterialId,
  sourceExternalId,
  relation,
  transformVersion,
  actorAddress,
  actorUserId,
  now,
} = {}) {
  const materialId = clean(sourceMaterialId, 64);
  if (!materialId) throw new Error("derived provenance requires a sourceMaterialId");

  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    kind: PROVENANCE_KINDS.DERIVED,
    origin: {
      type: PROVENANCE_KINDS.DERIVED,
      importBatchId: null,
      format: null,
      name: null,
      externalId: null,
      recordIndex: null,
      materialId,
      sourceExternalId: clean(sourceExternalId, 128),
      relation: clean(relation, 60) || "derived",
    },
    transform: {
      version: clean(transformVersion, 40) || TRANSFORM_VERSIONS.derived,
      step: "derive",
    },
    actor: actorMeta({ actorAddress, actorUserId }),
    recordedAt: toIso(now),
    revisions: [],
  };
}

/**
 * Preserve provenance through an update. The origin (kind, source, actor,
 * recordedAt) is immutable — only a new revision is appended, so an edit can
 * never rewrite history or make a record look like it came from somewhere
 * else.
 */
export function recordProvenanceRevision(
  existing,
  { actorAddress, actorUserId, importBatchId, changedFields = [], source = "creator", now } = {}
) {
  if (!existing || typeof existing !== "object") return existing ?? null;

  const revision = {
    at: toIso(now),
    actor: actorMeta({ actorAddress, actorUserId }),
    importBatchId: clean(importBatchId, 128),
    source: clean(source, 40) || "creator",
    changedFields: [...new Set((changedFields || []).map((field) => clean(field, 60)).filter(Boolean))],
  };

  const revisions = [
    ...(Array.isArray(existing.revisions) ? existing.revisions : []),
    revision,
  ].slice(-MAX_REVISIONS);

  return {
    ...existing,
    schemaVersion: existing.schemaVersion || PROVENANCE_SCHEMA_VERSION,
    revisions,
  };
}

/**
 * Walk a derived record's ancestry through `resolveSource(id)`. The resolver
 * returns a material document (or a minimal `{ provenance, externalId,
 * isDeleted }` shape) or null when the source no longer exists.
 *
 * A missing — or soft-deleted — source does not throw. It is recorded as
 * `sourceDeleted: true` with `exists: false` in the chain, because a
 * maintainer investigating a derivative needs to know the source is gone, not
 * get an error. Cycles are detected and reported via `broken`.
 */
export function traceProvenance(provenance, { resolveSource } = {}) {
  if (!provenance || typeof provenance !== "object" || provenance.kind !== PROVENANCE_KINDS.DERIVED) {
    return { chain: [], sourceDeleted: false, depth: 0, broken: false };
  }

  const chain = [];
  const visited = new Set();
  let current = provenance;
  let sourceDeleted = false;
  let broken = false;

  while (current && current.kind === PROVENANCE_KINDS.DERIVED && current.origin?.materialId) {
    const sourceId = String(current.origin.materialId);

    if (visited.has(sourceId)) {
      broken = true;
      break;
    }
    visited.add(sourceId);

    const source = typeof resolveSource === "function" ? resolveSource(sourceId) : null;
    if (!source) {
      chain.push({ materialId: sourceId, kind: null, externalId: null, exists: false, deleted: false });
      sourceDeleted = true;
      break;
    }

    if (source.isDeleted) {
      chain.push({ materialId: sourceId, kind: source.provenance?.kind || null, externalId: source.externalId || null, exists: false, deleted: true });
      sourceDeleted = true;
      break;
    }

    chain.push({
      materialId: sourceId,
      kind: source.provenance?.kind || null,
      externalId: source.externalId || null,
      exists: true,
      deleted: false,
    });

    current = source.provenance || null;
  }

  return { chain, sourceDeleted, depth: chain.length, broken };
}

export function hasProvenance(record) {
  return Boolean(record && typeof record === "object" && record.provenance);
}

/**
 * Flatten records into maintainer-facing provenance rows. `traces` is an
 * optional map of materialId -> traceProvenance() result, used to surface
 * whether a derived record's source chain is intact. The function stays pure
 * so it can be unit tested without a database.
 */
export function exportProvenance(materials = [], { traces = {} } = {}) {
  return materials.map((material) => {
    const provenance = material?.provenance || null;
    const origin = provenance?.origin || {};
    const materialId = String(material?._id ?? material?.materialId ?? "");
    const trace = provenance?.kind === PROVENANCE_KINDS.DERIVED ? traces[materialId] || null : null;
    const revisions = Array.isArray(provenance?.revisions) ? provenance.revisions : [];

    return {
      materialId,
      title: material?.title ?? null,
      userAddress: material?.userAddress ?? null,
      provenanceKind: provenance?.kind ?? "none",
      schemaVersion: provenance?.schemaVersion ?? null,
      sourceType: origin.type ?? null,
      importBatchId: origin.importBatchId ?? null,
      sourceExternalId: origin.sourceExternalId ?? origin.externalId ?? null,
      sourceMaterialId: origin.materialId ?? null,
      relation: origin.relation ?? null,
      transformVersion: provenance?.transform?.version ?? null,
      actorAddress: provenance?.actor?.walletAddress ?? null,
      recordedAt: provenance?.recordedAt ?? null,
      revisionCount: revisions.length,
      lastRevisedAt: revisions.length ? revisions[revisions.length - 1].at : null,
      sourceDeleted: trace ? Boolean(trace.sourceDeleted) : null,
      traceDepth: trace ? trace.depth : 0,
    };
  });
}

export function summarizeProvenance(rows = []) {
  const summary = {
    total: rows.length,
    imported: 0,
    derived: 0,
    native: 0,
    untracked: 0,
    sourcesDeleted: 0,
    revisions: 0,
  };

  for (const row of rows) {
    if (row.provenanceKind === PROVENANCE_KINDS.IMPORT) summary.imported += 1;
    else if (row.provenanceKind === PROVENANCE_KINDS.DERIVED) summary.derived += 1;
    else if (row.provenanceKind === "none") summary.untracked += 1;
    else summary.native += 1;

    if (row.sourceDeleted) summary.sourcesDeleted += 1;
    summary.revisions += row.revisionCount || 0;
  }

  return summary;
}

const CSV_COLUMNS = [
  "materialId",
  "title",
  "userAddress",
  "provenanceKind",
  "schemaVersion",
  "sourceType",
  "importBatchId",
  "sourceExternalId",
  "sourceMaterialId",
  "relation",
  "transformVersion",
  "actorAddress",
  "recordedAt",
  "revisionCount",
  "lastRevisedAt",
  "sourceDeleted",
  "traceDepth",
];

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Serialize provenance rows to CSV for an offline maintainer export. */
export function provenanceToCsv(rows = []) {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((row) => CSV_COLUMNS.map((column) => csvCell(row[column])).join(","));
  return [header, ...lines].join("\n");
}
