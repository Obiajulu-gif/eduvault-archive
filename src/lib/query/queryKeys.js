export const queryKeys = {
  materials: {
    all: ['materials'],
    marketplace: (params) => ['materials', 'marketplace', params],
    trending: (params) => ['materials', 'trending', params],
    detail: (id) => ['materials', 'detail', id],
    user: (address) => ['materials', 'user', address],
  },
  profile: {
    all: ['profile'],
    detail: (address) => ['profile', 'detail', address],
    activity: (address) => ['profile', 'activity', address],
    top: () => ['profile', 'top-creators'],
  },
  purchases: {
    all: ['purchases'],
    history: (address) => ['purchases', 'history', address],
    entitlement: (materialId, address) => ['purchases', 'entitlement', materialId, address],
  },
  dashboard: {
    stats: (address) => ['dashboard', 'stats', address],
    metrics: (address, timeframe) => ['dashboard', 'metrics', address, timeframe],
  }
};

