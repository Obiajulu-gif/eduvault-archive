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
  live catalog metadata or sale terms (#667). This immutable reference allows buyers to retain access to the exact version they purchased even if the creator issues a **version rollback** or deprecates a version.
- rollback workflows deprecate an unsafe current version while preserving historical receipts.
- refunds revoke an entitlement, so protected-download callers must treat a
  missing or inactive entitlement as denied access.

Off-chain projections store the same snapshot on each `purchases` document as
`purchaseSnapshot`. The purchased-materials API and receipt emails prefer this
snapshot over live `materials` fields when rendering what the buyer purchased.

## Previews for Paid Content

Unentitled users (e.g. before purchase) can only access bounded previews of paid materials:
- Preview requests to the material API enforce preview metadata bounds (length limits, restricted asset scope).
- Assets rendered for preview are watermarked or structurally restricted to prevent exposure of full content.
- Attempts to leak full assets or exceed preview limits are prevented server-side, returning an unauthorized response unless a confirmed purchase is verified.

Existing purchase records without a snapshot can be backfilled with:

```bash
node scripts/migrate-purchase-snapshots.mjs
```

Payment and entitlement behavior is covered in
`soroban/contracts/purchase-manager/src/test.rs`, including successful
purchases, duplicate prevention, entitlement reads, purchase snapshots, refunds, and TTL renewal.

## Disaster Recovery & Restore Verification (#715)

To guarantee that restored databases preserve entitlement enforcement boundaries and protected file accessibility:

1. `scripts/restore-verification.mjs` verifies that every protected material document contains a valid storage reference / CID and valid content hash format.
2. The verification engine probes entitlement decision rules against restored data to ensure entitled buyers retain access while unentitled callers are blocked and refunded/revoked purchases are denied.
3. System encryption keys (`JWT_SECRET`) are validated to ensure token signing and delivery decryption succeed post-restore.

For detailed documentation on the backend authorization policy, the five entitlement states, caching invariants, and troubleshooting workflows, see [`docs/entitlement-authorization.md`](entitlement-authorization.md) and [`docs/disaster-recovery.md`](disaster-recovery.md).

