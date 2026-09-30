import { applyMarketplaceRelevanceRanking } from './marketplaceDiscovery.js';

const DEFAULT_SIZE = 5000;
const DEFAULT_PAGE_SIZE = 24;

export function createMarketplaceLoadDataset({ size = DEFAULT_SIZE, now = new Date('2026-01-01T00:00:00.000Z') } = {}) {
  return Array.from({ length: size }, (_, index) => {
    const category = ['math', 'science', 'history', 'language'][index % 4];
    const subject = ['algebra', 'biology', 'civics', 'writing'][index % 4];
    return {
      _id: `material-${index}`,
      title: `${subject} marketplace resource ${index}`,
      description: `Synthetic ${category} catalog entry for load and browsing tests`,
      shortSummary: `${subject} lesson notes`,
      author: `creator-${index % 50}`,
      subject,
      category,
      visibility: 'public',
      archived: false,
      moderationStatus: 'approved',
      price: (index % 20) + 1,
      rating: 3 + ((index % 20) / 10),
      likes: index % 1000,
      createdAt: new Date(now.getTime() - index * 60_000).toISOString(),
    };
  });
}

export function browseMarketplaceDataset(items, {
  search = '',
  category = '',
  pageSize = DEFAULT_PAGE_SIZE,
  pages = 10,
} = {}) {
  const startedAt = performance.now();
  const normalizedSearch = search.trim().toLowerCase();
  const normalizedCategory = category.trim().toLowerCase();

  let filtered = items;
  if (normalizedCategory) {
    filtered = filtered.filter((item) => item.category === normalizedCategory);
  }
  if (normalizedSearch) {
    filtered = filtered.filter((item) => {
      const text = `${item.title} ${item.description} ${item.subject} ${item.category}`.toLowerCase();
      return text.includes(normalizedSearch);
    });
  }

  const ranked = applyMarketplaceRelevanceRanking(filtered, normalizedSearch);
  const visitedPages = [];
  for (let page = 0; page < pages; page += 1) {
    visitedPages.push(ranked.slice(page * pageSize, (page + 1) * pageSize));
  }

  return {
    totalItems: items.length,
    matchedItems: ranked.length,
    visitedPages: visitedPages.length,
    pageSize,
    durationMs: performance.now() - startedAt,
    firstResultId: ranked[0]?._id || null,
  };
}

export function assertMarketplaceLoadBudget(result, { maxDurationMs = 250, minMatchedItems = 1 } = {}) {
  return {
    ok: result.durationMs <= maxDurationMs && result.matchedItems >= minMatchedItems,
    maxDurationMs,
    minMatchedItems,
    ...result,
  };
}
