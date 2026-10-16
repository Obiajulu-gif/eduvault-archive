# Permission-Diff Report Engine

## Overview
The **Permission-Diff Report Engine** provides pre-flight impact analysis, risk classification, breaking change detection, and operational safeguards before administrative role or policy changes take effect on `eduvault-archive`.

## Architecture & Data Flow

1. **Pre-flight Evaluation (`GET /api/admin/users/role?userId=...&targetRole=...`)**:
   - An administrator or UI can query the endpoint in dry-run/preview mode.
   - Computes added permissions, revoked capabilities, risk assessment (`low`, `medium`, `high`, `critical`), and flags potential operational disruption.
2. **Transition Validation (`POST /api/admin/users/role`)**:
   - Evaluates caller authorization (admin required, fail-closed).
   - Validates transition constraints:
     - Rejects non-existent users (404) or invalid target roles (400).
     - Rejects idempotent/no-op role assignments (409 Conflict).
     - Protects against administrator self-demotion lockout (422 Unprocessable Entity).
     - Prevents unconfirmed critical elevation (428 Precondition Required) unless `confirmElevatedRisk: true` is supplied.
3. **Audit Ledger Enrichment**:
   - Both the intent and resulting role changes recorded via `appendAuditRecord` store the complete permission-diff report for non-repudiation and forensic accountability.

## Risk Classification Matrix

| Risk Level | Trigger Conditions | Examples | Safeguards |
| :--- | :--- | :--- | :--- |
| **Critical** | Target role is `admin` or grants system configuration / user governance capabilities | `users:manage_roles`, `system:configure`, `system:migrate`, `users:suspend` | Requires explicit `confirmElevatedRisk: true` flag |
| **High** | Grants platform moderation, dispute, financial refund, or full PII export access | `materials:moderate`, `refunds:process`, `export:pii`, `export:full` | Admin session verified; full audit log persisted |
| **Medium** | Grants publication, creator payout requests, or content editing | `materials:create`, `materials:publish_own`, `payouts:request` | Breaking change detection on demotion |
| **Low** | Read-only public discovery or individual learner library actions | `materials:read_public`, `profile:read_own`, `progress:write_own` | Standard role assignment |

## Operational Edge Cases & Rollback Playbook

### 1. Accidental Elevation
- **Detection**: Check audit log entries where `action === 'user.role_changed'` and `intent.diffReport.riskLevel === 'critical'`.
- **Mitigation / Rollback**: Submit a remediation `POST /api/admin/users/role` resetting the user back to their prior role (`intent.previousRole`). The audit trail retains the remediation link.

### 2. Lockout Prevention (Self-Demotion)
- **Scenario**: An admin inadvertently removes their own administrative role while adjusting accounts.
- **Safety**: The engine detects when `actor.sub === targetUser._id` and rejects self-demotion with code `422`. A different administrator must perform any intended de-elevation.

### 3. Creator Demotion & Orphaned Drafts
- **Scenario**: A user is transitioned from `creator` to `learner`.
- **Handling**: The engine emits a breaking-change advisory in `diffReport.breakingChanges` noting that published and draft materials become read-only to the user.

## Backward Compatibility
- Existing API clients submitting `{ userId, role }` continue to receive `{ success: true, previousRole, role }`.
- The added `diffReport` is purely additive and backward-compatible with all existing consumers.
