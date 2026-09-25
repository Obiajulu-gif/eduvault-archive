// Tests for issue #430: API route that receives file uploads, validates them,
// and pins them to IPFS via Pinata, returning the resulting CID (storageKey).
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the Pinata client so no real network/IPFS calls occur.
const uploadFile = vi.fn();
const uploadJson = vi.fn();
const convert = vi.fn();

vi.mock('@/lib/pinata', () => ({
  pinata: {
    upload: { public: { file: (...a) => uploadFile(...a), json: (...a) => uploadJson(...a) } },
    gateways: { public: { convert: (...a) => convert(...a) } },
  },
}));

// Bypass rate-limiting / hardening wrapper — just run the handler.
vi.mock('@/lib/api/hardening', () => ({
  withApiHardening: async (_req, _opts, handler) => handler(),
}));

vi.mock('@/lib/api/audit', () => ({ auditLog: vi.fn() }));

import { POST as UploadToIpfs } from '../../src/app/api/upload/route.js';

function makeFile(bytes, type, name) {
  return new File([new Uint8Array(bytes)], name, { type });
}

// Build a minimal request stub. The route only ever calls request.formData(),
// so we return a prepared FormData directly and avoid undici multipart
// serialization (which hangs on File bodies under the jsdom environment).
function formRequest(fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.append(k, v);
  }
  return { method: 'POST', headers: new Headers(), formData: async () => form };
}

describe('POST /api/upload (pin to IPFS via Pinata) — issue #430', () => {
  beforeEach(() => {
    uploadFile.mockReset();
    uploadJson.mockReset();
    convert.mockReset();
  });

  it('rejects a request with no file (400)', async () => {
    const res = await UploadToIpfs(formRequest({ title: 'Notes' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/no document file/i);
  });

  it('rejects an unsupported file type (415)', async () => {
    const file = makeFile(100, 'application/x-msdownload', 'evil.exe');
    const res = await UploadToIpfs(formRequest({ file, title: 'Notes' }));
    expect(res.status).toBe(415);
  });

  it('rejects a file over the 10MB size limit (413)', async () => {
    const big = { size: 11 * 1024 * 1024, type: 'application/pdf', name: 'big.pdf', arrayBuffer: async () => new ArrayBuffer(0) };
    // FormData coerces non-File objects to strings, so pass a real oversized File.
    const file = makeFile(11 * 1024 * 1024, 'application/pdf', 'big.pdf');
    void big;
    const res = await UploadToIpfs(formRequest({ file, title: 'Notes' }));
    expect(res.status).toBe(413);
  });

  it('pins a valid PDF to Pinata and returns the CID as storageKey', async () => {
    uploadFile.mockResolvedValue({ cid: 'bafyDOC123' });
    uploadJson.mockResolvedValue({ cid: 'bafyMETA456' });
    convert.mockImplementation(async (cid) => `https://gw.example/ipfs/${cid}`);

    const file = makeFile(2048, 'application/pdf', 'lecture.pdf');
    const res = await UploadToIpfs(
      formRequest({ file, title: 'Lecture Notes', description: 'Week 1', price: '5' })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.storageKey).toBe('bafyDOC123');
    expect(data.fileUrl).toBe('https://gw.example/ipfs/bafyDOC123');
    expect(data.metadata).toBe('https://gw.example/ipfs/bafyMETA456');
    // Document file pinned + metadata JSON pinned.
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadJson).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the Pinata upload fails after retries', async () => {
    uploadFile.mockRejectedValue(new Error('pinata down'));
    const file = makeFile(1024, 'application/pdf', 'lecture.pdf');
    const res = await UploadToIpfs(formRequest({ file, title: 'Lecture Notes' }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toMatch(/failed to upload document/i);
  });
});
