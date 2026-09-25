/**
 * Minimal in-memory MongoDB-collection fake for the refund workflow tests
 * (Issue #27) — supports exactly the query/update shapes used by
 * src/lib/refunds/*.js, so state transitions, sorting, and the
 * partial-unique-index on `refunds.purchaseId` can be exercised without a
 * real database.
 */
import { ObjectId } from 'mongodb';

function toComparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

function valuesEqual(actual, expected) {
  if (actual instanceof ObjectId || expected instanceof ObjectId) {
    return String(actual) === String(expected);
  }
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  return actual === expected;
}

function matchValue(actual, cond) {
  if (
    cond &&
    typeof cond === 'object' &&
    !Array.isArray(cond) &&
    !(cond instanceof ObjectId) &&
    !(cond instanceof Date)
  ) {
    if ('$in' in cond) return cond.$in.some((v) => valuesEqual(actual, v));
    if ('$ne' in cond) return !valuesEqual(actual, cond.$ne);
    if ('$lt' in cond) return toComparable(actual) < toComparable(cond.$lt);
    if ('$gt' in cond) return toComparable(actual) > toComparable(cond.$gt);
  }
  return valuesEqual(actual, cond);
}

function matches(doc, query) {
  return Object.entries(query).every(([key, cond]) => {
    if (key === '$or') return cond.some((sub) => matches(doc, sub));
    return matchValue(doc[key], cond);
  });
}

function applyUpdate(doc, update) {
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc)) {
      doc[k] = (doc[k] || 0) + v;
    }
  }
}

/**
 * @param {object} [opts]
 * @param {(doc: object) => any} [opts.uniqueKey] - returns a key for the
 *   partial-unique-index simulation; return null/undefined to exempt a doc.
 */
export function createFakeCollection({ uniqueKey } = {}) {
  const docs = [];

  return {
    docs,
    async insertOne(doc) {
      const _id = doc._id || new ObjectId();
      if (uniqueKey) {
        const key = uniqueKey(doc);
        if (key != null && docs.some((d) => uniqueKey(d) === key)) {
          const error = new Error('E11000 duplicate key error');
          error.code = 11000;
          throw error;
        }
      }
      const stored = { ...doc, _id };
      docs.push(stored);
      return { insertedId: _id };
    },
    async findOne(query = {}) {
      const found = docs.find((d) => matches(d, query));
      return found ? { ...found } : null;
    },
    find(query = {}) {
      const results = docs.filter((d) => matches(d, query));
      let sortSpec = null;
      let limitN = null;
      const cursor = {
        sort(spec) {
          sortSpec = spec;
          return cursor;
        },
        limit(n) {
          limitN = n;
          return cursor;
        },
        async toArray() {
          let out = [...results];
          if (sortSpec) {
            const [key, dir] = Object.entries(sortSpec)[0];
            out.sort((a, b) => {
              const av = toComparable(a[key]);
              const bv = toComparable(b[key]);
              if (av < bv) return -1 * dir;
              if (av > bv) return 1 * dir;
              return 0;
            });
          }
          if (limitN != null) out = out.slice(0, limitN);
          return out.map((d) => ({ ...d }));
        },
      };
      return cursor;
    },
    async updateOne(query, update) {
      const doc = docs.find((d) => matches(d, query));
      if (!doc) return { matchedCount: 0 };
      applyUpdate(doc, update);
      return { matchedCount: 1 };
    },
    async findOneAndUpdate(query, update, options = {}) {
      const doc = docs.find((d) => matches(d, query));
      if (!doc) return options.includeResultMetadata ? { value: null } : null;
      applyUpdate(doc, update);
      const copy = { ...doc };
      return options.includeResultMetadata ? { value: copy } : copy;
    },
  };
}

export function createFakeDb(collections) {
  return { collection: (name) => collections[name] };
}
