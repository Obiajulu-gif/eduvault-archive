# Record provenance for imports and derivatives (#888)

Imported and derived records keep a durable trail of **where they came from**
and **how they were transformed**. Maintainers can answer these questions from
the catalog alone, without replaying logs:

- Which import batch produced this listing, and from what source file?
- Which transform version shaped it, so a re-run can be told apart from a
  record written by an older pipeline?
- Who (wallet + user id) acted on it?
- For a derivative, which source record does it descend from — and is that
  source still present?

The tracking model lives in [`src/lib/backend/provenance.js`](../src/lib/backend/provenance.js).

## Data model

Provenance is stored on the material document under `provenance`:

```jsonc
{
  "schemaVersion": 1,
  "kind": "import",            // "import" | "derived"
  "origin": {
    "type": "import",
    "importBatchId": "e3f1…",  // import only — the batch handle
    "format": "csv",           // json | csv
    "name": "sis-export.csv",  // optional human label (body.sourceName / fileName)
    "externalId": "sis-1042",
    "recordIndex": 3,          // 1-based row number in the batch
    "materialId": null,        // derived only — the source record id
    "sourceExternalId": null,  // derived only — the source's external id
    "relation": null           // derived only — e.g. "adaptation"
  },
  "transform": { "version": "import@1", "step": "import" },
  "actor": { "walletAddress": "0x…", "userId": "…" },
  "recordedAt": "2026-09-30T12:00:00.000Z",
  "revisions": [
    { "at": "2026-10-01T09:00:00.000Z", "actor": { "walletAddress": "0x…" }, "source": "creator", "changedFields": ["title"] }
  ]
}
```

`transform.version` is the pipeline version (`TRANSFORM_VERSIONS` in the
module). Bump it whenever an import or derive pipeline changes the shape or
meaning of the data it produces — that is what lets a maintainer tell a record
written by the old pipeline from one written by the new one.

The `origin` is **immutable**. Updates never rewrite it; they only append to
`revisions` (capped at the 50 most recent). A record can therefore never be
made to look like it came from somewhere else.

## Imported records

[`POST /api/materials/import`](material-import.md) attaches an import
provenance on every `create`, and on every `update` to a record that already
has provenance it appends a revision. A record created before this feature
existed that is first touched by an import also gets an origin, so it does not
stay dark.

Optional request field: `sourceName` (or `fileName`) — a label for the file the
batch came from, echoed into `origin.name`.

## Derived records

`POST /api/materials` accepts an optional `derivedFrom` on create:

```jsonc
{
  "title": "Adapted algebra notes",
  "storageKey": "ipfs://bafy…",
  "derivedFrom": { "materialId": "66f…", "relation": "adaptation" }
  // or: "derivedFrom": "66f…"
  // or: { "externalId": "sis-1042" }
}
```

The route resolves the source by `materialId`, then by `externalId`, and
records `origin.materialId` / `origin.sourceExternalId`. If the source cannot
be resolved the create is rejected with `400` — a derivative must point at a
real record at creation time.

After creation the source may be deleted. The derivative keeps the id, and the
tracer reports the source as deleted rather than losing the link.

## Tracing and deleted sources

`traceProvenance(provenance, { resolveSource })` walks a derivative's ancestry.
A missing or soft-deleted source returns
`{ sourceDeleted: true, chain: [{ exists: false, … }] }` instead of throwing,
because a maintainer investigating a derivative needs to know the source is
gone. Cycles are detected and reported via `broken`.

## Maintainer view and export

`GET /api/admin/provenance` (admin only) returns flattened provenance rows plus
a summary. Filters:

| Query param | Effect |
| --- | --- |
| `kind` | `import` or `derived` |
| `importBatchId` | every record from one batch |
| `actor` | records acted on by a wallet address |
| `materialId` | one record |
| `limit` | 1–5000 (default 500) |
| `format=csv` | download a CSV instead of JSON |

Derived rows include `sourceDeleted` and `traceDepth`, resolved from a
preloaded ancestor closure (bounded to 10 hops). The summary counts imported,
derived, natively-created, untracked, and sources-deleted records plus total
revisions.

Example:

```bash
curl -s "$APP/api/admin/provenance?importBatchId=e3f1…" | jq '.summary'
# { "total": 12, "imported": 12, "derived": 0, "native": 0, "untracked": 0, "sourcesDeleted": 0, "revisions": 3 }
```

## Indexes and deployment

`REQUIRED_INDEXES.materials` in
[`src/lib/backend/schemaContracts.js`](../src/lib/backend/schemaContracts.js)
adds four indexes: `provenance.kind`,
`provenance.origin.importBatchId`, `provenance.origin.materialId`, and
`provenance.actor.walletAddress` (the id/batch/actor ones sparse). Run
`npm run db:indexes`, or let `ensureIndexes` run on startup. No data migration
is needed — records without a `provenance` field simply report as `none`.

## Tests

`tests/backend/provenance.test.mjs` covers import metadata, transform
versions, update revision handling, deleted-source tracing, cycle detection,
and the export/summary/CSV path:

```bash
npm run test:backend
```
