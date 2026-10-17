import { describe, expect, it } from 'vitest';
import {
  EvidenceBundleError,
  FREE_TEXT_MARKER,
  GENESIS_HASH,
  SECRET_MARKER,
  buildEvidenceBundle,
  createRedactor,
  verifyEvidenceBundle,
} from '../audit/evidenceBundle.js';

const KEY = 'k'.repeat(48);
const WALLET = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
// Secret-shaped fixtures are assembled at runtime so secret scanners don't
// flag this file.
const SEED = `S${WALLET.slice(1)}`;
const TX_HASH = 'a'.repeat(64);
const JWT = ['eyJ' + 'a'.repeat(12), 'b'.repeat(16), 'c'.repeat(16)].join('.');

function sampleEvents() {
  return [
    {
      _id: 'evt-2',
      type: 'purchase.confirmed',
      createdAt: '2026-10-01T10:05:00.000Z',
      purchaseId: 'pur-1',
      materialId: 'mat-9',
      buyerWallet: WALLET,
      txHash: TX_HASH,
      amount: '12.50',
      asset: 'USDC',
      signedXdr: 'AAAAAgAAAAB...',
    },
    {
      _id: 'evt-1',
      type: 'checkout.initiated',
      createdAt: '2026-10-01T10:00:00.000Z',
      purchaseId: 'pur-1',
      email: 'learner@example.com',
      authorization: `Bearer ${JWT}`,
      note: 'my phone is 555-0100, please call',
      meta: { userAgent: 'Mozilla/5.0', ip: '10.0.0.1', debug: `seed was ${SEED}` },
    },
  ];
}

