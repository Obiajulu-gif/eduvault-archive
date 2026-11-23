# Pagination, Filtering, and Authorization Boundary Contracts

## 1. Overview & System Scope

This document formalizes the canonical contracts and boundary rules governing data retrieval, sorting, filtering, and access control across the EduVault architecture. It provides executable verification guarantees across four core execution paths:
1. **Normal Path**: Standard, well-formed requests across public and authorized scopes.
2. **Failure Path**: Malformed parameters, corrupted cursors, invalid filters, and permission rejections.
3. **Retry Path**: Idempotent re-execution, resilience to mid-walk catalog mutations, and safe partial failure recovery.
4. **Authorization Path**: Strict multi-tenant isolation, role and permission gating, and sensitive field stripping.

---

## 2. Boundary Architecture

```
                    ┌────────────────────────────────────────────────────────┐
                    │                    Client Request                      │
                    └──────────────────────────┬─────────────────────────────┘
                                               │
                                 ┌─────────────┴─────────────┐
                                 ▼                           ▼
                        [ Public / Anonymous ]    [ Authenticated / Cookie ]
                                 │                           │
                   ┌─────────────┴─────────────┐             │
                   ▼                           ▼             │
             Public Catalog               Health/Status      │
         (Strict Field Stripping)                            │
                                                             ▼
                                             ┌───────────────────────────────┐
                                             │     Role / Permission Gate    │
                                             └───────┬───────────────┬───────┘
                                                     │               │
                                     ┌───────────────┘               └───────────────┐
                                     ▼                                               ▼
                              [ Buyer Scope ]                               [ Creator Scope ]
                       (Entitlement & Tenant Guard)                     (Ownership & Version CAS)
                                     │                                               │
                                     └───────────────────────┬───────────────────────┘
                                                             │
                                                             ▼
                                                  [ Operator / Admin Scope ]
                                              (Operations & Storage Maintenance)
```

### Four-Tier Boundary Hierarchy

