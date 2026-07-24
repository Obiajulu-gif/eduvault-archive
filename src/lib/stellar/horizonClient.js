import { Horizon } from "@stellar/stellar-sdk";
import { HORIZON_URL, isMainnet } from "@/lib/config/chain";

const horizonLogger = {
  warn(data, message) {
    console.warn(message, data);
  },
  info(data, message) {
    console.info(message, data);
  },
  error(data, message) {
    console.error(message, data);
  },
};

// Primary URL from config; fallback list ordered by preference.
const PRIMARY_URL = HORIZON_URL;

const FALLBACK_URLS = isMainnet
  ? [
      'https://horizon.stellar.org',
      'https://horizon.stellar.lobstr.co',
    ]
  : [
      'https://horizon-testnet.stellar.org',
    ];

// Gather any extra endpoints defined in env (space or comma separated).
const EXTRA_FALLBACKS = (process.env.STELLAR_HORIZON_FALLBACKS || '')
  .split(/[\s,]+/)
  .map((u) => u.trim())
  .filter(Boolean);

const ALL_ENDPOINTS = [
  PRIMARY_URL,
  ...EXTRA_FALLBACKS,
  ...FALLBACK_URLS,
].filter((url, idx, arr) => url && arr.indexOf(url) === idx);

const DEFAULT_TIMEOUT_MS = Number(process.env.STELLAR_HORIZON_TIMEOUT_MS || 8000);
const DEFAULT_RETRIES = Number(process.env.STELLAR_HORIZON_RETRIES || 2);

function buildServer(url) {
  const options = {
    allowHttp: url.startsWith("http://"),
  };

  try {
    return new Horizon.Server(url, options);
  } catch (error) {
    if (
      error instanceof TypeError &&
      String(error.message || "").includes("not a constructor")
    ) {
      return Horizon.Server(url, options);
    }
    throw error;
  }
}

