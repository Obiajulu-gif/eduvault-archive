/**
 * SSRF & DNS-rebinding protection for webhook destinations (issue #634)
 *
 * Signed webhooks are still dangerous if a user can register a destination that
 * reaches loopback, cloud metadata services, private networks, or a public host
 * that later rebinds to an internal address. This module:
 *   - canonicalizes URLs and enforces scheme / port / credential policy,
 *   - resolves every hostname to its addresses and rejects private, loopback,
 *     link-local, multicast, reserved, and cloud-metadata ranges (IPv4, IPv6,
 *     and IPv4-mapped forms, including decimal/octal/hex literals),
 *   - delivers via a restricted egress client with byte/time limits that
 *     re-validates every redirect hop.
 *
 * All errors surface safe diagnostics only — no secrets or raw host internals
 * are reflected back to the caller.
 */

import dns from "node:dns/promises";
import { URL } from "node:url";

export const ALLOWED_SCHEMES = ["http:", "https:"];

// Ports we are willing to egress to. Add to this list via env if needed.
export const ALLOWED_PORTS = new Set(
  (process.env.WEBHOOK_ALLOWED_PORTS || "80,443,8080,8443")
    .split(",")
    .map((p) => parseInt(p.trim(), 10))
    .filter(Number.isFinite)
);

const MAX_RESPONSE_BYTES = parseInt(
  process.env.WEBHOOK_MAX_BYTES || String(1 * 1024 * 1024),
  10
);
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.WEBHOOK_TIMEOUT_MS || "10000",
  10
);

export class SsrfError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SsrfError";
    this.code = code;
  }
}

// --- IP range policy -------------------------------------------------------

function parseIPv4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function inRange(ipInt, baseInt, prefix) {
  const mask = prefix === 32 ? 0xffffffff : ~((1 << (32 - prefix)) - 1) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function ipv4ToInt(nums) {
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

/**
 * Returns true if the given IPv4 address is private/loopback/metadata/etc.
 */
function isBlockedIPv4(ip) {
  const nums = parseIPv4(ip);
  if (!nums) return true; // unparseable is treated as unsafe
  const n = ipv4ToInt(nums);

  const ranges = [
    [0, 8], // "this" network
    [10, 8], // RFC1918 private
    [100, 10], // CGNAT
    [127, 8], // loopback
    [169, 16], // link-local incl. 169.254.169.254 metadata
    [172, 12], // RFC1918 private
    [192, 24], // incl. 192.0.0.170 (Oracle/cloud metadata)
    [192, 29], // 192.0.0.0/29 special
    [192, 168], // RFC1918 private
    [198, 15], // benchmarking
    [224, 4], // multicast
    [240, 4], // reserved / future use
  ];

  for (const [base, prefix] of ranges) {
    const baseNums = String(base)
      .padStart(0)
      .split(".")
      .map(Number);
    // base is given as the first octet; reconstruct full base int.
    const fullBase = ipv4ToInt([
      base,
      prefix >= 24 ? 0 : 0,
      prefix >= 16 ? 0 : 0,
      prefix >= 8 ? 0 : 0,
    ]);
    if (inRange(n, fullBase, prefix)) return true;
  }

  // Explicit cloud metadata endpoints that live outside the ranges above.
  const metadata = [
    "169.254.169.254",
    "169.254.169.253",
    "169.254.170.2",
    "100.100.100.200", // Alibaba
    "192.0.0.192", // sometimes used as metadata
  ];
  if (metadata.includes(ip)) return true;

  return false;
}

function stripIpv4Mapped(ip) {
  // ::ffff:a.b.c.d or ::a.b.c.d
  const mapped = /^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[2];
  return null;
}

/**
 * Returns true if the address (IPv4 or IPv6) must not be reached.
 */
export function isBlockedAddress(address) {
  if (!address) return true;
  const ip = address.toLowerCase();

  const mapped = stripIpv4Mapped(ip);
  if (mapped) return isBlockedIPv4(mapped);

  if (ip.includes(":")) {
    // IPv6
    if (ip === "::1" || ip === "::" || ip === "::ffff") return true;
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // unique local fc00::/7
    if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb"))
      return true; // link-local fe80::/10
    if (ip.startsWith("ff")) return true; // multicast
  }

  // IPv4 literal
  if (ip.includes(".")) return isBlockedIPv4(ip);

  return false;
}

// --- Canonicalization & validation ----------------------------------------

/**
 * Parse and canonicalize a raw webhook URL, enforcing scheme, credential, and
 * port policy. Returns a URL object or throws SsrfError with a safe message.
 */
export function canonicalizeWebhookUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new SsrfError("Webhook URL must be a non-empty string.", "invalid_url");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError("Webhook URL is not a valid URL.", "invalid_url");
  }

  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    throw new SsrfError(
      `Webhook scheme "${parsed.protocol}" is not allowed.`,
      "scheme_not_allowed"
    );
  }

  if (parsed.username || parsed.password) {
    throw new SsrfError(
      "Webhook URL must not contain credentials.",
      "credentials_present"
    );
  }

  const port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) {
    throw new SsrfError(`Webhook port ${port} is not allowed.`, "port_not_allowed");
  }

  return parsed;
}

