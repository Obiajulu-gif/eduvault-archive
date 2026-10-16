/**
 * Versioned record/API compatibility layer (#803).
 *
 * Records in the catalog are written by deploys that are not all on the same
 * schema version at once, and old clients keep talking to a new server. This
 * module is the single place that turns "a document of some version" into
 * "the shape a caller asked for", on both the read and write paths:
 *
 *   - every record carries a `schemaVersion`;
 *   - readers transparently upgrade legacy (or unversioned) documents to the
 *     shape they asked for, so old records stay readable after a change;
 *   - writers are stamped with the current version, and an older client can
 *     still write the version it knows;
 *   - a version the server does not know is rejected loudly instead of being
 *     silently mangled.
 *
 * Migration definitions are registered per collection. The `materials`
 * collection reuses the existing zero-downtime catalog migrations so there is
 * one source of truth; new collections register their own.
 */

import { CATALOG_MIGRATIONS, CURRENT_CATALOG_VERSION } from "../migrations/catalogMigrationFramework.js";

// Clients ask for a record shape with this request header; the server echoes
// the version it served back in the same header plus the current latest.
export const API_SCHEMA_HEADER = "x-schema-version";

export class UnsupportedSchemaVersionError extends Error {
  constructor(collection, version, { min = 1, latest } = {}) {
    super(
      `Unsupported schema version ${JSON.stringify(version)} for "${collection}" (supported: ${min}-${latest})`
    );
    this.name = "UnsupportedSchemaVersionError";
    this.collection = collection;
    this.version = version;
    this.min = min;
    this.latest = latest;
    this.status = 400;
  }
}

const schemaRegistry = new Map();

/**
 * Register (or override) the version history for a collection. A schema is
 * `{ collection, min, latest, migrations }` where `migrations[n]` is
 * `{ up, down?, validate? }` for the step that produces version `n`.
 */
export function registerRecordSchema(collection, schema) {
  if (!collection) throw new Error("registerRecordSchema requires a collection name");
  if (!schema || !Number.isInteger(schema.latest) || schema.latest < 1) {
    throw new Error(`Invalid schema registration for "${collection}"`);
  }
  const entry = {
    collection,
    min: Number.isInteger(schema.min) && schema.min >= 1 ? schema.min : 1,
    latest: schema.latest,
    migrations: schema.migrations || {},
  };
  schemaRegistry.set(collection, entry);
  return entry;
}

export function getRecordSchema(collection) {
  const schema = schemaRegistry.get(collection);
  if (!schema) throw new Error(`Unknown record schema: "${collection}"`);
  return schema;
}

export function listRecordSchemas() {
  return [...schemaRegistry.values()].map(({ collection, min, latest }) => ({ collection, min, latest }));
}

// The catalog's existing migrations are the authority for `materials`.
registerRecordSchema("materials", {
  collection: "materials",
  min: 1,
  latest: CURRENT_CATALOG_VERSION,
  migrations: CATALOG_MIGRATIONS,
});

export function normalizeSchemaVersion(value, { defaultVersion = 1, collection, schema } = {}) {
  if (value === undefined || value === null || value === "") return defaultVersion;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1) {
    if (collection) throw new UnsupportedSchemaVersionError(collection, value, schema || {});
    throw new Error(`Invalid schema version: ${JSON.stringify(value)}`);
  }
  return parsed;
}

function assertInRange(schema, version) {
  if (version > schema.latest || version < schema.min) {
    throw new UnsupportedSchemaVersionError(schema.collection, version, schema);
  }
}

function migrateUp(schema, doc, from, to) {
  let current = doc;
  for (let version = from + 1; version <= to; version += 1) {
    const migration = schema.migrations?.[version];
    if (!migration?.up) throw new UnsupportedSchemaVersionError(schema.collection, version, schema);
    current = migration.up(current);
  }
  return current;
}

