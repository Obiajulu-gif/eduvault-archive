# Deterministic Conflict Resolver for Multi-Client Edits

This document specifies the architecture, merge algorithms, authorization model, operational edge cases, and recovery runbooks for **deterministic conflict resolution** in EduVault.

---

## 1. Overview and Problem Statement

EduVault allows educators, creators, and institutions to manage educational content across multiple concurrent client sessions (web browsers, mobile interfaces, background import workers, and automated indexers).

Under standard binary Optimistic Concurrency Control (OCC):
- If Client A and Client B both read version $V_1$, and Client A writes version $V_2$, Client B's subsequent write is outright rejected with HTTP 409 Conflict.
- Even if Client A only updated `price` and Client B only updated `description`, Client B's work is lost unless manually retyped after a full page reload.

The **Deterministic Conflict Resolver** provides automated three-way merging for orthogonal edits, mathematically sound set unions for collection fields, relative delta updates for numeric counters, and deterministic tie-breaking for overlapping scalars—while strictly preventing unauthorized mutations, resurrection of deleted records, or privilege escalation.

```text
       +---------------------------------------------+
       |            Base Ancestor (V_base)           |
       +---------------------------------------------+
                        /           \
                       /             \
                      v               v
       +--------------------+   +--------------------+
       |  Server (V_server) |   | Client (V_proposed)|
       +--------------------+   +--------------------+
                      \               /
                       \             /
                        v           v
       +---------------------------------------------+
       |   Deterministic 3-Way Conflict Resolver     |
       |  (Orthogonal Merge, Set Union, Delta, LWW)  |
       +---------------------------------------------+
                              |
                              v
       +---------------------------------------------+
       |       Merged Document State (V_next)        |
       +---------------------------------------------+
```

---

## 2. Three-Way Merge Architecture

### 2.1 Inputs to Resolution
1. **Base Snapshot ($D_{\text{base}}$)**: The document state when the editing client opened the form at $V_{\text{base}}$.
2. **Current Server State ($D_{\text{server}}$)**: The database state committed by racing writes at $V_{\text{server}}$ ($V_{\text{server}} > V_{\text{base}}$).
3. **Proposed Client State ($D_{\text{client}}$)**: The client's submitted update payload.

### 2.2 Field Difference Analysis
For each field $f \in \text{Fields}(D_{\text{base}} \cup D_{\text{server}} \cup D_{\text{client}})$:
- $\Delta_{\text{server}}(f) = D_{\text{server}}[f] \neq D_{\text{base}}[f]$
- $\Delta_{\text{client}}(f) = D_{\text{client}}[f] \neq D_{\text{base}}[f]$

### 2.3 Deterministic Field Resolution Policies

| Conflict Scenario | Condition | Resolution Policy | Resulting Value $D_{\text{merged}}[f]$ |
|---|---|---|---|
| **Clean Client Edit** | $\Delta_{\text{client}}(f) \land \neg \Delta_{\text{server}}(f)$ | Client edit adopted cleanly | $D_{\text{client}}[f]$ |
| **Clean Server Retention** | $\Delta_{\text{server}}(f) \land \neg \Delta_{\text{client}}(f)$ | Server edit retained | $D_{\text{server}}[f]$ |
| **Identical Concurrent Edits** | $D_{\text{client}}[f] == D_{\text{server}}[f]$ | Idempotent convergence | $D_{\text{client}}[f]$ |
| **Array / Tag Set Union** | $f \in \{\text{tags}, \text{categories}, \text{learningOutcomes}\}$ | Deduplicated set union | $\text{ArrayUnion}(D_{\text{server}}[f], D_{\text{client}}[f])$ |
| **Numeric Counter Delta** | $f \in \{\text{likes}, \text{viewsCount}, \text{feedbackCount}\}$ | Relative delta arithmetic | $D_{\text{server}}[f] + (D_{\text{client}}[f] - D_{\text{base}}[f])$ |
| **Critical Field Conflict** | $f \in \text{CRITICAL\_FIELDS} \land \text{strict} == \text{true}$ | Rejection for manual review | None (triggers HTTP 409 Conflict) |
| **Scalar Overlap (LWW)** | $f \notin \text{CRITICAL\_FIELDS} \lor \text{strict} == \text{false}$ | Last-Write-Wins with Actor tie-break | $\text{Winner}(\text{timestamp}, \text{actorId})$ |

### 2.4 Deterministic Tie-Breaking
When both client and server update the same scalar field at identical timestamps, the resolver uses a **lexicographical tie-breaker** on actor IDs:
$$\text{winner} = \begin{cases} \text{client}, & \text{if } \text{actor}_{\text{client}} \ge \text{actor}_{\text{server}} \\ \text{server}, & \text{otherwise} \end{cases}$$
This eliminates nondeterministic race conditions across distributed instances.

---

## 3. Four-Path Acceptance Criteria Mapping

