# Material Visibility and Hidden Records (#1103)

## Contract

- Public discovery returns only public, non-hidden materials.
- Hidden/unpublished materials are visible only to owner or admin.
- Visibility changes require owner/admin authorization.

## Enforcement points

- `src/lib/materials/visibilityPolicy.js` - central policy helpers.
- `src/lib/backend/marketplaceDiscovery.js` - public discovery excludes hidden records.
- Any route mutating visibility should call `assertCanChangeVisibility`.

## Edge cases

- Missing `visibility` defaults to public for legacy records unless explicitly hidden.
- `isHidden`/`hidden` flags are treated as hidden.
- Admin override is explicit and audited by calling route.

## Tests

Add/extend tests for:
- normal public listing
- hidden record excluded from non-owner
- owner/admin can access hidden record
- unauthorized visibility change denied
- retry/idempotent update keeps same final state
