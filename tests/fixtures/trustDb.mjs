// Small Mongo contract fake: deterministic IDs, duplicate keys and compare-and-swap.
export function fakeDb() {
  const collections = new Map();
  return { collection(name) {
    if (!collections.has(name)) {
      const rows = [];
      const matches = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value);
      collections.set(name, { rows,
        async insertOne(row) {
          if (rows.some(r => r._id === row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
          rows.push(structuredClone(row));
        },
        async findOne(filter) { return structuredClone(rows.find(r => matches(r, filter)) || null); },
        async updateOne(filter, update) {
          const row = rows.find(r => matches(r, filter));
          if (!row) return { modifiedCount: 0 };
          Object.assign(row, structuredClone(update.$set || {}));
          for (const [key, value] of Object.entries(update.$push || {})) (row[key] ||= []).push(structuredClone(value));
          return { modifiedCount: 1 };
        },
      });
    }
    return collections.get(name);
  } };
}
