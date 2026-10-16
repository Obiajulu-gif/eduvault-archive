/**
 * Abuse-Resistant Invitation and Collaboration Workflow
 * Issue #811: Add abuse-resistant invitation and collaboration workflow
 *
 * Provides controls that prevent spam, unauthorized role escalation,
 * stale invites, and ambiguous ownership.
 *
 * Features:
 * - Invitation state management with expiry
 * - Role validation
 * - Rate limiting
 * - Acceptance/revocation flows
 * - Server-side role escalation prevention
 */

import { getDb } from '../db/mongodb.js';
import logger from '../logger.js';

const INVITATION_EXPIRY_HOURS = 72; // 3 days
const MAX_PENDING_INVITATIONS_PER_USER = 50;
const MAX_INVITATIONS_PER_HOUR = 10;
const MAX_INVITATIONS_PER_DAY = 50;

/**
 * Invitation states
 */
export const InvitationState = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
};

/**
 * Collaboration roles (from least to most privileged)
 */
export const CollaborationRole = {
  VIEWER: 'viewer',
  COMMENTER: 'commenter',
  EDITOR: 'editor',
  ADMIN: 'admin',
  OWNER: 'owner',
};

const ROLE_HIERARCHY = [
  CollaborationRole.VIEWER,
  CollaborationRole.COMMENTER,
  CollaborationRole.EDITOR,
  CollaborationRole.ADMIN,
  CollaborationRole.OWNER,
];

/**
 * Invitation structure
 * @typedef {object} Invitation
 * @property {string} inviterId - User who sent invitation
 * @property {string} inviteeEmail - Email of invited user
 * @property {string} [inviteeUserId] - User ID if registered
 * @property {string} resourceType - Type of resource (material, workspace, etc)
 * @property {string} resourceId - Resource identifier
 * @property {string} role - Assigned role
 * @property {string} state - Current state
 * @property {Date} expiresAt - Expiration timestamp
 * @property {Date} createdAt - Creation timestamp
 * @property {Date} [acceptedAt] - Acceptance timestamp
 * @property {Date} [revokedAt] - Revocation timestamp
 * @property {string} [revokedBy] - User who revoked
 * @property {string} token - Unique invitation token
 */

/**
 * Create a collaboration invitation
 * @param {object} config - Invitation configuration
 * @returns {Promise<Invitation>}
 */
export async function createInvitation(config) {
  const db = await getDb();
  const invitations = db.collection('invitations');
  const rateLimit = db.collection('invitation_rate_limits');

  // Validate inviter
  const inviter = await db
    .collection('profiles')
    .findOne({ _id: config.inviterId });

  if (!inviter) {
    throw new Error('Inviter not found');
  }

  // Validate role assignment permissions
  await validateRoleAssignment(
    config.inviterId,
    config.resourceType,
    config.resourceId,
    config.role
  );

  // Check rate limits
  await checkRateLimits(config.inviterId, rateLimit);

  // Check for existing pending invitation
  const existingInvitation = await invitations.findOne({
    inviteeEmail: config.inviteeEmail,
    resourceType: config.resourceType,
    resourceId: config.resourceId,
    state: InvitationState.PENDING,
    expiresAt: { $gt: new Date() },
  });

  if (existingInvitation) {
    throw new Error('Pending invitation already exists for this user');
  }

  // Check pending invitation limit
  const pendingCount = await invitations.countDocuments({
    inviterId: config.inviterId,
    state: InvitationState.PENDING,
  });

  if (pendingCount >= MAX_PENDING_INVITATIONS_PER_USER) {
    throw new Error('Maximum pending invitations limit reached');
  }

  const invitation = {
    inviterId: config.inviterId,
    inviterEmail: inviter.email,
    inviteeEmail: config.inviteeEmail.toLowerCase(),
    inviteeUserId: config.inviteeUserId || null,
    resourceType: config.resourceType,
    resourceId: config.resourceId,
    role: config.role,
    state: InvitationState.PENDING,
    expiresAt: new Date(
      Date.now() + INVITATION_EXPIRY_HOURS * 60 * 60 * 1000
    ),
    createdAt: new Date(),
    token: generateInvitationToken(),
    message: config.message || null,
  };

  const result = await invitations.insertOne(invitation);

  // Update rate limit tracking
  await updateRateLimitTracking(config.inviterId, rateLimit);

  // Log invitation creation
  await logInvitationEvent(db, {
    action: 'invitation_created',
    invitationId: result.insertedId,
    inviterId: config.inviterId,
    inviteeEmail: config.inviteeEmail,
    role: config.role,
  });

  logger.info('[Invitations] Invitation created', {
    invitationId: result.insertedId,
    inviter: config.inviterId,
    invitee: config.inviteeEmail,
    role: config.role,
  });

  return { ...invitation, _id: result.insertedId };
}