function migrateDown(schema, doc, from, to) {
  let current = doc;
  for (let version = from; version > to; version -= 1) {
    const migration = schema.migrations?.[version];
    if (!migration?.down) throw new UnsupportedSchemaVersionError(schema.collection, version, schema);
    current = migration.down(current);
  }
  return current;
}

function declaredVersion(doc, schema) {
  const raw = doc?.schemaVersion;
  if (raw === undefined || raw === null || raw === "") return schema.min;
  return normalizeSchemaVersion(raw, { collection: schema.collection, schema });
}

/**
 * Read a record as `targetVersion` (default: the latest schema). Legacy,
 * unversioned documents are upgraded in-memory, so a record is readable before
 * any backfill reaches it. A version newer than this server knows is rejected
 * rather than partially interpreted.
 */
export function readRecord(collection, doc, { targetVersion } = {}) {
  if (!doc || typeof doc !== "object") return doc;
  const schema = getRecordSchema(collection);
  const target = normalizeSchemaVersion(targetVersion, { defaultVersion: schema.latest, collection, schema });
  assertInRange(schema, target);

  const from = declaredVersion(doc, schema);
  if (from > schema.latest) throw new UnsupportedSchemaVersionError(collection, from, schema);

  if (target > from) return migrateUp(schema, { ...doc }, from, target);
  if (target < from) return migrateDown(schema, { ...doc }, from, target);
  return { ...doc };
}

/**
 * Prepare a record for writing at `version` (default: the latest schema).
 * A legacy payload is transformed up to the requested version and then
 * stamped, so the stored document always declares its own shape.
 */
export function writeRecord(collection, input, { version } = {}) {
  if (!input || typeof input !== "object") return input;
  const schema = getRecordSchema(collection);
  const requested = normalizeSchemaVersion(version, { defaultVersion: schema.latest, collection, schema });
  assertInRange(schema, requested);

  const from = declaredVersion(input, schema);
  if (from > schema.latest) throw new UnsupportedSchemaVersionError(collection, from, schema);

  let doc = { ...input };
  if (requested > from) doc = migrateUp(schema, doc, from, requested);
  else if (requested < from) doc = migrateDown(schema, doc, from, requested);
  doc.schemaVersion = requested;

  const validate = schema.migrations?.[requested]?.validate;
  if (validate && !validate(doc)) {
    throw new Error(`Record does not satisfy "${collection}" schema v${requested}`);
  }
  return doc;
}

function readRequestHeader(request, name) {
  const headers = request?.headers;
  if (!headers) return null;
  let value;
  if (typeof headers.get === "function") value = headers.get(name);
  else value = headers[name] ?? headers[name.toLowerCase()];
  return value === undefined || value === null ? null : String(value);
}

/**
 * Resolve the schema version a request is asking for. A missing header means
 * "latest" (new clients get the newest shape); a known-but-older version is
 * served with a deprecation flag; an unknown version is a 400.
 */
export function negotiateSchemaVersion(request, collection) {
  const schema = getRecordSchema(collection);
  const raw = readRequestHeader(request, API_SCHEMA_HEADER);

  if (raw === null) {
    return { version: schema.latest, latest: schema.latest, min: schema.min, source: "default", deprecated: false, requested: null };
  }

  const version = normalizeSchemaVersion(raw, { collection, schema });
  assertInRange(schema, version);
  return {
    version,
    latest: schema.latest,
    min: schema.min,
    source: "client",
    deprecated: version < schema.latest,
    requested: version,
  };
}

/** Response headers advertising the version served and the current latest. */
export function schemaResponseHeaders(collection, version) {
  const schema = getRecordSchema(collection);
  const served = normalizeSchemaVersion(version, { defaultVersion: schema.latest, collection, schema });
  return {
    "X-Schema-Version": String(served),
    "X-Schema-Latest": String(schema.latest),
    "X-Schema-Deprecated": served < schema.latest ? "true" : "false",
  };
}
