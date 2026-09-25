# Marketplace search strategy

## Query strategy

The marketplace reads the denormalized `material_search_documents` collection. Equality filters are applied first (`visibility`, `category`, `subject`, and similar fields), followed by price/rating ranges and a deterministic sort. The declared compound indexes cover the common UI shapes:

| Query shape | Index |
| --- | --- |
| category + price range + newest | `material_search_category_price_newest_idx` |
| subject + rating + newest | `material_search_subject_rating_newest_idx` |
| category + rating + newest | `material_search_category_rating_newest_idx` |
| popular | `material_search_popular_idx` |

Run `npm run db:indexes` (or allow application startup to call `ensureIndexes`) after deploying new declarations. Production checks should use `find(query).sort(sort).explain("executionStats")` and alert when `executionStats.totalKeysExamined` is disproportionate to returned rows or a `COLLSCAN` appears.

## Typo-tolerant and faceted search

A search term is normalized into tokens. Each token must match at least one searchable field using a bounded near-match regular expression, and all ordinary catalog filters remain part of the same MongoDB query. This fallback requires no separate service and keeps MongoDB writes authoritative. `includeFacets=true` runs a `$facet` aggregation over the same filters and returns counts for category, subject, level, language, and file type.

For larger catalogs, Atlas Search is the preferred next step: use a fuzzy text operator for relevance and a facet operator for counts, while retaining the MongoDB projection as the source of truth. The application fallback can remain available during index rebuilds or local development. If a separate search engine is introduced, consume the existing material search outbox intents rather than writing to the index from request handlers.

## Relevance formula

For `search` requests, results receive a deterministic score:

`0.55 * text + 0.15 * popularity + 0.15 * recency + 0.10 * rating + 0.05 * completeness`

Text is the fraction of query tokens present in searchable fields. Popularity is a capped logarithmic likes score, recency is an exponential 180-day decay, rating is normalized to five stars, and completeness counts title, description, summary, and thumbnail. Popularity is capped and freshness has its own weight so new, complete listings are not permanently buried. The returned `relevanceScore` is rounded for observability and debugging.

## Measurement and review

Record p50/p95 latency, result click-through rate, facet-request rate, and MongoDB execution statistics by query shape. Benchmark with at least 100,000 representative projection documents before enabling a new index broadly; compare write latency and storage size before and after index creation. Any new filter or sort must add a documented query shape, an explain check, and a representative ranking test.
