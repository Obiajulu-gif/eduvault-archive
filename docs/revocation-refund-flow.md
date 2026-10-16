# Revocation and Refund Flow for Purchase Entitlements

**Date:** 2026-09-27
**Author:** nonsobethel0-dev
**Issues:** #754

## Overview

This document defines the refund/dispute workflow for purchase entitlements. When a purchase is refunded, disputed, or reversed, the buyer's download entitlement must be revoked consistently.

## State Machine

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  REQUESTED  │────▶│ UNDER_REVIEW │────▶│   APPROVED   │
└─────────────┘     └──────────────┘     └──────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   REJECTED   │
                    └──────────────┘
```

### States

| State | Description | Entry Conditions |
|-------|-------------|------------------|
| `REQUESTED` | Refund request submitted | Buyer initiates refund |
| `UNDER_REVIEW` | Creator/admin reviewing | Auto-transition after submission |
| `APPROVED` | Refund approved, revocation pending | Creator/admin approval |
| `REJECTED` | Refund denied | Creator/admin rejection |

## API Endpoints

### POST /api/v1/refunds/request
- **Auth:** Buyer (authenticated)
- **Input:** `{ purchaseId, reason }`
- **Output:** `{ refundId, status: "REQUESTED" }`
- **Behavior:** Creates refund request, notifies creator

### POST /api/v1/refunds/:id/approve
- **Auth:** Creator or Admin
- **Input:** `{ refundId, refundAmount }`
- **Output:** `{ refundId, status: "APPROVED" }`
- **Behavior:** Triggers entitlement revocation and refund payment

### POST /api/v1/refunds/:id/reject
- **Auth:** Creator or Admin
- **Input:** `{ refundId, reason }`
- **Output:** `{ refundId, status: "REJECTED" }`
- **Behavior:** Notifies buyer of rejection

### GET /api/v1/refunds/:id
- **Auth:** Buyer, Creator, or Admin
- **Output:** `{ refundId, status, ...details }`

## Entitlement Revocation

When a refund is approved:

1. **Invalidate cached entitlements:**
   - Remove from entitlement cache (Redis/memory)
   - Set cache entry to `revoked: true` with TTL

2. **Revoke issued download URLs:**
   - Add `refundId` to revocation list
   - Any download URL issued before revocation is invalidated
   - New URLs check revocation list before issuance

3. **Audit logging:**
   - Log `{ refundId, purchaseId, buyerId, creatorId, timestamp }`
   - Log `{ entitlementRevoked: true, cacheInvalidated: true }`

## Edge Cases

### Partial Refunds
- Partial refunds reduce entitlement tier but don't revoke access
- Entitlement is modified to reflect reduced coverage

### Bundle Purchases
- Refund applies to entire bundle unless line-item specified
- All materials in bundle are revoked on full refund

### Creator Pulls Listing
- Creator can request removal after sale
- Requires admin approval to prevent abuse
- Buyer is notified and offered refund

## Database Schema

```sql
CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES purchases(id),
  buyer_id UUID NOT NULL,
  creator_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'REQUESTED',
  reason TEXT,
  refund_amount BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE revocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id UUID NOT NULL REFERENCES refunds(id),
  entitlement_id UUID NOT NULL,
  revoked_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_by UUID NOT NULL
);
```
