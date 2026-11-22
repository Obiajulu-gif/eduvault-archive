# PR: Deterministic Recovery Tests for Interrupted Multi-Step Operations (Issue #3)

## Summary

This PR implements a comprehensive testing framework for verifying recovery behavior from any interruption point in multi-step operations, with deterministic state snapshots, idempotency verification, and authorization preservation.

## Changes

### New Implementation

**Files Added**:
- `src/lib/operations/recoveryTests.js` - Recovery testing framework
- `src/lib/operations/__tests__/recoveryTests.test.js` - Comprehensive test suite (28 test cases)

**Files Modified**:
- `src/lib/backend/schemaContracts.js` - Added `recovery_tests` collection and indexes

## Features

### 1. Deterministic State Snapshots
- Cryptographic state hashing (SHA-256)
- Actor authorization embedded
- Metadata tracking
- Reproduc ible snapshot IDs

### 2. Interruption Points
Tests recovery from 6 critical interruption points:
- `BEFORE_START` - Operation not yet started
- `AFTER_VALIDATION` - Validation complete, execution pending
- `DURING_EXECUTION` - Partial execution
- `AFTER_PARTIAL_COMMIT` - Some changes committed
- `BEFORE_FINALIZATION` - Execution complete, finalization pending
- `AFTER_COMPLETION` - Operation complete, verification pending

### 3. Comprehensive Testing
- **Idempotency Verification**: Double execution produces same result
- **Authorization Preservation**: Actor details maintained through recovery
- **Rollback Testing**: Verify safe reversal from any point
- **Test Suite Execution**: Run all interruption points automatically

### 4. Path Coverage
✅ **Normal Path**: Successful recovery with state verification
✅ **Failure Path**: State mismatch, recovery errors, non-idempotent operations
✅ **Retry Path**: Idempotency verification (function called twice)
✅ **Authorization Path**: Actor preservation, authorization loss detection

## Database Schema

### Collection: `recovery_tests`

Indexes:
- Unique testId
- Operation type with timestamp
- Interruption point with status
- Status with timestamp for reporting

## Usage Examples

### Test Single Recovery Scenario

```javascript
import {
  testRecoveryFromInterruption,
  InterruptionPoint,
} from '@/lib/operations/recoveryTests.js';

const result = await testRecoveryFromInterruption({
  operationId: 'op_purchase_001',
  operationType: 'purchase',
  interruptionPoint: InterruptionPoint.AFTER_PARTIAL_COMMIT,
  
  initialState: {
    step: 'payment_processed',
    purchaseId: 'purch_123',
    entitlementCreated: false,
    emailSent: false,
  },
  
  recoveryFunction: async (snapshot) => {
    // Complete remaining steps
    if (!snapshot.state.entitlementCreated) {
      await createEntitlement(snapshot.state.purchaseId);
    }
    if (!snapshot.state.emailSent) {
      await sendEmail(snapshot.state.purchaseId);
    }
    return {
      step: 'completed',
      purchaseId: snapshot.state.purchaseId,
      actor: snapshot.actor,
    };
  },
  
  expectedFinalState: {
    step: 'completed',
    purchaseId: 'purch_123',
    actor: testActor,
  },
  
  actor: testActor,
});

console.log('Test passed:', result.status === 'passed');
```

### Run Comprehensive Test Suite

```javascript
import { runRecoveryTestSuite } from '@/lib/operations/recoveryTests.js';

const results = await runRecoveryTestSuite({
  operationType: 'refund',
  operationId: 'suite_refund_001',
  
  setupFunction: async (interruptionPoint) => ({
    initialState: { step: interruptionPoint, amount: 100 },
    expectedFinalState: { step: 'completed', amount: 100 },
  }),
  
  recoveryFunction: async (snapshot) => ({
    step: 'completed',
    amount: snapshot.state.amount,
  }),
  
  cleanupFunction: async (testResult) => {
    // Cleanup after each test
  },
  
  interruptionPoints: Object.values(InterruptionPoint),
  actor: adminActor,
});

console.log(`Results: ${results.passed}/${results.totalTests} passed`);
```

