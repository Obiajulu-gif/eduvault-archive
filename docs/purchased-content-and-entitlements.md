# Purchased content and Soroban entitlements

EduVault's buyer library is available at `/dashboard/purchases`. It lists an
authenticated buyer's completed purchases and requests a protected download URL
only after the access API verifies the buyer's active entitlement.

The Soroban `purchase-manager` contract is the source of truth for purchased
access:

- `has_entitlement(material_id, buyer)` returns whether an active entitlement
  exists for a material/buyer pair.
- `get_entitlement(material_id, buyer)` returns the associated purchase record
  when callers need purchase metadata.
- refunds revoke an entitlement, so protected-download callers must treat a
  missing or inactive entitlement as denied access.

Payment and entitlement behavior is covered in
`soroban/contracts/purchase-manager/src/test.rs`, including successful
purchases, duplicate prevention, entitlement reads, refunds, and TTL renewal.
