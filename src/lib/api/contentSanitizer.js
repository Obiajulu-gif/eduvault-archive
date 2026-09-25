// Issue #649: sanitization for any future rendering of creator-supplied
// rich content.
//
// Current state (verified): no rendering path in this app injects raw HTML
// from user/creator content today — src/app/layout.js's one
// dangerouslySetInnerHTML usage is a static theme-init script literal, and
// preview components (PreviewBlock.jsx, PreviewStat.jsx) render user
// strings as plain JSX text, which React escapes by default. This module
// exists as the defense-in-depth layer for when rich text/HTML rendering
// IS added (the upload route's `properties` payload is already free-form),
// so a sanitizer with real test coverage against the concrete adversarial
// formats named in the issue exists before that rendering path does,
// rather than being retrofitted after an incident.

import sanitizeHtml from 'sanitize-html';

// Deliberately conservative: only inline text-formatting tags survive.
// No <script>, <object>, <embed>, <iframe>, <svg>, <style>, or <form> —
// SVG in particular can carry its own <script>/onload, and object/embed
// can point at arbitrary content types (including PDFs with embedded
// JavaScript actions).
const ALLOWED_TAGS = ['b', 'strong', 'i', 'em', 'u', 'p', 'br', 'ul', 'ol', 'li', 'a', 'code', 'pre'];

const ALLOWED_ATTRIBUTES = {
  a: ['href', 'title', 'rel'],
};

// Only these URL schemes are ever allowed in an href/src — blocks
// javascript:, data: (which can carry an inline HTML/SVG payload that
// re-triggers script execution when navigated to), vbscript:, and file:.
const ALLOWED_SCHEMES = ['http', 'https', 'mailto'];

export function sanitizeRichText(input) {
  if (typeof input !== 'string' || input.length === 0) return '';

  return sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ALLOWED_SCHEMES,
    allowedSchemesByTag: {},
    allowProtocolRelative: false,
    // Every surviving <a> gets rel="noopener noreferrer nofollow" and
    // target enforcement is left to the renderer — this only strips what's
    // dangerous, it doesn't add navigation behavior.
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }, true),
    },
    // Disallow any attribute not explicitly listed above, on any tag —
    // this is what actually blocks DOM-clobbering vectors like id="body"
    // or name="location", since those attributes are stripped from every
    // tag regardless of tag name.
    disallowedTagsMode: 'discard',
    enforceHtmlBoundary: true,
  });
}

/**
 * A narrower check for a single URL value (not a full HTML fragment) — for
 * fields like a "website" or "cover image" URL that should never be free
 * HTML but do need scheme validation, since `javascript:` or `data:` in an
 * href is exploitable even without any surrounding HTML.
 */
export function isSafeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return false;

  // A scheme-relative URL ("//evil.com") or a bare relative path is
  // treated as safe only when there's genuinely no scheme to abuse;
  // anything with an explicit scheme must be on the allowlist.
  const schemeMatch = rawUrl.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) {
    // No scheme at all (a relative path) is fine; a protocol-relative URL
    // ("//host/path") is rejected since its effective scheme is
    // ambient/inherited and can't be verified here.
    return !rawUrl.startsWith('//');
  }

  const scheme = schemeMatch[1].toLowerCase();
  return ALLOWED_SCHEMES.includes(scheme);
}
