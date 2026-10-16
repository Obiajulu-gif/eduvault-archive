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
import { ALLOWED_SCHEMES } from './safeUrl.js';

// Deliberately conservative: only inline text-formatting tags survive.
// No <script>, <object>, <embed>, <iframe>, <svg>, <style>, or <form> —
// SVG in particular can carry its own <script>/onload, and object/embed
// can point at arbitrary content types (including PDFs with embedded
// JavaScript actions).
const ALLOWED_TAGS = ['b', 'strong', 'i', 'em', 'u', 'p', 'br', 'ul', 'ol', 'li', 'a', 'code', 'pre'];

const ALLOWED_ATTRIBUTES = {
  a: ['href', 'title', 'rel'],
};


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

// URL checks live in safeUrl.js so client components can use them without
// bundling sanitize-html; re-exported here for existing server imports.
export { isSafeUrl, safeExternalLinkProps } from './safeUrl.js';
