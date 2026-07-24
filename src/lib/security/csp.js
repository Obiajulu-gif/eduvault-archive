const DEFAULT_CONNECT_ORIGINS = [
  "https://soroban-testnet.stellar.org",
  "https://soroban-mainnet.stellar.org",
  "https://horizon-testnet.stellar.org",
  "https://horizon.stellar.org",
  "https://eth.merkle.io",
  "https://rpc.sepolia.org",
  "https://*.coinbase.com",
  "https://*.walletconnect.com",
  "https://*.walletconnect.org",
  "wss://*.walletconnect.com",
  "wss://*.walletconnect.org",
];

const DEFAULT_MEDIA_ORIGINS = ["https://gateway.pinata.cloud", "https://ipfs.io", "https://www.gravatar.com"];

function configuredOrigin(value) {
  try {
    const url = new URL(value);
    return ["https:", "wss:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

export function createCspNonce() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function buildContentSecurityPolicy(
  nonce,
  { development = process.env.NODE_ENV === "development" } = {},
) {
  if (!/^[a-f0-9]{32}$/i.test(nonce || "")) throw new TypeError("Invalid CSP nonce");

  const connectOrigins = [...new Set([
    ...DEFAULT_CONNECT_ORIGINS,
    configuredOrigin(process.env.NEXT_PUBLIC_STELLAR_RPC_URL),
    configuredOrigin(process.env.NEXT_PUBLIC_HORIZON_URL),
  ].filter(Boolean))];
  const mediaOrigins = [...new Set([
    ...DEFAULT_MEDIA_ORIGINS,
    configuredOrigin(process.env.NEXT_PUBLIC_GATEWAY_URL),
  ].filter(Boolean))];
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "frame-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    `style-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-inline'" : ""}`,
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' data:",
    `img-src 'self' data: blob: ${mediaOrigins.join(" ")}`,
    `media-src 'self' blob: ${mediaOrigins.join(" ")}`,
    `connect-src 'self' ${connectOrigins.join(" ")}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "require-trusted-types-for 'script'",
    "trusted-types nextjs nextjs#bundler",
    "upgrade-insecure-requests",
    "report-uri /api/csp-report",
    "report-to csp-endpoint",
  ].join("; ");
}

export const STATIC_SECURITY_HEADERS = {
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export function applyBrowserSecurityHeaders(response, { csp } = {}) {
  if (csp) response.headers.set("Content-Security-Policy", csp);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  response.headers.set("Reporting-Endpoints", 'csp-endpoint="/api/csp-report"');
  return response;
}

const CSP_REPORT_WINDOW_MS = 10 * 60 * 1000;
const seenReports = new Map();

function privateUrl(value) {
  if (!value || value === "inline" || value === "eval") return value || null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return "invalid-url";
  }
}

export function normalizeCspReport(payload) {
  const body = payload?.["csp-report"] || payload?.body || payload;
  if (!body || typeof body !== "object") return null;
  return {
    effectiveDirective: String(
      body["effective-directive"] || body.effectiveDirective || body["violated-directive"] || "unknown",
    ).slice(0, 100),
    blockedUrl: privateUrl(body["blocked-uri"] || body.blockedURL),
    documentUrl: privateUrl(body["document-uri"] || body.documentURL),
    sourceUrl: privateUrl(body["source-file"] || body.sourceFile),
    disposition: String(body.disposition || "enforce").slice(0, 20),
    statusCode: Number(body["status-code"] || body.statusCode || 0),
  };
}

export function shouldRecordCspReport(
  report,
  { now = Date.now(), random = Math.random, sampleRate } = {},
) {
  if (!report) return false;
  const rate = sampleRate ?? Number(process.env.CSP_REPORT_SAMPLE_RATE || "0.1");
  if (!Number.isFinite(rate) || rate <= 0 || random() > Math.min(rate, 1)) return false;
  for (const [key, timestamp] of seenReports) {
    if (now - timestamp > CSP_REPORT_WINDOW_MS) seenReports.delete(key);
  }
  if (seenReports.size >= 1_000) seenReports.delete(seenReports.keys().next().value);
  const key = ["effectiveDirective", "blockedUrl", "documentUrl", "sourceUrl", "disposition"]
    .map((field) => report[field]).join("|");
  if (now - seenReports.get(key) <= CSP_REPORT_WINDOW_MS) return false;
  seenReports.set(key, now);
  return true;
}
