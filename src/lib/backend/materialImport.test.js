import { describe, expect, it } from 'vitest';
import { planImport, publicPlanRows, validateImportPayload } from './materialImport';

const validate = (records) => validateImportPayload({ dryRun: true, records });

describe('material import preview planning', () => {
  it('plans valid rows for create, update, and skip without mutating input records', () => {
    const existing = [
      { _id: 'material-1', externalId: 'update-me', storageKey: 'ipfs://one', title: 'Old title' },
      { _id: 'material-2', externalId: 'same', storageKey: 'ipfs://two', title: 'Same title' },
    ];
    const result = planImport(validate([
      { externalId: 'new', title: 'New title', storageKey: 'ipfs://new' },
      { externalId: 'update-me', title: 'New title', storageKey: 'ipfs://one' },
      { title: 'Same title', storageKey: 'ipfs://two' },
    ]), existing);

    expect(result.summary).toEqual({ create: 1, update: 1, skip: 1, duplicate: 0, error: 0 });
    expect(result.rows.map(({ action }) => action)).toEqual(['create', 'update', 'skip']);
  });

  it('reports duplicate rows and storage-key conflicts with only safe conflict metadata', () => {
    const result = planImport(validate([
      { externalId: 'first', title: 'Secret first title', storageKey: 'ipfs://first' },
      { externalId: 'first', title: 'Secret duplicate title', storageKey: 'ipfs://second' },
      { externalId: 'new', title: 'Secret colliding title', storageKey: 'ipfs://owned' },
    ]), [
      { _id: 'owned-material', externalId: 'owned', storageKey: 'ipfs://owned', title: 'Secret existing title' },
    ]);
    const rows = publicPlanRows(result.rows);

    expect(result.summary).toEqual({ create: 1, update: 0, skip: 1, duplicate: 1, error: 1 });
    expect(rows[1].conflict).toEqual({ type: 'duplicate_in_batch', field: 'externalId', firstRow: 1 });
    expect(rows[2].conflict).toEqual({ type: 'existing_storage_key', field: 'storageKey' });
    expect(JSON.stringify(rows)).not.toMatch(/Secret|record|previous/);
  });

  it('returns actionable errors for invalid rows and duplicate counts stay separate', () => {
    const result = planImport(validate([
      { title: '', storageKey: 'ipfs://empty-title' },
      { title: 'No storage key' },
    ]));

    expect(result.summary).toEqual({ create: 0, update: 0, skip: 0, duplicate: 0, error: 2 });
    expect(result.rows.map((row) => row.errors[0].field)).toEqual(['title', 'storageKey']);
    expect(result.rows.every((row) => row.errors[0].message.length > 0)).toBe(true);
  });
});
