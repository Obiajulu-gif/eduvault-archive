# Partial Failure Dashboard

Issue #812: Build partial failure dashboard for background and external integrations

## Overview

The Partial Failure Dashboard provides visibility into operations stuck between internal state and external systems, enabling maintainers to resolve user-impacting failures quickly.

## Features

- **Operation Tracking**: Track partially completed operations
- **External References**: Store external system IDs for correlation
- **Failure Grouping**: Group by type, age, severity, and retryability
- **Remediation Actions**: Retry, inspect, or manually resolve
- **Safe Metadata**: Store context without leaking secrets
- **Dashboard View**: Comprehensive failure overview

## Failure Severity Levels

- **Low**: Minor issues, low user impact
- **Medium**: Moderate impact, requires attention
- **High**: Significant impact, urgent resolution needed
- **Critical**: Severe impact, immediate action required

## Operation Types

- `payment`: Payment processing failures
- `file_upload`: File upload failures
- `email`: Email delivery failures
- `blockchain_transaction`: Blockchain transaction failures
- `ipfs_pin`: IPFS pinning failures
- `indexer`: Indexer processing failures
- `webhook`: Webhook delivery failures
- `external_api`: External API call failures

## Usage

### Recording a Partial Failure

```javascript
import { recordPartialFailure } from '../lib/monitoring/partialFailureDashboard.js';

await recordPartialFailure({
  operationType: 'payment',
  operationId: 'pay_123',
  externalReferenceId: 'stripe_pi_456',
  userId: 'user_789',
  resourceId: 'material_101',
  status: 'failed',
  severity: 'high',
  retryable: true,
  errorMessage: 'Payment processing timeout',
  errorCode: 'TIMEOUT',
  metadata: {
    amount: 19.99,
    currency: 'USD',
    attempt: 1,
  },
  tags: ['stripe', 'checkout'],
});
```

### Getting Dashboard View

```javascript
import { getPartialFailuresDashboard } from '../lib/monitoring/partialFailureDashboard.js';

const dashboard = await getPartialFailuresDashboard({
  operationType: 'payment', // Optional filter
  severity: 'critical', // Optional filter
  retryable: true, // Optional filter
  olderThan: 24 * 60 * 60 * 1000, // Older than 24 hours
  limit: 100,
});

console.log('Total failures:', dashboard.summary.total);
console.log('Critical:', dashboard.summary.critical);
console.log('Retryable:', dashboard.summary.retryable);
console.log('Stale (>24h):', dashboard.summary.stale);
```

### Retrying a Failed Operation

```javascript
import { retryFailedOperation } from '../lib/monitoring/partialFailureDashboard.js';

try {
  const result = await retryFailedOperation(failureId, {
    userId: 'admin_user',
  });
  console.log('Retry successful:', result);
} catch (error) {
  console.error('Retry failed:', error.message);
}
```

### Manual Resolution

```javascript
import { markAsManuallyResolved } from '../lib/monitoring/partialFailureDashboard.js';

await markAsManuallyResolved(failureId, {
  userId: 'admin_user',
  notes: 'Manually processed payment through admin panel',
  metadata: {
    adminPaymentId: 'admin_pay_123',
    processedAt: new Date(),
  },
});
```

### Ignoring a Failure

```javascript
import { markAsIgnored } from '../lib/monitoring/partialFailureDashboard.js';

await markAsIgnored(failureId, {
  userId: 'admin_user',
  notes: 'User requested refund, payment failure is expected',
});
```

### Inspecting Failure Details

```javascript
import { getFailureDetails } from '../lib/monitoring/partialFailureDashboard.js';

const details = await getFailureDetails(failureId);

console.log('Failure:', details.failure);
console.log('Related failures:', details.relatedFailures);
console.log('Remediation options:', details.remediationOptions);
console.log('Investigation links:', details.investigationLinks);
```

## Dashboard Structure

### Dashboard Response

```json
{
  "failures": [
    {
      "_id": "fail_123",
      "operationType": "payment",
      "operationId": "pay_456",
      "externalReferenceId": "stripe_pi_789",
      "userId": "user_101",
      "severity": "high",
      "retryable": true,
      "attemptCount": 2,
      "firstFailedAt": "2026-09-29T10:00:00Z",
      "lastAttemptAt": "2026-09-29T11:00:00Z",
      "errorMessage": "Payment processing timeout",
      "age": 7200000,
      "ageFormatted": "2 hours",
      "actionLinks": {
        "retry": "/api/failures/fail_123/retry",
        "inspect": "/api/failures/fail_123",
        "resolve": "/api/failures/fail_123/resolve",
        "ignore": "/api/failures/fail_123/ignore"
      }
    }
  ],
  "summary": {
    "total": 45,
    "critical": 3,
    "retryable": 32,
    "stale": 8
  },
  "groupings": {
    "byType": {
      "payment": 15,
      "file_upload": 10,
      "email": 20
    },
    "bySeverity": {
      "low": 10,
      "medium": 20,
      "high": 12,
      "critical": 3
    },
    "byAge": {
      "lessThan1Hour": 5,
      "1to6Hours": 10,
      "6to24Hours": 15,
      "1to7Days": 10,
      "moreThan7Days": 5
    }
  },
  "timestamp": "2026-09-29T12:00:00Z"
}
```

