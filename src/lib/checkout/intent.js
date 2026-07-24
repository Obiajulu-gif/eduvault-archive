import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CHECKOUT_INTENT_POLICY_VERSION = "checkout-intent-v1";
export const CHECKOUT_AMOUNT_DECIMALS = 7;
export const CHECKOUT_INTENT_TTL_MS = 30 * 60 * 1000;

export const CHECKOUT_INTENT_ERROR_CODES = {
  EXPIRED: "intent_expired",
  CONSUMED: "intent_consumed",
  CHANGED: "intent_changed",
  UNSUPPORTED: "intent_unsupported",
  TAMPERED: "intent_tampered",
  WRONG_BUYER: "wrong_buyer",
  WRONG_MATERIAL: "wrong_material",
  WRONG_NETWORK: "wrong_network",
  WRONG_CONTRACT: "wrong_contract",
};

export class CheckoutIntentError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = "CheckoutIntentError";
    this.code = code;
    this.status = status;
  }
}

function sortForCanonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }

  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        if (value[key] !== undefined) {
          acc[key] = sortForCanonicalJson(value[key]);
        }
        return acc;
      }, {});
  }

  return value;
}

export function canonicalize(value) {
  return JSON.stringify(sortForCanonicalJson(value));
}

function getIntentSecret() {
  const secret = process.env.CHECKOUT_INTENT_SECRET || process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.UNSUPPORTED,
      "Checkout intent signing secret is not configured",
      500,
    );
  }
  return "development-checkout-intent-secret";
}

function normalizeBuyerAddress(address) {
  return String(address || "").trim().toLowerCase();
}

function parseDecimalParts(value) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^([0-9]+)(?:\.([0-9]+))?/);
  if (!match) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.UNSUPPORTED,
      "Material price must be a positive decimal amount",
      400,
    );
  }
  return { whole: match[1], fraction: match[2] || "" };
}

export function decimalToAtomicUnits(value, decimals = CHECKOUT_AMOUNT_DECIMALS) {
  const { whole, fraction } = parseDecimalParts(value);
  if (fraction.length > decimals) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.UNSUPPORTED,
      `Amount has more than ${decimals} decimal places`,
      400,
    );
  }

  const paddedFraction = fraction.padEnd(decimals, "0");
  const units = BigInt(`${whole}${paddedFraction}`);
  if (units <= 0n) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.UNSUPPORTED,
      "Checkout amount must be greater than zero",
      400,
    );
  }
  return units;
}

export function atomicUnitsToDecimal(units, decimals = CHECKOUT_AMOUNT_DECIMALS) {
  const value = BigInt(units);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const raw = absolute.toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, -decimals) || "0";
  const fraction = raw.slice(-decimals).replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

function bpsAmount(amountUnits, bps) {
  return (BigInt(amountUnits) * BigInt(bps || 0)) / 10000n;
}

export function percentToBasisPoints(percent) {
  const { whole, fraction } = parseDecimalParts(percent || 0);
  const wholeBps = BigInt(whole) * 100n;
  const fractionBps = BigInt((fraction || "").slice(0, 2).padEnd(2, "0"));
  const result = wholeBps + fractionBps;
  return Number(result > 10000n ? 10000n : result);
}

function resolveMaterialPrice(material) {
  const price = material?.price ?? material?.amount ?? material?.amountDecimal;
  if (price === undefined || price === null) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.UNSUPPORTED,
      "Material does not expose a checkout price",
      400,
    );
  }
  return price;
}

function normalizeAsset(asset) {
  if (typeof asset === "string") {
    return {
      code: asset,
      issuer: null,
      contract: null,
    };
  }

  return {
    code: String(asset?.code || asset?.assetCode || asset?.symbol || "").trim(),
    issuer: asset?.issuer || null,
    contract: asset?.contract || asset?.contractId || asset?.address || null,
  };
}

