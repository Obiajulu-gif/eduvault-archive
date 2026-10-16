# Quota Management

EduVault implements a quota management system for expensive operations such as storage uploads. This ensures fair usage and prevents accidental resource exhaustion or malicious abuse.

## Quotas Defined
- **Storage**: By default, users are limited to 500MB of storage usage for their uploaded materials (files and thumbnails).
- **Compute / API / Indexing**: Other expensive operations (such as API rate-limits and background job capacity) may be controlled via quotas in the future.

## API Contracts

### Admin Endpoints
Maintainers can inspect, reset, or override quota usage by actor or resource.

**Endpoint**: `GET /api/admin/quotas`
- **Query Params**:
  - `actorId` (required): The wallet address or user ID.
  - `resource` (optional): The resource to check (e.g. `storage`). Defaults to `storage`.
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
  - `resource` (required): The resource (e.g., `storage`).
  - `action` (required): Either `reset` or `override`.
  - `limit` (required if action is `override`): The new limit in bytes/units, or `-1` for unlimited.
- **Example**:
  ```json
  {
    "actorId": "user123",
    "resource": "storage",
    "action": "override",
    "limit": 1073741824
  }
  ```

## Development and Testing
- User quotas are enforced in the relevant handlers (like `src/app/api/upload/route.js`).
- The generic user quota manager is located at `src/lib/quotaManager.js`.
- Run tests via `npm run test` or `npx vitest run src/lib/quotaManager.test.js`.
