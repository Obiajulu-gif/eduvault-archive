# Maintainer Impersonation System

Issue #810: Implement scoped maintainer impersonation for support debugging

## Overview

The Maintainer Impersonation System provides a safe way for maintainers to reproduce user-reported issues without gaining broad access to private data or performing irreversible actions.

## Features

- **Time-Limited Sessions**: Automatic expiration (default 30 min, max 1 hour)
- **Scoped Permissions**: Read-only by default with explicit action allowlisting
- **Full Audit Logging**: Complete trail of all impersonation activities
- **Visible Indicators**: Clear UI indicators during impersonation
- **Sensitive Action Blocking**: Dangerous mutations require elevated confirmation
- **Session Management**: Easy start, stop, and monitoring of sessions

## Security Model

### Default Allowed Actions (Read-Only)

- `view_profile`
- `view_materials`
- `view_purchases`
- `view_saved_items`
- `search_marketplace`
- `view_progress`

### Blocked Actions

- `delete_account`
- `change_password`
- `change_email`
- `transfer_funds`
- `withdraw`
- `update_wallet`
- `delete_content`
- `transfer_ownership`
- `change_permissions`
- `revoke_access`

## Usage

### Starting an Impersonation Session

```javascript
import { startImpersonationSession } from '../lib/auth/impersonation.js';

const session = await startImpersonationSession({
  maintainerId: 'maintainer_user_id',
  targetUserId: 'user_to_impersonate_id',
  reason: 'Debug reported checkout issue',
  ticketId: 'SUPPORT-12345',
  duration: 30 * 60 * 1000, // 30 minutes
  additionalActions: [], // Optional: add specific allowed actions
});

console.log('Session ID:', session.sessionId);
console.log('Expires at:', session.expiresAt);
```

### Validating Actions

```javascript
import { validateImpersonationAction } from '../lib/auth/impersonation.js';

const result = await validateImpersonationAction(
  sessionId,
  'view_profile',
  { metadata: 'context' }
);

if (result.allowed) {
  // Proceed with action
} else {
  console.error('Action blocked:', result.reason);
}
```

### Ending a Session

```javascript
import { endImpersonationSession } from '../lib/auth/impersonation.js';

await endImpersonationSession(sessionId);
```

### Middleware Integration

```javascript
import { impersonationMiddleware } from '../lib/auth/impersonation.js';

app.use(impersonationMiddleware);

// In your route handler:
if (req.isImpersonating) {
  // Show impersonation banner
  // Log impersonation context
}
```

## API Routes

### Start Session

```
POST /api/admin/impersonation/start
```

Request body:
```json
{
  "targetUserId": "user_123",
  "reason": "Debug reported issue",
  "ticketId": "TICKET-456",
  "duration": 1800000
}
```

### End Session

```
POST /api/admin/impersonation/end
```

Request body:
```json
{
  "sessionId": "session_123"
}
```

### Check Active Session

```
GET /api/admin/impersonation/active
```

### Audit Trail

```
GET /api/admin/impersonation/audit/:userId
```

## Audit Logging

All impersonation activities are logged:

- Session start/end
- Actions performed
- Blocked action attempts
- Session expiration

Example audit entry:

```json
{
  "action": "impersonation_action_performed",
  "maintainerId": "maint_123",
  "targetUserId": "user_456",
  "sessionId": "sess_789",
  "performedAction": "view_profile",
  "metadata": {},
  "timestamp": "2026-09-29T12:00:00Z"
}
```

## UI Integration

### Impersonation Banner

When impersonating, display a prominent banner:

```html
<div class="impersonation-banner">
  ⚠️ Impersonating User: user@example.com
  <button onclick="endImpersonation()">End Session</button>
</div>
```

### Action Confirmation

For sensitive actions requiring elevated confirmation:

```javascript
import { requiresElevatedConfirmation } from '../lib/auth/impersonation.js';

if (req.isImpersonating && requiresElevatedConfirmation(action)) {
  // Show confirmation dialog
  // Log confirmation request
}
```

## Testing

Run tests:

```bash
npm run test -- src/lib/auth/__tests__/impersonation.test.js
```

Test coverage includes:

- Session creation and validation
- Permission enforcement
- Expiration handling
- Audit logging
- Blocked action attempts
- Session lifecycle

## Best Practices

1. **Always provide a reason**: Document why impersonation is needed
2. **Use shortest duration**: Default to 30 minutes unless more time is needed
3. **Link to support ticket**: Always reference the support ticket
4. **End session promptly**: Don't leave sessions running
5. **Review audit logs**: Regularly review impersonation activity
6. **Limit maintainer access**: Only grant impersonation to trusted maintainers

## Compliance

### User Privacy

- No access to passwords or authentication secrets
- Sensitive financial data remains protected
- Actions are logged and auditable
- Users are notified of impersonation (optional)

### Security

- Time-limited sessions prevent prolonged access
- Action allowlisting prevents unauthorized operations
- Full audit trail for compliance
- Session tokens are non-transferable

## Monitoring

Monitor impersonation usage:

```javascript
const auditTrail = await getImpersonationAuditTrail(userId, {
  since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
  limit: 100,
});

console.log('Impersonation sessions:', auditTrail.length);
```

## Troubleshooting

### Session Not Working

- Check session hasn't expired
- Verify maintainer has correct role
- Ensure target user exists
- Review audit logs for blocked actions

### Actions Being Blocked

- Check if action is in default allowed list
- Verify action isn't in blocked list
- Consider if action should require explicit allowlisting
- Review session configuration

## Future Enhancements

- User notification on impersonation start
- Time-based action allowlisting (e.g., allow purchases after 5 minutes)
- IP allowlisting for impersonation sessions
- Two-factor confirmation for starting sessions
- Automated session reports for compliance
