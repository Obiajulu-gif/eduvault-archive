# External Identity Linking (#880)

An EduVault account signs in with its **primary wallet**. It can also link
**external identities** (today: other Stellar accounts it controls) after
proving control of them. Linking and unlinking are deterministic, audited, and
can't hand one identity to two accounts.

Implementation: [`src/lib/auth/identityLinks.js`](../src/lib/auth/identityLinks.js).
Routes: `src/app/api/identities/`.

## States

```
(none) ──POST /challenge──▶ challenge: pending ──valid proof──▶ link: linked ──DELETE──▶ link: unlinked
                                  │                                                         │
                                  └─ bad proof / expired / replay ─▶ challenge: failed      └─ relink = new challenge + new link row
```

| Collection | Row | Notes |
| --- | --- | --- |
| `identity_link_challenges` | `{ challengeId, userId, provider, subjectKey, message, status, createdAt, expiresAt }` | Single use. TTL index removes rows at `expiresAt`. |
| `identity_links` | `{ linkId, userId, provider, subjectKey, status, linkedAt, verification: { method, challengeId, verifiedAt }, unlinkedAt?, unlinkedBy? }` | `unlinked` rows are kept as history. |

## Policy

| Rule | Enforcement |
| --- | --- |
| Proof of control | The identity's key signs the challenge message with [SEP-53](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md): `ed25519(sha256("Stellar Signed Message:\n" + message))`. This is what Freighter and Stellar Wallets Kit `signMessage` produce. Base64 and hex signatures are accepted. |
| Bound to the requesting account | The signed message contains `Account: <userId>`. A signature can't link the identity to any other account. |
| Domain separation | The message starts with `EduVault identity link`. It can't be confused with a login challenge or a maintainer approval signature. |
| Linked once | Partial unique index on `(provider, subjectKey)` where `status: "linked"`. Concurrent confirms for one identity: exactly one wins, the rest get `IDENTITY_ALREADY_LINKED`. |
| Not another account's primary wallet | The same `IDENTITY_ALREADY_LINKED` response is returned, so it never reveals which account owns the identity. |
| Per-account cap | `stellar.maxLinksPerUser = 5`, checked at challenge and at confirm. |
| Single-use challenges | Atomically consumed *before* the proof is checked. A failed or replayed proof burns it. TTL is 5 minutes. |
| No access left behind | Unlink marks the row `unlinked`, burns pending challenges for that identity, and revokes every other session of the account (`sessionVersion` bump plus refresh-token revocation, keeping the current session family). If revocation fails, the unlink is rolled back so a retry re-runs it. |
| Single read path | `findLinkedAccountId()` resolves only `linked` rows. Any feature that grants access through a linked identity must use it, so an unlinked identity resolves to `null` immediately. |

## Audit

Every action is appended to the tamper-evident `audit_ledger`:

| Action | Target | When |
| --- | --- | --- |
| `identity.linked` | `{ type: "user", id }` | Link created |
| `identity.link_failed` | `{ type: "user", id }` | Proof rejected |
| `identity.unlinked` | `{ type: "user", id }` | Link removed |
| `identity.unlink_denied` | `{ type: "identity_link", id }` | Another account tried to unlink an existing link |

## API

All routes require an active session (suspended or revoked sessions get
`401`/`403`) and are rate limited. Errors are RFC 9457 problem details. The
`type` URI identifies the reason, for example
`https://eduvault.dev/problems/duplicate_link`.

### `POST /api/identities/challenge`

```json
// request
{ "provider": "stellar", "subject": "GBXF…P7L" }
// 201
{
  "challengeId": "9b1c…",
  "provider": "stellar",
  "subject": "GBXF…P7L",
  "message": "EduVault identity link\nAccount: 66f…\nProvider: stellar\nIdentity: GBXF…P7L\nNonce: 4e0a…\nExpires: 2026-10-20T12:05:00.000Z",
  "expiresAt": "2026-10-20T12:05:00.000Z"
}
```

The client signs `message` exactly as returned, for example with Freighter:
`signMessage(message, { address: subject })`, which returns a base64 `signedMessage`.

### `POST /api/identities`

```json
// request
{ "challengeId": "9b1c…", "signature": "<base64 signedMessage>" }
// 201
{ "link": { "linkId": "0f6e…", "provider": "stellar", "subject": "GBXF…P7L", "linkedAt": "2026-10-20T12:01:00.000Z" } }
```

### `GET /api/identities`

`200 { "links": [ { "linkId", "provider", "subject", "linkedAt" } ] }`, listing only the caller's active links.

### `DELETE /api/identities/:linkId`

`200 { "linkId", "status": "unlinked", "unlinkedAt", "sessionsRevoked": true }`.
Other devices must sign in again. The current device keeps its refresh token
and gets a fresh access token on its next refresh.

### Error reasons

| `type` suffix | Status | Meaning |
| --- | --- | --- |
| `unsupported_provider` | 400 | Provider not in `IDENTITY_PROVIDERS` |
| `invalid_subject` | 400 | Not a valid Ed25519 `G…` account |
| `primary_identity` | 409 | The account's own primary wallet |
| `duplicate_link` | 409 | Already linked to this account |
| `identity_already_linked` | 409 | Linked to, or the primary wallet of, another account |
| `link_limit_reached` | 409 | Per-account cap reached |
| `challenge_invalid` | 409 | Unknown, expired, already used, or issued to another account |
| `verification_failed` | 422 | Signature does not verify for the identity |
| `link_not_found` | 404 | No active link with that id owned by the caller |

## Adding a provider

Add an entry to `IDENTITY_PROVIDERS` with `normalizeSubject`, `verifyProof`,
`verificationMethod` and `maxLinksPerUser`. The state machine, uniqueness,
auditing and unlink revocation apply unchanged.

## Deployment

The indexes are declared in `REQUIRED_INDEXES` (`identity_links`,
`identity_link_challenges`) and created by the existing `ensureIndexes()`
bootstrap. No data migration and no new environment variables are needed.

## Tests

```bash
npx tsx --test tests/backend/identity-links.test.mjs
npx vitest run src/app/api/__tests__/identities.route.test.js
```