/**
 * Accept an invitation
 * @param {string} token - Invitation token
 * @param {string} userId - Accepting user ID
 * @returns {Promise<object>}
 */
export async function acceptInvitation(token, userId) {
  const db = await getDb();
  const invitations = db.collection('invitations');
  const collaborators = db.collection('collaborators');

  const invitation = await invitations.findOne({ token });

  if (!invitation) {
    throw new Error('Invitation not found');
  }

  // Validate invitation state
  if (invitation.state !== InvitationState.PENDING) {
    throw new Error(`Invitation is ${invitation.state}`);
  }

  // Check expiration
  if (new Date() > invitation.expiresAt) {
    await invitations.updateOne(
      { _id: invitation._id },
      { $set: { state: InvitationState.EXPIRED } }
    );
    throw new Error('Invitation has expired');
  }

  // Verify user email matches invitation
  const user = await db.collection('profiles').findOne({ _id: userId });

  if (!user || user.email.toLowerCase() !== invitation.inviteeEmail) {
    throw new Error('Invitation not for this user');
  }

  // Check for existing collaboration
  const existingCollaboration = await collaborators.findOne({
    userId,
    resourceType: invitation.resourceType,
    resourceId: invitation.resourceId,
    active: true,
  });

  if (existingCollaboration) {
    throw new Error('User already has access to this resource');
  }

  // Create collaboration
  const collaboration = {
    userId,
    userEmail: user.email,
    resourceType: invitation.resourceType,
    resourceId: invitation.resourceId,
    role: invitation.role,
    invitedBy: invitation.inviterId,
    invitationId: invitation._id,
    grantedAt: new Date(),
    active: true,
  };

  await collaborators.insertOne(collaboration);

  // Update invitation state
  await invitations.updateOne(
    { _id: invitation._id },
    {
      $set: {
        state: InvitationState.ACCEPTED,
        acceptedAt: new Date(),
        inviteeUserId: userId,
      },
    }
  );

  await logInvitationEvent(db, {
    action: 'invitation_accepted',
    invitationId: invitation._id,
    userId,
    role: invitation.role,
  });

  logger.info('[Invitations] Invitation accepted', {
    invitationId: invitation._id,
    userId,
    role: invitation.role,
  });

  return collaboration;
}

/**
 * Revoke an invitation
 * @param {string} invitationId - Invitation ID
 * @param {string} revokerId - User revoking the invitation
 * @returns {Promise<void>}
 */
export async function revokeInvitation(invitationId, revokerId) {
  const db = await getDb();
  const invitations = db.collection('invitations');

  const invitation = await invitations.findOne({ _id: invitationId });

  if (!invitation) {
    throw new Error('Invitation not found');
  }

  // Verify revoker has permission
  if (invitation.inviterId !== revokerId) {
    const hasPermission = await canManageInvitations(
      revokerId,
      invitation.resourceType,
      invitation.resourceId
    );

    if (!hasPermission) {
      throw new Error('Unauthorized to revoke this invitation');
    }
  }

  // Can only revoke pending invitations
  if (invitation.state !== InvitationState.PENDING) {
    throw new Error(`Cannot revoke ${invitation.state} invitation`);
  }

  await invitations.updateOne(
    { _id: invitationId },
    {
      $set: {
        state: InvitationState.REVOKED,
        revokedAt: new Date(),
        revokedBy: revokerId,
      },
    }
  );

  await logInvitationEvent(db, {
    action: 'invitation_revoked',
    invitationId,
    revokerId,
  });

  logger.info('[Invitations] Invitation revoked', {
    invitationId,
    revokerId,
  });
}

/**
 * Decline an invitation
 * @param {string} token - Invitation token
 * @param {string} userId - Declining user ID
 * @returns {Promise<void>}
 */
export async function declineInvitation(token, userId) {
  const db = await getDb();
  const invitations = db.collection('invitations');

  const invitation = await invitations.findOne({ token });

  if (!invitation) {
    throw new Error('Invitation not found');
  }

  const user = await db.collection('profiles').findOne({ _id: userId });

  if (!user || user.email.toLowerCase() !== invitation.inviteeEmail) {
    throw new Error('Unauthorized');
  }

  if (invitation.state !== InvitationState.PENDING) {
    throw new Error(`Invitation is ${invitation.state}`);
  }

  await invitations.updateOne(
    { _id: invitation._id },
    {
      $set: {
        state: InvitationState.DECLINED,
        declinedAt: new Date(),
      },
    }
  );

  await logInvitationEvent(db, {
    action: 'invitation_declined',
    invitationId: invitation._id,
    userId,
  });

  logger.info('[Invitations] Invitation declined', {
    invitationId: invitation._id,
    userId,
  });
}

