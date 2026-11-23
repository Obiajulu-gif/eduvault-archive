// In-memory stand-in for the Mongo driver covering what rollbackVerification.js
// uses. `failNext` makes the next N calls of an operation throw.

const matches = (doc, query) =>
  Object.entries(query).every(([key, cond]) =>
    cond && typeof cond === "object" && "$in" in cond ? cond.$in.includes(doc[key]) : doc[key] === cond
  );

const UNRESOLVED = ["applying", "rolling_back", "rollback_failed", "rollback_drift", "unverifiable"];

export function createFakeMongo() {
  const stores = new Map();
  const indexLists = new Map();
  const failures = [];

  const store = (name) => stores.get(name) ?? stores.set(name, new Map()).get(name);

  function collection(name) {
    const rows = store(name);
    const maybeFail = (op) => {
      const f = failures.find((x) => x.collection === name && x.op === op && x.times > 0);
      if (f) {
        f.times -= 1;
        throw f.error;
      }
    };
    const find = (query) => [...rows.values()].filter((doc) => matches(doc, query));
    return {
      async countDocuments(query = {}) {
        maybeFail("countDocuments");
        return find(query).length;
      },
      find(query = {}) {
        let result = find(query);
        const cursor = {
          sort: () => ((result = [...result].sort((a, b) => (String(a._id) < String(b._id) ? -1 : 1))), cursor),
          limit: (n) => ((result = result.slice(0, n)), cursor),
          toArray: async () => {
            maybeFail("find");
            return result.map((d) => structuredClone(d));
          },
        };
        return cursor;
      },
      async findOne(query) {
        maybeFail("findOne");
        const doc = find(query)[0];
        return doc ? structuredClone(doc) : null;
      },
      async insertOne(doc) {
        maybeFail("insertOne");
        if (name === "rollback_verifications" && UNRESOLVED.includes(doc.state) && find({ name: doc.name, state: { $in: UNRESOLVED } }).length) {
          throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
        }
        rows.set(doc._id, structuredClone(doc));
        return { insertedId: doc._id };
      },
      async updateOne(query, update) {
        maybeFail("updateOne");
        const doc = find(query)[0];
        if (!doc) return { matchedCount: 0 };
        Object.assign(doc, update.$set);
        for (const [k, v] of Object.entries(update.$push ?? {})) (doc[k] ||= []).push(v);
        return { matchedCount: 1 };
      },
      async indexes() {
        return (indexLists.get(name) ?? [{ name: "_id_" }]).map((index) => ({ ...index }));
      },
    };
  }

  return {
    collection,
    seed(name, ...docs) {
      for (const doc of docs) store(name).set(doc._id, structuredClone(doc));
    },
    put(name, doc) {
      store(name).set(doc._id, structuredClone(doc));
    },
    remove(name, id) {
      store(name).delete(id);
    },
    get(name, id) {
      return store(name).get(id);
    },
    all(name) {
      return [...store(name).values()];
    },
    setIndexes(name, names) {
      indexLists.set(name, names.map((n) => ({ name: n })));
    },
    failNext(name, op, times = 1, error = new Error("simulated outage")) {
      failures.push({ collection: name, op, times, error });
    },
  };
}
