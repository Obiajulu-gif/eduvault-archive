# PR: Permission-Aware Export with Sensitive-Field Redaction (Issue #4)

## Summary

This PR implements a comprehensive permission-aware data export system with granular field-level redaction, multiple permission levels, and full audit trail for GDPR/compliance requirements.

## Changes

### New Implementation

**Files Added**:
- `src/lib/learner-export/permissionAwareExport.js` - Permission-aware export framework
- `src/lib/learner-export/__tests__/permissionAwareExport.test.js` - Comprehensive test suite (30 test cases)

**Files Modified**:
- `src/lib/backend/schemaContracts.js` - Added `learner_exports` collection and indexes

## Features

### 1. Permission Levels
- **SELF**: User exporting own data (full access, no redaction)
- **PARTIAL**: Support staff (limited PII, partial reveal available)
- **FULL_INTERNAL**: Admin with full PII access
- **COMPLIANCE**: Legal/compliance officer (highest access)

### 2. Sensitive Field Categories
- **PII**: Personally Identifiable Information (email, name, phone, address)
- **FINANCIAL**: Payment and transaction data
- **CREDENTIALS**: Passwords, tokens, keys
- **BEHAVIORAL**: Usage patterns, IP addresses
- **MEDICAL**: Health/educational records
- **BIOMETRIC**: Biometric identifiers

### 3. Field-Level Redaction
- Declarative field rules with allowed roles/permissions
- Full redaction: `[REDACTED:email]`
- Partial reveal: `jo***@example.com` or `***-***-4567`
- Recursive object and array redaction
- Category-based filtering

### 4. Path Coverage
✅ **Normal Path**: Successful export with appropriate redaction
✅ **Failure Path**: Authorization failures, export errors with audit
✅ **Retry Path**: Idempotent via exportId
✅ **Authorization Path**: Permission level determination, field filtering

## Database Schema

### Collection: `learner_exports`

Indexes:
- Unique exportId
- Subject wallet address with timestamp
- Requester with timestamp
- Permission level with timestamp

## Usage Examples

### Self-Export (Full Access)

```javascript
import { exportLearnerDataWithPermissions } from '@/lib/learner-export/permissionAwareExport.js';

// User exporting their own data
const selfExport = await exportLearnerDataWithPermissions({
  db: await getDb(),
  requester: {
    id: 'user_123',
    role: 'learner',
    walletAddress: 'GUSER123...',
  },
  subject: {
    walletAddress: 'GUSER123...', // Same wallet = self-export
    email: 'user@example.com',
    fullName: 'Jane Doe',
  },
  reason: 'GDPR data portability request',
  operationId: 'exp_self_20240115',
});

// No redaction for self-export
console.log('Email:', selfExport.data.profile.email); // 'user@example.com'
console.log('Full name:', selfExport.data.profile.fullName); // 'Jane Doe'
```

### Support Staff Export (Partial Access)

```javascript
// Support staff exporting user data for support case
const supportExport = await exportLearnerDataWithPermissions({
  db: await getDb(),
  requester: {
    id: 'support_alice',
    role: 'support',
    walletAddress: 'GSUPPORT...',
  },
  subject: {
    walletAddress: 'GUSER456...',
    email: 'customer@example.com',
    fullName: 'John Smith',
    phoneNumber: '555-123-4567',
  },
  reason: 'Support case #12345 - Purchase issue investigation',
  usePartialReveal: true, // Show partial info
  operationId: 'exp_support_001',
});

// Partial access with redaction
console.log('Email:', supportExport.data.profile.email); // 'cu***@example.com'
console.log('Full name:', supportExport.data.profile.fullName); // 'John S***'
console.log('Phone:', supportExport.data.profile.phoneNumber); // '***-***-4567'
```

### Admin Export (Full Internal)

```javascript
// Admin with full PII permission
const adminExport = await exportLearnerDataWithPermissions({
  db: await getDb(),
  requester: {
    id: 'admin_bob',
    role: 'admin',
    walletAddress: 'GADMIN...',
  },
  subject: {
    walletAddress: 'GUSER789...',
    email: 'vip@example.com',
  },
  reason: 'Fraud investigation case #999',
  includeCategories: ['pii', 'financial', 'behavioral'],
  operationId: 'exp_admin_fraud_001',
});

// Admin sees full data for allowed categories
console.log('Email:', adminExport.data.profile.email); // Full email
```

### Get Export History

