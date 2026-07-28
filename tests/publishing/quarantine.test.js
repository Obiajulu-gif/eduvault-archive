import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getDb } from '@/lib/mongodb';
import {
  createQuarantineRecord,
  finalizeQuarantine,
  runScanner,
  getQuarantineDecision,
  verifyMaterialNotQuarantined,
  replayQuarantine,
  QUARANTINE_STATES,
  QUARANTINE_REASONS,
} from '@/lib/publishing/quarantine';

describe('quarantine', () => {
  let mongod;
  let db;

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    process.env.MONGODB_URI = uri;
    process.env.MONGODB_DB = 'test';
    db = await getDb();
  });

  afterEach(async () => {
    await mongod.stop();
  });

  it('creates a quarantine record in pending state', async () => {
    const record = await createQuarantineRecord({
      db,
      contentHash: 'hash-123',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: '0xabc',
    });

    expect(record.state).toBe(QUARANTINE_STATES.PENDING);
    expect(record.contentHash).toBe('hash-123');
    expect(record.expiresAt).toBeDefined();
  });

  it('finalizes to clean state', async () => {
    await createQuarantineRecord({
      db,
      contentHash: 'hash-123',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: '0xabc',
    });

    const result = await finalizeQuarantine({
      db,
      contentHash: 'hash-123',
      state: QUARANTINE_STATES.CLEAN,
      scanner: 'clamav',
      scanResult: { verdict: 'clean', engineVersion: '1.2.3' },
    });

    expect(result.state).toBe(QUARANTINE_STATES.CLEAN);
    expect(result.scanner).toBe('clamav');
  });

  it('finalizes to rejected on malware signature', async () => {
    await createQuarantineRecord({
      db,
      contentHash: 'hash-malware',
      fileName: 'bad.exe',
      mimeType: 'application/octet-stream',
      sizeBytes: 2048,
      uploaderAddress: '0xabc',
    });

    const result = await finalizeQuarantine({
      db,
      contentHash: 'hash-malware',
      state: QUARANTINE_STATES.REJECTED,
      reason: QUARANTINE_REASONS.MALWARE_SIGNATURE,
      scanResult: { verdict: 'infected', threats: ['Trojan.Test'] },
    });

    expect(result.state).toBe(QUARANTINE_STATES.REJECTED);
    expect(result.reason).toBe(QUARANTINE_REASONS.MALWARE_SIGNATURE);
  });

  it('blocks publication while pending', async () => {
    await createQuarantineRecord({
      db,
      contentHash: 'hash-123',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: '0xabc',
    });

    const decision = await verifyMaterialNotQuarantined(db, 'hash-123');
    expect(decision.allowed).toBe(false);
    expect(decision.state).toBe(QUARANTINE_STATES.PENDING);
  });

  it('allows publication after clean scan', async () => {
    await createQuarantineRecord({
      db,
      contentHash: 'hash-123',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: '0xabc',
    });

    await finalizeQuarantine({ db, contentHash: 'hash-123', state: QUARANTINE_STATES.CLEAN });
    const decision = await verifyMaterialNotQuarantined(db, 'hash-123');

    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe(QUARANTINE_STATES.CLEAN);
  });

  it('prevents reuse of scan results for changed bytes', async () => {
    await createQuarantineRecord({
      db,
      contentHash: 'hash-v1',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: '0xabc',
    });

    await finalizeQuarantine({ db, contentHash: 'hash-v1', state: QUARANTINE_STATES.CLEAN });

    // Different content hash is not covered by the prior scan.
    const decision = await verifyMaterialNotQuarantined(db, 'hash-v2');
    expect(decision.allowed).toBe(false);
    expect(decision.state).toBe(QUARANTINE_STATES.PENDING);
  });

  it('fails closed on scanner timeout', async () => {
    await createQuarantineRecord({
      db,
      contentHash: 'hash-timeout',
      fileName: 'big.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024 * 1024,
      uploaderAddress: '0xabc',
    });

    const scanner = {
      name: 'slow-scanner',
      scan: async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { infected: false };
      },
    };

    const result = await runScanner({
      db,
      contentHash: 'hash-timeout',
      fileName: 'big.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024 * 1024,
      scannerImpl: scanner,
      timeoutMs: 50,
    });

    expect(result.state).toBe(QUARANTINE_STATES.SCANNER_UNAVAILABLE);
    expect(result.reason).toBe(QUARANTINE_REASONS.SCANNER_TIMEOUT);
  });

  it('fails closed on scanner outage', async () => {
    await createQuarantineRecord({
      db,
      contentHash: 'hash-outage',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: '0xabc',
    });

    const scanner = {
      name: 'down-scanner',
      scan: async () => {
        throw new Error('Service unavailable');
      },
    };

    const result = await runScanner({
      db,
      contentHash: 'hash-outage',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      scannerImpl: scanner,
      timeoutMs: 1000,
    });

    expect(result.state).toBe(QUARANTINE_STATES.SCANNER_UNAVAILABLE);
  });

  it('replays quarantined items after outage recovery', async () => {
    await createQuarantineRecord({
      db,
      contentHash: 'hash-1',
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: '0xabc',
    });

    await createQuarantineRecord({
      db,
      contentHash: 'hash-2',
      fileName: 'b.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: '0xabc',
    });

    await finalizeQuarantine({ db, contentHash: 'hash-1', state: QUARANTINE_STATES.SCANNER_UNAVAILABLE });
    await finalizeQuarantine({ db, contentHash: 'hash-2', state: QUARANTINE_STATES.TIMEOUT });

    const replayed = await replayQuarantine(db, 100);
    expect(replayed).toContain('hash-1');
    expect(replayed).toContain('hash-2');

    const decision1 = await getQuarantineDecision(db, 'hash-1');
    expect(decision1.state).toBe(QUARANTINE_STATES.PENDING);
  });

  it('marks manual review when scanner requests human review', async () => {
    await createQuarantineRecord({
      db,
      contentHash: 'hash-review',
      fileName: 'suspicious.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: '0xabc',
    });

    const scanner = {
      name: 'smart-scanner',
      scan: async () => ({
        infected: false,
        requiresManualReview: true,
        notes: 'Heuristic alert: embedded JavaScript',
      }),
    };

    const result = await runScanner({
      db,
      contentHash: 'hash-review',
      fileName: 'suspicious.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      scannerImpl: scanner,
      timeoutMs: 1000,
    });

    expect(result.state).toBe(QUARANTINE_STATES.MANUAL_REVIEW);
    expect(result.reason).toBe(QUARANTINE_REASONS.MANUAL_REVIEW_REQUIRED);
  });
});