function isTransientError(error) {
  const status = error?.response?.status ?? error?.status;
  if (status === 429 || status === 503 || status === 502 || status === 504) return true;
  const code = error?.code || '';
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') return true;
  const message = String(error?.message || '').toLowerCase();
  return message.includes('timeout') || message.includes('network') || message.includes('socket');
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Horizon request timed out (${ms}ms) for ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute `fn(server)` against each endpoint in order, switching to the next
 * node on connection or timeout errors. Logs each failover so operators can
 * triage node health from the dashboard alerts.
 *
 * @param {(server: Horizon.Server) => Promise<T>} fn
 * @param {{ timeoutMs?: number, retries?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function withFailover(fn, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES } = {}) {
  const errors = [];

  for (let attempt = 0; attempt <= retries; attempt++) {
    const url = ALL_ENDPOINTS[attempt % ALL_ENDPOINTS.length];
    const server = buildServer(url);

    try {
      const result = await withTimeout(fn(server), timeoutMs, url);

      if (attempt > 0) {
        horizonLogger.info(
          {
            failoverUrl: url,
            attempt: attempt + 1,
          },
          "Horizon failover succeeded",
        );
      }
      return result;
    } catch (err) {
      errors.push({ url, message: err.message });

      if (!isTransientError(err)) {
        horizonLogger.warn(
          {
            url,
            error: err.message,
          },
          "Horizon non-transient error; failover stopped",
        );
        throw err;
      }

      horizonLogger.warn(
        {
          primaryUrl: ALL_ENDPOINTS[0],
          failedUrl: url,
          nextUrl:
            ALL_ENDPOINTS[
              (attempt + 1) % ALL_ENDPOINTS.length
            ],
          attempt: attempt + 1,
          error: err.message,
        },
        "Horizon connection error detected; switching endpoint",
      );
    }
  }

  const summary = errors
    .map(({ url, message }) => `${url}: ${message}`)
    .join(" | ");

  throw new Error(
    `All Horizon endpoints failed after ${retries + 1} attempts. Errors: ${summary}`,
  );
}

/**
 * Convenience wrapper: load a Stellar account with failover support.
 *
 * @param {string} publicKey
 * @returns {Promise<Horizon.AccountResponse>}
 */
export async function loadAccount(publicKey) {
  return withFailover((server) => server.loadAccount(publicKey));
}

/**
 * Submit a signed transaction with failover support.
 *
 * @param {import('@stellar/stellar-sdk').Transaction} transaction
 * @returns {Promise<Horizon.HorizonApi.SubmitTransactionResponse>}
 */
export async function submitTransaction(transaction) {
  return withFailover((server) => server.submitTransaction(transaction));
}

/**
 * Fetch fee statistics from the primary Horizon endpoint.
 * Used by surge pricing detection (issue #385).
 *
 * @returns {Promise<Horizon.HorizonApi.FeeStatsResponse>}
 */
export async function fetchFeeStats() {
  return withFailover((server) => server.feeStats());
}

/**
 * Return the list of all configured Horizon endpoints (primary + fallbacks)
 * for diagnostics / health checks.
 */
export function getConfiguredEndpoints() {
  return [...ALL_ENDPOINTS];
}

/**
 * Fetch current network fee statistics from Horizon endpoint /fee_stats.
 * @returns {Promise<Object>} Fee statistics object
 */
export async function getFeeStats() {
  try {
    return await fetchFeeStats();
  } catch (error) {
    horizonLogger.error(
      {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
    );
  }

  const response = await fetch(`${HORIZON_URL}/fee_stats`, {
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch fee stats: ${response.statusText}`);
  }

  const data = await response.json();
  return data;
}

/**
 * Calculate optimal base fee rates based on network congestion.
 * @param {Object} feeStats - The fee statistics object from getFeeStats
 * @returns {Object} Optimal fee rates { low, medium, high } in stroops
 */
export function calculateOptimalFees(feeStats) {
  const p10 = parseInt(feeStats.fee_charged?.p10 || "100", 10);
  const p50 = parseInt(feeStats.fee_charged?.p50 || "100", 10);
  const p95 = parseInt(feeStats.fee_charged?.p95 || "100", 10);

  return {
    low: String(Math.max(100, p10)),
    medium: String(Math.max(100, p50)),
    high: String(Math.max(100, p95)),
  };
}

/**
 * Get the dynamic optimal fee for a given priority tier.
 * @param {'low' | 'medium' | 'high'} tier - Priority tier
 * @returns {Promise<string>} Base fee string in stroops
 */
export async function getDynamicBaseFee(tier = 'medium') {
  const feeStats = await getFeeStats();
  const optimalFees = calculateOptimalFees(feeStats);
  
  return optimalFees[tier] || optimalFees.medium;
}

const KNOWN_USDC_ISSUERS = {
  testnet: 'GBBD47IF6LWK7P7MDEVSCWRZDPOVPOFWLYERWFBN4JSE3OUQTISLV5EX',
  mainnet: 'GA5ZSEJYB37JDD5G3LYVYF77RD7QFGHSXPJNKXJFUMIVYQ33HE6IGM4Y',
};

/**
 * Check whether an account holds an active trustline for the specified asset.
 * Returns { hasTrustline, balance?, issuer? } on success.
 *
 * @param {string} publicKey  – Stellar G… address
 * @param {string} assetCode  – e.g. 'USDC'
 * @param {string} [issuerAddress] – asset issuer; resolved from env if omitted
 * @returns {Promise<{ hasTrustline: boolean, balance?: string, issuer?: string }>}
 */
export async function checkBuyerTrustline(publicKey, assetCode, issuerAddress) {
  const issuer = issuerAddress || process.env.NEXT_PUBLIC_USDC_ISSUER
    || KNOWN_USDC_ISSUERS[isMainnet ? 'mainnet' : 'testnet'];

  const account = await loadAccount(publicKey);
  const trustline = account.balances.find(
    (b) => b.asset_type !== 'native' && b.asset_code === assetCode && b.asset_issuer === issuer,
  );

  if (!trustline) {
    horizonLogger.info(
      {
        publicKey,
        assetCode,
        issuer,
      },
      "Buyer is missing the required asset trustline",
    );
    return {
      hasTrustline: false,
      issuer,
      instructions: {
        message: `Your wallet does not have an active trustline for ${assetCode}.`,
        steps: [
          `Use the Stellar Laboratory or your wallet to establish a trustline for ${assetCode} issued by ${issuer}.`,
          'Or run the following in the Stellar CLI:',
          `  stellar-cli asset add-Trust ${issuer}:${assetCode}`,
          `Trustline URL: ${isMainnet
            ? 'https://accountviewer.stellar.org/'
            : 'https://laboratory.stellar.org/'}`,
        ],
      },
    };
  }

  return {
    hasTrustline: true,
    balance: trustline.balance,
    issuer,
  };
}