/**
 * Scoped Maintainer Impersonation for Support Debugging
 * Issue #810: Implement scoped maintainer impersonation for support debugging
 *
 * Provides a safe way for maintainers to reproduce user-reported issues without
 * gaining broad access to private data or performing irreversible actions.
 *
 * Features:
 * - Time-limited impersonation sessions
 * - Scoped permissions (read-only by default)
 * - Full audit logging
 * - Visible indicators
 * - Sensitive action blocking
 */

import { getDb } from '../db/mongodb.js';
import logger from '../logger.js';

const IMPERSONATION_MAX_DURATION = 60 * 60 * 1000; // 1 hour
const IMPERSONATION_DEFAULT_DURATION = 30 * 60 * 1000; // 30 minutes

/**
 * Impersonation session configuration
 * @typedef {object} ImpersonationSession
 * @property {string} maintainerId - Maintainer user ID
 * @property {string} targetUserId - Target user being impersonated
 * @property {string[]} allowedActions - List of allowed action types
 * @property {Date} expiresAt - Session expiration time
 * @property {string} reason - Reason for impersonation
 * @property {string} ticketId - Support ticket reference
 * @property {Date} createdAt - Session creation time
 * @property {boolean} active - Whether session is active
 */

/**
 * Blocked actions during impersonation (unless explicitly allowed)
 */
const BLOCKED_ACTIONS = [
  'delete_account',
  'change_password',
  'change_email',
  'transfer_funds',
  'withdraw',
  'update_wallet',
  'delete_content',
  'transfer_ownership',
  'change_permissions',
  'revoke_access',
];

/**
 * Default allowed actions (read-only operations)
 */
const DEFAULT_ALLOWED_ACTIONS = [
  'view_profile',
  'view_materials',
  'view_purchases',
  'view_saved_items',
  'search_marketplace',
  'view_progress',
];

/**
 * Start an impersonation session
 * @param {object} config - Impersonation configuration
 * @param {string} config.maintainerId - Maintainer ID
 * @param {string} config.targetUserId - User to impersonate
 * @param {string} config.reason - Reason for impersonation
 * @param {string} [config.ticketId] - Support ticket reference
 * @param {number} [config.duration] - Duration in milliseconds
 * @param {string[]} [config.additionalActions] - Additional allowed actions
 * @returns {Promise<ImpersonationSession>}
 */
export async function startImpersonationSession(config) {
  const db = await getDb();
  const sessions = db.collection('impersonation_sessions');
  const auditLog = db.collection('audit_log');

  // Validate maintainer has permission
  const maintainer = await db
    .collection('profiles')
    .findOne({ _id: config.maintainerId });

  if (!maintainer || maintainer.role !== 'maintainer') {
    throw new Error('Unauthorized: Only maintainers can start impersonation');
  }

  // Validate target user exists
  const targetUser = await db
    .collection('profiles')
    .findOne({ _id: config.targetUserId });

  if (!targetUser) {
    throw new Error('Target user not found');
  }

  // Check for existing active session
  const existingSession = await sessions.findOne({
    maintainerId: config.maintainerId,
    targetUserId: config.targetUserId,
    active: true,
    expiresAt: { $gt: new Date() },
  });

  if (existingSession) {
    throw new Error('Active impersonation session already exists');
  }

  const duration = Math.min(
    config.duration || IMPERSONATION_DEFAULT_DURATION,
    IMPERSONATION_MAX_DURATION
  );

  const session = {
    maintainerId: config.maintainerId,
    maintainerEmail: maintainer.email,
    targetUserId: config.targetUserId,
    targetEmail: targetUser.email,
    allowedActions: [
      ...DEFAULT_ALLOWED_ACTIONS,
      ...(config.additionalActions || []),
    ],
    blockedActions: BLOCKED_ACTIONS,
    reason: config.reason,
    ticketId: config.ticketId || null,
    duration,
    expiresAt: new Date(Date.now() + duration),
    createdAt: new Date(),
    active: true,
    actionsPerformed: [],
  };

  const result = await sessions.insertOne(session);

  // Audit log entry
  await auditLog.insertOne({
    action: 'impersonation_started',
    maintainerId: config.maintainerId,
    targetUserId: config.targetUserId,
    sessionId: result.insertedId,
    reason: config.reason,
    ticketId: config.ticketId,
    duration,
    timestamp: new Date(),
    ipAddress: config.ipAddress || null,
  });

  logger.info('[Impersonation] Session started', {
    sessionId: result.insertedId,
    maintainerId: config.maintainerId,
    targetUserId: config.targetUserId,
    duration,
  });

  return { ...session, sessionId: result.insertedId };
}

/**
 * End an impersonation session
 * @param {string} sessionId - Session ID
 * @returns {Promise<void>}
 */
