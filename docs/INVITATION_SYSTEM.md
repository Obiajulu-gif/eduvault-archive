# Invitation and Collaboration System

Issue #811: Add abuse-resistant invitation and collaboration workflow

## Overview

The Invitation System provides abuse-resistant controls for collaboration invitations, preventing spam, unauthorized role escalation, stale invites, and ambiguous ownership.

## Features

- **Invitation States**: Pending, accepted, declined, revoked, expired
- **Role Validation**: Server-side role escalation prevention
- **Rate Limiting**: Throttle abusive invitation attempts
- **Expiration**: Automatic cleanup of stale invitations (72 hours)
- **Audit Trail**: Complete logging of invitation lifecycle
- **Collaboration Management**: Acceptance and revocation flows

## Collaboration Roles

Roles are hierarchical from least to most privileged:

1. **Viewer**: Read-only access
2. **Commenter**: View and comment
3. **Editor**: View, comment, and edit
4. **Admin**: Full management except ownership transfer
5. **Owner**: Complete control (cannot be assigned via invitation)

## Usage

### Creating an Invitation

```javascript
import { createInvitation } from '../lib/collaboration/invitations.js';

const invitation = await createInvitation({
  inviterId: 'user_123',
  inviteeEmail: 'collaborator@example.com',
  resourceType: 'material',
  resourceId: 'material_456',
  role: 'editor',
  message: 'Would you like to collaborate on this project?',
});

console.log('Invitation token:', invitation.token);
console.log('Expires at:', invitation.expiresAt);
```

### Accepting an Invitation

```javascript
import { acceptInvitation } from '../lib/collaboration/invitations.js';

const collaboration = await acceptInvitation(invitationToken, userId);

console.log('Collaboration created:', collaboration);
```

### Declining an Invitation

```javascript
import { declineInvitation } from '../lib/collaboration/invitations.js';

await declineInvitation(invitationToken, userId);
```

### Revoking an Invitation

```javascript
import { revokeInvitation } from '../lib/collaboration/invitations.js';

await revokeInvitation(invitationId, revokerId);
```

### Getting User Invitations

```javascript
import { getInvitationsForUser } from '../lib/collaboration/invitations.js';

const invitations = await getInvitationsForUser('user@example.com', {
  state: 'pending',
  limit: 50,
});
```

## Rate Limiting

Abuse protection through rate limits:

- **Per Hour**: 10 invitations maximum
- **Per Day**: 50 invitations maximum
- **Pending**: 50 maximum pending invitations per user

Rate limit exceeded errors:
```javascript
try {
  await createInvitation(config);
} catch (error) {
  if (error.message.includes('rate limit')) {
    // Handle rate limit error
  }
}
```

## Role Validation

### Escalation Prevention

Users cannot assign roles higher than their own:

```javascript
// Owner can assign admin
await createInvitation({ inviterId: ownerId, role: 'admin' }); // ✓

// Admin cannot assign admin
await createInvitation({ inviterId: adminId, role: 'admin' }); // ✗ Error

// Editor cannot assign admin
await createInvitation({ inviterId: editorId, role: 'admin' }); // ✗ Error
```

### Owner Role Protection

Owner role cannot be assigned via invitation:

```javascript
await createInvitation({ role: 'owner' }); // ✗ Error: Owner role cannot be assigned
```

Ownership transfer requires separate dedicated flow.

## Invitation States

### State Transitions

```
PENDING → ACCEPTED (user accepts)
PENDING → DECLINED (user declines)
PENDING → REVOKED (inviter or admin revokes)
PENDING → EXPIRED (time expires)
```

### State Validation

```javascript
// Can only accept/decline pending invitations
if (invitation.state !== 'pending') {
  throw new Error(`Invitation is ${invitation.state}`);
}

// Can only revoke pending invitations
if (invitation.state !== 'pending') {
  throw new Error(`Cannot revoke ${invitation.state} invitation`);
}
```

## Cleanup

Automatic cleanup of expired invitations:

```javascript
import { cleanupExpiredInvitations } from '../lib/collaboration/invitations.js';

const expiredCount = await cleanupExpiredInvitations();
console.log(`Cleaned up ${expiredCount} expired invitations`);
```

Schedule cleanup:

```bash
# Add to cron or scheduler
0 * * * * node scripts/cleanup-expired-invitations.mjs
```

## API Routes

### Create Invitation

```
POST /api/invitations
```

Request body:
```json
{
  "inviteeEmail": "user@example.com",
  "resourceType": "material",
  "resourceId": "mat_123",
  "role": "editor",
  "message": "Let's collaborate!"
}
```

### Accept Invitation

```
POST /api/invitations/:token/accept
```

### Decline Invitation

```
POST /api/invitations/:token/decline
```

### Revoke Invitation

```
DELETE /api/invitations/:invitationId
```

### List Invitations

```
GET /api/invitations/received
GET /api/invitations/sent
```

## Email Integration

Send invitation emails:

```javascript
import { sendInvitationEmail } from '../lib/email.js';

await sendInvitationEmail({
  to: invitation.inviteeEmail,
  inviterName: inviter.name,
  resourceName: resource.title,
  role: invitation.role,
  acceptUrl: `${baseUrl}/invitations/${invitation.token}`,
  expiresAt: invitation.expiresAt,
});
```

## Security Features

### Email Verification

Only users with matching email can accept:

```javascript
if (user.email.toLowerCase() !== invitation.inviteeEmail) {
  throw new Error('Invitation not for this user');
}
```

### Permission Checks

```javascript
// Check inviter has permission to invite
await validateRoleAssignment(
  inviterId,
  resourceType,
  resourceId,
  role
);

// Check revoker has permission
const hasPermission = await canManageInvitations(
  revokerId,
  resourceType,
  resourceId
);
```

### Duplicate Prevention

```javascript
const existingInvitation = await invitations.findOne({
  inviteeEmail,
  resourceType,
  resourceId,
  state: 'pending',
  expiresAt: { $gt: new Date() },
});

if (existingInvitation) {
  throw new Error('Pending invitation already exists');
}
```

## Audit Logging

All invitation activities are logged:

- Invitation created
- Invitation accepted
- Invitation declined
- Invitation revoked
- Invitation expired

Audit log format:

```json
{
  "action": "invitation_accepted",
  "invitationId": "inv_123",
  "userId": "user_456",
  "role": "editor",
  "timestamp": "2026-09-29T12:00:00Z"
}
```

## Testing

The invitation system includes comprehensive tests:

- Invitation creation
- Acceptance flow
- Revocation
- Expiration
- Rate limiting
- Role validation
- Security checks

## Best Practices

1. **Always validate roles**: Server-side validation prevents escalation
2. **Set reasonable expiry**: Default 72 hours balances usability and security
3. **Monitor rate limits**: Track invitation patterns for abuse
4. **Clean up regularly**: Run cleanup job to remove expired invitations
5. **Audit regularly**: Review invitation logs for suspicious activity
6. **Notify users**: Send email notifications for all invitation events

## Error Handling

Common errors and handling:

```javascript
try {
  await createInvitation(config);
} catch (error) {
  if (error.message.includes('rate limit')) {
    // Show rate limit message
  } else if (error.message.includes('role')) {
    // Show permission error
  } else if (error.message.includes('already exists')) {
    // Show duplicate invitation message
  }
}
```

## Future Enhancements

- Invitation templates
- Bulk invitations
- Team invitations
- Custom expiry periods
- Invitation reminders
- Analytics dashboard
