# Marketplace Discovery Operations

## Incremental indexing

Material writes increment `searchVersion` and enqueue a `material_search_sync` outbox intent. The side-effect worker applies only that material's projection. Projection writes reject versions older than the stored `projectionVersion`, so out-of-order delivery cannot overwrite a newer edit. Failed intents retry with bounded backoff and become dead-lettered after the configured attempt limit.

`reconcileMaterialSearch` is the repair path. Run the reconciliation route or worker periodically with `repair=true`; it compares every material's current version to its projection and repairs missing or stale documents. Monitor the reconciliation audit collection and outbox dead-letter collection.

The target operational measure is edit-to-search visibility latency: record `updatedAt` on the material and `projectedAt` on the search document, then report `projectedAt - updatedAt`. The default worker poll interval is 5 seconds (`SIDE_EFFECT_POLL_MS`), so normal propagation should be measured in seconds rather than treated as synchronous.

## Privacy-preserving analytics methodology

Analytics is designed to provide maintainers and creators with reliability and
usage trends without collecting learner activity trails. Each accepted event
increments a daily bucket in `material_analytics_aggregates`; its only
dimensions are `materialId`, UTC `day`, `eventType` (`view`, `download`, or
`purchase`), `source` (`server-confirmed` or `client-reported`),
`classification` (`trusted` or `filtered`), and a coarse `filterReason`.
The measure is a `count`. These dimensions support material usage, conversion,
and server/client reliability comparisons, but cannot identify a learner.

Requests are deduplicated for 30 minutes using a keyed HMAC. The opaque key is
stored alone in `material_analytics_dedupe`, expires automatically after one
hour, and is never returned by an API or export. Wallet addresses, IP
addresses, user agents, request headers, cookies, dwell times, interaction
counts, content, search terms, event payloads, and raw per-event timestamps
are not written to either analytics collection. Values used transiently to
classify traffic are discarded before the outbox intent is stored.

Known bot agents, non-browser requests, unengaged loads, and creator activity
increment `filtered` buckets. Other activity increments `trusted` buckets.
Server-confirmed purchase/download actions are labelled separately from
client-reported beacons so dashboards can show reliability tradeoffs without
claiming the two sources are equivalent. Daily aggregate buckets are retained
until the normal database retention policy removes them; the dedupe collection
is the only short-lived analytics collection.

### Deployment and validation

Set `ANALYTICS_HASH_SECRET` to a unique server-side secret before deploying.
Run `npm run db:indexes` to create the daily-bucket uniqueness and dedupe TTL
indexes. No migration of legacy raw event documents is performed: they must be
handled under the existing data-deletion process because recomputing an
aggregate would extend their retention. Validate the privacy boundary with:

```bash
npx vitest run src/lib/backend/analyticsEvents.test.js
```