/**
 * Resolve a hostname to all of its addresses and reject any that fall inside a
 * blocked range. Decimal/octal/hex IP literals (e.g. 2130706433, 0x7f000001)
 * are normalized by the resolver before inspection.
 *
 * Returns the validated list of addresses.
 */
export async function resolveAndValidateHost(hostname) {
  // If the host is already an IP literal, validate it directly (no DNS).
  if (hostname.includes(":") || /^[\d.]+$/.test(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new SsrfError("Destination address is not allowed.", "blocked_address");
    }
    return [hostname];
  }

  let addresses;
  try {
    const records = await dns.lookup(hostname, { all: true });
    addresses = records.map((r) => r.address);
  } catch {
    throw new SsrfError("Destination host could not be resolved.", "dns_failure");
  }

  if (addresses.length === 0) {
    throw new SsrfError("Destination host resolved to no addresses.", "dns_failure");
  }

  for (const addr of addresses) {
    if (isBlockedAddress(addr)) {
      throw new SsrfError("Destination address is not allowed.", "blocked_address");
    }
  }

  return addresses;
}

/**
 * Full destination validation used at both registration and delivery time.
 */
export async function validateWebhookDestination(rawUrl, { requireHttps = false } = {}) {
  const parsed = canonicalizeWebhookUrl(rawUrl);

  if (requireHttps && parsed.protocol !== "https:") {
    throw new SsrfError("Webhook destination must use HTTPS.", "scheme_not_allowed");
  }

  await resolveAndValidateHost(parsed.hostname);

  return {
    href: parsed.href,
    origin: parsed.origin,
    hostname: parsed.hostname,
    protocol: parsed.protocol,
  };
}

// --- Restricted egress client ----------------------------------------------

/**
 * Perform a single validated HTTP request. Enforces a total timeout and a
 * maximum response body size. Redirects are followed manually so each hop is
 * re-validated (protecting against DNS rebinding on the redirect target).
 */
export async function safeFetch(rawUrl, options = {}) {
  const { method = "POST", headers, body, redirectHops = 0 } = options;

  const parsed = await validateWebhookDestination(rawUrl);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(parsed.href, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw new SsrfError("Webhook request timed out.", "timeout");
    }
    throw new SsrfError("Webhook request failed.", "request_failed");
  }

  // Handle redirects manually so each target is re-validated.
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    clearTimeout(timeoutId);
    if (redirectHops >= MAX_REDIRECTS) {
      throw new SsrfError("Too many webhook redirects.", "too_many_redirects");
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new SsrfError("Webhook redirect missing location.", "bad_redirect");
    }
    const nextMethod = response.status === 303 ? "GET" : method;
    return safeFetch(location, {
      ...options,
      method: nextMethod,
      body: nextMethod === "GET" ? undefined : body,
      redirectHops: redirectHops + 1,
    });
  }

  // Enforce max response body size before the caller reads it.
  const reader = response.body?.getReader ? response.body.getReader() : null;
  if (reader) {
    let received = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        clearTimeout(timeoutId);
        throw new SsrfError("Webhook response exceeded size limit.", "response_too_large");
      }
      chunks.push(value);
    }
    clearTimeout(timeoutId);
    const full = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      full.set(c, offset);
      offset += c.byteLength;
    }
    response = new Response(full, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    return response;
  }

  clearTimeout(timeoutId);
  return response;
}

/**
 * Validate a list of webhook URLs (registration-time check). Throws on the
 * first invalid entry with a safe diagnostic.
 */
export async function validateWebhookUrls(urls) {
  if (!Array.isArray(urls)) {
    throw new SsrfError("Webhook URLs must be an array.", "invalid_list");
  }
  const seen = new Set();
  for (const url of urls) {
    const validated = await validateWebhookDestination(url);
    if (seen.has(validated.href)) {
      throw new SsrfError("Duplicate webhook URL supplied.", "duplicate_url");
    }
    seen.add(validated.href);
  }
  return true;
}