```javascript
import { getExportHistory } from '@/lib/learner-export/permissionAwareExport.js';

const history = await getExportHistory({
  subjectWallet: 'GUSER123...',
  requester: { id: 'user_123', walletAddress: 'GUSER123...' },
  limit: 10,
});

history.forEach(exp => {
  console.log(`Export ${exp.exportId}:`);
  console.log(`  Date: ${exp.generatedAt}`);
  console.log(`  Requester: ${exp.requestedBy.role}`);
  console.log(`  Permission: ${exp.permissionLevel}`);
});
```

### Generate Export Report (Admin Only)

```javascript
import { generateExportReport } from '@/lib/learner-export/permissionAwareExport.js';

const report = await generateExportReport({
  since: new Date('2024-01-01'),
  requester: { id: 'admin_1', role: 'admin' },
});

console.log(`Total exports: ${report.totalExports}`);
console.log('By permission level:', report.byPermissionLevel);
console.log('Sensitive field access:', report.sensitiveFieldAccess);
```

## Test Coverage

**File**: `src/lib/learner-export/__tests__/permissionAwareExport.test.js`

30 test cases covering:
- ✅ Permission level determination (SELF, PARTIAL, FULL_INTERNAL, COMPLIANCE)
- ✅ Field-level redaction based on permissions
- ✅ Partial reveal functionality
- ✅ Recursive object and array redaction
- ✅ Normal successful export
- ✅ Idempotent retry behavior
- ✅ Authorization enforcement (unauthenticated, unauthorized)
- ✅ Category filtering based on permissions
- ✅ Failure handling with audit trail
- ✅ Export history retrieval
- ✅ Report generation
- ✅ Edge cases (null values, nested objects, missing fields)
- ✅ Recovery and rollback behavior
- ✅ Partial reveal error handling

## Redaction Rules Example

```javascript
SENSITIVE_FIELD_RULES = {
  'profile.email': {
    category: SensitiveFieldCategory.PII,
    allowedRoles: ['admin', 'support', 'compliance'],
    allowedPermissions: ['export:full_pii'],
    redactedValue: '[REDACTED:email]',
    partialReveal: (value) => {
      const [local, domain] = value.split('@');
      return `${local.substring(0, 2)}***@${domain}`;
    }
  },
  'profile.phoneNumber': {
    category: SensitiveFieldCategory.PII,
    allowedRoles: ['admin', 'compliance'],
    allowedPermissions: ['export:full_pii'],
    redactedValue: '[REDACTED:phone]',
    partialReveal: (value) => `***-***-${value.slice(-4)}`
  },
  'purchases.*.transactionHash': {
    category: SensitiveFieldCategory.FINANCIAL,
    allowedRoles: ['admin', 'support', 'compliance'],
    allowedPermissions: ['export:financial'],
    redactedValue: '[REDACTED:tx_hash]',
    partialReveal: (value) => `${value.substring(0, 8)}...${value.slice(-8)}`
  }
}
```

## Acceptance Criteria

- [x] Cover normal, failure, retry, and authorization paths
- [x] Automated tests with comprehensive coverage (30 tests)
- [x] Document operational edge cases and recovery/rollback behavior
- [x] Preserve existing contracts (extends existing export system)

## Breaking Changes

**None.** All changes are additive:
- Extends existing learner export functionality
- New collection `learner_exports` for audit trail
- No changes to existing export APIs

## Security & Compliance

### GDPR Compliance
- Right to data portability (self-export)
- Right to access (export history)
- Data minimization (field-level redaction)
- Audit trail for all exports

### Security Features
- Permission-based access control
- Field-level redaction
- Audit trail with reason tracking
- Authorization verification at multiple levels

### Privacy Protection
- PII redaction for non-authorized users
- Partial reveal option (balances utility and privacy)
- Category-based filtering
- Sensitive field masking

## Performance Impact

- Efficient indexed queries
- Recursive redaction optimized
- No impact on existing export operations
- Export history queries use indexes

## Use Cases

### 1. GDPR Compliance
- Users can export their own data
- Full access to their PII
- Portable format

### 2. Customer Support
- Support staff can view partial data
- Enough info to help without full PII
- Partial reveal shows context

### 3. Fraud Investigation
- Admins can access financial data
- Full transaction history
- Behavioral patterns

### 4. Legal/Compliance
- Compliance officers get highest access
- All categories available
- Full audit trail

### 5. Audit & Reporting
- Generate export activity reports
- Track sensitive field access
- Monitor permission usage

## Migration Path

1. Deploy code changes
2. MongoDB creates `learner_exports` collection on first use
3. Indexes created automatically
4. Start using permission-aware export
5. Existing export endpoints can migrate gradually

## Related Issues

- Issue #4: Implement permission-aware export with sensitive-field redaction

---

**Status**: Ready for review. Implementation is complete with comprehensive test coverage and full GDPR compliance support.
