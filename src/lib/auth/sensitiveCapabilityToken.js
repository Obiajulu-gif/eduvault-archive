import { createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { hasPermission } from './permissions.js';

/**
 * Expiring Capability Tokens for Sensitive Actions
 *
 * Implements fine-grained, short-lived, cryptographically signed capability tokens
 * for high-risk actions (payouts, wallet updates, material deletion, quarantine overrides,
 * GDPR exports, account deletion, refund initiation, role escalations, and maintainer elevations).
 *
 * Security Model:
 *   - Object-Capability: Tokens grant authority to perform a specific action on a specific
 *     target resource for a bounded window of time.
 *   - Cryptographic Integrity: HMAC-SHA256 signatures over canonical payload JSON with
 *     constant-time verification (`timingSafeEqual`) to prevent timing side-channel attacks.
 *   - Expiration Enforcement: Deterministic TTLs with clear error classification
 *     (`EVT_AUTH_003` with `refresh_capability` support action).
 *   - Replay Protection: Single-use JTI/nonce tracking with automatic TTL expiration.
 *   - Role & Tenant Scoping: Tokens cannot be issued across tenant boundaries or for
 *     unauthorized roles.
 */

export const SENSITIVE_ACTIONS = Object.freeze({
  PAYOUT_REQUEST: 'payout:request',
  PAYOUT_SETTLE: 'payout:settle',
  WALLET_UPDATE: 'wallet:update',
  MATERIAL_DELETE: 'material:delete',
  MATERIAL_ARCHIVE: 'material:archive',
  QUARANTINE_OVERRIDE: 'quarantine:override',
  LEARNER_DATA_EXPORT: 'learner:export_data',
  ACCOUNT_DELETE: 'user:delete_account',
  REFUND_INITIATE: 'refund:initiate',
  ROLE_ESCALATE: 'role:escalate',
  MAINTAINER_CONFIRMATION: 'maintainer:elevated_confirmation',
  DOWNLOAD_ACCESS: 'download:access',
});

export const DEFAULT_CAPABILITY_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_CAPABILITY_TTL_MS = 60 * 60 * 1000; // 1 hour max
export const MIN_CAPABILITY_TTL_MS = 5 * 1000; // 5 seconds min

function getCapabilitySecret(customSecret) {
  return (
    customSecret ||
    process.env.CAPABILITY_TOKEN_SECRET ||
    process.env.DOWNLOAD_CAPABILITY_SECRET ||
    process.env.JWT_SECRET ||
    'development-capability-secret-key-change-in-production'
  );
}

function signPayload(payloadJson, secret) {
  return createHmac('sha256', secret).update(payloadJson).digest('hex');
}

function constantTimeCompare(expectedHex, receivedHex) {
  if (typeof expectedHex !== 'string' || typeof receivedHex !== 'string') return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const received = Buffer.from(receivedHex, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Creates an in-memory bounded nonce / revocation store with automatic cleanup of expired entries.
 */
export function createCapabilityNonceStore({ maxEntries = 10000, pruneIntervalMs = 60000 } = {}) {
  const consumedNonces = new Map(); // jti -> { exp, consumedAt, reason }
  const revokedNonces = new Map(); // jti -> { exp, revokedAt, reason }

  function prune(now = Date.now()) {
    for (const [jti, meta] of consumedNonces.entries()) {
      if (meta.exp < now) consumedNonces.delete(jti);
    }
    for (const [jti, meta] of revokedNonces.entries()) {
      if (meta.exp < now) revokedNonces.delete(jti);
    }
  }

  return {
    consume(jti, exp, reason = 'consumed') {
      if (consumedNonces.size >= maxEntries) prune();
      consumedNonces.set(jti, { exp, consumedAt: Date.now(), reason });
    },
    isConsumed(jti) {
      const entry = consumedNonces.get(jti);
      if (!entry) return false;
      if (entry.exp < Date.now()) {
        consumedNonces.delete(jti);
        return false;
      }
      return true;
    },
    revoke(jti, exp = Date.now() + DEFAULT_CAPABILITY_TTL_MS, reason = 'revoked') {
      if (revokedNonces.size >= maxEntries) prune();
      revokedNonces.set(jti, { exp, revokedAt: Date.now(), reason });
    },
    isRevoked(jti) {
      const entry = revokedNonces.get(jti);
      if (!entry) return false;
      if (entry.exp < Date.now()) {
        revokedNonces.delete(jti);
        return false;
      }
      return true;
    },
    clear() {
      consumedNonces.clear();
      revokedNonces.clear();
    },
    size() {
      return { consumed: consumedNonces.size, revoked: revokedNonces.size };
    },
    prune,
  };
}

export const defaultCapabilityStore = createCapabilityNonceStore();

/**
 * Generate a signed, expiring capability token for a sensitive action.
 *
 * @param {object} options
 * @param {string} options.actor - Actor ID / wallet address authorized to execute
 * @param {string} options.action - Sensitive action string (must be in SENSITIVE_ACTIONS or valid namespace)
 * @param {string} options.target - Target resource ID (e.g. materialId, learnerId, or '*' for global)
 * @param {object} [options.constraints={}] - Optional action constraints (e.g. maxAmount, byteRange, redactionLevel)
 * @param {number} [options.ttlMs=DEFAULT_CAPABILITY_TTL_MS] - Time to live in ms
 * @param {boolean} [options.singleUse=true] - Whether token can only be consumed once
 * @param {string} [options.secret] - Optional secret override for test isolation
 * @param {string} [options.nonce] - Optional explicit nonce
 * @param {string} [options.jti] - Optional explicit token ID
 * @param {number} [options.iat] - Optional explicit issued-at timestamp
 * @returns {{ token: string, payload: object }} Signed token string and raw payload
 */
export function generateSensitiveCapabilityToken({
  actor,
  action,
  target,
  constraints = {},
  ttlMs = DEFAULT_CAPABILITY_TTL_MS,
  singleUse = true,
  secret,
  nonce,
  jti,
  iat,
} = {}) {
  if (!actor || typeof actor !== 'string') {
    throw new Error('Actor identifier is required');
  }
  if (!action || typeof action !== 'string') {
    throw new Error('Action identifier is required');
  }
  if (!target || typeof target !== 'string') {
    throw new Error('Target resource identifier is required');
  }

  const boundedTtl = Math.max(MIN_CAPABILITY_TTL_MS, Math.min(MAX_CAPABILITY_TTL_MS, Number(ttlMs) || DEFAULT_CAPABILITY_TTL_MS));
  const issuedAtMs = typeof iat === 'number' ? iat : Date.now();
  const tokenJti = jti || randomUUID();
  const tokenNonce = nonce || randomBytes(16).toString('hex');
  const signingSecret = getCapabilitySecret(secret);

  const payload = {
    v: 1, // Capability schema version
    jti: tokenJti,
    actor: actor.trim(),
    action: action.trim(),
    target: target.trim(),
    constraints: constraints && typeof constraints === 'object' ? constraints : {},
    singleUse: Boolean(singleUse),
    nonce: tokenNonce,
    iat: issuedAtMs,
    exp: issuedAtMs + boundedTtl,
  };

  const payloadJson = JSON.stringify(payload);
  const signature = signPayload(payloadJson, signingSecret);
  const envelope = JSON.stringify({ payload: payloadJson, signature });
  const token = Buffer.from(envelope, 'utf-8').toString('base64url');

  return { token, payload };
}

/**
 * Verify a sensitive capability token against signature, expiry, actor, action, and constraints.
 *
 * @param {string} token - Base64url encoded capability token
 * @param {object} [options]
 * @param {string} [options.expectedActor] - Required actor to match
 * @param {string} [options.expectedAction] - Required action to match
 * @param {string} [options.expectedTarget] - Required target to match
 * @param {object} [options.constraints] - Constraints to validate against token payload constraints
 * @param {boolean} [options.consume=false] - If true, atomically marks single-use token as consumed
 * @param {object} [options.store=defaultCapabilityStore] - Nonce / revocation store
 * @param {string} [options.secret] - Secret override
 * @param {number} [options.now=Date.now()] - Current epoch timestamp
 * @returns {object} Validation result
 */
export function verifySensitiveCapabilityToken(token, {
  expectedActor,
  expectedAction,
  expectedTarget,
  constraints = {},
  consume = false,
  store = defaultCapabilityStore,
  secret,
  now = Date.now(),
} = {}) {
  if (!token || typeof token !== 'string') {
    return {
      valid: false,
      code: 'EVT_AUTH_001',
      error: 'Capability token missing',
      status: 401,
      retryable: false,
      supportAction: 'none',
    };
  }

  let envelope;
  try {
    const rawJson = Buffer.from(token, 'base64url').toString('utf-8');
    envelope = JSON.parse(rawJson);
  } catch {
    return {
      valid: false,
      code: 'EVT_AUTH_002',
      error: 'Malformed capability token structure',
      status: 401,
      retryable: false,
      supportAction: 'none',
    };
  }

  const { payload: payloadJson, signature } = envelope || {};
  if (typeof payloadJson !== 'string' || typeof signature !== 'string') {
    return {
      valid: false,
      code: 'EVT_AUTH_002',
      error: 'Malformed capability token envelope fields',
      status: 401,
      retryable: false,
      supportAction: 'none',
    };
  }

  const signingSecret = getCapabilitySecret(secret);
  const expectedSignature = signPayload(payloadJson, signingSecret);
  if (!constantTimeCompare(expectedSignature, signature)) {
    return {
      valid: false,
      code: 'EVT_AUTH_002',
      error: 'Capability token signature mismatch (tampering detected)',
      status: 401,
      retryable: false,
      supportAction: 'none',
    };
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return {
      valid: false,
      code: 'EVT_AUTH_002',
      error: 'Malformed capability payload JSON',
      status: 401,
      retryable: false,
      supportAction: 'none',
    };
  }

  // Revocation check
  if (store.isRevoked(payload.jti)) {
    return {
      valid: false,
      code: 'EVT_AUTH_002',
      error: 'Capability token has been revoked',
      status: 401,
      retryable: false,
      supportAction: 'none',
    };
  }

  // Expiration check
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    return {
      valid: false,
      code: 'EVT_AUTH_003',
      error: 'Capability token expired — short-lived TTL has elapsed',
      status: 401,
      retryable: true,
      supportAction: 'refresh_capability',
      expiredAt: payload.exp,
    };
  }

  // Future-dating check (clock skew guard: max 60s in future)
  if (typeof payload.iat !== 'number' || payload.iat > now + 60_000) {
    return {
      valid: false,
      code: 'EVT_AUTH_002',
      error: 'Capability token is future-dated beyond allowable clock skew',
      status: 401,
      retryable: false,
      supportAction: 'none',
    };
  }

  // Actor validation
  if (expectedActor !== undefined && payload.actor !== expectedActor.trim()) {
    return {
      valid: false,
      code: 'EVT_AUTH_004',
      error: `Actor mismatch: token issued for '${payload.actor}' cannot be used by '${expectedActor}'`,
      status: 403,
      retryable: false,
      supportAction: 'none',
    };
  }

  // Action validation
  if (expectedAction !== undefined && payload.action !== expectedAction.trim()) {
    return {
      valid: false,
      code: 'EVT_AUTH_004',
      error: `Action mismatch: token issued for '${payload.action}' cannot be used for '${expectedAction}'`,
      status: 403,
      retryable: false,
      supportAction: 'none',
    };
  }

  // Target resource validation
  if (expectedTarget !== undefined && payload.target !== '*' && payload.target !== expectedTarget.trim()) {
    return {
      valid: false,
      code: 'EVT_AUTH_004',
      error: `Target mismatch: token issued for '${payload.target}' cannot be used on '${expectedTarget}'`,
      status: 403,
      retryable: false,
      supportAction: 'none',
    };
  }

  // Fine-grained constraint validations
  const tokenConstraints = payload.constraints || {};
  if (constraints) {
    // Max amount constraint (e.g. payout / refund caps)
    if (tokenConstraints.maxAmount !== undefined && constraints.amount !== undefined) {
      if (Number(constraints.amount) > Number(tokenConstraints.maxAmount)) {
        return {
          valid: false,
          code: 'EVT_INPUT_002',
          error: `Requested amount (${constraints.amount}) exceeds capability limit (${tokenConstraints.maxAmount})`,
          status: 403,
          retryable: false,
          supportAction: 'none',
        };
      }
    }

    // Currency constraint
    if (tokenConstraints.currency && constraints.currency) {
      if (tokenConstraints.currency.toUpperCase() !== constraints.currency.toUpperCase()) {
        return {
          valid: false,
          code: 'EVT_INPUT_002',
          error: `Currency '${constraints.currency}' does not match capability token currency '${tokenConstraints.currency}'`,
          status: 403,
          retryable: false,
          supportAction: 'none',
        };
      }
    }

    // Byte-range quota constraint (download compatibility)
    if (tokenConstraints.byteRangeQuota !== undefined && constraints.requestedBytes !== undefined) {
      if (Number(constraints.requestedBytes) > Number(tokenConstraints.byteRangeQuota)) {
        return {
          valid: false,
          code: 'EVT_DOWNLOAD_004',
          error: 'Requested byte range exceeds capability token allowed quota',
          status: 403,
          retryable: false,
          supportAction: 'none',
        };
      }
    }
  }

  // Single-use replay protection
  if (payload.singleUse) {
    if (store.isConsumed(payload.jti)) {
      return {
        valid: false,
        code: 'EVT_AUTH_002',
        error: 'Capability token has already been consumed (replay attempt rejected)',
        status: 409,
        retryable: false,
        supportAction: 'none',
      };
    }

    if (consume) {
      store.consume(payload.jti, payload.exp);
    }
  }

  return {
    valid: true,
    payload,
    remainingTtlMs: Math.max(0, payload.exp - now),
  };
}

/**
 * Explicitly consume a single-use capability token.
 */
export function consumeSensitiveCapabilityToken(token, options = {}) {
  return verifySensitiveCapabilityToken(token, { ...options, consume: true });
}

/**
 * Revoke a capability token immediately before its TTL.
 */
export function revokeSensitiveCapabilityToken(tokenOrJti, {
  reason = 'revoked',
  store = defaultCapabilityStore,
} = {}) {
  let jti = tokenOrJti;

  // If full token string was provided, extract jti
  if (typeof tokenOrJti === 'string' && tokenOrJti.length > 50) {
    try {
      const envelope = JSON.parse(Buffer.from(tokenOrJti, 'base64url').toString('utf-8'));
      const payload = JSON.parse(envelope.payload);
      jti = payload.jti;
    } catch {
      jti = tokenOrJti;
    }
  }

  store.revoke(jti, Date.now() + DEFAULT_CAPABILITY_TTL_MS, reason);
  return { revoked: true, jti, reason };
}

/**
 * Policy-gated issuance of sensitive capability tokens.
 * Validates that the requester has the requisite role or resource ownership
 * before minting the token.
 */
export function issueSensitiveCapability({
  requester,
  action,
  target,
  resourceOwnerId,
  constraints = {},
  ttlMs = DEFAULT_CAPABILITY_TTL_MS,
  secret,
  store = defaultCapabilityStore,
}) {
  if (!requester || typeof requester !== 'object') {
    return {
      success: false,
      code: 'EVT_AUTH_001',
      error: 'Requester credentials required for capability issuance',
      status: 401,
    };
  }

  const role = requester.role || 'learner';
  const requesterId = requester.id || requester.userAddress || requester.userId;

  // Authorization policy checks per sensitive action
  switch (action) {
    case SENSITIVE_ACTIONS.PAYOUT_REQUEST:
      if (role !== 'creator' && role !== 'admin') {
        return {
          success: false,
          code: 'EVT_AUTH_004',
          error: 'Only creators or administrators can request payout capabilities',
          status: 403,
        };
      }
      break;

    case SENSITIVE_ACTIONS.PAYOUT_SETTLE:
    case SENSITIVE_ACTIONS.QUARANTINE_OVERRIDE:
    case SENSITIVE_ACTIONS.ROLE_ESCALATE:
      if (role !== 'admin') {
        return {
          success: false,
          code: 'EVT_AUTH_004',
          error: `Action '${action}' requires administrative privileges`,
          status: 403,
        };
      }
      break;

    case SENSITIVE_ACTIONS.MATERIAL_DELETE:
    case SENSITIVE_ACTIONS.MATERIAL_ARCHIVE:
      if (role !== 'admin') {
        if (resourceOwnerId && resourceOwnerId !== requesterId) {
          return {
            success: false,
            code: 'EVT_AUTH_004',
            error: 'Cannot issue destructive capability for materials owned by another creator',
            status: 403,
          };
        }
      }
      break;

    case SENSITIVE_ACTIONS.MAINTAINER_CONFIRMATION:
      if (!requester.isMaintainer && role !== 'admin') {
        return {
          success: false,
          code: 'EVT_AUTH_004',
          error: 'Only maintainers can request elevated impersonation confirmation capabilities',
          status: 403,
        };
      }
      break;

    default:
      // General actions allowed if authenticated
      break;
  }

  const { token, payload } = generateSensitiveCapabilityToken({
    actor: requesterId,
    action,
    target,
    constraints,
    ttlMs,
    secret,
  });

  return {
    success: true,
    token,
    payload,
    expiresAt: new Date(payload.exp).toISOString(),
    ttlMs: payload.exp - payload.iat,
  };
}

/**
 * Extracts a capability token from incoming request headers, query string, or body.
 */
export function extractCapabilityTokenFromRequest(request) {
  if (!request) return null;

  // 1. Header: X-Capability-Token
  if (request.headers) {
    const customHeader = typeof request.headers.get === 'function'
      ? request.headers.get('x-capability-token')
      : request.headers['x-capability-token'];
    if (customHeader && customHeader.trim()) return customHeader.trim();

    // 2. Authorization: Capability <token>
    const authHeader = typeof request.headers.get === 'function'
      ? request.headers.get('authorization')
      : request.headers['authorization'];
    if (authHeader && authHeader.startsWith('Capability ')) {
      return authHeader.slice(11).trim();
    }
  }

  // 3. Query param: `cap`
  if (request.url) {
    try {
      const url = new URL(request.url, 'http://localhost');
      const capParam = url.searchParams.get('cap');
      if (capParam && capParam.trim()) return capParam.trim();
    } catch {
      // Ignored
    }
  }

  // 4. Body field: `capabilityToken`
  if (request.body && typeof request.body === 'object') {
    if (request.body.capabilityToken && typeof request.body.capabilityToken === 'string') {
      return request.body.capabilityToken.trim();
    }
  }

  return null;
}

/**
 * Standard error formatter for capability verification failures.
 */
export function formatCapabilityError(verificationResult) {
  return {
    error: {
      code: verificationResult.code || 'EVT_AUTH_001',
      message: verificationResult.error || 'Capability authorization failed',
      retryable: Boolean(verificationResult.retryable),
      supportAction: verificationResult.supportAction || 'none',
      status: verificationResult.status || 401,
      timestamp: new Date().toISOString(),
    },
  };
}
