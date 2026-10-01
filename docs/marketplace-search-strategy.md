# Marketplace search strategy

## Indexable fields and visibility constraints

Every material is projected into the denormalized `material_search_documents` collection. The projection includes the searchable fields (title, description, summary, category, subject, level, language, fileType, price, rating, likes, thumbnailUrl) and the visibility metadata needed to enforce access controls (visibility, visibilityScope, ownerAddress, indexable, deleted, revoked, archived, searchVersion, updatedAt).

Visibility is normalized into three values:

- `public` - visible to everyone.
- `restricted` - visible only to the owner and addresses listed in `visibilityScope`.
- `private` - never indexed for discovery; only the owner can read it through authenticated endpoints.

Any material that is deleted, revoked, archived, or private is marked `archived: true` / `indexable: false` and removed from the search collection by the projection hook.

## Query strategy

The marketplace reads the denormalized `material_search_documents` collection. Equality filters are applied first (`visibility`, `category`, `subject`, and similar fields), followed by price/rating ranges and a deterministic sort. The declared compound indexes cover the common UI shapes:

| Query shape | Index |
| --- | --- |
| category + price range + newest | `material_search_category_price_newest_idx` |
| subject + rating + newest | `material_search_subject_rating_newest_idx` |
| category + rating + newest | `material_search_category_rating_newest_idx` |
| popular | `material_search_popular_idx` |

Run `npm run db:indexes` (or allow application startup to call `ensureIndexes`) after deploying new declarations. Production checks should use `find(query).sort(sort).explain("executionStats")` and alert when `executionStats.totalKeysExamined` is disproportionate to returned rows or a `COLLSCAN` appears.

## Permission-aware queries

@api/marketplace/search builds its MongoDB query through `buildSearchFilter`:

- Anonymous requests are restricted to `visibility: "public"`.
- Authenticated requests with `includePrivate=tru` add `$or` clauses for the viewer's own materials and for materials whose `visibilityScope` contains the viewer address.
- Every query always applies `indexable: true`, `deleted: { $ne: true }`, `revoked: { $ne: true }`, and `archived: { $ne: true }`.

## Update and delete hooks

Visibility-changing mutations must call `enqueueMaterialSearchProjection` after the authoritative MongoDBB write:

- `PATCH /api/creator/materials/[id]` updates allowed fields (including visibility and visibilityScope) and reprojects the document.
- `DELETE /api/creator/materials/[id]` marks the material deleted and removes it from the search collection.
- `POST /api/creator/materials/[id]/archive` toggles archive state and reprojects.

Each hook writes an intent to `material_search_intents` so external indexers can consume the same events without writing to the index directly.

## Stale-index repair

Run `node scripts/repair-search-index.js` to repair stale or missing index entries. The job:

1. Scans `material_search_documents` for documents that are deleted, revoked, archived, private, or older than `SEARCH_INDEX_MAX_AGE_MS`.
2. Reprojects the corresponding material from the authoritative `materials` collection or deletes the stale document when the material no longer exists or is no longer indexable.
3. Scans indexable materials that are missing from the search collection and upserts them.

Environment variables:

- `SEARCH_INDEX_MAX_AGE_MS` (default `3600000`) - age threshold for treating a projection as stale.
- `SEARCH_INDEX_REPAIR_LIMIT` (default `500`) - maximum number of documents to examine per pass.

The job returns a JSON summary with `scanned`, `repaired`, `removed`, and `missing` counts for observability.

## Typo-tolerant and faceted search

A search term is normalized into tokens. Each token must match at least one searchable field using a bounded near-match regular expression, and all ordinary catalog filters remain part of the same MongoDB query. This fallback requires no separate service and keeps MongoDB writes authoritative. `includeFacets=true` runs a `$facet` aggregation over the same filters and returns counts for category, subject, level, language, and file type.

For larger catalogs, Atlas Search is the preferred next step: use a fuzzy text operator for relevance and a facet operator for counts, while retaining the MongoDB projection as the source of truth. The application fallback can remain available during index rebuilds or local development. If a separate search engine is introduced, consume the existing material search outbox intents rather than writing to the index from request handlers.

## Relevance formula

For `search` requests, results receive a deterministic score:

`0.55 * text + 0.15 * popularity + 0.15 * recency + 0.10 * rating + 0.05 * completeness`

Text is the fraction of query tokens present in searchable fields. Popularity is a capped logarithmic likes score, recency is an exponential 180-day decay, rating is normalized to five stars, and completeness counts title, description, summary, and thumbnail. Popularity is capped and freshness has its own weight so new, complete listings are not permanently buried. The returned `relevanceScore` is rounded for observability and debugging.

## Measurement and review

Record p50/p95 latency, result click-through rate, facet-request rate, and MongoDB execution statistics by query shape. Benchmark with at least 100,000 representative projection documents before enabling a new index broadly; compare write latency and storage size before and after index creation. Any new filter or sort must add a documented query shape, an explain check, and a representative ranking test.
