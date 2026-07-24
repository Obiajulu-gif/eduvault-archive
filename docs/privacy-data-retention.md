# Privacy Data Retention and Account Deletion

This document describes how EduVault collects, retains, and erases personal data.
It is the authoritative reference for operators, auditors, and contributors.

The machine-readable source of truth is [`src/lib/privacy/retentionPolicy.js`](../src/lib/privacy/retentionPolicy.js).

---

## Personal Data Inventory

| Collection | PII Fields | Legal Basis | Retention | On Deletion |
|---|---|---|---|---|
| `users` | `walletAddress`, `email`, `fullName`, `displayName`, `bio`, `avatarCid/Url`, `institution`, `country`, `payoutWalletAddress`, `payoutNotes` | Consent (Art. 6(1)(a)) | Deleted immediately | **Delete** |
| `refresh_tokens` | `userId` | Legitimate interest (Art. 6(1)(f)) | 7 days (token TTL) | **Delete** |
| `auth_challenges` | `account` | Legitimate interest | 90 days | **Delete** |
| `materials` | `userAddress` | Contract (Art. 6(1)(b)) | Immediate | **Anonymize** creator wallet |
| `purchases` | `buyerAddress` | Legal obligation (Art. 6(1)(c)) | 7 years | **Anonymize** buyer wallet |
| `entitlement_cache` | `buyerAddress` | Legal obligation | 7 years | **Anonymize** buyer wallet |
| `saved_materials` | `walletAddress` | Consent | Immediate | **Delete** |
| `collections` | `creatorId` | Consent | Immediate | **Delete** |
| `progress` | `userId` | Consent | Immediate | **Delete** |
| `reviews` | `walletAddress` | Consent | Immediate | **Anonymize** author wallet |
| `material_history` | `updatedBy` | Legitimate interest | Immediate | **Anonymize** actor wallet |
| `webhooks` | `userId` | Consent | Immediate | **Delete** |
| `webhook_deliveries` | `userId` | Consent | Immediate | **Delete** |
| `outbox` | none | Legitimate interest | Immediate | **Delete** |
| `upload_sessions` | `ownerId` | Consent | Immediate | **Delete** |
| `ledger` | none | Legal obligation | 7 years | **Retain** (no PII) |
| `material_manifests` | none | Legitimate interest | 7 years | **Retain** (no PII) |
| `manifest_digest_anchors` | none | Legitimate interest | 7 years | **Retain** (no PII) |
| IPFS pins (avatar) | — | Consent | Immediate | **Unpin** |
| IPFS pins (material files) | — | Consent | Immediate | **Unpin** (if no other buyers hold entitlements) |

### Anonymization values

| Field type | Anonymized value |
|---|---|
| Wallet address | `0x0000000000000000000000000000000000000000` |
| Email | `deleted@eduvault.invalid` |
| Full name / display name | `[deleted]` |
| Free-text fields (bio, notes) | `[redacted]` |
| CID / avatar URL | `null` |

---

## Data Export

### How it works

1. The user clicks **Request Data Export** in Settings → Privacy & Data.
2. A `POST /api/privacy/export` request creates a `data_export_requests` document and immediately runs `generateExport()`.
3. The service collects all exportable collections (see table above) and builds a versioned JSON manifest.
4. The manifest is stored in MongoDB and a 48-hour expiry is set.
5. The user receives a `requestId` and a capability `token`. Both are required to download.
6. The user calls `GET /api/privacy/export/download?requestId=...&token=...` which streams the JSON file.

### Export manifest format

```json
{
  "version": "1",
  "generatedAt": "2026-07-22T12:00:00.000Z",
  "userId": "...",
  "walletAddress": "0x...",
  "email": "user@example.com",
  "sections": {
    "users": [...],
    "purchases": [...],
    "entitlement_cache": [...],
    "saved_materials": [...],
    "collections": [...],
    "progress": [...],
    "reviews": [...],
    "webhooks": [...]
  }
}
```

### Constraints

- Only one pending/processing/ready export is allowed per user at a time.
- Exports expire after 48 hours. After expiry a new request must be made.
- The download URL is capability-protected (token) so it can be shared with a trusted party without exposing the session cookie.
- Rate limited to 3 requests per hour per user.

---

## Account Deletion

### State machine

```
                              ┌────────────────────┐
                              │                    │
  Initial request             │  pending_reauth    │──── wrong token / expired ──▶ (stays pending)
  POST /api/privacy/deletion  │                    │
  action=request              └────────┬───────────┘
                                       │  confirm_reauth
                                       ▼
                              ┌────────────────────┐
                              │                    │
                              │   cooling_off      │◀─── 14-day window starts
                              │                    │──── cancel ──▶ cancelled (terminal)
                              └────────┬───────────┘
                                       │  cooling-off elapsed + obligations clear
                                       ▼
                              ┌────────────────────┐
                              │                    │
                              │    executing       │──── step failure ──▶ failed
                              │                    │                         │
                              └────────┬───────────┘                    retry │
                                       │  all steps OK                        ▼
                                       ▼                             ┌──────────────┐
                              ┌────────────────────┐                 │    failed    │
                              │                    │                 └──────────────┘
                              │    completed       │
                              │  (receipt issued)  │
                              └────────────────────┘
```

### Deletion steps (in order)

