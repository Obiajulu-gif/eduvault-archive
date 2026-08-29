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
- `get_purchase_snapshot(purchase_id)` returns immutable metadata captured at
  purchase time (`metadata_hash`, `rights_hash`, `sale_terms_version`) so
  buyer receipts and purchase history are not rewritten when creators update
  live catalog metadata or sale terms (#667).
- refunds revoke an entitlement, so protected-download callers must treat a
  missing or inactive entitlement as denied access.

Off-chain projections store the same snapshot on each `purchases` document as
`purchaseSnapshot`. The purchased-materials API and receipt emails prefer this
snapshot over live `materials` fields when rendering what the buyer purchased.

Existing purchase records without a snapshot can be backfilled with:

```bash
node scripts/migrate-purchase-snapshots.mjs
```

Payment and entitlement behavior is covered in
`soroban/contracts/purchase-manager/src/test.rs`, including successful
purchases, duplicate prevention, entitlement reads, purchase snapshots, refunds, and TTL renewal.

For detailed documentation on the backend authorization policy, the five entitlement states, caching invariants, and troubleshooting workflows, see [`docs/entitlement-authorization.md`](entitlement-authorization.md).

## Version-scoped learner progress & bookmarks (#708)

Learner bookmarks and progress markers are scoped by `(walletAddress, materialId, version)`. When content updates or rollbacks occur, bookmarks attached to historical material versions remain accessible and uncorrupted.

