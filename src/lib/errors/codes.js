/**
 * Structured error taxonomy for EduVault (Issue #786).
 *
 * Every known failure mode maps to a stable error code so clients, logs, and
 * support tooling can correlate failures without parsing free-text messages.
 * Each code carries retryability metadata and a user-safe message with
 * recovery guidance so API responses never leak internals.
 */

export const ERROR_CODES = {
  // --- Validation (400/413) ---
  VALIDATION_FAILED: {
    code: "VALIDATION_FAILED",
    status: 400,
    retryable: false,
    userMessage: "The request could not be validated.",
    recovery: "Review the highlighted fields and try again.",
  },
  VALIDATION_FIELD: {
    code: "VALIDATION_FIELD",
    status: 400,
    retryable: false,
    userMessage: "One or more fields are invalid.",
    recovery: "Check the field errors and correct them before resubmitting.",
  },
  VALIDATION_FILE_TYPE: {
    code: "VALIDATION_FILE_TYPE",
    status: 400,
    retryable: false,
    userMessage: "The uploaded file type is not supported.",
    recovery: "Upload a file in one of the supported formats (PDF, DOC, PPT, ZIP, MP4, etc.).",
  },
  VALIDATION_FILE_SIZE: {
    code: "VALIDATION_FILE_SIZE",
    status: 400,
    retryable: false,
    userMessage: "The uploaded file exceeds the size limit.",
    recovery: "Compress the file or split it into smaller parts and try again.",
  },
  VALIDATION_UPLOAD_TOO_LARGE: {
    code: "VALIDATION_UPLOAD_TOO_LARGE",
    status: 413,
    retryable: false,
    userMessage: "The uploaded request exceeds the size limit.",
    recovery: "Reduce the upload size and try again.",
  },
  VALIDATION_RANGE_TOO_LARGE: {
    code: "VALIDATION_RANGE_TOO_LARGE",
    status: 413,
    retryable: false,
    userMessage: "The requested download range is too large.",
    recovery: "Request a smaller byte range and try again.",
  },

  // --- Authentication & authorization (401/403) ---
  AUTH_UNAUTHENTICATED: {
    code: "AUTH_UNAUTHENTICATED",
    status: 401,
    retryable: false,
    userMessage: "You must be signed in to perform this action.",
    recovery: "Sign in and try again.",
  },
  AUTH_SESSION_EXPIRED: {
    code: "AUTH_SESSION_EXPIRED",
    status: 401,
    retryable: false,
    userMessage: "Your session has expired.",
    recovery: "Sign in again to continue.",
  },
  AUTH_FORBIDDEN: {
    code: "AUTH_FORBIDDEN",
    status: 403,
    retryable: false,
    userMessage: "You do not have permission to perform this action.",
    recovery: "Contact support if you believe this is a mistake.",
  },
  AUTH_SUSPENDED: {
    code: "AUTH_SUSPENDED",
    status: 403,
    retryable: false,
    userMessage: "Your account has been suspended.",
    recovery: "Contact support to appeal the suspension.",
  },

  // --- Entitlements and protected content ---
  ENTITLEMENT_REQUIRED: {
    code: "ENTITLEMENT_REQUIRED",
    status: 403,
    retryable: false,
    userMessage: "You do not have access to this learning material.",
    recovery: "Check that you are signed into the purchasing account or purchase the material.",
  },
  ENTITLEMENT_PURCHASE_REQUIRED: {
    code: "ENTITLEMENT_PURCHASE_REQUIRED",
    status: 402,
    retryable: false,
    userMessage: "A purchase is required to access this learning material.",
    recovery: "Review the listing and complete checkout to receive access.",
  },
  ENTITLEMENT_UNAVAILABLE: {
    code: "ENTITLEMENT_UNAVAILABLE",
    status: 503,
    retryable: true,
    userMessage: "Access could not be verified right now.",
    recovery: "Wait briefly and check again. Do not repeat a payment while its status is uncertain.",
  },
  MATERIAL_ARCHIVED: {
    code: "MATERIAL_ARCHIVED",
    status: 410,
    retryable: false,
    userMessage: "This material is no longer available for purchase.",
    recovery: "Contact the creator if you believe the material should be available.",
  },

  // --- Not found (404) ---
  NOT_FOUND: {
    code: "NOT_FOUND",
    status: 404,
    retryable: false,
    userMessage: "The requested resource could not be found.",
    recovery: "Check the identifier and try again.",
  },

  // --- Conflicts (409) ---
  CONFLICT_DUPLICATE: {
    code: "CONFLICT_DUPLICATE",
    status: 409,
    retryable: false,
    userMessage: "A record with these details already exists.",
    recovery: "Review the existing record or update it instead of creating a new one.",
  },
  CONFLICT_IN_PROGRESS: {
    code: "CONFLICT_IN_PROGRESS",
    status: 409,
    retryable: true,
    userMessage: "An identical request is already being processed.",
    recovery: "Wait a moment and resend the same request with the same idempotency key to get the result.",
  },
  CONFLICT_IDEMPOTENCY_KEY: {
    code: "CONFLICT_IDEMPOTENCY_KEY",
    status: 409,
    retryable: false,
    userMessage: "This idempotency key was already used with a different request.",
    recovery: "Use a new idempotency key, or resend the exact same request to get the original result.",
  },
  CONFLICT_STATE: {
    code: "CONFLICT_STATE",
    status: 409,
    retryable: false,
    userMessage: "This action cannot be performed in the current state.",
    recovery: "Refresh the page to see the latest state and try again.",
  },
  SETTLEMENT_QUOTE_EXPIRED: {
    code: "SETTLEMENT_QUOTE_EXPIRED",
    status: 409,
    retryable: false,
    userMessage: "The checkout quote has expired.",
    recovery: "Refresh the listing to obtain a current quote before paying.",
  },

  // --- Settlement (402/409/502) ---
  SETTLEMENT_INSUFFICIENT_FUNDS: {
    code: "SETTLEMENT_INSUFFICIENT_FUNDS",
    status: 402,
    retryable: false,
    userMessage: "There are not enough funds to complete this transaction.",
    recovery: "Add funds to your wallet and try again.",
  },
  SETTLEMENT_TX_FAILED: {
    code: "SETTLEMENT_TX_FAILED",
    status: 502,
    retryable: true,
    userMessage: "The payment transaction failed.",
    recovery: "Wait a moment and try again. If the problem persists, contact support.",
  },
  SETTLEMENT_TIMEOUT: {
    code: "SETTLEMENT_TIMEOUT",
    status: 504,
    retryable: true,
    userMessage: "The payment confirmation timed out.",
    recovery: "Your payment may still be processing. Wait a few minutes and check your transaction history before retrying.",
  },
  SETTLEMENT_UNAVAILABLE: {
    code: "SETTLEMENT_UNAVAILABLE",
    status: 503,
    retryable: true,
    userMessage: "The payment service is temporarily unavailable.",
    recovery: "Try again in a few minutes.",
  },

  // --- Creator payout reporting ---
  PAYOUT_PROFILE_INCOMPLETE: {
    code: "PAYOUT_PROFILE_INCOMPLETE",
    status: 400,
    retryable: false,
    userMessage: "A creator payout wallet is not available for this account.",
    recovery: "Add or verify your payout wallet in creator settings.",
  },
  PAYOUT_UNAVAILABLE: {
    code: "PAYOUT_UNAVAILABLE",
    status: 503,
    retryable: true,
    userMessage: "Creator payout information is temporarily unavailable.",
    recovery: "Retry this report shortly. Reconcile payout records if the reported totals remain inconsistent.",
  },

  // --- Storage workflows (400/404/502) ---
  STORAGE_UPLOAD_FAILED: {
    code: "STORAGE_UPLOAD_FAILED",
    status: 502,
    retryable: true,
    userMessage: "The file could not be uploaded.",
    recovery: "Check your connection and try again.",
  },
  STORAGE_NOT_FOUND: {
    code: "STORAGE_NOT_FOUND",
    status: 404,
    retryable: false,
    userMessage: "The stored file could not be found.",
    recovery: "The file may have been removed. Contact support if you purchased this content.",
  },
  STORAGE_UNAVAILABLE: {
    code: "STORAGE_UNAVAILABLE",
    status: 503,
    retryable: true,
    userMessage: "The content delivery service is temporarily unavailable.",
    recovery: "Wait briefly and retry the download. Do not share or reuse an expired capability URL.",
  },
  STORAGE_QUARANTINED: {
    code: "STORAGE_QUARANTINED",
    status: 403,
    retryable: false,
    userMessage: "This content is under review and temporarily unavailable.",
    recovery: "Check back later or contact support for more information.",
  },

  // --- Rate limiting (429) ---
  RATE_LIMITED: {
    code: "RATE_LIMITED",
    status: 429,
    retryable: true,
    userMessage: "Too many requests.",
    recovery: "Wait a moment before trying again.",
  },

  // --- Internal (500) ---
  INTERNAL: {
    code: "INTERNAL",
    status: 500,
    retryable: true,
    userMessage: "Something went wrong on our end.",
    recovery: "Try again in a few moments. If the problem persists, contact support with the reference code.",
  },
};

export function getErrorCode(code) {
  return Object.hasOwn(ERROR_CODES, code) ? ERROR_CODES[code] : ERROR_CODES.INTERNAL;
}
