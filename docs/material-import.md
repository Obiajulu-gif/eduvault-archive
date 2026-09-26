# Material import pipeline

`POST /api/materials/import` bulk-creates or updates a creator's materials from a JSON payload. Every import can be previewed with a dry run first, and a repeated import doesn't create duplicates. The schema is in [`openapi.yaml`](openapi.yaml) (`MaterialImportRecord`, `MaterialImportResponse`, `MaterialImportCommitResponse`).

## Format

```json
{
  "format": "json",
  "dryRun": true,
  "records": [
    { "externalId": "sis-1042", "title": "Algebra notes", "storageKey": "ipfs://bafy...", "price": 2, "subject": "algebra" }
  ]
}
```

- `format`: `json` (default) or `csv`. For `csv`, the client parses the file into `records`.
- `dryRun`: defaults to `true`. Send `false` explicitly to write.
- `records` (or `items`): between 1 and 500 rows.

### Row validation

| Field | Rule |
| --- | --- |
| `title` | required, up to 160 characters |
| `storageKey` / `fileUrl` | required |
| `externalId` | optional, up to 128 characters; unique per creator |
| `price` | a number ≥ 0 |
| `visibility` | `private` (default), `public`, `unlisted` |
| `category`, `subject`, `level` | must resolve in the [taxonomy](taxonomy.md) |
| `coverImageUrl`, `thumbnailUrl` | `http`, `https`, or a relative path. `javascript:`, `data:` and protocol-relative (`//host`) URLs are rejected |
| `description` | HTML is sanitized with `sanitizeRichText` (scripts and event handlers are removed) |

Two rows in the same batch with the same `externalId` or `storageKey` are both flagged as errors, except for the first occurrence.

## What each row does

Rows are matched against the caller's existing materials only:

| Action | When |
| --- | --- |
| `create` | no existing material has this `externalId` or `storageKey` |
| `update` | the `externalId` matches and at least one field differs (`fields` lists which) |
| `skip` | the `externalId` matches with no changes, or a row without an `externalId` has a `storageKey` that was already imported |
| `error` | the row failed validation or duplicates an earlier row |

**Idempotency:** rows with an `externalId` can be re-imported safely. Re-running the same file gives all `skip`, and an edited file gives `update`. A unique index on `{ userAddress, externalId }` also blocks duplicates when two imports run at the same time. Rows without an `externalId` can never be updated, only created or skipped.

## Dry run

Dry runs only read from the database. Nothing is written: no materials, quarantine records, history or notifications.

```json
{
  "dryRun": true, "total": 4, "valid": 3, "invalid": 1,
  "summary": { "create": 1, "update": 1, "skip": 1, "error": 1 },
  "rows": [
    { "row": 1, "action": "skip", "externalId": "sis-1041", "materialId": "66f…", "reason": "No changes" },
    { "row": 2, "action": "update", "externalId": "sis-1042", "materialId": "66f…", "fields": ["title"] },
    { "row": 3, "action": "create", "externalId": "sis-1043" },
    { "row": 4, "action": "error", "errors": [{ "field": "title", "message": "Title is required" }] }
  ],
  "invalidRows": [{ "row": 4, "errors": [{ "field": "title", "message": "Title is required" }] }],
  "message": "Dry run: no records were written"
}
```

The status is `200` when no rows have errors and `400` when any do.

## Committing

| Status | Meaning |
| --- | --- |
| `400` | at least one row has an `error`. **Nothing is written**, so one typo never leaves a file half-applied |
| `200` | every row was `skip`, so there was nothing to write |
| `201` | every create and update was written |
| `207` | partial: some writes failed (see `failedRows`) |
| `500` | every write failed |

A committed response adds `importBatchId`, `created`, `updated`, `imported` (created + updated), `failedRows` and `rollback`. The creator also gets an `import_completed` or `import_partial_failure` notification.

## Fixing invalid rows and partial imports

- **Invalid rows (400):** fix each entry in `invalidRows` (the `row` number is its 1-based position in `records`), then dry-run again until `summary.error` is 0.
- **Partial import (207):** the rows that succeeded are already saved. Fix the rows in `failedRows` and re-run the **same file**. Rows with an `externalId` that already succeeded are skipped, so only the failed rows get written. A `code: 11000` failure means another import created that `externalId` first; a dry run will now show that row as `skip` or `update`.
- **Rolling back an import:**
  - To undo creates, delete `materials` with `{ importBatchId: "<id>" }`. `materials_import_batch_idx` indexes that field.
  - To undo updates, use the `material_history` entries with `changeReason: "import <id>"`. Their `changes` store the `from` value of every field the import changed. Materials an import updated also carry `lastImportBatchId`.

## Deployment

Run `npm run db:indexes`, or let `ensureIndexes` run on startup, to create `materials_import_external_id_idx` (unique, partial on `externalId`) and `materials_import_batch_idx`. No data migration is needed because existing materials have no `externalId`.