### Test Rollback Behavior

```javascript
import { testRollbackFromInterruption } from '@/lib/operations/recoveryTests.js';

const result = await testRollbackFromInterruption({
  operationId: 'op_rollback_001',
  operationType: 'batch_insert',
  interruptionPoint: InterruptionPoint.AFTER_PARTIAL_COMMIT,
  
  interruptedState: {
    committedRecords: 5,
    pendingRecords: 5,
  },
  
  rollbackFunction: async (snapshot) => ({
    step: 'rolled_back',
    committedRecords: 0,
    pendingRecords: 0,
  }),
  
  expectedRollbackState: {
    step: 'rolled_back',
    committedRecords: 0,
    pendingRecords: 0,
  },
  
  actor: adminActor,
});
```

### Generate Recovery Test Report

```javascript
import { generateRecoveryTestReport } from '@/lib/operations/recoveryTests.js';

const report = await generateRecoveryTestReport({
  operationType: 'purchase',
  since: new Date('2024-01-01'),
});

console.log(`Total tests: ${report.totalTests}`);
console.log(`Pass rate: ${100 - report.failureRate}%`);
console.log(`Average duration: ${report.averageDuration}ms`);
```

## Test Coverage

**File**: `src/lib/operations/__tests__/recoveryTests.test.js`

28 test cases covering:
- ✅ State snapshot creation with deterministic hashing
- ✅ Hash consistency for identical states
- ✅ Successful recovery verification
- ✅ Idempotency enforcement (double execution)
- ✅ State mismatch detection
- ✅ Non-idempotent operation detection
- ✅ Recovery function error handling
- ✅ Authorization preservation through recovery
- ✅ Authorization loss detection
- ✅ Comprehensive test suite execution
- ✅ Partial failure handling in suite
- ✅ Rollback testing
- ✅ Rollback idempotency
- ✅ Test history retrieval
- ✅ Report generation with statistics
- ✅ Edge cases (before_start, after_completion)
- ✅ Complex state objects with nested data

## Key Features

### Idempotency Verification
- Recovery function executed twice
- Results must be identical
- Non-deterministic operations detected

### Authorization Preservation
- Actor details captured in snapshot
- Verified in recovered state
- Authorization loss flagged as error

### Deterministic Hashing
- Same state always produces same hash
- Enables reliable comparison
- Prevents false positives

## Acceptance Criteria

- [x] Cover normal, failure, retry, and authorization paths
- [x] Automated tests with comprehensive coverage (28 tests)
- [x] Document operational edge cases and recovery/rollback behavior
- [x] Preserve existing contracts (additive only, no breaking changes)

## Breaking Changes

**None.** All changes are additive:
- New collection `recovery_tests` created on first use
- Testing framework is opt-in
- No impact on existing operations

## Performance Impact

- Tests run independently
- No impact on production operations
- Efficient indexed queries for history

## Use Cases

### 1. Development
- Test recovery logic during development
- Verify idempotency of operations
- Catch non-deterministic behavior early

### 2. CI/CD Integration
```javascript
const results = await runRecoveryTestSuite({...});
if (results.failed > 0) {
  process.exit(1); // Fail the build
}
```

### 3. Operational Verification
- Verify recovery procedures work
- Test rollback behavior
- Generate recovery test reports

### 4. Chaos Engineering
- Simulate failures at any point
- Verify system resilience
- Document recovery procedures

## Migration Path

1. Deploy code changes
2. MongoDB creates `recovery_tests` collection on first use
3. Indexes created automatically
4. Start testing critical operations
5. Integrate into CI/CD pipeline

## Related Issues

- Issue #3: Add deterministic recovery tests for interrupted multi-step operations

---

**Status**: Ready for review. Implementation is complete with comprehensive test coverage.