export async function endImpersonationSession(sessionId) {
  const db = await getDb();
  const sessions = db.collection('impersonation_sessions');
  const auditLog = db.collection('audit_log');

  const session = await sessions.findOne({ _id: sessionId });

  if (!session) {
    throw new Error('Session not found');
  }

  await sessions.updateOne(
    { _id: sessionId },
    {
      $set: {
        active: false,
        endedAt: new Date(),
      },
    }
  );

  await auditLog.insertOne({
    action: 'impersonation_ended',
    maintainerId: session.maintainerId,
    targetUserId: session.targetUserId,
    sessionId,
    duration: new Date() - session.createdAt,
    actionsPerformed: session.actionsPerformed?.length || 0,
    timestamp: new Date(),
  });

  logger.info('[Impersonation] Session ended', {
    sessionId,
    duration: new Date() - session.createdAt,
  });
}

/**
 * Validate an action during impersonation
 * @param {string} sessionId - Session ID
 * @param {string} action - Action to validate
 * @param {object} [metadata] - Additional metadata
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
export async function validateImpersonationAction(
  sessionId,
  action,
  metadata = {}
) {
  const db = await getDb();
  const sessions = db.collection('impersonation_sessions');
  const auditLog = db.collection('audit_log');

  const session = await sessions.findOne({ _id: sessionId, active: true });

  if (!session) {
    return { allowed: false, reason: 'No active session found' };
  }

  // Check expiration
  if (new Date() > session.expiresAt) {
    await endImpersonationSession(sessionId);
    return { allowed: false, reason: 'Session expired' };
  }

  // Check if action is blocked
  if (
    session.blockedActions.includes(action) &&
    !session.allowedActions.includes(action)
  ) {
    // Log blocked attempt
    await auditLog.insertOne({
      action: 'impersonation_action_blocked',
      maintainerId: session.maintainerId,
      targetUserId: session.targetUserId,
      sessionId,
      blockedAction: action,
      metadata,
      timestamp: new Date(),
    });

    logger.warn('[Impersonation] Blocked action attempted', {
      sessionId,
      action,
      maintainerId: session.maintainerId,
    });

    return { allowed: false, reason: 'Action not permitted during impersonation' };
  }

  // Check if action is explicitly allowed
  if (!session.allowedActions.includes(action)) {
    return { allowed: false, reason: 'Action not in allowed list' };
  }

  // Log allowed action
  await sessions.updateOne(
    { _id: sessionId },
    {
      $push: {
        actionsPerformed: {
          action,
          timestamp: new Date(),
          metadata,
        },
      },
    }
  );

  await auditLog.insertOne({
    action: 'impersonation_action_performed',
    maintainerId: session.maintainerId,
    targetUserId: session.targetUserId,
    sessionId,
    performedAction: action,
    metadata,
    timestamp: new Date(),
  });

  return { allowed: true };
}

/**
 * Get active impersonation session for a maintainer
 * @param {string} maintainerId - Maintainer ID
 * @returns {Promise<ImpersonationSession|null>}
 */
export async function getActiveSession(maintainerId) {
  const db = await getDb();
  const sessions = db.collection('impersonation_sessions');

  const session = await sessions.findOne({
    maintainerId,
    active: true,
    expiresAt: { $gt: new Date() },
  });

  return session;
}

/**
 * Get impersonation audit trail
 * @param {string} targetUserId - User ID
 * @param {object} [options] - Query options
 * @returns {Promise<object[]>}
 */
export async function getImpersonationAuditTrail(targetUserId, options = {}) {
  const db = await getDb();
  const auditLog = db.collection('audit_log');

  const query = {
    targetUserId,
    action: { $regex: /^impersonation_/ },
  };

  if (options.since) {
    query.timestamp = { $gte: options.since };
  }

  const entries = await auditLog
    .find(query)
    .sort({ timestamp: -1 })
    .limit(options.limit || 100)
    .toArray();

  return entries;
}

/**
 * Middleware to inject impersonation context
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @param {Function} next - Next middleware
 */
export async function impersonationMiddleware(req, res, next) {
  const sessionId = req.headers['x-impersonation-session'];

  if (!sessionId) {
    return next();
  }

  const db = await getDb();
  const sessions = db.collection('impersonation_sessions');

  const session = await sessions.findOne({
    _id: sessionId,
    active: true,
    expiresAt: { $gt: new Date() },
  });

  if (session) {
    req.impersonation = {
      active: true,
      sessionId,
      maintainerId: session.maintainerId,
      targetUserId: session.targetUserId,
      allowedActions: session.allowedActions,
    };

    // Override user context for impersonation
    req.userId = session.targetUserId;
    req.isImpersonating = true;
  }

  next();
}

/**
 * Check if action requires elevated confirmation during impersonation
 * @param {string} action - Action type
 * @returns {boolean}
 */
export function requiresElevatedConfirmation(action) {
  const sensitiveActions = [
    'purchase_material',
    'update_profile',
    'save_material',
    'rate_content',
  ];

  return sensitiveActions.includes(action);
}

export default {
  startImpersonationSession,
  endImpersonationSession,
  validateImpersonationAction,
  getActiveSession,
  getImpersonationAuditTrail,
  impersonationMiddleware,
  requiresElevatedConfirmation,
};