| Path | Scenario | Expected Behavior | Invariant / Status |
|---|---|---|---|
| **Normal** | Orthogonal edits: Client A edits `title`, Client B edits `price` & `description` | Both edits merged automatically into single document | `status: 'auto_merged'`, $V_{\text{next}} = V_{\text{server}} + 1$, zero lost edits |
| **Normal** | Both clients update `visibility: 'private'` concurrently | Idempotent convergence | `status: 'auto_merged'`, strategy: `idempotent_identical` |
| **Normal** | Concurrent tag updates: Server adds `['energy']`, Client adds `['kinematics']` | Deduplicated set union preserving all tags | All unique tags retained without duplicates |
| **Normal** | Concurrent like updates: Base 100, Server +5, Client +8 | Relative delta addition: $100 + 5 + 8 = 113$ | Metric reflects aggregate additions |
| **Failure** | Conflicting `license` in strict mode | Blocked; manual resolution required | `status: 'conflict_requires_action'`, HTTP 409, structured diff envelope |
| **Failure** | Server record was deleted (`isDeleted: true`); client submits edit | Blocked; resurrection forbidden | `status: 'invalid_transition'`, HTTP 409 |
| **Failure** | Document does not exist in collection | Rejected | `status: 'not_found'`, HTTP 404 |
| **Retry** | Client receives 409 conflict envelope | Inspects diff, applies preference, and retries with updated version | Atomic CAS succeeds on retry with $V_{\text{next}}$ |
| **Authorization** | Learner role submits catalog material update | Denied at authorization boundary | `status: 'unauthorized'`, HTTP 403 Forbidden |
| **Authorization** | Creator Alice attempts to edit Creator Bob's material | Denied by tenant isolation guard | `status: 'unauthorized'`, HTTP 403 Forbidden |
| **Authorization** | Creator attempts to smuggle privileged fields (`moderationStatus`) | Privileged field modifications stripped and blocked | `status: 'unauthorized'`, HTTP 403 Forbidden |
| **Authorization** | Administrator merges updates including privileged fields | Allowed with audit entry | HTTP 200 OK |

---

## 4. Operational Edge Cases & Mitigations

### 4.1 Clock Drift and Out-of-Order Timestamps
- **Threat**: Client device clocks diverging by seconds or minutes could bias Last-Write-Wins in favor of a misconfigured clock.
- **Mitigation**: Server receipt timestamps can override client timestamps, and equal timestamps resolve deterministically via actor ID string comparison.

### 4.2 Array Mutation Duplication
- **Threat**: Concurrent additions of the same tag creating duplicate elements in MongoDB arrays.
- **Mitigation**: `mergeArrayUnion` normalizes elements into a set, deduplicating elements by JSON equality before committing.

### 4.3 Concurrent Tombstone / Soft-Deletion Races
- **Threat**: Client A deletes a listing while Client B edits its title. An automated merge could unset `isDeleted: true`, accidentally resurrecting deleted material.
- **Mitigation**: `resolveConflictThreeWay` explicitly checks `server.isDeleted === true` and aborts with `INVALID_TRANSITION` if a client edit attempts to overwrite a tombstoned record.

### 4.4 High-Contention Retry Storms
- **Threat**: 20+ clients simultaneously editing the same high-traffic listing, causing cascading CAS failures.
- **Mitigation**: `updateWithConflictResolution` bounds resolution retries to `maxResolutionRetries = 3`. If contention persists, it returns `CONFLICT_REQUIRES_ACTION` with `retryable: true`, allowing clients to back off with jitter.

---

## 5. Recovery and Rollback Behavior

### 5.1 Audit Journaling
Every resolved conflict records a persistent audit entry via `buildConflictAuditRecord`:
```json
{
  "materialId": "mat-101",
  "actor": "creator-alice",
  "baseVersion": 1,
  "serverVersion": 2,
  "newVersion": 3,
  "status": "auto_merged",
  "resolvedFields": [
    { "field": "tags", "strategy": "array_set_union", "winner": "union" },
    { "field": "likes", "strategy": "numeric_relative_delta", "winner": "delta" }
  ],
  "unresolvedCount": 0,
  "timestamp": "2026-10-19T08:15:00.000Z"
}
```

### 5.2 Rollback Procedure
If an automated merge produces an undesired outcome:
1. Fetch the pre-merge snapshot from `material_history` or `audit_ledger`.
2. Apply the pre-merge state with an atomic increment: $V_{\text{rollback}} = V_{\text{current}} + 1$.
3. This preserves linear version monotonicity and ensures client caches invalidate without ghost updates.

---

## 6. Backward Compatibility & Migration Plan

- **Preservation of Existing OCC**:
  - `src/lib/backend/versionedWrite.js` remains completely untouched and functional for existing callers.
  - Callers wishing simple fail-fast behavior continue calling `updateWithExpectedVersion`.
  - Routes wishing automatic merge call `updateWithConflictResolution`.
- **API Response Compatibility**:
  - Unresolved conflicts return HTTP 409 with standard `CONCURRENCY_CONFLICT` error envelopes, ensuring existing frontend error modals continue to display accurately.
