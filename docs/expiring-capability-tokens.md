# Expiring Capability Tokens for Sensitive Actions

This document specifies the architecture, cryptographic protocol, error taxonomy, and operational runbook for **expiring capability tokens for sensitive actions** in EduVault.

---

## 1. Overview and Security Architecture

EduVault uses an **Object-Capability (cap-based) security model** for privileged, high-risk mutations. 

While user session JWTs prove *identity* (`who you are`), capability tokens prove *scoped authorization* (`what specific high-risk action you are authorized to perform on which specific resource for what exact duration`).

```text
+-----------------------+      1. Challenge / Elevate       +---------------------------+
|                       | --------------------------------> |                           |
|                       |                                   |  Capability Token Issuer  |
|                       | <-------------------------------- |  (Role & Tenant Gated)    |
|   Client / Frontend   |      2. Signed Capability Token   +---------------------------+
|                       |         (TTL: 5-15 min, HMAC)
|                       |
|                       |      3. Sensitive Mutation + Cap  +---------------------------+
|                       | --------------------------------> |  Protected Route Handler  |
|                       |                                   |  (Verify, Constrain,      |
+-----------------------+                                   |   Single-Use Consume)     |
                                                            +---------------------------+
```

### Sensitive Action Taxonomy

The following operations require expiring capability tokens:

| Action Identifier | Category | Typical TTL | Replay Policy | Role Floor | Description |
|---|---|---|---|---|---|
| `payout:request` | Financial | 5 min | Single-use | `creator` | Creator initiates withdrawal/payout of accrued earnings |
| `payout:settle` | Financial | 15 min | Single-use | `admin` | Administrator executes financial batch settlement |
| `wallet:update` | Security | 5 min | Single-use | Resource Owner | Updating settlement or payout wallet address |
| `material:delete` | Resource | 5 min | Single-use | Resource Owner / `admin` | Soft or hard deletion of an educational material |
| `material:archive` | Resource | 10 min | Single-use | Resource Owner / `admin` | Unpublishing or archiving published content |
| `quarantine:override` | Security | 10 min | Single-use | `admin` | Administrative override of malware scanner quarantine |
| `learner:export_data` | Privacy | 15 min | Single-use | Learner / `admin` | Exporting student educational records (GDPR / FERPA) |
| `user:delete_account` | Security | 5 min | Single-use | Account Owner | Permanent account deletion |
| `refund:initiate` | Financial | 5 min | Single-use | `admin` / Buyer | Initiating escrow or purchase refund |
| `role:escalate` | Privileged | 5 min | Single-use | `admin` | Granting elevated roles or permissions |
| `maintainer:elevated_confirmation` | Support | 10 min | Single-use | Maintainer | Confirming elevated mutations during support impersonation |
| `download:access` | Content | 15 sec | Multi-range | Entitled Buyer | Accessing encrypted IPFS material content |

---

## 2. Cryptographic Envelope & Token Lifecycle

### 2.1 Token Envelope Structure

Capability tokens are compact `base64url`-encoded JSON envelopes:

