/**
 * Minimal in-memory MongoDB double for backend tests (#1083-#1086).
 *
 * Supports the subset of query/update semantics the repair, merge-review and
 * schema-compat code relies on: equality (deep, for embedded documents),
 * `$exists`, `$gt`, `$gte`, `$lt`, `$lte`, `$ne`, `$in`, top-level `$or`,
 * `$set` / `$unset` / `$inc` updates, upserts, `sort({ field: ±1 })`,
 * `limit(0 = unlimited)`, and `matchedCount` results for compare-and-set.
 *
 * `failNext(collection, op, times)` makes the next N calls of an operation
 * throw, to exercise failure and retry paths deterministically.
 */

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

function stable(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const isOperatorObject = (cond) =>
  cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date) && Object.keys(cond).some((k) => k.startsWith("$"));

function compare(a, b) {
  if (a instanceof Date) a = a.getTime();
  if (b instanceof Date) b = b.getTime();
  return a < b ? -1 : a > b ? 1 : 0;
}

function matchesField(doc, key, cond) {
  const has = Object.prototype.hasOwnProperty.call(doc, key);
  const value = doc[key];
  if (isOperatorObject(cond)) {
    return Object.entries(cond).every(([op, arg]) => {
      switch (op) {
        case "$exists":
          return Boolean(arg) === has;
        case "$gt":
          return has && compare(value, arg) > 0;
        case "$gte":
          return has && compare(value, arg) >= 0;
        case "$lt":
          return has && compare(value, arg) < 0;
        case "$lte":
          return has && compare(value, arg) <= 0;
        case "$ne":
          return stable(value) !== stable(arg);
        case "$in":
          return arg.some((candidate) => stable(candidate) === stable(value));
        default:
          throw new Error(`memoryMongo: unsupported operator ${op}`);
      }
    });
  }
  if (cond === null) return !has || value === null;
  return has && stable(value) === stable(cond);
}

export function matches(doc, query = {}) {
  return Object.entries(query).every(([key, cond]) => {
    if (key === "$or") return cond.some((sub) => matches(doc, sub));
    return matchesField(doc, key, cond);
  });
}

function applyUpdate(doc, update) {
  for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = clone(v);
  for (const k of Object.keys(update.$unset ?? {})) delete doc[k];
  for (const [k, v] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + v;
}

export function createMemoryMongo(initial = {}) {
  const stores = new Map();
  const failures = [];
  const calls = [];

  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  for (const [name, docs] of Object.entries(initial)) {
    for (const doc of docs) store(name).set(stable(doc._id), clone(doc));
  }

  function maybeFail(name, op) {
    calls.push(`${name}.${op}`);
    const failure = failures.find((f) => f.collection === name && f.op === op && f.times > 0);
    if (failure) {
      failure.times -= 1;
      throw failure.error;
    }
  }

  function collection(name) {
    const rows = store(name);
    const filter = (query) => [...rows.values()].filter((doc) => matches(doc, query));

    return {
      find(query = {}) {
        let sortSpec = null;
        let limitN = 0;
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
            maybeFail(name, "find");
            let result = filter(query);
            if (sortSpec) {
              const entries = Object.entries(sortSpec);
              result = [...result].sort((a, b) => {
                for (const [field, dir] of entries) {
                  const c = compare(a[field], b[field]);
                  if (c !== 0) return c * dir;
                }
                return 0;
              });
            }
            if (limitN > 0) result = result.slice(0, limitN);
            return result.map(clone);
          },
          async *[Symbol.asyncIterator]() {
            for (const doc of await cursor.toArray()) yield doc;
          },
          async close() {},
        };
        return cursor;
      },
      async findOne(query = {}) {
        maybeFail(name, "findOne");
        const doc = filter(query)[0];
        return doc ? clone(doc) : null;
      },
      async countDocuments(query = {}) {
        maybeFail(name, "countDocuments");
        return filter(query).length;
      },
      async insertOne(doc) {
        maybeFail(name, "insertOne");
        const id = doc._id ?? `${name}-${rows.size + 1}`;
        if (rows.has(stable(id))) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
        rows.set(stable(id), clone({ ...doc, _id: id }));
        return { acknowledged: true, insertedId: id };
      },
      async updateOne(query, update, options = {}) {
        maybeFail(name, "updateOne");
        const doc = filter(query)[0];
        if (doc) {
          applyUpdate(doc, update);
          return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
        }
        if (options.upsert) {
          const created = {};
          for (const [k, v] of Object.entries(query)) if (!k.startsWith("$") && !isOperatorObject(v)) created[k] = clone(v);
          applyUpdate(created, update);
          rows.set(stable(created._id), created);
          return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: created._id };
        }
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      },
      async replaceOne(query, replacement) {
        maybeFail(name, "replaceOne");
        const doc = filter(query)[0];
        if (!doc) return { matchedCount: 0 };
        rows.set(stable(doc._id), clone({ ...replacement, _id: doc._id }));
        return { matchedCount: 1 };
      },
    };
  }

  return {
    collection,
    get(name, id) {
      return clone(store(name).get(stable(id)));
    },
    all(name) {
      return [...store(name).values()].map(clone);
    },
    put(name, doc) {
      store(name).set(stable(doc._id), clone(doc));
    },
    failNext(name, op, times = 1, error = new Error("simulated outage")) {
      failures.push({ collection: name, op, times, error });
    },
    calls,
  };
}
