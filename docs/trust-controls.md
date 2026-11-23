# Trust controls

Material deletion/restoration checks persisted `users.securityReviewRequired`,
`materials.fraudHold` and quarantined status before mutation. Review bindings include
actor, target, operation and material search version; a changed target needs a new
review. No request-supplied risk flags are trusted. Other mutation routes are not
covered by this initial integration.

`GET /api/admin/fraud-reviews` lists up to 100 pending reviews for active admins.
`POST` accepts `{id, decision: "approved" | "rejected", reason}`. Self-review is
forbidden. Resolution and attributed history are one atomic Mongo update; duplicate
decisions return 409. Review evidence stores only enumerated signals and material
status, never storage keys, files, cookies or request bodies. Only admins can read
the evidence. Approval authorizes retry through normal ownership/session checks;
it does not execute the action or bypass other gates.
Pass `?id=...` to GET to read a resolved review and its complete audit history.
The endpoint limits requests to 60/minute.

No backfill is required. Mongo creates `fraud_reviews` on first use; its built-in
unique `_id` deduplicates identical requests. The normal database startup creates
binding/state and chronological pending-queue indexes through `REQUIRED_INDEXES`.
Grant application-only writes and
restrict database operator access. Embedded audit arrays are intended for bounded
review histories, not an external immutable archive.

Validation: `node --test tests/backend/fraud-review.test.mjs`.

## Consent

`GET /api/consent?policy=catalog-management:1` returns published policy text, its
SHA-256 version hash and the caller's own history. `POST /api/consent` accepts
`{policyKey, versionHash, decision: "accepted" | "revoked"}`. Actor, source and time
are server-assigned. History cannot be requested for another account. Responses
are no-store. Consent events append atomically with the current decision using
revision compare-and-swap; conflicting submissions return 409 and may be retried.

Material deletion/restoration returns 428 with the exact required policy if consent
is missing, revoked or stale. Consent does not replace ownership or maintainer
authorization. To change terms, add a new immutable entry to `POLICIES`, retain
old entries for disputes, and update `REQUIRED_CONSENT`. Deploying that change
requires renewed consent; existing records are never silently upgraded. Review
the supplied catalog policy wording before production deployment. There is no
backfill or grandfathering. The new `consent_ledgers` collection uses Mongo's
unique `_id`; histories are embedded and should be monitored against Mongo's
document size limit. Validate with `node --test tests/backend/consent-ledger.test.mjs`.
`consent_policy_versions` pins each published version's content hash globally on
first acceptance; reusing that version with different content fails closed even
for a new user. Restrict this collection to insert/read access for the application.
Consent and support endpoints each limit requests to 30/minute.

## Support timelines

`POST /api/support/cases` with `{summary}` creates a case owned by the active caller.
With `{id, type, content, visibility}` it appends an event. Types are status, note,
evidence, escalation and resolution; visibility is user (default) or private.
Only admins may add private events or types other than note. Evidence should be
redacted references; never paste tokens, raw student records or storage credentials.
`GET /api/support/cases?id=...` allows only the owner or an active admin. Owner
responses omit private events and their hashes/sequence numbers. Resolved cases
reject further writes. Status is a narrative update; escalation and resolution
set lifecycle state explicitly.

`support_cases` embeds a SHA-256 chain with actor, time and strictly increasing
sequence. Each append atomically compares revision and head, stores the new event
and updates state. Concurrent appends return 409 for retry. Reads and appends
verify integrity and fail closed on corruption. This detects accidental edits,
reordering and truncation against the stored head; a database administrator able
to rewrite the whole chain can forge it. External head anchoring is deferred.
No migration/configuration is needed; enforce application-only writes, backups
and monitor document growth. Validate with
`node --test tests/backend/support-timeline.test.mjs`.

## Adaptive step-up verification

Catalog management checks persisted `users.stepUpRequired`, security review flags,
asset fraud holds and quarantined restores. Low risk proceeds without a challenge.
After consent and fraud approval, high risk returns 428 with a safe explanation,
retry URL and exact action binding. POST `{binding}` to `/api/verification/step-up`.
Sign the returned message's UTF-8 bytes with the account's linked Stellar Ed25519
wallet; POST `{id, signature}` (base64 detached signature) to the same endpoint.
Wallet clients must support signing these exact raw bytes. Other wallet formats
are rejected explicitly. The endpoint limits requests to 10/minute.

Retry the original material request with `verificationId`. Grants expire after
five minutes, bind actor/target/action/search version/deletion state, and are
atomically consumed once. Failed or expired challenges require a fresh challenge;
they cannot be reset. A failed downstream mutation also requires fresh proof.
The server computes the execution binding independently of the supplied binding.
Mongo creates `step_up_verifications` automatically. Retain decision records per
the deployment's security retention policy; expiry is checked at use rather than
relying on background deletion. No environment variable or migration is required.
Validate all controls without dependencies:
`node --test tests/backend/fraud-review.test.mjs tests/backend/consent-ledger.test.mjs tests/backend/support-timeline.test.mjs tests/backend/step-up-verification.test.mjs`.

Additional concurrency and lifecycle snapshot checks (the latter uses the normal
installed application dependencies):
`node --test tests/backend/trust-concurrency.test.mjs tests/backend/trust-material-snapshot.test.mjs`.
Route and real linked-wallet signature checks:
`npx vitest run --config test/trust-vitest.config.mjs`.
