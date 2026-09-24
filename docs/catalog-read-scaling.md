# Marketplace catalog read scaling

Anonymous catalog queries use Redis read-through caching. Keys include a global
catalog revision and retain the existing ten-minute TTL. Material create, edit,
delete/restore, and creator-profile writes increment the revision, making stale
price, availability, and creator data unreachable immediately without an
expensive key scan. The TTL then reclaims superseded generations.

Personalized buyer ranking bypasses the shared cache. Search projection documents
remain the denormalized read model; material writes enqueue projection updates,
and profile writes invalidate the catalog revision until the projection sync has
refreshed creator fields.

The route contract test demonstrates the load reduction: a hot-cache request
performs zero MongoDB collection operations, versus one count and one page query
for an uncached offset page. Production latency should be tracked at p50/p95 for
cache-hit and cache-miss paths, alongside hit ratio and MongoDB query volume.
