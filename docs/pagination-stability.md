# Pagination Stability Documentation

## Overview

This document explains the pagination implementation strategy for EduVault, ensuring stable and predictable list behavior when records are created, updated, or hidden during user navigation.

## Problem Statement

Offset-based pagination (`SKIP/LIMIT`) can cause instability when the underlying dataset changes:
- **Duplicates**: Inserting a record before the user's position shifts all subsequent pages, causing the first item of page N+1 to appear as the last item of page N.
- **Skipped records**: Deleting a record shifts the dataset backward, causing page N+1's first item to be skipped.
- **Inconsistent ordering**: Without deterministic tie-breaking, records with identical sort values can appear in different positions across requests.

## Solution: Cursor-Based Pagination

### Architecture

**Cursor encoding**: Each cursor encodes the complete sort key of the last item on the current page:
```javascript
{
  _id: "507f1f77bcf86cd799439011",
  createdAt: "2024-11-07T10:30:00.000Z",
  price: 29.99
}
```

**Base64url-encoded** for transport safety and compactness.

**Cursor decoding**: The next page query uses range comparisons (`$gt` / `$lt`) instead of offset arithmetic:
```javascript
{
  $or: [
    { createdAt: { $lt: "2024-11-07T10:30:00.000Z" } },
    {
      createdAt: "2024-11-07T10:30:00.000Z",
      _id: { $lt: ObjectId("507f1f77bcf86cd799439011") }
    }
  ]
}
```

### Deterministic Ordering

All pagination queries include `_id` as the final tie-breaker:
```javascript
sort: { createdAt: -1, _id: -1 }
```

This ensures:
- Records with identical `createdAt` values always appear in the same order.
- Pagination cursors uniquely identify a position in the dataset.
- Concurrent inserts do not shift already-paginated results.

### Supported Sort Patterns

| Sort By | MongoDB Index | Cursor Fields |
|---------|---------------|---------------|
| Newest | `{ createdAt: -1, _id: -1 }` | `createdAt`, `_id` |
| Price (ascending) | `{ price: 1, createdAt: -1, _id: 1 }` | `price`, `createdAt`, `_id` |
| Price (descending) | `{ price: -1, createdAt: -1, _id: -1 }` | `price`, `createdAt`, `_id` |
| Rating | `{ rating: -1, createdAt: -1, _id: -1 }` | `rating`, `createdAt`, `_id` |
| Popular | `{ likes: -1, rating: -1, createdAt: -1, _id: -1 }` | `likes`, `rating`, `createdAt`, `_id` |

### Filter Consistency

**Catalog visibility rules** are enforced by `buildMarketplaceDiscoveryQuery()`:
```javascript
{
  visibility: "public",
  archived: { $ne: true },
  moderationStatus: { $ne: "suspended" },
  isDeleted: { $ne: true },
  creatorSuspended: { $ne: true },
  legalTombstone: { $ne: true }
}
```

**Applied uniformly** to:
- Initial page load
- Cursor-based pagination
- Facet aggregation pipelines
- Single material fetch by ID

**Soft-deleted materials** are excluded from public catalog queries but remain accessible to entitled buyers via the `/api/download` route, which bypasses catalog filters and authorizes on entitlement only.

## API Usage

### Request Parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `paginationType` | `cursor` \| `offset` | Pagination strategy | `cursor` |
| `cursor` | string | Opaque cursor from previous response | — |
| `pageSize` | integer | Results per page (1-100) | 20 |
| `sortBy` | `newest` \| `price_asc` \| `price_desc` \| `rating` \| `popular` | Sort order | `newest` |

### Response Format

```json
{
  "items": [...],
  "pagination": {
    "pageSize": 20,
    "hasNextPage": true,
    "nextCursor": "eyJfaWQiOiI2NzJkM2Y4YzQxZjdhYzAwMTIzNDU2NzgiLCJjcmVhdGVkQXQiOiIyMDI0LTExLTA3VDEwOjMwOjAwLjAwMFoifQ",
    "paginationType": "cursor"
  },
  "facets": {...}
}
```

### Client Integration

```javascript
const loadNextPage = async (cursor) => {
  const params = new URLSearchParams({
    paginationType: 'cursor',
    pageSize: 20,
    sortBy: 'newest',
    ...(cursor && { cursor })
  });
  
  const response = await fetch(`/api/market-materials?${params}`);
  return response.json();
};
```

## Performance Characteristics

**Cursor-based pagination**:
- ✅ Constant query performance regardless of page depth
- ✅ No duplicate or skipped records under concurrent writes
- ✅ Efficient index-only scans
- ❌ Cannot jump to arbitrary page numbers
- ❌ Cannot compute total page count without full collection scan

**Offset-based pagination** (legacy fallback):
- ✅ Can jump to arbitrary pages
- ✅ Can display total page count
- ❌ Performance degrades linearly with page depth (`SKIP` scans all skipped documents)
- ❌ Duplicates/skips under concurrent writes

**Benchmark results** (from `tests/pagination-performance.test.js`):
- Cursor @ page 50: ~5ms, 20 documents examined
- Offset @ page 50: ~180ms, 1000+ documents examined

## Testing Strategy

### Automated Tests

**Unit tests** (`tests/backend/marketplace-discovery.test.mjs`):
- Cursor encoding/decoding round-trip
- Cursor clause generation for each sort pattern
- Invalid cursor rejection

**Integration tests** (`tests/pagination-stability.test.mjs`):
- No duplicates across pages when records are inserted mid-pagination
- No skipped records when records are deleted mid-pagination
- Deterministic ordering with identical sort values
- Hidden/archived/suspended records are consistently excluded

**Performance tests** (`tests/pagination-performance.test.js`):
- Cursor vs offset performance at various page depths
- Index coverage verification

### Manual Validation

1. Load marketplace with 1000+ materials
2. Navigate to page 5 (cursor-based)
3. While keeping the page open, have another user create 10 new materials
4. Click "Next page"
5. **Expected**: No duplicates from page 5 appear on page 6
6. **Verify**: No materials are skipped in the sequence

## Migration Path

**Current state**: Both cursor and offset pagination are supported via `paginationType` parameter.

**Rollout plan**:
1. ✅ Deploy cursor-based pagination with feature flag (completed)
2. ✅ Monitor error rates and performance metrics (ongoing)
3. 🔄 Migrate frontend components to cursor-only mode (in progress)
4. ⏳ Deprecate offset pagination after 30-day observation period
5. ⏳ Remove offset code paths and tests

**Backward compatibility**: Legacy clients using `page` parameter will continue to receive offset-based responses until the deprecation deadline.

## References

- Implementation: `src/lib/backend/marketplaceDiscovery.js`
- API route: `src/app/api/market-materials/route.js`
- Index setup: `scripts/setup-db-indexes.js`
- Tests: `tests/backend/marketplace-discovery.test.mjs`
- Soft-delete logic: `src/lib/db/softDelete.js`
