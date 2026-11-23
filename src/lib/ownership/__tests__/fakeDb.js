// Minimal in-memory stand-in for the Mongo driver, covering only the operators
// ownershipTransfer.js uses. `failNext` lets a test make a call throw once.

const value = (v) => (v instanceof Date ? v.getTime() : v);

function matches(doc, query) {
  return Object.entries(query).every(([key, cond]) => {
    if (key === "$or") return cond.some((sub) => matches(doc, sub));
    const actual = doc[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, expected]) => {
        if (op === "$in") return expected.includes(actual);
        if (op === "$ne") return actual !== expected;
        if (op === "$gt") return value(actual) > value(expected);
        if (op === "$lte") return value(actual) <= value(expected);
        throw new Error(`fakeDb: unsupported operator ${op}`);
      });
    }
    return value(actual) === value(cond);
  });
}

export function createFakeDb() {
  const stores = new Map();
  const failures = [];

  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  function collection(name) {
    const rows = store(name);
    const maybeFail = (op) => {
      const index = failures.findIndex((f) => f.collection === name && f.op === op);
      if (index !== -1) throw failures.splice(index, 1)[0].error;
    };
    const find = (query) => [...rows.values()].filter((doc) => matches(doc, query));
    return {
      async findOne(query) {
        return find(query)[0] ?? null;
      },
      async insertOne(doc) {
        maybeFail("insertOne");
        if (name === "ownership_transfers" && ["pending", "accepting"].includes(doc.state)) {
          const dup = find({ materialId: doc.materialId, state: { $in: ["pending", "accepting"] } });
          if (dup.length) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
        }
        rows.set(doc._id, structuredClone(doc));
        return { insertedId: doc._id };
      },
      async findOneAndUpdate(query, update) {
        maybeFail("findOneAndUpdate");
        const doc = find(query)[0];
        if (!doc) return null;
        Object.assign(doc, update.$set);
        for (const [k, v] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] || 0) + v;
        for (const [k, v] of Object.entries(update.$push ?? {})) (doc[k] ||= []).push(v);
        return structuredClone(doc);
      },
      find(query) {
        let result = find(query);
        const cursor = {
          sort: (spec) => {
            const keys = Object.entries(spec);
            result = [...result].sort((a, b) => {
              for (const [k, dir] of keys) {
                const diff = value(a[k]) < value(b[k]) ? -1 : value(a[k]) > value(b[k]) ? 1 : 0;
                if (diff) return diff * dir;
              }
              return 0;
            });
            return cursor;
          },
          limit: (n) => ((result = result.slice(0, n)), cursor),
          toArray: async () => result.map((d) => structuredClone(d)),
        };
        return cursor;
      },
    };
  }

  return {
    collection,
    seed(name, doc) {
      store(name).set(doc._id, structuredClone(doc));
    },
    get(name, id) {
      return store(name).get(id);
    },
    failNext(collectionName, op, error = new Error("simulated outage")) {
      failures.push({ collection: collectionName, op, error });
    },
  };
}
