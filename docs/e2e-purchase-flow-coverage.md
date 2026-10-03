# E2E Purchase Flow Test Coverage (Issue #787)

## Overview

This document describes the end-to-end test coverage for the highest-risk user journey in EduVault: the **Purchase/Checkout Flow**.

## Why This Flow is Highest Risk

The purchase flow is the most critical user journey because it:

1. **Involves financial transactions** - Users pay real money for educational content
2. **Has multiple integration points** - MongoDB, Stellar RPC, IPFS/Pinata, email service, webhooks
3. **Requires complex state management** - Checkout quotes, purchase records, entitlements, access control
4. **Has high impact on user trust** - Payment failures or access issues directly affect user satisfaction
5. **Has concurrency concerns** - Race conditions during duplicate purchase attempts
6. **Requires idempotency** - Users may retry or interrupt checkout mid-flow

## Test Suite Location

The E2E test suite is located at:
```
test/integration/purchase-flow-e2e.test.js
```

## Test Categories

### 1. Happy Path - Successful Purchase

Tests the complete successful purchase flow from checkout initiation to entitlement creation:

- **Full purchase flow**: Initiates checkout → creates quote → completes payment → creates entitlement
- **Purchase history retrieval**: Verifies buyer can retrieve their purchase history after successful purchase

**Key assertions:**
- Checkout initiation returns 201 with valid checkoutId
- Purchase creation returns 201 with confirmed status
- Entitlement is created in entitlement_cache
- Access is granted immediately after purchase
- Purchase history is retrievable via GET /api/purchase

### 2. Validation Failures

Tests that the API properly validates input and rejects invalid requests:

- **Missing materialId**: Rejects checkout initiation without materialId
- **Invalid amount**: Rejects negative or zero amounts
- **Missing asset**: Rejects checkout without asset specification
- **Missing buyer address**: Rejects purchase without authenticated buyer
- **Unauthorized access**: Returns 401 for unauthenticated requests

**Key assertions:**
- All validation errors return 400 or 401 status codes
- Error messages are descriptive and actionable
- No database changes occur for invalid requests

### 3. Payment Failures

Tests payment processing error scenarios:

- **Expired checkout quote**: Rejects purchase with expired quote
- **Invalid checkout quote**: Rejects purchase with invalid quote
- **Missing quote with payment**: Rejects payment without valid quote
- **Material not available**: Handles deleted/archived materials

**Key assertions:**
- Expired quotes return 409 with error message
- Invalid quotes return 409 with error message
- Material availability is checked before quote creation
- No purchase records are created for failed payments

### 4. Duplicate Purchase Prevention

Tests that the system prevents duplicate purchases and handles race conditions:

- **Duplicate purchase detection**: Returns existing purchase for same material/buyer
- **Race condition handling**: Handles concurrent purchase attempts gracefully
- **Pending purchase state**: Returns pending status for incomplete purchases

**Key assertions:**
- Duplicate purchases return 200 with "Already purchased" message
- No new purchase record is inserted for duplicates
- Race conditions converge on the winning purchase
- Pending purchases return 202 status

### 5. Retry and Recovery (Idempotency)

Tests that the system supports safe retries and recovery from interruptions:

- **Idempotency key support**: Honors idempotency keys for checkout initiation
- **Interrupted checkout**: Handles pending states from interrupted flows
- **Pending to confirmed transition**: Updates pending purchase to confirmed on payment completion

**Key assertions:**
- Idempotency keys prevent duplicate checkout intents
- Pending purchases can be updated to confirmed
- Transaction state is recoverable after interruption

### 6. Access Control After Purchase

Tests that access control is properly enforced after purchase:

- **Immediate access grant**: Access is granted immediately after successful purchase
- **Non-purchaser denial**: Non-purchasers are denied access
- **Access status checking**: Verifies access status endpoint works correctly

**Key assertions:**
- Access is granted (accessGranted: true) after purchase
- Non-purchasers receive accessGranted: false
- Access status reflects entitlement state

## External Dependencies Mocked

All external dependencies are mocked to ensure deterministic, isolated tests:

1. **MongoDB** - All collections (materials, purchases, entitlement_cache, checkout_quotes, checkout_intents, users)
2. **Stellar Horizon Client** - Trustline checks
3. **Tax Estimator** - Tax calculation
4. **Discount Verifier** - Discount code validation
5. **Email Service** - Receipt sending
6. **Webhook Sender** - Purchase event broadcasting
7. **Analytics Events** - Server-side analytics recording
8. **Audit Ledger** - Critical mutation logging

Mocks are configured in:
- `test/setup.js` - Base MongoDB and auth mocks
- `test/setup-vitest.js` - Additional service mocks for E2E tests

