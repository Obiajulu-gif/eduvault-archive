// Only these URL schemes are ever allowed in an href/src — blocks
// javascript:, data: (which can carry an inline HTML/SVG payload that
// re-triggers script execution when navigated to), vbscript:, and file:.
export const ALLOWED_SCHEMES = ['http', 'https', 'mailto'];

/**
 * A narrower check for a single URL value (not a full HTML fragment) — for
 * fields like a "website" or "cover image" URL that should never be free
 * HTML but do need scheme validation, since `javascript:` or `data:` in an
 * href is exploitable even without any surrounding HTML.
 */
// Parsing against a throwaway base lets the WHATWG URL parser apply the same
// normalization a browser does (stripping leading C0/space and embedded
// tab/newline, treating "\" as "/"), so "java\tscript:" or " javascript:"
// can't slip past a regex that sees a different string than the browser.
const RELATIVE_BASE = 'https://relative.invalid';

export function isSafeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return false;

  let url;
  try {
    url = new URL(rawUrl, RELATIVE_BASE);
  } catch {
    return false;
  }

  // Resolved onto the base: a genuine relative path, no scheme to abuse.
  if (url.origin === RELATIVE_BASE) return true;

  if (!ALLOWED_SCHEMES.includes(url.protocol.slice(0, -1))) return false;

  // A protocol-relative URL ("//host", "\\host") picks up an ambient scheme
  // and points off-site, so the scheme must be written out explicitly.
  const normalized = rawUrl.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+/, '');
  return /^[a-z][a-z0-9+.-]*:/i.test(normalized);
}

/**
 * Anchor props for a user-supplied outbound link. Returns null when the URL
 * isn't an absolute http(s) URL so callers render plain text instead of a
 * link. Opens in a new tab without handing the opener or referrer to the
 * destination, and marks it nofollow so user links don't borrow our ranking.
 */
export function safeExternalLinkProps(rawUrl) {
  if (!isSafeUrl(rawUrl)) return null;
  const href = rawUrl.trim();
  if (!/^https?:\/\//i.test(href)) return null;
  return { href, target: '_blank', rel: 'noopener noreferrer nofollow' };
}
