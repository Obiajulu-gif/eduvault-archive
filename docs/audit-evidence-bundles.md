# Privacy-Preserving Audit Evidence Bundles (#943)

`src/lib/audit/evidenceBundle.js` turns raw audit events (audit ledger rows,
outbox records, purchase/refund transitions) into an **exportable evidence
bundle** for support investigations. A bundle can be attached to a ticket or
shared with a creator, payment provider or auditor without leaking secrets or
PII, but still carries enough IDs, hashes and timestamps to verify what the
system did.

The module is pure (no DB/network access) and is not wired into any route, so
existing APIs, schemas and user-facing behavior are unchanged.

## Usage

```js
import { buildEvidenceBundle, verifyEvidenceBundle } from '@/lib/audit/evidenceBundle';

const bundle = buildEvidenceBundle({
  investigationId: 'SUP-1001',
  events,                                   // rows you loaded for the case window
  bundleKey: process.env.EVIDENCE_BUNDLE_KEY, // server-side, >= 32 chars
  requestedBy: { id: admin.id, role: 'support_agent' },
  subject: learnerWallet,                   // stored only as a pseudonym
});

verifyEvidenceBundle(bundle);               // anyone: chain, root, manifest, leak scan
verifyEvidenceBundle(bundle, { bundleKey, sourceEvents: events }); // operator: matches DB rows
```

## What each field becomes

| Class | Examples (key match) | Exported as |
| :--- | :--- | :--- |
| Secrets | `password`, `token`, `jwt`, `authorization`, `cookie`, `apiKey`, `privateKey`, `seed`, `mnemonic`, `signedXdr`, `envelopeXdr`, `signature`, `otp`, `cvv` | `[REDACTED:secret]` — no hash, no prefix |
| PII | `email`, `wallet`, `address`, `account`, `fullName`, `phone`, `ip`, `userAgent`, `buyer`, `seller`, `learner`, `recipient`, `payer`, `payee` | `pii:<16 hex>` keyed HMAC pseudonym |
| Free text | `note`, `comment`, `message`, `reason`, `description`, `body`, `feedback` | `[REDACTED:free-text]` |
| Verifiable | `*Id`, `_id`, `*Hash`, `cid`, `status`, `type`, `amount`, `fee`, `asset`, `network`, `ledger`, `*At`, `timestamp`, `contractId` | verbatim |

Strings that survive (including verifiable ones) are also scanned for
secret/PII *shapes* — Stellar secret seeds, JWTs, `Bearer` credentials,
emails, Stellar `G…` accounts and `0x…` wallets — and masked inline. On-chain
64-hex transaction hashes are deliberately **not** masked.

Pseudonyms are case/whitespace-insensitive and stable inside one bundle key
(the same learner correlates across events), and unlinkable across bundles
built with different keys.

## Integrity model

- Every entry stores `payloadDigest = HMAC(bundleKey, stableJSON(originalEvent))`.
  Only a holder of the key can link an entry back to a source row, and the
  digest cannot be brute-forced into PII without the key.
- Entries are sorted by `(occurredAt, eventId)` and chained:
  `entryHash = sha256(entry without entryHash)`, each `prevHash` is the previous
  `entryHash` (genesis = 64 zeros). `manifest.rootHash` is the last `entryHash`.
- `manifestHash = sha256(stableJSON(manifest))` covers investigation id,
  window, counts, redaction policy version and a key fingerprint.
- Rebuilding from the same rows with the same key is byte-for-byte
  deterministic, regardless of input order.

`verifyEvidenceBundle` reports: `manifest_hash_mismatch`, `event_count_mismatch`,
`sequence_gap:i`, `chain_broken:i`, `entry_hash_mismatch:i`, `root_hash_mismatch`,
`leak_detected:*`, and with the key: `bundle_key_mismatch`, `source_missing:id`,
`source_mismatch:id`.

## Edge cases and failure modes

| Situation | Behavior |
| :--- | :--- |
| Missing/short bundle key | Throws `INVALID_BUNDLE_KEY` — never falls back to an unkeyed hash. |
| Event without id, invalid timestamp, duplicate id | Throws `INVALID_EVENT` (fail closed). With `allowPartial: true` it is listed in `omitted[]` with a reason and counted in `manifest.omittedCount`. |
| More than `maxEvents` (default 5000) | Throws `TOO_MANY_EVENTS`; narrow the investigation window instead of truncating silently. |
| Empty window | Valid bundle, `rootHash` = genesis, `window: null`. |
| Deeply nested payloads | Truncated at depth 8 as `[TRUNCATED]`. |
| New field name that is sensitive but matches no pattern | Still scanned for inline shapes; `verifyEvidenceBundle` runs a leak scan before export. Add the key to the patterns and bump `REDACTION_POLICY_VERSION`. |
| Over-redaction (e.g. `contractAddress` vs `address`) | `contractId`/`contractAddress` are allow-listed; anything else that matches PII is pseudonymized — over-redaction is the safe default. |
| Bundle edited after export | Hash chain / manifest hash checks fail. |

## Operations, rollback and recovery

- **Key management:** use a dedicated `EVIDENCE_BUNDLE_KEY` (not `JWT_SECRET`).
  Rotating it only affects *new* bundles; keep old keys (by `keyFingerprint`)
  for as long as you may need to re-verify old bundles against source rows.
- **Lost key:** bundles remain verifiable for tampering (chain/root/manifest),
  but can no longer be linked to source rows. Rebuild a fresh bundle from the
  database with a new key.
- **Leak found after export:** treat it like any data incident — revoke the
  shared copy, add the field pattern, bump `REDACTION_POLICY_VERSION`, rebuild.
  The manifest records the policy version each bundle was built with.
- **Rollback:** the feature is additive and unused by existing routes; reverting
  the module and its tests restores the previous state. No migrations.

## Tests

- `src/lib/__tests__/evidenceBundle.test.js` (Vitest)
- `tests/backend/audit-evidence-bundle.test.mjs` (`npm run test:backend`)
