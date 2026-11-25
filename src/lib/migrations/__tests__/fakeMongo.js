function getPath(obj, path) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  const parts = path.split(".");
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

const matches = (doc, query = {}) => {
  return Object.entries(query).every(([key, cond]) => {
    if (key === "$or") return cond.some((subQuery) => matches(doc, subQuery));
    if (key === "$and") return cond.every((subQuery) => matches(doc, subQuery));
    const val = getPath(doc, key);
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("$in" in cond && !cond.$in.includes(val)) return false;
      if ("$nin" in cond && cond.$nin.includes(val)) return false;
      if ("$lt" in cond && !(val < cond.$lt)) return false;
      if ("$lte" in cond && !(val <= cond.$lte)) return false;
      if ("$gt" in cond && !(val > cond.$gt)) return false;
      if ("$gte" in cond && !(val >= cond.$gte)) return false;
      if ("$ne" in cond && val === cond.$ne) return false;
      if ("$exists" in cond) {
        const exists = val !== undefined;
        if (cond.$exists !== exists) return false;
      }
      return true;
    }
    return val === cond;
  });
};

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
        let cursorIndex = 0;
        const cursor = {
          sort: () => ((result = [...result].sort((a, b) => (String(a._id) < String(b._id) ? -1 : 1))), cursor),
          limit: (n) => ((result = result.slice(0, n)), cursor),
          toArray: async () => {
            maybeFail("find");
            return result.map((d) => structuredClone(d));
          },
          hasNext: async () => {
            maybeFail("find");
            return cursorIndex < result.length;
          },
          next: async () => {
            maybeFail("find");
            if (cursorIndex >= result.length) return null;
            const doc = result[cursorIndex++];
            return structuredClone(doc);
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
      async updateOne(query, update, options = {}) {
        maybeFail("updateOne");
        let doc = find(query)[0];
        if (!doc) {
          if (options.upsert) {
            const target = { _id: query._id ?? `id-${Date.now()}` };
            if (update.$set) Object.assign(target, update.$set);
            rows.set(target._id, target);
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
          }
          return { matchedCount: 0, modifiedCount: 0 };
        }
        if (update.$set) Object.assign(doc, update.$set);
        for (const [k, v] of Object.entries(update.$push ?? {})) (doc[k] ||= []).push(v);
        rows.set(doc._id, doc);
        return { matchedCount: 1, modifiedCount: 1 };
      },
      async replaceOne(query, replacement, options = {}) {
        maybeFail("replaceOne");
        const doc = find(query)[0];
        if (!doc && !options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        const id = doc?._id ?? query._id ?? replacement._id;
        rows.set(id, structuredClone({ ...replacement, _id: id }));
        return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0, upsertedCount: doc ? 0 : 1 };
      },
      async deleteOne(query) {
        maybeFail("deleteOne");
        const doc = find(query)[0];
        if (!doc) return { deletedCount: 0 };
        rows.delete(doc._id);
        return { deletedCount: 1 };
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
