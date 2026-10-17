# Feature Rollout Guardrails & Emergency Disablement

Operational guide for staged rollout and emergency kill-switch of feature flags
in the eduvault-archive path (#1018).

---

## Overview

Every new risky feature is gated behind a feature flag with a **safe default of
`false`**. A flag must be explicitly enabled to activate new behavior.

There are two layers of control, in priority order:

| Priority | Layer | How to change | Latency |
|---|---|---|---|
| 1 (highest) | **DB override** | `POST /api/admin/feature-flags` | Next request (no restart) |
| 2 | **Env var** | Deploy with `FEATURE_FLAG_<KEY>=true/false` | On next process start |
| 3 (lowest) | **Registry default** | Code change | On next deploy |

A DB override is the **emergency kill-switch** — it takes effect on the very
next request without a code change or restart.

---

## Registered Flags

| Key | Default | Controls |
|---|---|---|
| `ARCHIVE_MATERIAL` | `false` | `POST /api/creator/materials/[id]/archive` — creator archive/restore |
| `LEARNER_DATA_EXPORT` | `false` | `GET /api/learner-export` — learner data export endpoint |
| `CRITICAL_LIFECYCLE_NOTIFICATIONS` | `false` | In-app notifications for purchases, refunds, entitlements |

---

## Normal Rollout Procedure

### Stage 1 — Internal

1. Enable in `.env.local` only:
   ```
   FEATURE_FLAG_ARCHIVE_MATERIAL=true
   ```
2. Verify with the status script: `node scripts/feature-flag-status.mjs`
3. Run the test suite: `npm run test:concurrency && npm test`

### Stage 2 — Staging / Preview

1. Set the env var in the Vercel preview environment.
2. Run smoke tests: `bash scripts/smoke-test.sh`
3. Confirm the feature flag status endpoint: `GET /api/admin/feature-flags`

### Stage 3 — Production (GA)

1. Set `FEATURE_FLAG_ARCHIVE_MATERIAL=true` in the Vercel production
   environment variables.
2. Redeploy (or trigger a restart if the platform supports it).
3. Confirm with: `node scripts/feature-flag-status.mjs --db`
4. Monitor error rates and latency for 30 minutes post-deploy.

---

## Emergency Disablement (Kill Switch)

Use this when a newly-enabled feature causes an incident and you need to disable
it **immediately without a redeploy**.

### Via API (instant, no restart)

```bash
curl -X POST https://<YOUR_APP>/api/admin/feature-flags \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $ADMIN_API_TOKEN" \
  -d '{
    "key": "ARCHIVE_MATERIAL",
    "enabled": false,
    "reason": "P1 incident: archive route triggering cascade failure in indexer"
  }'
```

Takes effect on the **very next request**. No restart needed.

Verify it worked:

```bash
curl https://<YOUR_APP>/api/admin/feature-flags \
  -H "x-admin-token: $ADMIN_API_TOKEN"
# → source: "override", enabled: false
```

Or locally with DB access:

```bash
node scripts/feature-flag-status.mjs --db
# → [disabled] ARCHIVE_MATERIAL  (from DB override)
#              Override by: oncall
#              Reason: P1 incident: ...
```

### Via env var (requires restart)

Set `FEATURE_FLAG_ARCHIVE_MATERIAL=false` in your deployment platform and
trigger a redeploy/restart. Slower than the DB approach but doesn't require
a live DB connection.

---

## Recovery / Rollback After Incident

Once the incident is resolved, re-enable the flag **or** revert the override
to let the env var take effect again.

### Re-enable after fix

```bash
curl -X POST https://<YOUR_APP>/api/admin/feature-flags \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $ADMIN_API_TOKEN" \
  -d '{
    "key": "ARCHIVE_MATERIAL",
    "enabled": true,
    "reason": "incident resolved, fix deployed in v1.2.3"
  }'
```

### Revert override entirely (back to env var)

```bash
curl -X POST https://<YOUR_APP>/api/admin/feature-flags \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $ADMIN_API_TOKEN" \
  -d '{ "key": "ARCHIVE_MATERIAL", "clear": true }'
```

After clearing, the env var value resumes control. If the env var is `true`,
the feature will be re-enabled immediately.

---

## Adding a New Feature Flag

1. Add an entry to `FEATURE_FLAG_REGISTRY` in `src/lib/featureFlags.js`:
   ```js
   MY_NEW_FEATURE: {
     key: 'MY_NEW_FEATURE',
     description: 'What this flag controls.',
     defaultValue: false,           // always false — safe default
     rolloutStages: ['internal', 'beta', 'ga'],
   },
   ```

2. Add to `.env.example`:
   ```
   FEATURE_FLAG_MY_NEW_FEATURE=false
   ```

3. Gate the route handler with `withFeatureGuard`:
   ```js
   import { withFeatureGuard } from '@/lib/featureFlags';

   async function handleMyRoute(request, context) { ... }

   export const GET  = withFeatureGuard('MY_NEW_FEATURE', handleMyRoute);
   export const POST = withFeatureGuard('MY_NEW_FEATURE', handleMyRoute);
   ```
   When the flag is off, every method returns `503 FEATURE_DISABLED`
   automatically without touching any business logic.

4. For routes that need fine-grained control (e.g. flag check mid-handler):
   ```js
   import { resolveFeatureFlag } from '@/lib/featureFlags';

   const db = await getDb();
   const { enabled } = await resolveFeatureFlag('MY_NEW_FEATURE', db);
   if (!enabled) return NextResponse.json({ error: '...' }, { status: 503 });
   ```

5. Add tests — at minimum: disabled path returns 503, enabled path passes
   through, DB override disables when env is enabled.

---

## Operational Edge Cases

| Situation | Behavior | Action |
|---|---|---|
| DB unavailable on `GET /api/admin/feature-flags` | Returns env/default values with `warning` field | Check DB health; values are still accurate for env-controlled flags |
| DB unavailable on `POST /api/admin/feature-flags` | Returns `503 retryable:true` | Retry once DB recovers; fall back to env var in the meantime |
| DB unavailable inside `withFeatureGuard` | Falls back to env/default — **never enables** a disabled flag | Safe; env var remains authoritative until DB recovers |
| Override set, then env var changed | DB override always wins | Clear the override first, then change the env var |
| Two concurrent emergency-disable calls | Both succeed — upsert is idempotent | No data corruption; last writer sets the reason field |
| Flag disabled mid-request | In-flight request completes normally | Only new requests see the disabled state |
| Malformed override in DB (`enabled` is not boolean) | Override is ignored; falls back to env/default | Fix or delete the override doc in MongoDB |

---

## DB Schema

Collection: `feature_flag_overrides`

```json
{
  "_id": ObjectId,
  "key":       "ARCHIVE_MATERIAL",
  "enabled":   false,
  "updatedBy": "oncall-wallet-address-or-user-id",
  "reason":    "P1 incident: cascade failure",
  "updatedAt": ISODate("2026-10-16T...")
}
```

Index: `{ key: 1 }` unique — ensures concurrent emergency-disable calls are
safe (upsert on unique key = last writer wins, no duplicates).

---

## Authorization

The admin flag API requires `admin:access` permission, which is granted to:

- Users with `role === "admin"` in the `users` collection.
- Service callers presenting a valid `ADMIN_API_TOKEN` via the
  `x-admin-token` header (for CI/automation pipelines).

Never expose `ADMIN_API_TOKEN` in client-side code or public CI logs.