## Security: Metadata Sanitization

Sensitive information is automatically sanitized:

```javascript
// Input metadata
{
  apiKey: 'sk_live_123456',
  token: 'tok_visa_123',
  password: 'secret123',
  amount: 19.99
}

// Stored metadata (sanitized)
{
  apiKey: '***',
  token: '***',
  password: '***',
  amount: 19.99
}
```

Error messages are also sanitized:

```javascript
// Original error
'Payment failed with API key: sk_live_123456'

// Sanitized error
'Payment failed with api_key=***'
```

## API Routes

### Dashboard

```
GET /api/admin/failures/dashboard
```

Query parameters:
- `operationType`: Filter by operation type
- `severity`: Filter by severity
- `retryable`: Filter by retryability
- `olderThan`: Filter by age (milliseconds)
- `limit`: Result limit

### Failure Details

```
GET /api/admin/failures/:failureId
```

### Retry Operation

```
POST /api/admin/failures/:failureId/retry
```

### Mark as Resolved

```
POST /api/admin/failures/:failureId/resolve
```

Request body:
```json
{
  "notes": "Manual resolution description",
  "metadata": {}
}
```

### Mark as Ignored

```
POST /api/admin/failures/:failureId/ignore
```

Request body:
```json
{
  "notes": "Reason for ignoring"
}
```

## Integration Examples

### Payment Processing

```javascript
try {
  await processPayment(paymentData);
} catch (error) {
  await recordPartialFailure({
    operationType: 'payment',
    operationId: paymentData.id,
    externalReferenceId: paymentData.stripePaymentIntentId,
    userId: paymentData.userId,
    resourceId: paymentData.materialId,
    severity: 'high',
    retryable: true,
    errorMessage: error.message,
    metadata: {
      amount: paymentData.amount,
      currency: paymentData.currency,
    },
  });
  throw error;
}
```

### File Upload

```javascript
try {
  const result = await uploadToIPFS(file);
  return result;
} catch (error) {
  await recordPartialFailure({
    operationType: 'file_upload',
    operationId: file.id,
    userId: file.userId,
    severity: 'medium',
    retryable: true,
    errorMessage: error.message,
    metadata: {
      fileSize: file.size,
      fileType: file.type,
    },
  });
  throw error;
}
```

### Email Delivery

```javascript
try {
  await sendEmail(emailData);
} catch (error) {
  await recordPartialFailure({
    operationType: 'email',
    operationId: emailData.id,
    userId: emailData.recipientId,
    severity: 'low',
    retryable: true,
    errorMessage: error.message,
    metadata: {
      emailType: emailData.type,
      recipientEmail: emailData.to,
    },
  });
}
```

## Monitoring

### Automated Cleanup

Schedule cleanup of resolved failures:

```javascript
// Clean up resolved failures older than 30 days
const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

await db.collection('partial_failures').deleteMany({
  resolution: { $exists: true },
  resolvedAt: { $lt: new Date(thirtyDaysAgo) },
});
```

### Critical Failure Alerts

Critical failures automatically trigger alerts:

```javascript
// Automatically called when severity is 'critical'
async function sendCriticalFailureAlert(failure) {
  // Send to Slack, PagerDuty, email, etc.
  await alertingService.send({
    level: 'critical',
    title: `Critical ${failure.operationType} failure`,
    message: failure.errorMessage,
    link: `/admin/failures/${failure._id}`,
  });
}
```

### Metrics

Track failure metrics:

```javascript
const metrics = await getFailureMetrics({
  since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
});

console.log('Failure rate:', metrics.totalFailures / metrics.totalOperations);
console.log('Resolution time (avg):', metrics.avgResolutionTime);
console.log('Retry success rate:', metrics.retrySuccessRate);
```

## Best Practices

1. **Record early**: Capture failures as soon as they occur
2. **Include context**: Add relevant metadata for debugging
3. **Set severity correctly**: Use appropriate severity levels
4. **Mark retryability**: Indicate if operation can be safely retried
5. **External references**: Always include external system IDs
6. **Review regularly**: Check dashboard daily for new failures
7. **Clean up**: Remove resolved failures after retention period
8. **Monitor trends**: Track failure patterns and address root causes

## Troubleshooting

### High Failure Rate

- Check external service status
- Review error patterns in dashboard
- Investigate common failure causes
- Consider circuit breaker implementation

### Stale Failures

- Review failures older than 24 hours
- Determine if manual intervention needed
- Update remediation procedures
- Improve retry logic

### Retry Failures

- Verify operation is truly retryable
- Check if external state changed
- Review error messages for guidance
- Consider manual resolution

## Future Enhancements

- Automated retry scheduling
- Failure pattern detection
- Root cause analysis
- Integration with monitoring tools
- Failure prediction
- Custom severity rules
- Webhook notifications
- Failure analytics dashboard