```json
{
  "payload": "{\"v\":1,\"jti\":\"3f8a4e9b-...\",\"actor\":\"GCREATOR...\",\"action\":\"payout:request\",\"target\":\"payout-101\",\"constraints\":{\"maxAmount\":1500,\"currency\":\"XLM\"},\"singleUse\":true,\"nonce\":\"c8f1...\",\"iat\":1792195200000,\"exp\":1792195500000}",
  "signature": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

### 2.2 Payload Schema Fields

| Field | Type | Description |
|---|---|---|
| `v` | integer | Capability schema version (`1`) |
| `jti` | string | Universally unique token identifier (UUIDv4) |
| `actor` | string | Canonical address or user ID authorized to spend the capability |
| `action` | string | Specific sensitive action identifier (from `SENSITIVE_ACTIONS`) |
| `target` | string | Target resource ID (e.g. `mat-101`, `payout-55`, or `*` for actor-scoped actions) |
| `constraints` | object | Fine-grained bounds (e.g. `maxAmount`, `currency`, `byteRangeQuota`) |
| `singleUse` | boolean | If `true`, the token's JTI is tracked and consumed upon execution |
| `nonce` | string | High-entropy cryptographic random hex for replay prevention |
| `iat` | integer | Issued-at epoch timestamp in milliseconds |
| `exp` | integer | Expiration epoch timestamp in milliseconds |

### 2.3 Cryptographic Integrity and Constant-Time Verification

Signatures are computed via HMAC-SHA256:

$$\text{signature} = \text{HMAC-SHA256}(K_{\text{secret}}, \text{payloadJson})$$

To guard against **timing attacks**, verification compares signatures using Node's `timingSafeEqual`:

```javascript
const expected = Buffer.from(expectedHex, 'hex');
const received = Buffer.from(receivedHex, 'hex');
return expected.length === received.length && timingSafeEqual(expected, received);
```

---

## 3. Four-Path Acceptance Criteria Mapping

| Path | Scenario | Result & Status Code | Error Taxonomy Code |
|---|---|---|---|
| **Normal** | Valid capability token presented for matching actor, action, target, within TTL | Operation allowed, token consumed, execution proceeds | HTTP 200 OK |
| **Normal** | Single-use consumption | Nonce recorded in store; subsequent presentation blocked | HTTP 200 OK |
| **Failure** | Token missing from request | Rejected before invoking sensitive handler | HTTP 401 (`EVT_AUTH_001`) |
| **Failure** | Malformed base64url or corrupt JSON | Rejected with malformed envelope notice | HTTP 401 (`EVT_AUTH_002`) |
| **Failure** | Signature tampered (e.g. modified target ID or amount constraint) | Timing-safe check fails; tampering audit logged | HTTP 401 (`EVT_AUTH_002`) |
| **Failure** | Token expired (`now >= exp`) | Rejected with refresh guidance | HTTP 401 (`EVT_AUTH_003`) |
| **Failure** | Action mismatch (e.g. `material:archive` token used for `material:delete`) | Denied; capability not transferable | HTTP 403 (`EVT_AUTH_004`) |
| **Failure** | Target mismatch (e.g. token for `mat-1` used on `mat-2`) | Denied; strict object binding | HTTP 403 (`EVT_AUTH_004`) |
| **Failure** | Actor mismatch (e.g. token for Alice presented by Eve) | Denied; strict subject binding | HTTP 403 (`EVT_AUTH_004`) |
| **Failure** | Constraint violation (e.g. `amount` exceeds `maxAmount`) | Denied; constraint exceeded | HTTP 403 (`EVT_INPUT_002`) |
| **Failure** | Single-use replay attack | Second attempt rejected with conflict notice | HTTP 409 (`EVT_AUTH_002`) |
| **Failure** | Explicitly revoked token | Immediately rejected even if within TTL | HTTP 401 (`EVT_AUTH_002`) |
| **Retry** | Expired capability token presented | Returns structured retryable envelope with `refresh_capability` action | HTTP 401 (`EVT_AUTH_003`, `retryable: true`) |
| **Retry** | Token re-issuance & retry | Client re-authenticates/refreshes token and retries; succeeds cleanly | HTTP 200 OK |
| **Authorization** | Learner requests payout or quarantine capability | Issuance denied at policy level | HTTP 403 (`EVT_AUTH_004`) |
| **Authorization** | Creator attempts destructive action on another creator's material | Cross-tenant issuance blocked | HTTP 403 (`EVT_AUTH_004`) |
| **Authorization** | Administrator issues privileged capabilities | Permitted across system with audit trace | HTTP 200 OK |

---

## 4. Operational Edge Cases & Mitigations

### 4.1 Distributed Clock Skew and Clock Drift
- **Risk**: Edge nodes or server clocks diverging by several seconds causing premature expiration or rejection of freshly minted tokens.
- **Mitigation**: Verification permits up to 60 seconds of clock skew for `iat` (`iat <= now + 60_000`), while strictly enforcing `exp <= now` at the evaluation node.

### 4.2 Replay Protection & Memory Leak Prevention in Nonce Store
- **Risk**: A high volume of single-use capabilities exhausts in-memory storage of consumed JTIs.
- **Mitigation**: `createCapabilityNonceStore` implements automatic TTL-based pruning. Nonces whose `exp < now` are automatically evicted, bounding memory consumption.

### 4.3 Concurrent Retry Storms & Network Dropouts
- **Risk**: A client issues a sensitive operation; the operation executes, but the HTTP response drops. The client retries with the same capability token.
- **Mitigation**:
  - For non-idempotent operations, the second attempt is rejected as `EVT_AUTH_002` (409 Replay Detected), preventing duplicate side effects.
  - For idempotent operations wrapped in `withIdempotency()`, the idempotency layer intercepts duplicate retries, returning the cached outcome without re-consuming or failing.

### 4.4 Maintainer Support Impersonation Safety
- **Risk**: Support maintainers impersonating users for debugging could accidentally trigger irreversible financial withdrawals or account deletions.
- **Mitigation**: In accordance with `docs/MAINTAINER_IMPERSONATION.md`, blocked sensitive actions require explicit elevated confirmation capability tokens (`maintainer:elevated_confirmation`), requiring explicit maintainer re-authorization.

---

## 5. Recovery and Rollback Behavior

### 5.1 Immediate Token Revocation
If a capability token is intercepted or leaked before its TTL elapses:
```javascript
import { revokeSensitiveCapabilityToken } from '@/lib/auth/sensitiveCapabilityToken.js';

// Instantly invalidates the specific token across the cluster
revokeSensitiveCapabilityToken(tokenJti, { reason: 'suspected_compromise' });
```

### 5.2 Emergency Secret Rotation Kill Switch
In the event of a critical security breach:
1. Update `CAPABILITY_TOKEN_SECRET` in environment variables:
   ```bash
   CAPABILITY_TOKEN_SECRET="new-high-entropy-secret-rotated-2026"
   ```
2. Restart application instances.
3. Because all active capabilities were signed with the previous secret, every outstanding capability token is invalidated across the system. Affected clients receive `EVT_AUTH_002` / `EVT_AUTH_003` and must re-authenticate.

---

## 6. Backward Compatibility & Migration Plan

- **Preservation of Download Capability Tokens**:
  [`src/lib/downloads/capabilityToken.js`](../src/lib/downloads/capabilityToken.js) continues to operate for high-throughput IPFS download ranges.
- **Taxonomy Alignment**:
  All error responses adhere to the standard error taxonomy in [`docs/API_REFERENCE.md`](API_REFERENCE.md) (`EVT_AUTH_001` through `EVT_AUTH_004`, `EVT_INPUT_002`, `refresh_capability`).