describe('evidence bundles (#943)', () => {
  it('redacts secrets and PII but keeps ids, hashes, amounts and timestamps', () => {
    const bundle = buildEvidenceBundle({
      investigationId: 'SUP-1001',
      events: sampleEvents(),
      bundleKey: KEY,
      requestedBy: { id: 'agent-7', role: 'support_agent', email: 'agent@eduvault.io' },
      now: '2026-10-02T00:00:00.000Z',
    });

    const text = JSON.stringify(bundle);
    expect(text).not.toContain(WALLET);
    expect(text).not.toContain(SEED);
    expect(text).not.toContain(JWT);
    expect(text).not.toContain('learner@example.com');
    expect(text).not.toContain('agent@eduvault.io');
    expect(text).not.toContain('555-0100');
    expect(text).not.toContain('10.0.0.1');
    expect(text).not.toContain('AAAAAgAAAAB');

    const [first, second] = bundle.entries;
    expect(first.eventId).toBe('evt-1'); // chronological
    expect(first.payload.authorization).toBe(SECRET_MARKER);
    expect(first.payload.note).toBe(FREE_TEXT_MARKER);
    expect(first.payload.email).toMatch(/^pii:[a-f0-9]{16}$/);
    expect(first.payload.meta.debug).toContain(SECRET_MARKER);

    expect(second.payload.txHash).toBe(TX_HASH);
    expect(second.payload.purchaseId).toBe('pur-1');
    expect(second.payload.amount).toBe('12.50');
    expect(second.payload.signedXdr).toBe(SECRET_MARKER);
    expect(second.occurredAt).toBe('2026-10-01T10:05:00.000Z');

    expect(bundle.manifest.requestedBy).toEqual({ id: 'agent-7', role: 'support_agent' });
    expect(bundle.manifest.window).toEqual({
      from: '2026-10-01T10:00:00.000Z',
      to: '2026-10-01T10:05:00.000Z',
    });
    expect(verifyEvidenceBundle(bundle)).toEqual({ valid: true, errors: [] });
  });

  it('produces stable pseudonyms within a bundle and unlinkable ones across keys', () => {
    const a = createRedactor(KEY);
    expect(a.pseudonym(WALLET)).toBe(a.pseudonym(` ${WALLET.toLowerCase()} `));
    const b = createRedactor('z'.repeat(48));
    expect(a.pseudonym(WALLET)).not.toBe(b.pseudonym(WALLET));
  });

  it('is deterministic for the same inputs regardless of input order', () => {
    const args = { investigationId: 'SUP-1', bundleKey: KEY, now: '2026-10-02T00:00:00Z' };
    const one = buildEvidenceBundle({ ...args, events: sampleEvents() });
    const two = buildEvidenceBundle({ ...args, events: sampleEvents().reverse() });
    expect(one.manifest.rootHash).toBe(two.manifest.rootHash);
    expect(one.manifestHash).toBe(two.manifestHash);
  });

  it('detects tampering, reordering and dropped entries', () => {
    const build = () =>
      buildEvidenceBundle({ investigationId: 'SUP-2', events: sampleEvents(), bundleKey: KEY });

    const edited = build();
    edited.entries[1].payload.amount = '0.01';
    expect(verifyEvidenceBundle(edited).errors).toContain('entry_hash_mismatch:1');

    const reordered = build();
    reordered.entries.reverse();
    expect(verifyEvidenceBundle(reordered).valid).toBe(false);

    const dropped = build();
    dropped.entries.pop();
    const result = verifyEvidenceBundle(dropped);
    expect(result.errors).toEqual(expect.arrayContaining(['event_count_mismatch', 'root_hash_mismatch']));

    const manifest = build();
    manifest.manifest.investigationId = 'SUP-OTHER';
    expect(verifyEvidenceBundle(manifest).errors).toContain('manifest_hash_mismatch');
  });

  it('flags leaked secrets that were smuggled into a bundle', () => {
    const bundle = buildEvidenceBundle({ investigationId: 'SUP-3', events: sampleEvents(), bundleKey: KEY });
    bundle.entries[0].payload.extra = WALLET;
    const result = verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('leak_detected'))).toBe(true);
  });

  it('proves entries match source rows when the operator holds the key', () => {
    const events = sampleEvents();
    const bundle = buildEvidenceBundle({ investigationId: 'SUP-4', events, bundleKey: KEY });
    expect(verifyEvidenceBundle(bundle, { bundleKey: KEY, sourceEvents: events }).valid).toBe(true);

    const altered = sampleEvents();
    altered[0].amount = '99.00';
    expect(verifyEvidenceBundle(bundle, { bundleKey: KEY, sourceEvents: altered }).errors).toContain(
      'source_mismatch:evt-2'
    );
    expect(
      verifyEvidenceBundle(bundle, { bundleKey: 'q'.repeat(48), sourceEvents: events }).errors
    ).toContain('bundle_key_mismatch');
  });

  it('fails closed on invalid input and supports explicit partial exports', () => {
    expect(() => buildEvidenceBundle({ investigationId: 'X', events: [], bundleKey: 'short' })).toThrow(
      EvidenceBundleError
    );
    expect(() => buildEvidenceBundle({ events: [], bundleKey: KEY })).toThrow(/investigationId/);
    expect(() =>
      buildEvidenceBundle({ investigationId: 'X', events: [{}, {}], bundleKey: KEY, maxEvents: 1 })
    ).toThrow(/limit 1/);

    const bad = [...sampleEvents(), { _id: 'evt-3', createdAt: 'not-a-date' }, { _id: 'evt-1', createdAt: '2026-10-01T00:00:00Z' }];
    expect(() => buildEvidenceBundle({ investigationId: 'X', events: bad, bundleKey: KEY })).toThrow(
      /missing_or_invalid_timestamp/
    );

    const partial = buildEvidenceBundle({ investigationId: 'X', events: bad, bundleKey: KEY, allowPartial: true });
    expect(partial.manifest.eventCount).toBe(2);
    expect(partial.omitted.map((o) => o.reason)).toEqual(['missing_or_invalid_timestamp', 'duplicate_event_id']);
    expect(verifyEvidenceBundle(partial).valid).toBe(true);
  });

  it('handles an empty investigation window', () => {
    const bundle = buildEvidenceBundle({ investigationId: 'SUP-0', events: [], bundleKey: KEY });
    expect(bundle.manifest.rootHash).toBe(GENESIS_HASH);
    expect(bundle.manifest.window).toBeNull();
    expect(verifyEvidenceBundle(bundle).valid).toBe(true);
  });
});
