import { describe, it, expect } from 'vitest';
import { sniffMimeType, checkDecompressionSafety, inspectUploadedFile } from '../securityScanner.js';

describe('Upload Security Scanner', () => {
  it('sniffs PDF magic bytes correctly', () => {
    const pdfBuf = Buffer.from('%PDF-1.4 test content');
    expect(sniffMimeType(pdfBuf)).toBe('application/pdf');
  });

  it('detects hidden executables disguised with pdf extension', () => {
    const exeBuf = Buffer.from([0x4D, 0x5A, 0x90, 0x00]); // MZ executable header
    expect(sniffMimeType(exeBuf)).toBe('application/x-executable');
  });

  it('rejects zip bombs with extreme decompression ratios', () => {
    const res = checkDecompressionSafety(100, 100000); // 1000:1 ratio
    expect(res.safe).toBe(false);
    expect(res.reason).toContain('exceeds safety limit');
  });

  it('quarantines malicious uploads and provides appeal URL', async () => {
    const eicarBuf = Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE');
    const result = await inspectUploadedFile({
      buffer: eicarBuf,
      originalFilename: 'malware.pdf',
      declaredMimeType: 'application/pdf'
    });

    expect(result.accepted).toBe(false);
    expect(result.status).toBe('quarantined');
    expect(result.appealUrl).toBe('/support/appeals');
  });
});
