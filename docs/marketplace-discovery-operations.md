# Marketplace Discovery Operations

## Incremental indexing

Material writes increment `searchVersion` and enqueue a `material_search_sync` outbox intent. The side-effect worker applies only that material's projection. Projection writes reject versions older than the stored `projectionVersion`, so out-of-order delivery cannot overwrite a newer edit. Failed intents retry with bounded backoff and become dead-lettered after the configured attempt limit.

`reconcileMaterialSearch` is the repair path. Run the reconciliation route or worker periodically with `repair=true`; it compares every material's current version to its projection and repairs missing or stale documents. Monitor the reconciliation audit collection and outbox dead-letter collection.

The target operational measure is edit-to-search visibility latency: record `updatedAt` on the material and `projectedAt` on the search document, then report `projectedAt - updatedAt`. The default worker poll interval is 5 seconds (`SIDE_EFFECT_POLL_MS`), so normal propagation should be measured in seconds rather than treated as synchronous.

## Analytics methodology

Raw view and download events are retained in `material_analytics_events`. The event key combines event type, material, a keyed viewer identifier, and a 30-minute bucket. Duplicate inserts are ignored. Known bot agents, non-browser requests, unengaged loads, and creator traffic increment filtered counters; only other events increment trusted counters. Thresholds and classifier behavior are versioned in the raw event fields so the trusted-count calculation can be recomputed later.