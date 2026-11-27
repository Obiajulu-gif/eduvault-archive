import { QUOTE_SIGNING_BUFFER_MS, STALE_QUOTE_REASONS } from './quoteConstants.js';

export const DEFAULT_SIGNING_BUFFER_MS = QUOTE_SIGNING_BUFFER_MS;

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function formatAmount(value, asset) {
  const num = Number(value);
  const formatted = Number.isFinite(num) ? num.toFixed(2) : String(value ?? '');
  return asset ? `${formatted} ${asset}` : formatted;
}

/**
 * Synchronous client-side pre-check before contacting the server or opening a
 * wallet signing prompt. Catches missing quotes, switched wallets, expired
 * quotes, quotes inside the signing safety buffer, and local price drift.
 */
export function evaluateClientQuoteFreshness({
  quote,
  materialId,
  buyerAddress,
  expectedPrice,
  now = Date.now(),
  signingBufferMs = DEFAULT_SIGNING_BUFFER_MS,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  if (!quote || !quote.quoteId) {
    return {
      fresh: false,
      stale: true,
      canRefresh: true,
      reason: STALE_QUOTE_REASONS.QUOTE_NOT_FOUND,
    };
  }

  if (
    quote.buyerAddress &&
    buyerAddress &&
    normalizeAddress(quote.buyerAddress) !== normalizeAddress(buyerAddress)
  ) {
    return {
      fresh: false,
      stale: true,
      canRefresh: true,
      reason: STALE_QUOTE_REASONS.BUYER_MISMATCH,
    };
  }

  if (materialId !== undefined && quote.materialId && String(quote.materialId) !== String(materialId)) {
    return {
      fresh: false,
      stale: true,
      canRefresh: true,
      reason: STALE_QUOTE_REASONS.MATERIAL_MISMATCH,
    };
  }

  if (quote.expiresAt) {
    const expiresAtMs = new Date(quote.expiresAt).getTime();
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs) {
      return {
        fresh: false,
        stale: true,
        canRefresh: true,
        reason: STALE_QUOTE_REASONS.QUOTE_EXPIRED,
        expiresAt: quote.expiresAt,
        remainingMs: 0,
      };
    }

    const remainingMs = expiresAtMs - nowMs;
    if (signingBufferMs > 0 && remainingMs <= signingBufferMs) {
      return {
        fresh: false,
        stale: true,
        canRefresh: true,
        reason: STALE_QUOTE_REASONS.QUOTE_EXPIRING_SOON,
        expiresAt: quote.expiresAt,
        remainingMs,
      };
    }
  }

  if (
    expectedPrice !== undefined &&
    expectedPrice !== null &&
    quote.price !== undefined &&
    quote.price !== null &&
    Number(expectedPrice) !== Number(quote.price)
  ) {
    return {
      fresh: false,
      stale: true,
      canRefresh: true,
      reason: STALE_QUOTE_REASONS.TERMS_CHANGED,
      changedFields: ['price'],
      quoteTerms: { price: quote.price, asset: quote.asset },
      currentTerms: { price: Number(expectedPrice), asset: quote.asset },
    };
  }

  return {
    fresh: true,
    stale: false,
    canRefresh: false,
  };
}

/**
 * Formats a buyer-facing title, message, and refreshability flag for any
 * stale-quote, authorization, or transient validation failure.
 */
export function formatStaleQuoteMessage(result = {}) {
  const { reason, changedFields = [], quoteTerms, currentTerms, fallbackMessage } = result;

  switch (reason) {
    case STALE_QUOTE_REASONS.QUOTE_EXPIRED:
      return {
        title: 'Quote expired before signing',
        message: 'Your checkout quote expired before wallet signing. Refresh to get a current quote.',
        canRefresh: true,
      };
    case STALE_QUOTE_REASONS.QUOTE_EXPIRING_SOON:
      return {
        title: 'Quote expiring soon',
        message: 'Your quote has too little time left to complete signing safely. Refresh to lock in a fresh quote.',
        canRefresh: true,
      };
    case STALE_QUOTE_REASONS.TERMS_CHANGED: {
      if (changedFields.includes('price') && quoteTerms && currentTerms) {
        const oldPrice = formatAmount(quoteTerms.price, quoteTerms.asset);
        const newPrice = formatAmount(currentTerms.price, currentTerms.asset || quoteTerms.asset);
        return {
          title: 'Price changed before signing',
          message: `The listing price updated from ${oldPrice} to ${newPrice}. Refresh your quote to review the new total before signing.`,
          canRefresh: true,
        };
      }
      return {
        title: 'Listing terms updated',
        message: 'Listing terms changed since your quote was issued. Refresh your quote to review the updated terms before signing.',
        canRefresh: true,
      };
    }
    case STALE_QUOTE_REASONS.BUYER_MISMATCH:
      return {
        title: 'Wallet changed',
        message: 'Your active wallet does not match the wallet that requested this quote. Refresh to issue a quote for your current wallet.',
        canRefresh: true,
      };
    case STALE_QUOTE_REASONS.QUOTE_CONSUMED:
      return {
        title: 'Quote already used',
        message: 'This quote was already consumed. Refresh to request a new checkout quote.',
        canRefresh: true,
      };
    case STALE_QUOTE_REASONS.MATERIAL_ARCHIVED:
      return {
        title: 'Material archived',
        message: 'This material has been archived and is no longer available for purchase.',
        canRefresh: false,
      };
    case STALE_QUOTE_REASONS.MATERIAL_UNAVAILABLE:
      return {
        title: 'Material unavailable',
        message: 'This material is no longer available for purchase.',
        canRefresh: false,
      };
    case STALE_QUOTE_REASONS.QUOTE_NOT_FOUND:
    case STALE_QUOTE_REASONS.MATERIAL_MISMATCH:
    default:
      return {
        title: 'Checkout quote needs refresh',
        message: fallbackMessage || 'Your checkout quote is no longer valid. Refresh to get a current quote before signing.',
        canRefresh: result.canRefresh !== false,
      };
  }
}