## Test Fixtures

Deterministic fixtures are defined in `test/fixtures/index.js`:

- `purchaseFixtures.material` - Sample published material
- `purchaseFixtures.checkoutQuote` - Sample checkout quote
- `purchaseFixtures.purchase` - Sample purchase record
- `purchaseFixtures.entitlement` - Sample entitlement record
- `purchaseFixtures.stellarTransaction` - Sample Stellar transaction

## Running the Tests

### Run the E2E purchase flow tests only:

```bash
npm test -- test/integration/purchase-flow-e2e.test.js
```

### Run all integration tests:

```bash
npm run test:integration
```

### Run all frontend tests (includes integration tests):

```bash
npm run test:frontend
```

### Run the complete test suite:

```bash
npm test
```

## Validation Script

A validation script is provided to verify the E2E test coverage:

```bash
node scripts/validate-e2e-purchase-coverage.mjs
```

This script:
1. Checks that the test file exists
2. Verifies test fixtures are defined
3. Validates mock configuration
4. Runs the test suite
5. Reports on test coverage

## CI Integration

The E2E tests are included in the CI pipeline through the standard test commands. They run as part of:

- `npm test` - Full test suite
- `npm run test:frontend` - Frontend and integration tests

## Test Coverage Summary

| Category | Test Count | Status |
|----------|------------|--------|
| Happy Path | 2 | ✅ Implemented |
| Validation Failures | 5 | ✅ Implemented |
| Payment Failures | 4 | ✅ Implemented |
| Duplicate Purchase Prevention | 3 | ✅ Implemented |
| Retry and Recovery | 3 | ✅ Implemented |
| Access Control | 2 | ✅ Implemented |
| **Total** | **19** | **✅ Complete** |

## Design Decisions and Tradeoffs

### Why Vitest for E2E Tests?

- **Consistency with existing tests** - The project already uses Vitest for integration tests
- **Fast execution** - Vitest provides fast test execution with parallel runs
- **Built-in mocking** - Excellent support for mocking external dependencies
- **Watch mode** - Useful for development with hot reload

### Why Mock All External Dependencies?

- **Determinism** - Tests produce consistent results regardless of external services
- **Speed** - No network calls or external service latency
- **Isolation** - Tests can run in any environment without external setup
- **Reliability** - No flakiness from external service downtime or rate limits

### Why Test at API Route Level?

- **Realistic** - Tests the actual API endpoints that users interact with
- **End-to-end** - Covers the full request/response cycle
- **Integration** - Verifies that all components work together
- **Maintainable** - Tests stay in sync with API contract

## Maintenance Notes

### Adding New Test Cases

When adding new test cases:

1. Add test fixtures to `test/fixtures/index.js` if needed
2. Configure mocks in `test/setup-vitest.js` for new dependencies
3. Add the test case to the appropriate describe block in `test/integration/purchase-flow-e2e.test.js`
4. Reset mocks in beforeEach to ensure test isolation

### Updating Mocks

When API endpoints change:

1. Update the relevant route handler in `src/app/api/`
2. Update the mock configuration in `test/setup-vitest.js` if new dependencies are added
3. Add or update test cases to cover the new behavior
4. Run the test suite to verify changes

### Adding New External Dependencies

When integrating new external services:

1. Add the dependency to the implementation
2. Create a mock in `test/setup-vitest.js`
3. Update test fixtures if the dependency affects data structures
4. Add test cases to verify the integration works correctly

## Known Limitations

1. **No actual Stellar transactions** - Stellar RPC calls are mocked; real transaction validation is not tested
2. **No actual IPFS uploads** - Pinata/IPFS interactions are mocked
3. **No actual email delivery** - Email sending is mocked
4. **No actual webhook delivery** - Webhook calls are mocked

These limitations are acceptable because:
- Stellar transaction validation is covered by Soroban contract tests
- IPFS upload is covered by separate integration tests
- Email and webhook delivery are non-critical for the purchase flow itself

## Future Enhancements

Potential improvements for future iterations:

1. **Add performance tests** - Measure response times for critical endpoints
2. **Add load tests** - Test behavior under concurrent load
3. **Add browser-based E2E tests** - Use Playwright or Cypress for UI-level testing
4. **Add chaos engineering** - Test resilience to partial failures
5. **Add monitoring integration** - Verify metrics and logging are correct

## References

- Issue #787: https://github.com/Obiajulu-gif/eduvault-archive/issues/787
- User Flows Documentation: `docs/user-flows.md`
- Test Configuration: `vitest.config.mjs`
- Test Setup: `test/setup.js`, `test/setup-vitest.js`
