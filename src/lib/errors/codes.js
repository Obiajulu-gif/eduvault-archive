/**
 * Structured error taxonomy for EduVault (Issue #786, extended #1012).
 *
 * Every known failure mode maps to a stable error code so clients, logs, and
 * support tooling can correlate failures without parsing free-text messages.
 *
 * Each entry carries:
 *   code            – stable SCREAMING_SNAKE identifier, never renamed.
 *   status          – HTTP status code.
 *   retryable       – whether the client may safely retry without changes.
 *   userMessage     – safe, user-facing short description.
 *   recovery        – user-facing remediation step (rendered in the UI).
 *   remediationHints – operator / developer triage steps (not sent to clients).
 *
 * STABILITY CONTRACT: codes are additive only — existing codes are never
 * renamed or removed.  To deprecate a code, add `deprecated: true` and point
 * `supersededBy` at the replacement.  Client code must branch on the `code`
 * string, not on HTTP status.
 */

export const ERROR_CODES = {
  // =========================================================================
  // Validation (400)
  // =========================================================================

  VALIDATION_FAILED: {
    code: "VALIDATION_FAILED",
    status: 400,
    retryable: false,
    userMessage: "The request could not be validated.",
    recovery: "Review the highlighted fields and try again.",
    remediationHints: [
      "Inspect the `details` field in the error response for the specific validation failure.",
      "Ensure the request body is valid JSON and all required fields are present.",
      "Check field length, type, and format constraints in the API reference.",
    ],
  },
  VALIDATION_FIELD: {
    code: "VALIDATION_FIELD",
    status: 400,
    retryable: false,
    userMessage: "One or more fields are invalid.",
    recovery: "Check the field errors and correct them before resubmitting.",
    remediationHints: [
      "Read the `details.field` property to identify which field failed.",
      "Cross-reference the field against the schema documented in docs/API_REFERENCE.md.",
      "Common causes: wrong type (string vs number), out-of-range value, forbidden characters.",
    ],
  },
  VALIDATION_FILE_TYPE: {
    code: "VALIDATION_FILE_TYPE",
    status: 400,
    retryable: false,
    userMessage: "The uploaded file type is not supported.",
    recovery: "Upload a file in one of the supported formats (PDF, DOC, PPT, ZIP, MP4, etc.).",
    remediationHints: [
      "Verify the MIME type declared in the Content-Type header matches the actual file content.",
      "Allowed types are listed in src/lib/api/validation.js `validateUploadFileMetadata`.",
      "SVG and HTML uploads are intentionally blocked to prevent stored-XSS via file delivery.",
    ],
  },
  VALIDATION_FILE_SIZE: {
    code: "VALIDATION_FILE_SIZE",
    status: 400,
    retryable: false,
    userMessage: "The uploaded file exceeds the size limit.",
    recovery: "Compress the file or split it into smaller parts and try again.",
    remediationHints: [
      "Current limit is 10 MB per file (enforced in `validateUploadFileMetadata`).",
      "For video content consider transcoding to a lower bitrate before upload.",
      "The limit is configurable via the UPLOAD_MAX_FILE_SIZE_MB environment variable.",
    ],
  },
  VALIDATION_MISSING_FIELD: {
    code: "VALIDATION_MISSING_FIELD",
    status: 400,
    retryable: false,
    userMessage: "A required field is missing from the request.",
    recovery: "Add the missing field and resubmit.",
    remediationHints: [
      "Check `details.field` to see which field is required.",
      "Review the required vs optional field list in docs/API_REFERENCE.md.",
    ],
  },
  VALIDATION_PAYLOAD_TOO_LARGE: {
    code: "VALIDATION_PAYLOAD_TOO_LARGE",
    status: 413,
    retryable: false,
    userMessage: "The request payload is too large.",
    recovery: "Reduce the size of the request body and try again.",
    remediationHints: [
      "Maximum JSON body size is enforced by the Next.js bodyParser limit.",
      "For bulk operations consider batching into smaller requests.",
    ],
  },

  // =========================================================================
  // Authentication & authorization (401 / 403)
  // =========================================================================

  AUTH_UNAUTHENTICATED: {
    code: "AUTH_UNAUTHENTICATED",
    status: 401,
    retryable: false,
    userMessage: "You must be signed in to perform this action.",
    recovery: "Sign in and try again.",
    remediationHints: [
      "The `auth_token` cookie is absent or could not be parsed.",
      "Ensure the client sends credentials with every request to protected routes.",
      "Check that the JWT_SECRET environment variable is set and stable across deployments.",
    ],
  },
  AUTH_SESSION_EXPIRED: {
    code: "AUTH_SESSION_EXPIRED",
    status: 401,
    retryable: false,
    userMessage: "Your session has expired.",
    recovery: "Sign in again to continue.",
    remediationHints: [
      "Access tokens expire after 15 minutes (ACCESS_TOKEN_TTL_SECONDS).",
      "The client should call POST /api/auth/refresh before the token expires.",
      "If refresh also fails, redirect the user to the sign-in flow.",
    ],
  },
  AUTH_TOKEN_REVOKED: {
    code: "AUTH_TOKEN_REVOKED",
    status: 401,
    retryable: false,
    userMessage: "Your session has been revoked.",
    recovery: "Sign in again to continue.",
    remediationHints: [
      "The session was explicitly revoked (logout, admin action, or replay-attack detection).",
      "Check the `session_revocations` collection for the revocation reason.",
      "A replay-attack detection event revokes all sessions for the user — review security logs.",
    ],
  },
  AUTH_FORBIDDEN: {
    code: "AUTH_FORBIDDEN",
    status: 403,
    retryable: false,
    userMessage: "You do not have permission to perform this action.",
    recovery: "Contact support if you believe this is a mistake.",
    remediationHints: [
      "The authenticated user lacks the required RBAC permission for this route.",
      "Check `src/lib/auth/permissions.js` for the permission matrix.",
      "Admin routes require `admin:access`; creator routes require `creator:write`.",
    ],
  },
  AUTH_SUSPENDED: {
    code: "AUTH_SUSPENDED",
    status: 403,
    retryable: false,
    userMessage: "Your account has been suspended.",
    recovery: "Contact support to appeal the suspension.",
    remediationHints: [
      "Check the `users` collection for `suspended: true` and `suspendedReason`.",
      "Suspension is enforced at the DB layer on every authenticated request (not just the JWT).",
      "Admin can lift the suspension via POST /api/admin/users/:id/unsuspend.",
    ],
  },
  AUTH_WALLET_MISMATCH: {
    code: "AUTH_WALLET_MISMATCH",
    status: 403,
    retryable: false,
    userMessage: "The wallet address does not match your account.",
    recovery: "Use the wallet address associated with your account.",
    remediationHints: [
      "The signing wallet address does not match the address stored in the JWT `sub` claim.",
      "User may have switched wallets in their browser wallet extension without re-authenticating.",
      "Direct the user to sign out and sign back in with the correct wallet.",
    ],
  },

  // =========================================================================
  // Not found (404)
  // =========================================================================

  NOT_FOUND: {
    code: "NOT_FOUND",
    status: 404,
    retryable: false,
    userMessage: "The requested resource could not be found.",
    recovery: "Check the identifier and try again.",
    remediationHints: [
      "Verify the resource ID in the URL path or request body.",
      "The resource may have been deleted or may not yet be published.",
      "For materials, check `visibility` — private/unlisted materials return 404 for non-owners.",
    ],
  },
  NOT_FOUND_MATERIAL: {
    code: "NOT_FOUND_MATERIAL",
    status: 404,
    retryable: false,
    userMessage: "The learning material could not be found.",
    recovery: "Return to the marketplace to browse available materials.",
    remediationHints: [
      "The material may have been unpublished, deleted, or was never public.",
      "Check the `materials` collection for the record and its `visibility` and `status` fields.",
      "Ensure the requesting user is the owner if accessing a private material.",
    ],
  },
  NOT_FOUND_PURCHASE: {
    code: "NOT_FOUND_PURCHASE",
    status: 404,
    retryable: false,
    userMessage: "No purchase record was found for this content.",
    recovery: "Purchase the content to access it.",
    remediationHints: [
      "Query the `purchases` collection by `{ materialId, buyerAddress, status: 'confirmed' }`.",
      "The payment may have failed or the purchase confirmation is still pending.",
      "Check `partial_failures` for a purchase that completed on-chain but failed to write the DB record.",
    ],
  },

  // =========================================================================
  // Conflicts (409)
  // =========================================================================

  CONFLICT_DUPLICATE: {
    code: "CONFLICT_DUPLICATE",
    status: 409,
    retryable: false,
    userMessage: "A record with these details already exists.",
    recovery: "Review the existing record or update it instead of creating a new one.",
    remediationHints: [
      "MongoDB returned error code 11000 (duplicate key).",
      "Check which unique index was violated via the error's `keyPattern` field.",
      "Use the existing record's ID for update operations instead of creating a new one.",
    ],
  },
  CONFLICT_IN_PROGRESS: {
    code: "CONFLICT_IN_PROGRESS",
    status: 409,
    retryable: true,
    userMessage: "An identical request is already being processed.",
    recovery: "Wait a moment and resend the same request with the same idempotency key to get the result.",
    remediationHints: [
      "A concurrent request with the same idempotency key is in-flight.",
      "Poll with the same idempotency key after 1–2 seconds to receive the cached result.",
      "Check the `side_effect_outbox` collection for stuck in-progress items.",
    ],
  },
  CONFLICT_IDEMPOTENCY_KEY: {
    code: "CONFLICT_IDEMPOTENCY_KEY",
    status: 409,
    retryable: false,
    userMessage: "This idempotency key was already used with a different request.",
    recovery: "Use a new idempotency key, or resend the exact same request to get the original result.",
    remediationHints: [
      "The idempotency key was used with a different request body hash.",
      "Generate a new UUID for the `Idempotency-Key` header if the request body has changed.",
      "If the request body has not changed, replay the original request to retrieve the cached response.",
    ],
  },
  CONFLICT_STATE: {
    code: "CONFLICT_STATE",
    status: 409,
    retryable: false,
    userMessage: "This action cannot be performed in the current state.",
    recovery: "Refresh the page to see the latest state and try again.",
    remediationHints: [
      "The resource is in a state that does not allow this transition (e.g. a draft cannot be re-published).",
      "Inspect the `status` field of the resource to understand its current state.",
      "State machine transitions are documented in docs/creator-publishing-guide.md.",
    ],
  },
  CONFLICT_VERSION: {
    code: "CONFLICT_VERSION",
    status: 409,
    retryable: false,
    userMessage: "This record was modified by another request. Please reload and try again.",
    recovery: "Reload the page to get the latest version and reapply your changes.",
    remediationHints: [
      "Optimistic concurrency check failed: the `expectedVersion` in the request does not match the current record version.",
      "Fetch the current record version, merge changes, and resubmit with the updated `expectedVersion`.",
      "See src/lib/backend/versionedWrite.js for the versioning implementation.",
    ],
  },

  // =========================================================================
  // Entitlement & access (403)
  // =========================================================================

  ENTITLEMENT_NOT_FOUND: {
    code: "ENTITLEMENT_NOT_FOUND",
    status: 403,
    retryable: false,
    userMessage: "You do not have access to this content.",
    recovery: "Purchase this content to gain access.",
    remediationHints: [
      "No entitlement record exists in `entitlement_cache` for this buyer + material pair.",
      "Verify the purchase was confirmed and the outbox has delivered the entitlement grant.",
      "Check `partial_failures` for a purchase that completed on-chain but missed the entitlement write.",
    ],
  },
  ENTITLEMENT_REVOKED: {
    code: "ENTITLEMENT_REVOKED",
    status: 403,
    retryable: false,
    userMessage: "Your access to this content has been revoked.",
    recovery: "Contact support for details about the access change.",
    remediationHints: [
      "The entitlement record exists but `active` is false or `state` is 'revoked'.",
      "Revocation reasons include: refund processed, content DMCA takedown, account suspension.",
      "Check `entitlement_cache.revokedAt` and `revokedReason` for context.",
    ],
  },
  ENTITLEMENT_EXPIRED: {
    code: "ENTITLEMENT_EXPIRED",
    status: 403,
    retryable: false,
    userMessage: "Your access to this content has expired.",
    recovery: "Renew your subscription or repurchase the content to regain access.",
    remediationHints: [
      "The entitlement has an `expiresAt` date that has passed.",
      "Subscription-based entitlements auto-expire; repurchase triggers a fresh grant.",
    ],
  },

  // =========================================================================
  // Settlement / payment (402 / 502 / 503 / 504)
  // =========================================================================

  SETTLEMENT_INSUFFICIENT_FUNDS: {
    code: "SETTLEMENT_INSUFFICIENT_FUNDS",
    status: 402,
    retryable: false,
    userMessage: "There are not enough funds to complete this transaction.",
    recovery: "Add funds to your wallet and try again.",
    remediationHints: [
      "The Stellar account balance is below the required amount plus the base reserve.",
      "Account minimum reserve is 1 XLM × (2 + number of trustlines).",
      "Prompt the user to fund their wallet via a supported on-ramp (Coinbase, Coinflow, etc.).",
    ],
  },
  SETTLEMENT_TX_FAILED: {
    code: "SETTLEMENT_TX_FAILED",
    status: 502,
    retryable: true,
    userMessage: "The payment transaction failed.",
    recovery: "Wait a moment and try again. If the problem persists, contact support.",
    remediationHints: [
      "Inspect the Stellar transaction result code (e.g. `tx_bad_seq`, `op_no_trust`).",
      "Common causes: stale sequence number, missing trustline, surge fee too low.",
      "See docs/disaster-recovery.md for on-call runbook steps.",
    ],
  },
  SETTLEMENT_TIMEOUT: {
    code: "SETTLEMENT_TIMEOUT",
    status: 504,
    retryable: true,
    userMessage: "The payment confirmation timed out.",
    recovery: "Your payment may still be processing. Wait a few minutes and check your transaction history before retrying.",
    remediationHints: [
      "The Horizon/Soroban RPC did not confirm the transaction within the timeout window.",
      "Query Horizon directly with the transaction hash to determine the actual status.",
      "Check `partial_failures` — the payment may have succeeded but the DB write failed.",
    ],
  },
  SETTLEMENT_UNAVAILABLE: {
    code: "SETTLEMENT_UNAVAILABLE",
    status: 503,
    retryable: true,
    userMessage: "The payment service is temporarily unavailable.",
    recovery: "Try again in a few minutes.",
    remediationHints: [
      "Stellar Horizon or the Soroban RPC endpoint is unreachable.",
      "Check STELLAR_HORIZON_URL and STELLAR_HORIZON_FALLBACKS environment variables.",
      "Monitor https://stellarbeat.io or the configured Horizon instance health endpoint.",
    ],
  },
  SETTLEMENT_QUOTE_EXPIRED: {
    code: "SETTLEMENT_QUOTE_EXPIRED",
    status: 410,
    retryable: false,
    userMessage: "The checkout quote has expired. Please start a new checkout.",
    recovery: "Return to the course page and start a new checkout.",
    remediationHints: [
      "Checkout quotes expire after a configured TTL (default: 15 minutes).",
      "The client must re-initiate checkout before presenting payment to the user.",
      "Quote TTL is controlled by CHECKOUT_QUOTE_TTL_MS in the environment.",
    ],
  },
  SETTLEMENT_REFUND_WINDOW_CLOSED: {
    code: "SETTLEMENT_REFUND_WINDOW_CLOSED",
    status: 409,
    retryable: false,
    userMessage: "The refund window for this purchase has closed.",
    recovery: "Refunds are only available within the refund period. Contact support if you have a special circumstance.",
    remediationHints: [
      "The purchase `purchasedAt` date is outside the REFUND_WINDOW_DAYS window.",
      "Admin can process an out-of-window refund via the admin console.",
      "Check docs/balance-reconciliation.md for the refund policy.",
    ],
  },

  // =========================================================================
  // Storage / content delivery (400 / 403 / 404 / 502)
  // =========================================================================

  STORAGE_UPLOAD_FAILED: {
    code: "STORAGE_UPLOAD_FAILED",
    status: 502,
    retryable: true,
    userMessage: "The file could not be uploaded.",
    recovery: "Check your connection and try again.",
    remediationHints: [
      "Pinata or Vercel Blob returned a non-2xx response.",
      "Check PINATA_JWT and BLOB_READ_WRITE_TOKEN environment variables.",
      "Review the Pinata dashboard for storage quota or API rate-limit issues.",
    ],
  },
  STORAGE_NOT_FOUND: {
    code: "STORAGE_NOT_FOUND",
    status: 404,
    retryable: false,
    userMessage: "The stored file could not be found.",
    recovery: "The file may have been removed. Contact support if you purchased this content.",
    remediationHints: [
      "The IPFS CID or Blob URL is no longer resolvable.",
      "Check whether the content was unpinned from Pinata or the Blob was deleted.",
      "For purchased content, open a support case — data retention policy requires content to remain available.",
    ],
  },
  STORAGE_QUARANTINED: {
    code: "STORAGE_QUARANTINED",
    status: 403,
    retryable: false,
    userMessage: "This content is under review and temporarily unavailable.",
    recovery: "Check back later or contact support for more information.",
    remediationHints: [
      "The material's `moderationStatus` is 'quarantined' or `discoveryReviewStatus` is 'flagged'.",
      "A moderation case exists in `moderation_cases` — review it in the admin console.",
      "See docs/content-takedown-and-evidence-retention.md for the moderation workflow.",
    ],
  },
  STORAGE_DOWNLOAD_CAPABILITY_INVALID: {
    code: "STORAGE_DOWNLOAD_CAPABILITY_INVALID",
    status: 403,
    retryable: false,
    userMessage: "The download link is invalid or has expired.",
    recovery: "Return to your library and download the file again.",
    remediationHints: [
      "The HMAC-signed capability token failed verification or has exceeded its TTL (default 15 s).",
      "Capability tokens are single-use and expire quickly — the client must not cache them.",
      "Check CAPABILITY_SECRET is set and consistent across all instances.",
    ],
  },

  // =========================================================================
  // Rate limiting (429)
  // =========================================================================

  RATE_LIMITED: {
    code: "RATE_LIMITED",
    status: 429,
    retryable: true,
    userMessage: "Too many requests.",
    recovery: "Wait a moment before trying again.",
    remediationHints: [
      "The sliding-window rate limit for this route was exceeded.",
      "Respect the `Retry-After` header value before retrying.",
      "Persistent rate-limiting of legitimate users may indicate a client bug (tight polling loop).",
    ],
  },
  RATE_LIMITED_UPLOAD: {
    code: "RATE_LIMITED_UPLOAD",
    status: 429,
    retryable: true,
    userMessage: "You have uploaded too many files recently. Please wait before trying again.",
    recovery: "Wait a few minutes and try the upload again.",
    remediationHints: [
      "The per-user upload rate limit was exceeded (separate from the global route limit).",
      "Default: 10 uploads per hour per user.",
      "Check Redis for the rate-limit key pattern `upload:POST:<userId>`.",
    ],
  },

  // =========================================================================
  // Content / publishing
  // =========================================================================

  CONTENT_PUBLISHING_FAILED: {
    code: "CONTENT_PUBLISHING_FAILED",
    status: 502,
    retryable: true,
    userMessage: "Publishing failed. Your content has been saved as a draft.",
    recovery: "Try publishing again from your creator dashboard.",
    remediationHints: [
      "The publication saga failed at one of its steps (upload, contract registration, DB write).",
      "Check the `resource_drafts` collection for the failed saga state.",
      "See docs/creator-publishing-guide.md for the publication saga steps and recovery procedures.",
    ],
  },
  CONTENT_DUPLICATE_DETECTED: {
    code: "CONTENT_DUPLICATE_DETECTED",
    status: 409,
    retryable: false,
    userMessage: "This content appears to be a duplicate of an existing listing.",
    recovery: "Review your existing materials or modify the content to make it distinct.",
    remediationHints: [
      "The duplication / near-duplicate scoring system flagged this upload.",
      "Check `manipulationAssessment.reasons` on the material record.",
      "See docs/DUPLICATE_DETECTION_AND_MERGE_WORKFLOW.md for the review workflow.",
    ],
  },

  // =========================================================================
  // Blockchain / wallet
  // =========================================================================

  BLOCKCHAIN_RPC_UNAVAILABLE: {
    code: "BLOCKCHAIN_RPC_UNAVAILABLE",
    status: 503,
    retryable: true,
    userMessage: "The blockchain service is temporarily unavailable.",
    recovery: "Try again in a few minutes.",
    remediationHints: [
      "All Stellar Horizon endpoints (primary + fallbacks) are unreachable.",
      "Check STELLAR_HORIZON_URL and STELLAR_HORIZON_FALLBACKS.",
      "Consider enabling EDUVAULT_SANDBOX=true for non-payment operations during an outage.",
    ],
  },
  BLOCKCHAIN_BAD_SEQUENCE: {
    code: "BLOCKCHAIN_BAD_SEQUENCE",
    status: 409,
    retryable: true,
    userMessage: "The transaction could not be submitted due to a sequencing conflict.",
    recovery: "Try again — the system will fetch the latest sequence number automatically.",
    remediationHints: [
      "Stellar returned `tx_bad_seq`: the transaction's sequence number is stale.",
      "Fetch the current sequence number from Horizon before re-signing.",
      "This is safe to retry — no funds have been moved.",
    ],
  },
  BLOCKCHAIN_TRUSTLINE_MISSING: {
    code: "BLOCKCHAIN_TRUSTLINE_MISSING",
    status: 402,
    retryable: false,
    userMessage: "Your wallet has not set up a trustline for the payment asset.",
    recovery: "Set up a trustline for the required asset in your wallet and try again.",
    remediationHints: [
      "Stellar returned `op_no_trust` or `op_no_destination`.",
      "The buyer's account must hold a trustline for the asset before a payment can be sent.",
      "Guide the user to add the trustline in their wallet app.",
    ],
  },

  // =========================================================================
  // Data export / privacy (202 / 404 / 503)
  // =========================================================================

  EXPORT_IN_PROGRESS: {
    code: "EXPORT_IN_PROGRESS",
    status: 202,
    retryable: false,
    userMessage: "Your data export is being prepared.",
    recovery: "You will receive an email when your export is ready to download.",
    remediationHints: [
      "The learner data export job has been queued successfully.",
      "Poll GET /api/learner-export/status with the `exportId` to check completion.",
      "Exports are retained for 7 days then deleted per the data-retention policy.",
    ],
  },
  EXPORT_NOT_READY: {
    code: "EXPORT_NOT_READY",
    status: 404,
    retryable: true,
    userMessage: "Your export is not ready yet.",
    recovery: "Please check back in a few minutes.",
    remediationHints: [
      "The export job is still running.",
      "Poll with exponential back-off; typical export time is < 60 seconds.",
    ],
  },

  // =========================================================================
  // Internal (500 / 503)
  // =========================================================================

  INTERNAL: {
    code: "INTERNAL",
    status: 500,
    retryable: true,
    userMessage: "Something went wrong on our end.",
    recovery: "Try again in a few moments. If the problem persists, contact support with the reference code.",
    remediationHints: [
      "An unhandled exception was caught by withApiHardening — check server logs for the correlation ID.",
      "The exception was reported to the error capture sink (src/lib/sentry.js).",
      "Use the `correlationId` from the response to find the matching log entry.",
    ],
  },
  SERVICE_UNAVAILABLE: {
    code: "SERVICE_UNAVAILABLE",
    status: 503,
    retryable: true,
    userMessage: "The service is temporarily unavailable.",
    recovery: "Try again in a few minutes.",
    remediationHints: [
      "A required dependency (MongoDB, Redis, Stellar RPC) is not responding.",
      "Check the /api/status endpoint and the operational status page.",
      "Review docs/disaster-recovery.md for on-call runbook steps.",
    ],
  },
};

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Returns the error code definition for `code`, falling back to INTERNAL.
 * Never throws — safe to call with arbitrary untrusted strings.
 */
export function getErrorCode(code) {
  return ERROR_CODES[code] || ERROR_CODES.INTERNAL;
}

/**
 * Returns true if `code` is a known, registered error code.
 */
export function isKnownErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

/**
 * Returns all error codes belonging to a given HTTP status family.
 * Useful for test assertions and documentation generation.
 *
 * @param {number} statusFamily  e.g. 400 for 4xx, 500 for 5xx
 */
export function getErrorCodesByFamily(statusFamily) {
  const floor = Math.floor(statusFamily / 100) * 100;
  return Object.values(ERROR_CODES).filter(
    (def) => Math.floor(def.status / 100) * 100 === floor
  );
}

/**
 * Returns the operator/developer remediation hints for a code.
 * Returns an empty array for unknown codes rather than throwing.
 */
export function getRemediationHints(code) {
  return ERROR_CODES[code]?.remediationHints ?? [];
}
