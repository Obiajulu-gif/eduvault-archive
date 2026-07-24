/**
 * Tax Estimator Module
 * Provides geolocation-based tax rate estimation for checkout processing
 */

// Default tax rates by country/region (in basis points: 10000 = 100%)
const DEFAULT_TAX_RATES = {
  US: 800, // 8% average sales tax
  GB: 2000, // 20% VAT
  DE: 1900, // 19% VAT
  FR: 2000, // 20% VAT
  CA: 500, // 5% GST
  AU: 1000, // 10% GST
  JP: 1000, // 10% consumption tax
  IN: 1800, // 18% GST
  BR: 1700, // 17% average ICMS
  MX: 1600, // 16% VAT
  IT: 2200, // 22% VAT
  ES: 2100, // 21% VAT
  NL: 2100, // 21% VAT
  BE: 2100, // 21% VAT
  AT: 2000, // 20% VAT
  CH: 77, // 7.7% VAT
  SE: 2500, // 25% VAT
  NO: 2500, // 25% VAT
  DK: 2500, // 25% VAT
  PL: 2300, // 23% VAT
  CZ: 2100, // 21% VAT
  HU: 2700, // 27% VAT
  RO: 1900, // 19% VAT
  BG: 2000, // 20% VAT
  GR: 2400, // 24% VAT
  PT: 2300, // 23% VAT
  FI: 2400, // 24% VAT
  IE: 2300, // 23% VAT
  LU: 1700, // 17% VAT
  SK: 2000, // 20% VAT
  SI: 2200, // 22% VAT
  EE: 2000, // 20% VAT
  LV: 2100, // 21% VAT
  LT: 2100, // 21% VAT
  CY: 1900, // 19% VAT
  MT: 1800, // 18% VAT
  // Default for unknown regions
  DEFAULT: 0,
};

/**
 * Resolve geolocation from IP address
 * @param {string} ipAddress - The client's IP address
 * @returns {Promise<Object>} Geolocation data with country code
 */
async function resolveGeolocation(ipAddress) {
  try {
    // Use a free geolocation API (ip-api.com)
    // In production, consider using a paid service like MaxMind GeoIP2
    const response = await fetch(`http://ip-api.com/json/${ipAddress}`);
    
    if (!response.ok) {
      console.warn('Geolocation API request failed:', response.status);
      return { countryCode: 'DEFAULT', countryName: 'Unknown' };
    }

    const data = await response.json();
    
    return {
      countryCode: data.countryCode || 'DEFAULT',
      countryName: data.country || 'Unknown',
      region: data.regionName || null,
      city: data.city || null,
    };
  } catch (error) {
    console.error('Error resolving geolocation:', error);
    return { countryCode: 'DEFAULT', countryName: 'Unknown' };
  }
}

/**
 * Get tax rate for a specific country code
 * @param {string} countryCode - ISO 3166-1 alpha-2 country code
 * @returns {number} Tax rate in basis points (10000 = 100%)
 */
export function getTaxRateForCountry(countryCode) {
  const upperCode = countryCode?.toUpperCase() || 'DEFAULT';
  return DEFAULT_TAX_RATES[upperCode] || DEFAULT_TAX_RATES.DEFAULT;
}

/**
 * Calculate tax amount for a given base amount
 * @param {number} baseAmount - The base amount before tax
 * @param {number} taxRateBps - Tax rate in basis points
 * @returns {number} Tax amount
 */
function calculateTaxAmount(baseAmount, taxRateBps) {
  return Math.round((baseAmount * taxRateBps) / 10000);
}

/**
 * Estimate tax for a checkout based on IP geolocation
 * @param {Object} params - Tax estimation parameters
 * @param {string} params.ipAddress - Client's IP address
 * @param {number} params.baseAmount - Base amount before tax
 * @param {string} [params.countryCode] - Optional country code override
 * @returns {Promise<Object>} Tax estimation result
 */
export async function estimateTax({ ipAddress, baseAmount, countryCode }) {
  let geoData;

  if (countryCode) {
    geoData = {
      countryCode,
      countryName: 'Provided',
      region: null,
      city: null,
    };
  } else if (ipAddress) {
    geoData = await resolveGeolocation(ipAddress);
  } else {
    geoData = {
      countryCode: 'DEFAULT',
      countryName: 'Unknown',
      region: null,
      city: null,
    };
  }

  const taxRateBps = getTaxRateForCountry(geoData.countryCode);
  const taxAmount = calculateTaxAmount(baseAmount, taxRateBps);
  const totalAmount = baseAmount + taxAmount;

  return {
    baseAmount,
    taxRateBps,
    taxRatePercent: (taxRateBps / 100).toFixed(2),
    taxAmount,
    totalAmount,
    geolocation: geoData,
  };
}

/**
 * Get tax estimation for checkout intent
 * @param {Object} checkoutIntent - Checkout intent data
 * @returns {Promise<Object>} Adjusted checkout totals with tax
 */
export async function applyTaxToCheckout(checkoutIntent) {
  const { amount, buyerIp, buyerCountry } = checkoutIntent;

  if (!amount || amount <= 0) {
    throw new Error('Invalid amount for tax calculation');
  }

  const taxEstimation = await estimateTax({
    ipAddress: buyerIp,
    baseAmount: amount,
    countryCode: buyerCountry,
  });

  return {
    ...checkoutIntent,
    originalAmount: amount,
    taxAmount: taxEstimation.taxAmount,
    taxRateBps: taxEstimation.taxRateBps,
    totalAmount: taxEstimation.totalAmount,
    geolocation: taxEstimation.geolocation,
  };
}

/**
 * Validate tax rate is within acceptable bounds
 * @param {number} taxRateBps - Tax rate in basis points
 * @returns {boolean} True if tax rate is valid
 */
export function isValidTaxRate(taxRateBps) {
  return taxRateBps >= 0 && taxRateBps <= 3000; // Max 30% tax
}
