import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  AllowlistError,
  validateUrlScheme,
  validateFileTypeByMime,
  validateUploadDestination,
  getAllowlistConfig,
  ALLOWED_FILE_TYPES,
} from '../allowlist.js';

describe('Allowlist Validation', () => {
  describe('validateUrlScheme', () => {
    it('should allow http and https URLs', () => {
      const httpsUrl = validateUrlScheme('https://example.com/file.pdf');
      assert.match(httpsUrl, /^https:/);

      const httpUrl = validateUrlScheme('http://example.com/file.pdf');
      assert.match(httpUrl, /^http:/);
    });

    it('should allow ipfs and ipns URLs', () => {
      const ipfsUrl = validateUrlScheme('ipfs://QmXxxx');
      assert.match(ipfsUrl, /^ipfs:/);

      const ipnsUrl = validateUrlScheme('ipns://k2k4r8l...');
      assert.match(ipnsUrl, /^ipns:/);
    });

    it('should reject javascript: scheme', () => {
      assert.throws(
        () => validateUrlScheme('javascript:alert(1)'),
        AllowlistError
      );
    });

    it('should reject data: scheme', () => {
      assert.throws(
        () => validateUrlScheme('data:text/html,<script>alert(1)</script>'),
        AllowlistError
      );
    });

    it('should reject file: scheme', () => {
      assert.throws(
        () => validateUrlScheme('file:///etc/passwd'),
        AllowlistError
      );
    });

    it('should handle empty or null URLs gracefully', () => {
      assert.doesNotThrow(() => validateUrlScheme(null));
      assert.doesNotThrow(() => validateUrlScheme(''));
      assert.doesNotThrow(() => validateUrlScheme(undefined));
    });

    it('should trim and normalize URLs', () => {
      const url = validateUrlScheme('  HTTPS://EXAMPLE.COM  ');
      assert.match(url, /^https:/);
    });
  });

  describe('validateFileTypeByMime', () => {
    it('should allow document types', () => {
      assert.doesNotThrow(() =>
        validateFileTypeByMime('application/pdf', 'documents')
      );
      assert.doesNotThrow(() =>
        validateFileTypeByMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'documents')
      );
    });

    it('should allow video types', () => {
      assert.doesNotThrow(() =>
        validateFileTypeByMime('video/mp4', 'videos')
      );
      assert.doesNotThrow(() =>
        validateFileTypeByMime('video/webm', 'videos')
      );
    });

    it('should allow image types', () => {
      assert.doesNotThrow(() =>
        validateFileTypeByMime('image/jpeg', 'images')
      );
      assert.doesNotThrow(() =>
        validateFileTypeByMime('image/png', 'images')
      );
    });

    it('should reject executable types', () => {
      assert.throws(
        () => validateFileTypeByMime('application/x-msdownload', 'documents'),
        AllowlistError
      );
      assert.throws(
        () => validateFileTypeByMime('application/x-executable', 'documents'),
        AllowlistError
      );
    });

    it('should reject script types', () => {
      assert.throws(
        () => validateFileTypeByMime('application/x-sh', 'documents'),
        AllowlistError
      );
      assert.throws(
        () => validateFileTypeByMime('text/x-python', 'documents'),
        AllowlistError
      );
    });

    it('should accept types in all category', () => {
      assert.doesNotThrow(() =>
        validateFileTypeByMime('application/pdf', 'all')
      );
      assert.doesNotThrow(() =>
        validateFileTypeByMime('video/mp4', 'all')
      );
      assert.doesNotThrow(() =>
        validateFileTypeByMime('image/png', 'all')
      );
    });

    it('should reject unknown categories', () => {
      assert.throws(
        () => validateFileTypeByMime('application/pdf', 'unknown'),
        AllowlistError
      );
    });
  });

  describe('validateUploadDestination', () => {
    it('should allow pinata destination', () => {
      const dest = validateUploadDestination('pinata');
      assert.strictEqual(dest, 'pinata');
    });

    it('should allow ipfs destination', () => {
      const dest = validateUploadDestination('ipfs');
      assert.strictEqual(dest, 'ipfs');
    });

    it('should normalize case', () => {
      const dest = validateUploadDestination('PINATA');
      assert.strictEqual(dest, 'pinata');
    });

    it('should reject unknown destinations', () => {
      assert.throws(
        () => validateUploadDestination('s3'),
        AllowlistError
      );
      assert.throws(
        () => validateUploadDestination('azure'),
        AllowlistError
      );
    });

    it('should support custom allowed list', () => {
      assert.doesNotThrow(() =>
        validateUploadDestination('arweave', { allowed: ['arweave', 'pinata'] })
      );
    });

    it('should reject empty destination', () => {
      assert.throws(
        () => validateUploadDestination(''),
        AllowlistError
      );
    });
  });

  describe('getAllowlistConfig', () => {
    it('should return complete allowlist configuration', () => {
      const config = getAllowlistConfig();

      assert(config.urlSchemes);
      assert(config.fileTypes);
      assert(config.destinations);
      assert(config.imageMimeTypes);
      assert(config.videoMimeTypes);
      assert(config.documentMimeTypes);
    });

    it('should include http and https in URL schemes', () => {
      const config = getAllowlistConfig();
      assert(config.urlSchemes.includes('http://'));
      assert(config.urlSchemes.includes('https://'));
    });

    it('should include ipfs support', () => {
      const config = getAllowlistConfig();
      assert(config.urlSchemes.includes('ipfs://'));
      assert(config.destinations.includes('ipfs'));
    });
  });

  describe('ALLOWED_FILE_TYPES export', () => {
    it('should have distinct file type categories', () => {
      assert(ALLOWED_FILE_TYPES.documents.length > 0);
      assert(ALLOWED_FILE_TYPES.videos.length > 0);
      assert(ALLOWED_FILE_TYPES.images.length > 0);
      assert(ALLOWED_FILE_TYPES.archives.length > 0);
    });

    it('should have comprehensive all category', () => {
      const allCount = ALLOWED_FILE_TYPES.all.length;
      assert(allCount >= 11); // at least covers all categories
    });
  });
});
