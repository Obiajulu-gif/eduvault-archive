# Threat model: cross-boundary trust decisions

EduVault makes several decisions about *who to trust* at the points where
one system boundary hands control or data to another: creator-registered
webhook destinations, the Stellar/Soroban chains, maintainer tooling, and
the dual EVM/Soroban entitlement path left over from the ongoing migration
(see [`EVM_TO_SOROBAN_ENTITLEMENT_MIGRATION.md`](EVM_TO_SOROBAN_ENTITLEMENT_MIGRATION.md)).
This document walks each of those boundaries as a scenario: what's being
trusted, what an abuser would try, what mitigates it today, and what check
(if any) exercises that mitigation.

It complements, rather than replaces, the boundary-specific docs already in
this repo ([`webhook-signatures.md`](webhook-signatures.md),
[`MAINTAINER_IMPERSONATION.md`](MAINTAINER_IMPERSONATION.md),
[`entitlement-authorization.md`](entitlement-authorization.md),
[`PROTECTED_STORAGE_SECURITY.md`](PROTECTED_STORAGE_SECURITY.md)) by looking
across them for the shape of trust decision they share, rather than
re-documenting any one of them in full.

## How to read each scenario

- **Trust boundary** — the two sides, and which one is less trusted.
- **Abuse case** — what someone on the less-trusted side would try.
- **Mitigation** — what in the code actually stops it today.
- **Check** — the automated test/check that exercises the mitigation, or
  the gap if there isn't one yet.

---

## 1. Outbound webhook delivery (EduVault → creator-registered endpoint)

