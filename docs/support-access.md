# Time-Bounded Maintainer Impersonation / Support Access

`src/lib/auth/supportAccess.js` + admin routes + expiry sweep

## What it is

Maintainers occasionally need to see what a user sees (billing issues,
"my download doesn't work" reports). This feature makes that access:

- **Scoped** — every session carries an explicit scope list from
  `SUPPORT_SCOPES` (`read`, `billing`, `refunds`, `moderation`). Guards check
  the specific scope; there is no implicit "god mode".
- **Time-bounded** — TTL is clamped to **[5 min, 60 min]** (default 30 min).
  `expiresAt` is enforced on every validation; `npm run support:expire`
  (cron) keeps statuses honest and writes a summary ledger record.
- **Audited, unavoidably** — session creation appends
  `support.access_started` to the immutable hash-chained `audit_ledger`
  **before** the session row is inserted; guarded use appends
  `support.access_used` **before** the action proceeds. If the ledger is
  unavailable: creation throws and use fails closed with HTTP 503. An
  un-auditable support action cannot happen.
- **User-visible** — `GET /api/support/sessions` returns the signed-in user's
  active sessions as sanitized notices (scopes, window, reason — never actor
  ids or token material).
- **Token-safe** — a 32-byte bearer token is generated once, returned to the
  maintainer's browser as an httpOnly `support_session` cookie, and only its
  SHA-256 hash is persisted. Tokens never appear in audit records.

## API

| Route | Auth | Behaviour |
| --- | --- | --- |
| `POST /api/admin/support-sessions` | admin | `{ userId, reason, scopes?, ttlMinutes? }` → creates session, sets cookie. 400 invalid input, 403 non-admin/suspended target, 404 unknown target, 500 persistence failure (no session created) |
| `GET /api/admin/support-sessions` | admin | Lists sessions started by the calling admin (`?targetUserId=&limit=`) |
| `DELETE /api/admin/support-sessions/[id]` | admin | Revokes (any admin may revoke; revoker recorded). Clears caller cookie |
| `GET /api/support/sessions` | signed-in user | Own active sessions as user-safe notices |

Library surface (`src/lib/auth/supportAccess.js`): `createSupportSession`,
`resolveSupportSession`, `requireSupportAccess` (the scoped guard any admin
tool calls), `recordSupportUse`, `revokeSupportSession`,
`expireSupportSessions`, `buildSupportNotice`, `toUserSafeNotice`,
`hasSupportScope`.

```js
// Guarding an admin tool that needs to act on a user's behalf:
const guard = await requireSupportAccess({
  db,
  request,
  scope: SUPPORT_SCOPES.BILLING,
  resource: "purchases.read",
});
if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
// guard.session.targetUserId is the impersonated user; the use is already audited.
```

## Operational edge cases

| Case | Behaviour | Operator note |
| --- | --- | --- |
| Maintainer's admin role revoked mid-session | `resolveSupportSession` re-checks the actor on every resolution → 401 | Revocation of the role ends impersonation immediately |
| `expiresAt` passes between checks | Next validation returns null and lazily marks the session `expired` (+ ledger record) | Cron sweep is status hygiene only; enforcement does not depend on it |
| Audit ledger unavailable | Creation throws; guarded use returns 503 | Investigate the ledger first — never "retry without audit" |
| Session row insert fails after audit append | Request fails; ledger keeps the intent record (append-only) | Retry creates a new session id; orphan intent record is harmless evidence |
| Target user suspended | Creation rejected (403) | Suspension must not be bypassable via support access |
| Maintainer tries to impersonate themselves | 400 `self_target_forbidden` | Use a normal admin session |
| Overlapping sessions | Allowed; each is independently scoped/expiring/audited | Revoke individually; `GET` lists all |
| Token leak (e.g. shared terminal) | Revoke via `DELETE /api/admin/support-sessions/[id]` — effective immediately | The cookie is inert once revoked |

## Failure modes and diagnosis

- **"Support session is required" (401)**: no cookie, expired, revoked, or the
  actor is no longer an admin. Check `support_sessions` for the token hash
  (`sha256(token)`) — the raw token cannot be recovered by design.
- **503 "audit unavailable"**: the ledger append failed. Check Mongo and the
  `audit_ledger` health; do not add a bypass.
- **Audit forensics**: filter the ledger by action
  (`support.access_started`, `support.access_used`, `support.access_revoked`,
  `support.access_expired`), actor, and target user id. Usage records carry the
  resource (`intent.resource`) and timestamp.
- **Sweep not running**: statuses stay `active` past expiry but every
  validation still denies — fix the cron/`npm run support:expire` schedule,
  don't extend sessions.

## Rollback / recovery

1. **Revoke access now**: `DELETE /api/admin/support-sessions/<id>` (any
   admin). No redeploy needed.
2. **Disable the feature entirely**: remove the admin routes / revert the
   `support_sessions` registry entry. Existing rows remain as forensic data;
   nothing else reads them except the user-safe notice route.
3. **Data hygiene**: sessions are never deleted automatically (they are
   audit-relevant). If retention requires pruning, agree on a period
   (e.g. 180 days of expired/revoked sessions) and prune deliberately — the
   ledger records remain regardless.
4. **Suspected abuse**: export ledger records for the actor from
   `audit_ledger`, cross-reference `useCount`/`lastUsedAt` on the session, and
   preserve both before any pruning.

## Tests

`tests/backend/supportAccess.test.mjs` — admin-only creation, TTL clamping,
token hashing (raw token never persisted), audit-first fail-closed creation,
scope enforcement, use auditing + use counting, 401/403/503 guard paths,
lazy expiry + sweep, revocation, and notice sanitization.

Run: `npx tsx --test tests/backend/supportAccess.test.mjs`
