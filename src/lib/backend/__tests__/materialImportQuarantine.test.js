import { describe, expect, it } from 'vitest';
import { validateImportRow } from '../materialImport.js';
import { isReadyToPublish } from '../../publishing/checklist.js';
import { QUARANTINE_STATES } from '../../publishing/quarantine.js';

describe('Material Import Quarantine Gate (#600)', () => {
  it('proves an imported record claiming an un-scanned storageKey cannot reach a published/checklist-ready state', () => {
    const rawRow = {
      title: 'Unscanned Material',
      storageKey: 'unscanned/key/file123.pdf',
      price: 10,
      quarantineState: 'clean', // Attempt spoof
    };

    const rowValidation = validateImportRow(rawRow, 0);
    expect(rowValidation.valid).toBe(true);

    const importedDoc = {
      ...rowValidation.data,
      userAddress: '0x123',
      quarantineState: QUARANTINE_STATES.PENDING, // Enrolled as pending unless verified clean server-side
      contentManifestHash: null,
      contentManifestGeneration: null,
    };

    const publishCheck = isReadyToPublish(importedDoc);
    expect(publishCheck.ready).toBe(false);
    expect(publishCheck.missingRequired).toContain('quarantine');
    expect(publishCheck.missingRequired).toContain('contentManifest');
  });

  it('allows an imported record referencing a verified clean quarantine record to be checklist ready', () => {
    const rawRow = {
      title: 'Scanned Material',
      storageKey: 'clean/key/file456.pdf',
      price: 10,
    };

    const rowValidation = validateImportRow(rawRow, 0);
    expect(rowValidation.valid).toBe(true);

    const importedDoc = {
      ...rowValidation.data,
      userAddress: '0x123',
      quarantineState: QUARANTINE_STATES.CLEAN,
      contentManifestHash: '0xmanifest123',
      contentManifestGeneration: 1,
    };

    const publishCheck = isReadyToPublish(importedDoc);
    expect(publishCheck.ready).toBe(true);
    expect(publishCheck.missingRequired).toHaveLength(0);
  });
});
