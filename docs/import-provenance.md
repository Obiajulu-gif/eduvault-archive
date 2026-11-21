# Import provenance chain (#1120)

`src/lib/backend/importProvenanceChain.js` makes the sequence of records from one
import batch tamper-evident. Each entry stores a SHA-256 digest over a canonical
serialization of the record together with the batch id, importer, and row index,
and links to the previous entry's hash. Verification detects altered records,
reordered or missing entries, and forged links.

This module is standalone. The import route does not call it yet, so existing
imports are unchanged.

## Entry fields

| Field | Meaning |
| --- | --- |
| `seq` | 1-based position in the batch chain |
| `algorithm` | digest algorithm; only `sha256` is supported |
| `digest` | SHA-256 over `{ v, batch, importer, index, record }` in canonical form |
| `importBatchId`, `importerAddress`, `recordIndex` | the identity bound into the digest |
| `recordedAt` | ISO timestamp; part of the entry hash, not the digest |
| `previousEntryHash` | `null` for `seq` 1, otherwise the previous `entryHash` |
| `entryHash` | SHA-256 over all fields above, in canonical form |

## Canonical form

Object keys are sorted recursively. `undefined` members are omitted, matching JSON
storage. `Date` values become ISO strings. `NaN`, infinite numbers, functions, and
symbols are rejected with `invalid_input`. Logically equal records therefore hash
the same regardless of key order.

## Error codes

| Code | Raised by | Meaning |
| --- | --- | --- |
| `unauthorized` | `createProvenanceEntry` | `authorized` was not the boolean `true`. No entry is produced. |
| `invalid_input` | both | missing or oversized ids, bad seq or link shape, non-finite values |
| `unsupported_algorithm` | both | algorithm is not in `SUPPORTED_DIGEST_ALGORITHMS` |
| `sequence_gap` | `verifyProvenanceChain` | an entry is missing, reordered, or the lengths differ |
| `chain_broken` | `verifyProvenanceChain` | `previousEntryHash` does not match the prior entry |
| `entry_tampered` | `verifyProvenanceChain` | entry fields no longer match `entryHash` |
| `missing_record` | `verifyProvenanceChain` | no record supplied for an entry |
| `digest_mismatch` | `verifyProvenanceChain` | the record was altered after import |

## Retry and idempotency

The digest does not include `recordedAt`. Re-running the same file for the same
batch and importer reproduces every digest exactly, so a retried row can be matched
to its earlier entry by digest. A retry that builds a fresh chain gets a new
`entryHash` for each entry (the timestamp differs), so store the first accepted chain
and reuse it instead of rebuilding.

## Authorization

Pass `authorized: true` only after the caller has passed the same creator check the
import route enforces. Any other value, including the string `"true"` or a missing
flag, throws `unauthorized` and produces no entry.

## Edge cases

- Empty chains verify with `headHash: null`.
- A chain must be verified against the full, ordered list of records. Verifying
  a subset fails with `sequence_gap` by design.
- Changing `importerAddress` or `recordIndex` on a stored entry is caught by
  `entry_tampered` before the digest is checked, since those fields are hashed into
  `entryHash`.
- The module does not verify signatures. It detects accidental or unauthorized
  edits to stored data, not a database writer who recomputes every hash.

## Recovery

If a chain fails verification:

1. Identify the failing `seq` from the error message.
2. For `digest_mismatch`, compare the stored record with the source file row
   `recordIndex`. Restore the record from the source file and re-import that row.
3. For `sequence_gap` or `chain_broken`, the stored chain is incomplete. Re-run the
   original import file for that batch to rebuild the chain from its first row.
4. For `entry_tampered`, treat the entry as compromised. Do not repair its fields
   by hand. Rebuild the chain from the source file.