| # | Step | Description |
|---|---|---|
| 1 | `revoke_sessions` | Invalidates all refresh tokens for the user |
| 2 | `delete_auth_challenges` | Removes pending auth challenge nonces |
| 3 | `delete_upload_sessions` | Removes in-progress upload sessions |
| 4 | `delete_*` | Deletes saved materials, collections, progress, webhooks, webhook deliveries, outbox events, data export requests, and refresh tokens |
| 5 | `anonymize_retained` | Replaces PII in purchases, entitlement_cache, materials, reviews, and material_history |
| 6 | `unpin_ipfs` | Unpins avatar and material files from Pinata (skipped gracefully if Pinata is not configured, or if other buyers hold entitlements to a material) |
| 7 | `delete_user_profile` | Removes the `users` document |

Steps are recorded individually in the `deletion_requests.steps` array so a partial failure can be diagnosed and retried without re-running completed steps.

### Obligation checks

Deletion is blocked (with a clear error) if any of:

- The user has purchases in a non-terminal state (pending, in-flight).
- Other buyers are still in-flight purchasing a material the user created.
- The user has unsettled credit entries on the ledger (unclaimed creator earnings).

The user is shown a specific message for each blocker.

### Cooling-off period

The 14-day cooling-off window starts after the user confirms re-authentication.
During this window the user can cancel at any time via:

- The UI: **Cancel Deletion Request** button.
- The API: `POST /api/privacy/deletion/cancel`.

After the window expires the next cron run (or manual trigger) advances the request to `executing`.

### Completion receipt

On successful completion the `deletion_requests` document is updated with:

- `status: "completed"`
- `completedAt: <timestamp>`
- `receiptId: <UUID>`

The user is shown the receipt ID in the UI. This record does not contain any PII because the `users` document has been deleted by this point.

---

## API Reference

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/privacy/export` | JWT cookie | Create export request |
| `GET` | `/api/privacy/export?requestId=` | JWT cookie | Poll export status |
| `GET` | `/api/privacy/export/download?requestId=&token=` | JWT cookie | Download export JSON |
| `POST` | `/api/privacy/deletion` | JWT cookie | `action=request` / `confirm_reauth` / `execute` |
| `GET` | `/api/privacy/deletion` | JWT cookie | Get active deletion request status |
| `POST` | `/api/privacy/deletion/cancel` | JWT cookie | Cancel during cooling-off |

---

## Backups and Analytics

### Backups

EduVault uses a MongoDB dump + S3 backup workflow (`scripts/backup.mjs`).

**Backup behavior on deletion:**
- Existing backups **are not modified** when a user deletes their account. Backups are point-in-time snapshots.
- Backups containing the deleted user's PII are covered by the documented backup retention schedule.
- Operators should configure backup lifecycle policies (e.g., S3 Object Lifecycle) to expire backup bundles after the maximum retention period (7 years for financial records).
- The `PERSONAL_DATA_NOTE` field in each backup manifest (`scripts/create-backup-manifest.mjs`) should reference this document as the retention policy source.

**Operator responsibility:**
Backup restore operations must not be used to resurrect deleted user profiles. If a backup must be restored for disaster recovery, any user accounts that were deleted after the backup date must be re-deleted following the same procedure.

### Analytics

EduVault does not currently integrate a third-party analytics provider (PostHog, Amplitude, etc.).
Server-side metrics are emitted via the internal `src/lib/telemetry/metrics.js` Prometheus-compatible layer using only aggregate counters — no individual user identifiers are emitted to external systems.

If analytics are added in future:
1. Update `DATA_INVENTORY` in `retentionPolicy.js` to include the new data category.
2. Ensure the analytics provider is notified of deletion requests (e.g., via their delete API).
3. Document the provider's retention behaviour here.

---

## Configuration

Retention periods are defined in constants in `retentionPolicy.js`:

```js
export const RETENTION = Object.freeze({
  FINANCIAL_YEARS_7: 2555,  // 7 years in days
  AUTH_AUDIT_90:       90,
  SESSION_7:            7,
  IMMEDIATE:            0,
});
```

To adjust a retention period, update the constant and redeploy. No database migration is required for the policy itself — the values are enforced operationally (by deletion jobs and TTL indexes).

---

## Related Files

| File | Purpose |
|---|---|
| `src/lib/privacy/retentionPolicy.js` | Personal data inventory and retention constants |
| `src/lib/privacy/dataExportService.js` | Export generation and download |
| `src/lib/privacy/deletionStateMachine.js` | State transitions and guards |
| `src/lib/privacy/deletionExecutor.js` | Orchestrated deletion pipeline |
| `src/lib/privacy/anonymizationService.js` | PII field replacement |
| `src/lib/privacy/obligationChecker.js` | Financial/escrow obligation checks |
| `src/lib/privacy/storageCleanup.js` | Pinata IPFS unpin logic |
| `src/app/api/privacy/export/route.js` | Export API |
| `src/app/api/privacy/deletion/route.js` | Deletion API |
| `src/app/api/privacy/deletion/cancel/route.js` | Cancellation API |
| `src/app/dashboard/components/PrivacyDataExportPanel.jsx` | Export UI |
| `src/app/dashboard/components/PrivacyAccountDeletionPanel.jsx` | Deletion UI |
| `tests/backend/privacy.test.mjs` | Automated tests (45 tests, 6 suites) |
