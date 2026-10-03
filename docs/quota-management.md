# Quota Management

EduVault implements a quota management system for expensive operations such as storage uploads. This ensures fair usage and prevents accidental resource exhaustion or malicious abuse.

## Quotas Defined
- **Storage**: 500 MiB by default for uploaded materials and thumbnails.
- **Compute**: 1,000 units by default.
- **API**: 5,000 units by default.
- **Indexing**: 100 units by default.

The generic policy helper is in `src/lib/quotaManager.js`. Enforcement is server-side; clients cannot choose the actor identity used by a policy check. Current upload enforcement charges the authenticated upload actor before pinning, so a failed external pin can still consume quota and should be reviewed by a maintainer before a reset.

## Expensive operation coverage

| Operation | Server-side limit |
| --- | --- |
| `/api/upload`, `/api/materials/upload` | File and thumbnail bytes count against storage; each file counts as one compute and one indexing unit. |
| `/api/materials/bulk-upload` | Combined file bytes count against storage; each file counts as one compute and one indexing unit before any Pinata request starts. |
| API request volume | `withApiHardening` applies route-specific request rate limits before handler work. The generic `api` counter is available for future actor-scoped quotas but is not currently used as a second request limiter. |
| Material imports | The endpoint has a 500-row request cap and route rate limit. A commit counts each create/update row as one compute and indexing unit; dry runs consume neither quota and perform no writes. |

Upload quota counters use a unique `(actorId, resource)` key and an atomic conditional increment. Concurrent requests therefore cannot both pass a stale usage check and overspend the same configured limit.

## Deployment

`REQUIRED_INDEXES` declares unique scope indexes for `actor_quotas` and `actor_quota_usage`; `ensureIndexes` creates them during application startup. Run `npm run db:indexes` as part of deployment and inspect startup/index output. If a pre-existing database contains multiple documents for the same actor/resource pair, reconcile those records before enabling the unique indexes.

## API Contracts

### Admin Endpoints
Both endpoints require an active administrator session with `admin:access`. Every reset and override is scoped to exactly one `(actorId, resource)` pair and records an immutable request entry in the audit ledger before the change is applied. If the audit store is unavailable, the change is not applied.

**Endpoint**: `GET /api/admin/quotas`
- **Query Params**:
  - `actorId` (required): The wallet address or user ID.
  - `resource` (optional): One of `storage`, `compute`, `api`, or `indexing`. Defaults to `storage`.
- **Response**:
  ```json
  {
    "actorId": "user123",
    "resource": "storage",
    "used": 15000000,
    "limit": 524288000
  }
  ```

**Endpoint**: `POST /api/admin/quotas`
- **Body Params**:
  - `actorId` (required): The wallet address or user ID.
  - `resource` (required): One of `storage`, `compute`, `api`, or `indexing`.
  - `action` (required): Either `reset` or `override`.
  - `reason` (required): A maintainer explanation of at least 8 characters; stored in the audit ledger.
  - `limit` (required if action is `override`): A non-negative integer in bytes/units, or `-1` for unlimited.
- **Example**:
  ```json
  {
    "actorId": "user123",
    "resource": "storage",
    "action": "override",
    "reason": "Temporary migration import allowance",
    "limit": 1073741824
  }
  ```

## Development and Testing
- User quotas are enforced in the relevant handlers (like `src/app/api/upload/route.js`).
- The generic user quota manager is located at `src/lib/quotaManager.js`.
- Run tests via `npx vitest run src/lib/quotaManager.test.js` and the admin quota route test.

When a user hits a quota, the API returns a safe message that recommends reducing usage or contacting support for a scoped limit change. It does not disclose another actor's quota configuration.