/**
 * Full pre-signing guard: runs synchronous local freshness checks first, then
 * verifies quote freshness and authorization with the server before wallet
 * signing begins.
 */
export async function verifyQuoteBeforeSigning({
  quote,
  materialId,
  buyerAddress,
  expectedPrice,
  validateQuoteFn,
  now = Date.now(),
  signingBufferMs = DEFAULT_SIGNING_BUFFER_MS,
}) {
  const localCheck = evaluateClientQuoteFreshness({
    quote,
    materialId,
    buyerAddress,
    expectedPrice,
    now,
    signingBufferMs,
  });

  if (!localCheck.fresh) {
    const formatted = formatStaleQuoteMessage(localCheck);
    return {
      ok: false,
      kind: 'stale',
      source: 'client',
      reason: localCheck.reason,
      canRefresh: formatted.canRefresh,
      title: formatted.title,
      message: formatted.message,
      changedFields: localCheck.changedFields || [],
      quoteTerms: localCheck.quoteTerms || null,
      currentTerms: localCheck.currentTerms || null,
    };
  }

  try {
    const response = await validateQuoteFn({
      materialId,
      quoteId: quote.quoteId,
      buyerAddress,
      minRemainingMs: signingBufferMs,
    });

    if (response?.fresh) {
      return {
        ok: true,
        quote: {
          ...quote,
          ...response,
        },
      };
    }

    const formatted = formatStaleQuoteMessage({
      reason: response?.reason,
      changedFields: response?.changedFields,
      quoteTerms: response?.quoteTerms,
      currentTerms: response?.currentTerms,
      canRefresh: response?.canRefresh,
      fallbackMessage: response?.error,
    });

    return {
      ok: false,
      kind: 'stale',
      source: 'server',
      reason: response?.reason || STALE_QUOTE_REASONS.QUOTE_NOT_FOUND,
      canRefresh: formatted.canRefresh,
      title: formatted.title,
      message: formatted.message,
      changedFields: response?.changedFields || [],
      quoteTerms: response?.quoteTerms || null,
      currentTerms: response?.currentTerms || null,
    };
  } catch (err) {
    const status = err?.status;
    const data = err?.data || {};
    const code = data?.code || err?.code || null;

    if (status === 401 || (status === 403 && !data?.stale)) {
      return {
        ok: false,
        kind: 'auth',
        source: 'server',
        status,
        code,
        canRefresh: false,
        title: status === 401 ? 'Sign in required' : 'Wallet authorization mismatch',
        message:
          data?.error ||
          err?.message ||
          (status === 401
            ? 'Your session expired. Sign in again before signing this purchase.'
            : 'Your connected wallet does not match your authenticated session.'),
      };
    }

    if (
      data?.stale === true ||
      status === 409 ||
      status === 410 ||
      status === 404 ||
      code === 'SETTLEMENT_QUOTE_EXPIRED'
    ) {
      const reason =
        data?.reason ||
        (status === 410 && code === 'MATERIAL_ARCHIVED'
          ? STALE_QUOTE_REASONS.MATERIAL_ARCHIVED
          : status === 404
            ? STALE_QUOTE_REASONS.MATERIAL_UNAVAILABLE
            : code === 'SETTLEMENT_QUOTE_EXPIRED'
              ? STALE_QUOTE_REASONS.QUOTE_EXPIRED
              : STALE_QUOTE_REASONS.QUOTE_NOT_FOUND);

      const formatted = formatStaleQuoteMessage({
        reason,
        changedFields: data?.changedFields,
        quoteTerms: data?.quoteTerms,
        currentTerms: data?.currentTerms,
        canRefresh: data?.canRefresh,
        fallbackMessage: data?.error || err?.message,
      });

      return {
        ok: false,
        kind: reason === STALE_QUOTE_REASONS.BUYER_MISMATCH && status === 403 ? 'auth' : 'stale',
        source: 'server',
        status,
        code,
        reason,
        canRefresh: formatted.canRefresh,
        title: formatted.title,
        message: formatted.message,
        changedFields: data?.changedFields || [],
        quoteTerms: data?.quoteTerms || null,
        currentTerms: data?.currentTerms || null,
      };
    }

    return {
      ok: false,
      kind: 'error',
      source: 'network',
      status: status || null,
      code,
      retryable: true,
      canRefresh: false,
      title: 'Could not verify quote',
      message:
        err?.message ||
        'Unable to verify quote freshness before signing. Check your connection and retry.',
    };
  }
}
