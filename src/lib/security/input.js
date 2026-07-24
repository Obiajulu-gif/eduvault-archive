const CONTROL_AND_BIDI_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
const PRIVATE_IPV4 = /^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const SAFE_FILE_CHARS = /[^\p{L}\p{N}._()\- ]/gu;

export const REMOTE_IMAGE_HOSTS = Object.freeze([
  "gateway.pinata.cloud",
  "ipfs.io",
  "www.gravatar.com",
]);

function configuredImageHost() {
  try {
    return new URL(process.env.NEXT_PUBLIC_GATEWAY_URL).hostname;
  } catch {
    return null;
  }
}

export function normalizePlainText(value, { maxLength = 5000 } = {}) {
  if (value === undefined || value === null) return "";
  return String(value)
    .normalize("NFKC")
    .replace(CONTROL_AND_BIDI_CHARS, "")
    .replaceAll("<", "＜")
    .replaceAll(">", "＞")
    .trim()
    .slice(0, maxLength);
}

function isPublicHostname(hostname) {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  return lower.includes(".") && lower !== "localhost" && !lower.endsWith(".localhost") &&
    !lower.endsWith(".local") && !PRIVATE_IPV4.test(lower) && !lower.startsWith("[");
}

export function normalizeExternalUrl(
  value,
  { allowedHosts, allowSubdomains = false, maxLength = 2048 } = {},
) {
  const clean = normalizePlainText(value, { maxLength });
  if (!clean) return null;

  let url;
  try {
    url = new URL(clean);
  } catch {
    throw new TypeError("URL must be absolute");
  }

  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new TypeError("URL must use public HTTPS without credentials or a custom port");
  }
  if (!isPublicHostname(url.hostname)) throw new TypeError("URL host is not public");

  if (allowedHosts?.length) {
    const hostname = url.hostname.toLowerCase();
    const allowed = allowedHosts.some((candidate) => hostname === candidate.toLowerCase() ||
      (allowSubdomains && hostname.endsWith(`.${candidate.toLowerCase()}`)));
    if (!allowed) throw new TypeError("URL host is not allowlisted");
  }

  url.hash = "";
  return url.toString();
}

export function normalizeRemoteImageUrl(value) {
  const clean = normalizePlainText(value, { maxLength: 2048 });
  if (!clean) return null;
  if (clean.startsWith("/") && !clean.startsWith("//") && !clean.includes("\\")) {
    if (/\.svg(?:$|[?#])/i.test(clean)) {
      throw new TypeError("SVG is not accepted as user-controlled media");
    }
    return clean;
  }
  const url = normalizeExternalUrl(value, {
    allowedHosts: [...REMOTE_IMAGE_HOSTS, configuredImageHost()].filter(Boolean),
  });
  if (/\.svg(?:$|[?#])/i.test(url)) {
    throw new TypeError("SVG is not accepted as user-controlled media");
  }
  return url;
}

export function normalizeRedirectPath(value, { fallback = "/" } = {}) {
  const clean = normalizePlainText(value, { maxLength: 2048 });
  if (!clean.startsWith("/") || clean.startsWith("//") || clean.includes("\\")) return fallback;
  try {
    const url = new URL(clean, "https://eduvault.invalid");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function normalizeDownloadFilename(value, { fallback = "download", maxLength = 160 } = {}) {
  const basename = normalizePlainText(value, { maxLength: maxLength * 2 })
    .replaceAll("\\", "/")
    .split("/")
    .pop().replace(SAFE_FILE_CHARS, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, maxLength);
  return basename || fallback;
}

export function contentDispositionAttachment(filename) {
  const safe = normalizeDownloadFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