export function buildCheckoutIntentTerms({
  buyerAddress,
  materialId,
  material,
  materialVersion = null,
  manifestDigest = null,
  sellerAddress = null,
  network,
  contractId,
  asset,
  discountBps = 0,
  taxBps = 0,
  platformFeeBps = 0,
  nonce = randomBytes(16).toString("hex"),
  now = new Date(),
  expiresAt = new Date(now.getTime() + CHECKOUT_INTENT_TTL_MS),
} = {}) {
  const buyer = normalizeBuyerAddress(buyerAddress);
  const resolvedAsset = normalizeAsset(asset);
  if (!buyer || !materialId || !resolvedAsset.code || !network || !contractId) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.UNSUPPORTED,
      "Buyer, material, asset, network, and contract are required",
      400,
    );
  }

  const price = resolveMaterialPrice(material);
  const baseAmountUnits = decimalToAtomicUnits(price);
  const discountUnits = bpsAmount(baseAmountUnits, discountBps);
  const discountedUnits = baseAmountUnits - discountUnits;
  const taxUnits = bpsAmount(discountedUnits, taxBps);
  const amountUnits = discountedUnits + taxUnits;
  const platformFeeUnits = bpsAmount(amountUnits, platformFeeBps);
  const sellerNetUnits = amountUnits - platformFeeUnits;

  return {
    policyVersion: CHECKOUT_INTENT_POLICY_VERSION,
    buyer,
    material: {
      id: String(materialId),
      version: materialVersion || null,
      manifestDigest: manifestDigest || null,
      priceFingerprint: canonicalize({
        price: String(price),
        status: material?.status || null,
        paused: Boolean(material?.paused),
        withdrawn: Boolean(material?.withdrawn || material?.isWithdrawn),
      }),
    },
    seller: sellerAddress || material?.creatorAddress || material?.userAddress || material?.authorAddress || null,
    network: String(network),
    contract: String(contractId),
    asset: resolvedAsset,
    amount: {
      units: amountUnits.toString(),
      decimals: CHECKOUT_AMOUNT_DECIMALS,
      display: atomicUnitsToDecimal(amountUnits),
    },
    feeBreakdown: {
      baseUnits: baseAmountUnits.toString(),
      discountBps,
      discountUnits: discountUnits.toString(),
      taxBps,
      taxUnits: taxUnits.toString(),
      platformFeeBps,
      platformFeeUnits: platformFeeUnits.toString(),
      sellerNetUnits: sellerNetUnits.toString(),
      rounding: "integer-floor-bps",
    },
    expiry: new Date(expiresAt).toISOString(),
    nonce,
    issuedAt: new Date(now).toISOString(),
  };
}

export function hashCheckoutIntentTerms(terms) {
  return createHash("sha256").update(canonicalize(terms)).digest("hex");
}

export function signCheckoutIntentTerms(terms) {
  return createHmac("sha256", getIntentSecret()).update(canonicalize(terms)).digest("hex");
}

export function createSignedCheckoutIntent(params) {
  const terms = buildCheckoutIntentTerms(params);
  return {
    terms,
    intentHash: hashCheckoutIntentTerms(terms),
    signature: signCheckoutIntentTerms(terms),
    signatureAlg: "hmac-sha256",
  };
}

export function verifySignedCheckoutIntent(intent) {
  const terms = intent?.terms;
  const signature = intent?.signature;
  if (!terms || !signature) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.TAMPERED,
      "Checkout intent is missing signed terms",
      422,
    );
  }

  const expected = signCheckoutIntentTerms(terms);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(String(signature), "hex");
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.TAMPERED,
      "Checkout intent signature is invalid",
      422,
    );
  }

  const expectedHash = hashCheckoutIntentTerms(terms);
  if (intent.intentHash && intent.intentHash !== expectedHash) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.TAMPERED,
      "Checkout intent hash does not match signed terms",
      422,
    );
  }

  return true;
}

export function assertCheckoutIntentMatches({
  intent,
  buyerAddress,
  materialId,
  network,
  contractId,
  now = new Date(),
}) {
  verifySignedCheckoutIntent(intent);

  const terms = intent.terms;
  if (terms.buyer !== normalizeBuyerAddress(buyerAddress)) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.WRONG_BUYER,
      "Checkout intent belongs to a different buyer",
      403,
    );
  }

  if (terms.material.id !== String(materialId)) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.WRONG_MATERIAL,
      "Checkout intent belongs to a different material",
      422,
    );
  }

  if (terms.network !== String(network)) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.WRONG_NETWORK,
      "Checkout intent was created for a different Stellar network",
      422,
    );
  }

  if (terms.contract !== String(contractId)) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.WRONG_CONTRACT,
      "Checkout intent was created for a different purchase contract",
      422,
    );
  }

  if (new Date(terms.expiry).getTime() <= new Date(now).getTime()) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.EXPIRED,
      "Checkout intent has expired",
      409,
    );
  }
}

export function assertMaterialStillMatchesIntent({ intent, material, materialVersion = null, manifestDigest = null }) {
  const currentFingerprint = canonicalize({
    price: String(resolveMaterialPrice(material)),
    status: material?.status || null,
    paused: Boolean(material?.paused),
    withdrawn: Boolean(material?.withdrawn || material?.isWithdrawn),
  });

  if (
    intent.terms.material.priceFingerprint !== currentFingerprint ||
    intent.terms.material.version !== (materialVersion || null) ||
    intent.terms.material.manifestDigest !== (manifestDigest || null)
  ) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.CHANGED,
      "Material terms changed after this checkout intent was created",
      409,
    );
  }
}