| Boundary Tier | Target Actors | Allowed Entrypoints | Invariant Enforcements |
|---|---|---|---|
| **PUBLIC** | Anonymous users, web crawlers | `/api/market-materials`, `/api/health`, `/api/status` | Sensitive storage keys (`storageKey`, `fileUrl`, `metadataUrl`) strictly stripped; soft-deleted, suspended, or quarantined records omitted. |
| **BUYER** | Authenticated students / purchasers | `/api/purchased-materials`, `/api/saved-materials`, `/api/download`, `/api/notifications` | Verified session cookie; access requires active entitlement (`EVT_ENTITLEMENT_004` if missing); strict tenant isolation (cannot read other buyers' data). |
| **CREATOR** | Content creators / instructors | `/api/materials`, `/api/materials/import`, `/api/creator/payouts` | Requires `creator:manage` permission; mutation requires authorship (`userAddress` matching caller wallet); optimistic concurrency version check (`If-Match` / `expectedVersion`). |
| **OPERATOR_ADMIN** | Maintainers, support staff, operators | `/api/admin/partial-failures`, `/api/admin/storage-jobs`, `/api/admin/support-sessions` | Requires `admin` role or `operations:read` / `operations:write` / `storage:maintain` permissions; all actions recorded to immutable audit ledger. |

---

## 3. Pagination Contract

### 3.1 Cursor-Based Keyset Pagination (Primary)

Cursor pagination provides $O(\log n)$ retrieval performance across arbitrary depths and avoids duplicate or skipped records during concurrent catalog writes.

- **Request Parameters**:
  - `paginationType`: `"cursor"` (default)
  - `cursor`: Opaque, base64url-encoded JSON string containing sort values and the primary tie-breaker `_id`.
  - `pageSize`: Integer in range `[1, 100]` (default: `12` or `20`).
  - `sortBy`: One of `"newest"`, `"price_asc"`, `"price_desc"`, `"rating_desc"`, `"popular"`, `"relevance"`.

- **Cursor Structure**:
  ```json
  {
    "_id": "672d3f8c41f7ac0012345678",
    "s": "createdAt,_id",
    "createdAt": "2026-02-01T12:00:00.000Z"
  }
  ```

- **Response Contract**:
  ```json
  {
    "items": [...],
    "pageSize": 20,
    "hasNextPage": true,
    "nextCursor": "eyJfaWQiOiI2NzJkM2Y4YzQxZjdhYzAwMTIzNDU2NzgiLCJzIjoiY3JlYXRlZEF0LF9pZCIsImNyZWF0ZWRBdCI6IjIwMjYtMDItMDFUMTI6MDA6MDAuMDAwWiJ9",
    "paginationType": "cursor"
  }
  ```

- **Guarantees**:
  - **Deterministic Ordering**: `_id` is always appended as the final tie-breaker in ascending order for identical sort keys.
  - **Terminal Page**: When no additional records exist beyond the current page, `hasNextPage` is `false` and `nextCursor` is `null`.
  - **Signature Integrity**: The `s` field validates that the cursor matches the request's `sortBy`. Changing the sort pattern with a prior cursor returns `400 Bad Request` (`Invalid cursor`).

### 3.2 Offset Pagination (Legacy Fallback)

Maintained for backwards compatibility with legacy integrations:

- **Request Parameters**:
  - `paginationType`: `"offset"`
  - `page`: 1-indexed integer (`>= 1`).
  - `pageSize`: Integer in range `[1, 100]`.

- **Response Contract**:
  ```json
  {
    "items": [...],
    "page": 2,
    "pageSize": 20,
    "total": 150,
    "totalPages": 8,
    "paginationType": "offset"
  }
  ```

### 3.3 Status Precedence Sorting Contract

When listing mixed-status records (e.g. in author dashboards or operations queues), sorting adheres to deterministic status precedence:
1. **Active / Published / Completed** (`precedence: 0`)
2. **Pending / Draft / Investigating** (`precedence: 1`)
3. **Suspended / Quarantined / Appealed** (`precedence: 2`)
4. **Archived / Rejected / Failed** (`precedence: 3`)
5. **Soft-Deleted** (`isDeleted: true`, `precedence: 4`) — always sorts last.

---

## 4. Filtering Contract & Security Invariants

### 4.1 Discovery Query Invariants

Every public catalog query enforces a mandatory predicate set that **cannot be overridden** by user parameters:

```javascript
{
  visibility: "public",
  archived: { $ne: true },
  moderationStatus: { $ne: "suspended" },
  isDeleted: { $ne: true },
  creatorSuspended: { $ne: true },
  $or: [
    { quarantineState: "clean" },
    { quarantineState: { $exists: false } }
  ],
  $and: [
    {
      $or: [
        { relevanceStatus: { $exists: false } },
        { relevanceStatus: { $ne: "low" } }
      ]
    }
  ]
}
```

### 4.2 Query Parameters & Normalization

- **Search Query (`search`)**:
  - Sanitized to max 120 characters, control characters stripped.
  - Normalized with NFKD, punctuation removed, stop words omitted.
  - Fuzzy token matching combined with exact regex clauses.
- **Taxonomy Filters (`subject`, `category`, `level`)**:
  - Normalized via canonical taxonomy tables in `src/lib/backend/taxonomy.js`. Aliases (e.g. `"math"` -> `"mathematics"`) resolve deterministically.
- **Price Range (`minPrice`, `maxPrice`)**:
  - Finite non-negative numbers. Inverted ranges (`minPrice > maxPrice`) yield empty results without query syntax crashes.
- **Rating (`minRating`)**:
  - Clamped to numeric evaluation against `rating` / `averageScore`.
- **Entitlement Personalization**:
  - Supplying `buyerAddress` personalizes result ordering: already-purchased materials sink below unowned listings, marked with `owned: true`, preserving keyset sort order.

---

## 5. Execution Paths

### 5.1 Normal Execution Path
1. Request arrives with valid parameters or headers.
2. Authorization guard validates caller token and checks permissions against target boundary.
3. Query builder applies lifecycle invariants, sanitization, and cursor/offset clauses.
4. Response serializer strips sensitive internal fields (`storageKey`, `fileUrl`, etc.).
5. Response returned with `200 OK` (or `201 Created`) and conforming JSON Schema.

### 5.2 Failure Execution Path
1. **Invalid Cursor (400)**: Corrupted base64, missing keys, operator injection (`$gt`, `$ne` in cursor payload), or signature mismatch. Response: `{ "error": "Invalid cursor" }`.
2. **Unauthenticated (401)**: Missing, malformed, or expired `auth_token` cookie for protected boundaries. Response: `{ "error": "Unauthorized" }`.
3. **Forbidden (403)**:
   - Non-entitled user requesting protected content: `{ "error": "Active entitlement required (EVT_ENTITLEMENT_004)" }`.
   - Creator attempting to mutate another creator's material: `{ "error": "Forbidden: not the material owner" }`.
   - Cross-tenant access attempt: `{ "error": "Tenant boundary violation" }`.
   - Non-admin attempting operator operations: `{ "error": "Forbidden: operations access required" }`.
4. **Concurrency Conflict (409)**: Material edit where `expectedVersion` does not match current persistent version. Response: `{ "error": "Version conflict", "code": "CONFLICT_VERSION" }`.

### 5.3 Retry & Idempotency Path
1. **Repeated Pagination Queries**: Retrying identical cursor requests returns the exact same window of items.
2. **Concurrent Churn**: Inserts or deletes occurring before the cursor boundary do not shift the sequence or duplicate items.
3. **Idempotent Resource Creation**: Submissions carrying an `idempotencyKey` return the existing created document with status `200` (`duplicate: true`).
4. **Partial Failure Remediation**:
   - Safe retries (`canRetrySafely: true`, `requiresUserAction: false`): Increments retry counter, logs audit entry, transitions status to `retrying`.
   - User-action-required retries (`requiresUserAction: true`): Blocked with explicit recovery guidance (e.g., wallet funding or file re-upload required) until user action is confirmed.

---

## 6. Operational Edge Cases & Recovery / Rollback

### 6.1 Edge Cases

| Scenario | Impact | Mitigation / Behavior |
|---|---|---|
| **Mutable Sort Keys** (`price`, `rating`, `likes`) | If a listing's rating changes between pages, it may appear twice or be skipped. | Documented keyset behavior. For exact walks, clients should use `sortBy=newest` (immutable `createdAt` + `_id`). |
| **Trailing Empty Page** | All items beyond the cursor are hidden/deleted mid-walk. | Next page returns `{ items: [], hasNextPage: false, nextCursor: null }`. |
| **Cursor Injection Attempt** | Attackers injecting MongoDB query operators into cursor JSON. | `decodeMarketplaceCursor` strictly enforces primitive-only values and valid `ObjectId` strings. Objects and operator expressions throw immediate 400 errors. |
| **Clock Skew / Stale Tokens** | Server time drift causing invalid signature or date comparisons. | Cursors store ISO timestamps parsed to UTC `Date` objects; authentication uses standard JWT verification tolerances. |

### 6.2 Recovery & Rollback Behavior

- **Client Recovery**:
  - If a client receives `400 Invalid cursor` (due to sort pattern change, expired token, or catalog drift), the client MUST drop the cursor and restart pagination from page 1.
  - If a buyer encounters `403 EVT_ENTITLEMENT_004`, client should prompt to refresh quote or verify blockchain settlement.
- **Server Rollback**:
  - All pagination and filter implementations are stateless and non-destructive.
  - Reverting code changes does not require database repair or schema rollback.
  - Compound indexes (`marketplace_newest_cursor`, `materials_active_catalog_idx`) are non-blocking background indexes that support both cursor and offset paths.

---

## 7. Migration Plan & Contract Preservation

1. **Full Backwards Compatibility**:
   - Existing clients using `page` and offset pagination continue to receive valid offset responses without modification.
   - Cursors issued under older versions (without sort signatures) remain decodable through backwards-compatible fallback parsing.
2. **Contract Preservation**:
   - The OpenAPI 3.1 schema specification remains authoritative.
   - Contract test suite `tests/backend/pagination-filtering-auth-contract.test.mjs` automatically verifies contract compliance across all environments.
