# PR Description

## Overview
This PR resolves four critical platform issues across UI accessibility, database indexing transactions, discovery filtering, and dashboard navigation:
- **#342**: Adds interface review checklist & UI accessibility compliance for resource pages.
- **#631**: Guarantees single-transaction atomic updates across raw events, projections, side-effect outbox intents, and indexer checkpoints.
- **#339**: Adds resource language metadata, card badge displays, fallback logic, and discovery query filters.
- **#341**: Implements responsive Quick Action cards on the main dashboard for creating, browsing, and accessing saved resources.

---

## Changes

### Task 1: Add interface review checklist (#342)
**Files:**
- `docs/tasks/resource-pages-interface-review.md` (new)
- `src/components/marketplace/MaterialCard.jsx`
- `src/components/marketplace/MarketplaceFilters.jsx`
- `src/components/materials/ResourceStatusBadge.jsx`

**Details:**
- Performed a WCAG 2.1 Level AA accessibility evaluation for resource pages (`/marketplace`, `/marketplace/[id]`, `/dashboard/upload`, `/library`).
- Documented audit findings covering heading hierarchy (`<h1>`-`<h3>`), form field labels (`aria-label`, `<label htmlFor>`), keyboard navigation (tab order, focus rings, Enter/Space activation), and color contrast ratios in light/dark themes.
- Enforced `focus-visible:ring-2 focus-visible:ring-blue-500` focus indicators on interactive buttons, input fields, and tab controls.

**Acceptance Criteria:**
- ✅ Check headings and labels
- ✅ Check keyboard access
- ✅ Check color contrast
- ✅ Document results

---

### Task 2: Commit indexed events, derived writes, and checkpoints atomically (#631)
**Files:**
- `src/lib/indexer/stellarIndexer.js`
- `src/lib/entitlement.js`
- `tests/backend/indexer-atomic.test.mjs` (new)

**Details:**
- Refactored `applyIndexedEvent` and `runIndexerBatch` in `stellarIndexer.js` to execute raw event persistence (`syncEvents`), aggregate projections (`materials`, `purchases`, `entitlementCache`), side-effect outbox writes (`side_effect_outbox`), and cursor checkpoints (`syncState`) inside single atomic transaction sessions.
- Enforced deterministic idempotency keys across all projections (`materialId`, `materialId:buyerAddress`, `deliveryId`).
- Recorded complete ledger identity metadata (`indexedLedger`, `ledgerHash`, `txHash`) across projection records for replay and rollback safety.
- Updated `getIndexerHealth` to track `blockedEventsCount` alongside lag and dead-letter metrics.
- Added comprehensive unit test coverage in `tests/backend/indexer-atomic.test.mjs` for crash boundary behavior and state convergence.

**Acceptance Criteria:**
- ✅ Crash injection at each boundary creates no gap or double effect
- ✅ Restart and overlapping-worker tests converge to one state
- ✅ Health reports lag, active checkpoint generation, and blocked events

---

### Task 3: Add resource language filter (#339)
**Files:**
- `src/lib/backend/marketplaceDiscovery.js`
- `src/components/marketplace/MarketplaceFilters.jsx`
- `src/components/marketplace/MaterialCard.jsx`
- `src/lib/publishing/checklist.js`
- `tests/backend/marketplace-discovery.test.mjs`

**Details:**
- Added `LANGUAGE_OPTIONS` array and regex/unknown fallback query matching in `marketplaceDiscovery.js`.
- Integrated Language dropdown filter into `MarketplaceFilters.jsx` with full keyboard and aria accessibility.
- Displayed language tag on resource cards in `MaterialCard.jsx`, falling back to `"English"` (or `"Unknown"`) for materials without explicit language metadata.
- Added language field check in recommended publishing checklist in `checklist.js`.
- Added unit tests verifying language query construction and fallback handling in `marketplace-discovery.test.mjs`.

**Acceptance Criteria:**
- ✅ Add language field
- ✅ Show language on cards
- ✅ Add language filter
- ✅ Add fallback for unknown language

---

### Task 4: Add dashboard quick actions (#341)
**Files:**
- `src/app/dashboard/components/QuickActions.jsx` (new)
- `src/app/dashboard/page.jsx`

**Details:**
- Created dedicated `QuickActions.jsx` component featuring responsive action cards:
  1. **Create Resource**: Direct shortcut to resource upload flow (`/dashboard/upload`).
  2. **Browse Resources**: Direct shortcut to marketplace discovery (`/marketplace`).
  3. **Saved Resources**: Direct shortcut to bookmarked/saved items (`/dashboard/library`).
- Styled cards with custom gradient icons, badges, hover micro-animations, and light/dark theme support (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`).
- Replaced static placeholder links in `src/app/dashboard/page.jsx` with the interactive `QuickActions` component.

**Acceptance Criteria:**
- ✅ Add create resource action
- ✅ Add browse resources action
- ✅ Add saved resources action
- ✅ Keep cards responsive

---

## Testing Recommendations

### Backend & Indexer Tests
- Run `node --test tests/backend/indexer-atomic.test.mjs` to verify atomic transaction semantics, outbox idempotency, and health metrics.
- Run `node --test tests/backend/marketplace-discovery.test.mjs` to verify language filtering and unknown language fallback logic.
- Run `node --test tests/backend/publishing-checklist.test.mjs` to verify publishing readiness rules.

### UI & Accessibility Verification
- Test focus rings and Tab key navigation on `/marketplace` filter bar and `MaterialCard` buttons.
- Verify responsive card grid scaling on `/dashboard` across mobile (`320px`), tablet (`768px`), and desktop (`1024px+`) viewports.

---

## Security Considerations
- Outbox intents use deterministic delivery IDs to prevent duplicate email receipts or webhook side-effects on event replays.
- Sanitized language query parameters prevent regex pattern injection.
- Atomic indexer checkpoints prevent partial uncommitted projections on unexpected worker terminations.

---

## Breaking Changes
None. All API and database schema changes are additive and backward-compatible.

Closes #342, #631, #339, #341
