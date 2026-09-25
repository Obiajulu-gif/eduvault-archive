# Pull Request: Marketplace Trust, Discovery, and Analytics Hardening

## Summary

This PR closes #768, #769, #770, and #771 by replacing unstable marketplace pagination, adding incremental discovery indexing safeguards, introducing creator-facing ranking-manipulation review, and separating raw analytics events from trusted counters.

## Changes

### #768 - Cursor-based marketplace pagination

- Marketplace pagination now defaults to opaque cursor/keyset pagination.
- Sorts use stable compound keys with `_id` tie-breaking for newest, price, rating, and popular views.
- Invalid cursors return `400` instead of silently restarting from the first page.
- The marketplace client uses `useInfiniteQuery` and a Load more flow, avoiding numbered offsets.
- Added cursor tests covering compound ordering and concurrent insertion behavior.

### #769 - Search-ranking manipulation detection

- Added tunable heuristic scoring for keyword-density anomalies and near-duplicate listings within a creator catalog.
- Flagged listings are marked `pending_review` and routed to `moderation_cases`; they are not automatically rejected.
- Added policy-versioned assessments and near-duplicate evidence for admin review.
- Updated the moderation dashboard actions to use the existing propose-then-approve workflow.

### #770 - Incremental discovery index updates

- Existing material edit/create outbox projection flow is retained and invoked after listing changes.
- Monotonic projection versions prevent out-of-order updates from overwriting newer search documents.
- Existing retry, dead-letter, and reconciliation behavior is documented and operationally indexed.
- Search projections now exclude listings pending manipulation review.
- Added documented propagation-latency measurement using material `updatedAt` and projection `projectedAt`.

### #771 - Bot-resistant analytics

- Added asynchronous view/download event ingestion through the existing side-effect outbox worker.
- Raw events are retained in `material_analytics_events` with hashed viewer identity and a unique dedupe key.
- Events are deduplicated per material/viewer/event type within a 30-minute window.
- Known bot agents, non-browser requests, unengaged loads, and creator traffic are counted as filtered rather than trusted.
- Creator analytics exposes trusted and filtered views/downloads plus the dedupe-window methodology.
- Download capability issuance now feeds the same analytics pipeline.

## Files and operational notes

- Run `scripts/setup-db-indexes.js` against the projection database to create cursor and analytics indexes.
- Run the existing search reconciliation route/job periodically with repair enabled to detect and repair projection drift.
- Tune manipulation thresholds with `MANIPULATION_MAX_KEYWORD_DENSITY` and `MANIPULATION_NEAR_DUPLICATE_SIMILARITY`.
- Set `ANALYTICS_HASH_SECRET` in production so viewer hashes are stable without persisting raw viewer identifiers.

## Test plan

- `node --check` passes for all modified server modules.
- VS Code diagnostics report no errors in touched files.
- Added focused tests for analytics deduplication, manipulation scoring, and cursor mutation safety.
- Full Vitest execution remains pending because the workspace dependency installation is blocked by the existing lockfile `undici` mismatch and a restricted remote JSR dependency.

Closes #768
Closes #769
Closes #770
Closes #771
