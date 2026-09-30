import { describe, expect, it } from 'vitest';
import {
  assertMarketplaceLoadBudget,
  browseMarketplaceDataset,
  createMarketplaceLoadDataset,
} from '../src/lib/backend/marketplaceLoadSuite.js';

describe('marketplace load and catalog browsing suite', () => {
  it('generates a deterministic marketplace-sized fixture', () => {
    const dataset = createMarketplaceLoadDataset({ size: 1000 });

    expect(dataset).toHaveLength(1000);
    expect(dataset[0]).toMatchObject({
      _id: 'material-0',
      visibility: 'public',
      category: 'math',
    });
    expect(dataset[999]._id).toBe('material-999');
  });

  it('keeps search and multi-page browsing inside the local budget', () => {
    const dataset = createMarketplaceLoadDataset({ size: 5000 });
    const result = browseMarketplaceDataset(dataset, {
      search: 'biology',
      category: 'science',
      pageSize: 24,
      pages: 20,
    });
    const budget = assertMarketplaceLoadBudget(result, {
      maxDurationMs: 300,
      minMatchedItems: 100,
    });

    expect(budget.ok).toBe(true);
    expect(budget.visitedPages).toBe(20);
    expect(budget.firstResultId).toMatch(/^material-/);
  });
});