/**
 * Get invitations for a user
 * @param {string} email - User email
 * @param {object} [options] - Query options
 * @returns {Promise<Invitation[]>}
 */
export async function getInvitationsForUser(email, options = {}) {
  const db = await getDb();
  const invitations = db.collection('invitations');

  const query = {
    inviteeEmail: email.toLowerCase(),
    ...(options.state && { state: options.state }),
  };

  return invitations
    .find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 50)
    .toArray();
}

/**
 * Clean up expired invitations
 * @returns {Promise<number>} Number of expired invitations
 */
export async function cleanupExpiredInvitations() {
  const db = await getDb();
  const invitations = db.collection('invitations');

  const result = await invitations.updateMany(
    {
      state: InvitationState.PENDING,
      expiresAt: { $lt: new Date() },
    },
    {
      $set: {
        state: InvitationState.EXPIRED,
        expiredAt: new Date(),
      },
    }
  );

  logger.info('[Invitations] Cleaned up expired invitations', {
    count: result.modifiedCount,
  });

  return result.modifiedCount;
}

/**
 * Helper functions
 */

async function validateRoleAssignment(
  inviterId,
  resourceType,
  resourceId,
  requestedRole
) {
  const db = await getDb();

  // Get inviter's role on the resource
  const inviterRole = await getUserRole(inviterId, resourceType, resourceId);

  if (!inviterRole) {
    throw new Error('You do not have access to this resource');
  }

  // Prevent role escalation
  const inviterRoleIndex = ROLE_HIERARCHY.indexOf(inviterRole);
  const requestedRoleIndex = ROLE_HIERARCHY.indexOf(requestedRole);

  if (requestedRoleIndex > inviterRoleIndex) {
    throw new Error(
      'Cannot assign a role higher than your own'
    );
  }

  // Only owners can assign admin roles
  if (
    requestedRole === CollaborationRole.ADMIN &&
    inviterRole !== CollaborationRole.OWNER
  ) {
    throw new Error('Only owners can assign admin roles');
  }

  // Owner role can only be transferred, not assigned
  if (requestedRole === CollaborationRole.OWNER) {
    throw new Error('Owner role cannot be assigned via invitation');
  }
}

async function getUserRole(userId, resourceType, resourceId) {
  const db = await getDb();

  // Check if user is the owner
  const resource = await db.collection(resourceType + 's').findOne({
    _id: resourceId,
    creatorId: userId,
  });

  if (resource) {
    return CollaborationRole.OWNER;
  }

  // Check collaborator role
  const collaboration = await db.collection('collaborators').findOne({
    userId,
    resourceType,
    resourceId,
    active: true,
  });

  return collaboration?.role || null;
}

async function canManageInvitations(userId, resourceType, resourceId) {
  const role = await getUserRole(userId, resourceType, resourceId);
  return role === CollaborationRole.OWNER || role === CollaborationRole.ADMIN;
}

async function checkRateLimits(userId, rateLimitCollection) {
  const now = new Date();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

  const limits = await rateLimitCollection.findOne({ userId });

  if (limits) {
    const recentInvitations = limits.invitations || [];
    const lastHour = recentInvitations.filter((t) => t > oneHourAgo).length;
    const lastDay = recentInvitations.filter((t) => t > oneDayAgo).length;

    if (lastHour >= MAX_INVITATIONS_PER_HOUR) {
      throw new Error('Hourly invitation limit exceeded');
    }

    if (lastDay >= MAX_INVITATIONS_PER_DAY) {
      throw new Error('Daily invitation limit exceeded');
    }
  }
}

async function updateRateLimitTracking(userId, rateLimitCollection) {
  const now = new Date();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

  await rateLimitCollection.updateOne(
    { userId },
    {
      $push: { invitations: now },
      $pull: { invitations: { $lt: oneDayAgo } },
    },
    { upsert: true }
  );
}

function generateInvitationToken() {
  return (
    Math.random().toString(36).substring(2) +
    Date.now().toString(36) +
    Math.random().toString(36).substring(2)
  );
}

async function logInvitationEvent(db, event) {
  await db.collection('audit_log').insertOne({
    ...event,
    timestamp: new Date(),
  });
}

export default {
  createInvitation,
  acceptInvitation,
  revokeInvitation,
  declineInvitation,
  getInvitationsForUser,
  cleanupExpiredInvitations,
  InvitationState,
  CollaborationRole,
};