**Trust boundary:** EduVault's own backend (trusted) handing a payload and
an HTTP request to a URL a *creator* chose (not trusted — it could be an
internal address, a rebinding DNS name, or a redirect chain ending
somewhere it shouldn't).

**Abuse case:** A creator (or anyone who compromises a creator account)
registers a webhook URL pointing at `169.254.169.254` (cloud metadata),
`localhost`, or a public hostname that later rebinds to an internal IP —
using EduVault's own egress as an SSRF pivot into infrastructure the
creator has no business reaching.

**Mitigation:** `validateWebhookDestination`/`safeFetch`
(`src/lib/webhooks/ssrfGuard.js`) canonicalize the URL, resolve every
hostname, reject private/loopback/link-local/metadata ranges in all their
IPv4/IPv6/mapped/decimal/octal/hex forms, and re-validate every redirect
hop rather than trusting the first resolution.

**Check:** `src/lib/webhooks/ssrfGuard.test.js` (pre-existing, extensive).
No gap here — this is the boundary with the most coverage already.

---

## 2. Inbound webhook signature verification (creator-controlled receiver → EduVault's delivery retry logic)

**Trust boundary:** this one runs the other direction from #1 — it's about
what EduVault's *own* retry/replay-cache logic must defend against a
malicious or buggy receiver inferring from timing, or an attacker who
captured one valid delivery trying to replay or mutate it.

**Abuse case:** replay a captured signed payload later; tamper with the
body after capturing a valid signature for a different body of the same
length; present a signature computed with a different (previously rotated)
secret and hope the rotation grace window is checked loosely.

**Mitigation:** `verifyWebhookSignature`/`verifyWebhookSignatureWithRotation`
(`src/lib/webhooks/sender.js`) bind the signature to the exact canonical
body bytes, enforce a timestamp skew window, and remember used
`signatureHeader`s in a short-lived replay cache so a byte-identical replay
is rejected even with a mathematically valid signature.

**Check:** `src/lib/webhooks/sender.test.js` (pre-existing) plus the new
golden fixture corpus added alongside this document —
`test/fixtures/webhook-adversarial/` and
`src/lib/webhooks/adversarial-fixtures.test.js` (issue #941) — which adds
dedicated adversarial cases: replay of a genuinely valid signature, a valid
signature applied to a mutated body, verification against the wrong
secret, and a same-length-body forgery attempt, alongside structurally
malformed headers (missing fields, non-hex signatures, reordered fields,
oversized values).

---

## 3. Inbound Stellar payment reconciliation (external scheduler → EduVault granting entitlements)

**Trust boundary:** `POST /api/webhooks/stellar`
(`src/app/api/webhooks/stellar/route.js`) is polled by an external
scheduler to reconcile pending purchases against Horizon and grant
entitlements for confirmed payments. The caller's *identity* is the only
untrusted input (the route itself fetches transaction data from Horizon
rather than trusting a payload), gated by `STELLAR_WEBHOOK_SECRET` or
`CRON_SECRET` when one is configured.

**Abuse case:** an attacker who can reach this route in a deployment where
neither secret was ever configured can trigger reconciliation runs at
will. The route's own on-chain lookups limit the *direct* damage (it still
checks Horizon before granting anything), but unauthenticated triggering
is itself a resource-exhaustion and timing-oracle surface, and is clearly
not the intended production posture.

**Finding:** `isAuthorized` in that route intentionally fails **open** when
no secret is set — documented as a "local/dev convenience" in its own
comment. The existing production env validator
(`validateRuntimeEnv`/`assertRuntimeEnv` in `src/lib/env.js`) only requires
this secret when `webhooksEnabled` is true, and `webhooksEnabled` is
derived from `WEBHOOK_URL` or the secret itself being set — i.e. it's
gated on *outbound* creator webhooks being configured. A production
deployment that never opts into outbound webhooks gets **no signal at all**
that this unrelated *inbound* route is running unauthenticated. This is
the clearest actual gap this threat model surfaced.

**Mitigation added:** rather than changing `validateRuntimeEnv`'s existing,
deliberately-scoped contract (which a pinned test in `env.test.js` checks:
"does not require a webhook secret in production when webhooks are
disabled" — changing that behavior without a migration plan would violate
this issue's own compatibility requirement), this adds a separate,
additive check: `auditCrossBoundaryTrustSecrets()` in `src/lib/env.js`,
called from the route handler itself, which logs a loud warning on every
request handled while the secret is unset in production. It never blocks
startup and never changes `validateRuntimeEnv`'s return value, so it can't
regress existing deploys that intentionally run without this secret in
non-production environments.

**Check:** `src/lib/__tests__/auditCrossBoundaryTrustSecrets.test.js`
(new, issue #939) — verifies the warning fires only in production and only
when both `STELLAR_WEBHOOK_SECRET` and `CRON_SECRET` are absent or
placeholder values, and is silent the moment either is set.

**Residual risk / follow-up:** the route still fails open by design. Fully
closing this boundary (fail closed in production) is a behavior change
that needs its own migration plan (existing deployments relying on the
open-by-default behavior would break), so it's called out here rather than
done as part of this vertical slice.

---

## 4. Maintainer impersonation (support tooling → user's own account data)

**Trust boundary:** a maintainer (elevated internal trust) acting *as* a
specific user, without that user's active consent for this particular
session.

**Abuse case:** a maintainer (or someone who compromises maintainer
tooling) uses impersonation to read data outside the support scope, holds
a session open indefinitely, or performs an irreversible action
(withdrawal, ownership transfer) while "being" the user.

**Mitigation:** per
[`MAINTAINER_IMPERSONATION.md`](MAINTAINER_IMPERSONATION.md) — time-limited
sessions (30 min default, 1 hour max), a default-deny allowlist of
read-only actions, an explicit block-list for irreversible mutations
(`transfer_funds`, `withdraw`, `delete_account`, `transfer_ownership`,
etc.), and full audit logging of session start/actions/stop.

**Check:** covered by that feature's own test suite (outside this
document's scope to re-verify); flagged here because it's a textbook
cross-boundary trust decision — elevated internal trust granted narrow,
time-boxed, audited scope rather than broad access — and the pattern is
worth naming for future boundaries that need the same shape.

---

## 5. Dual-chain entitlement authority during the EVM → Soroban migration

**Trust boundary:** during migration, entitlement truth can live on either
the legacy EVM contracts or the new Soroban contracts
(see [`EVM_TO_SOROBAN_ENTITLEMENT_MIGRATION.md`](EVM_TO_SOROBAN_ENTITLEMENT_MIGRATION.md),
[`ENTITLEMENT_ABSTRACTION.md`](ENTITLEMENT_ABSTRACTION.md),
[`entitlement-fallback-design.md`](entitlement-fallback-design.md)). Each
chain is a separate trust domain with its own finality and failure modes.

**Abuse case:** a user (or a bug) causes the two chains to disagree about
entitlement state — e.g. a refund lands on one chain but the fallback
check still reads the other as "entitled" — producing access the business
no longer intends to grant, or a double-grant across the cutover.

**Mitigation:** per `entitlement-fallback-design.md`'s documented fallback
order and `ENTITLEMENT_ABSTRACTION.md`'s single entry point, callers are
meant to go through one abstraction rather than querying either chain
directly, so the fallback/precedence rule is enforced in exactly one place.

**Check:** none added by this document — this boundary's risk is
concentrated in a migration that is still in progress elsewhere in the
codebase, and a meaningful check here would need to assert properties of
that migration's *current* state (which chain is authoritative for which
cohort of users right now), not a fixed invariant. Flagged as a boundary to
re-examine with a dedicated check once the migration's cutover plan is
finalized, rather than guessed at here.

---

## Summary table

| # | Boundary | Less-trusted side | Highest-risk gap found | Check |
|---|----------|--------------------|--------------------------|-------|
| 1 | Outbound webhook delivery | Creator-registered URL | None (well covered) | `ssrfGuard.test.js` |
| 2 | Inbound webhook verification | Payload holder / replayer | None (well covered) | `sender.test.js` + `adversarial-fixtures.test.js` |
| 3 | Stellar reconciliation trigger | Anonymous caller | **Fails open with no production signal** | `auditCrossBoundaryTrustSecrets.test.js` (mitigated: logs loudly; residual: still fails open) |
| 4 | Maintainer impersonation | Internal elevated trust | None found (scoped, time-boxed, audited) | covered by feature's own suite |
| 5 | Dual-chain entitlement authority | Migration-era ambiguity | Not assessable without migration cutover plan | none (follow-up) |

The one concrete, previously-unflagged gap this review found and mitigated
is **#3**: a boundary whose risk was invisible precisely because it was
being checked by a *different* boundary's feature flag (`webhooksEnabled`,
driven by outbound webhook config) rather than its own.
