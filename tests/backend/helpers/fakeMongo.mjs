/**
 * An in-memory Mongo double that enforces unique indexes and can inject write
 * faults.
 *
 * The existing indexer test double keys documents as
 * `query._id || \`${materialId}:${buyerAddress}\`` and models no constraints,
 * so a duplicate-key error is unrepresentable and a crash mid-batch is
 * unsimulatable. That makes the two scenarios the indexer most needs to
 * survive — replay and checkpoint resume — exactly the two it cannot be tested
 * for. This double exists to close that gap.
 *
 * It is deliberately partial: it implements the query and update shapes the
 * indexer actually uses, and throws on anything it does not understand rather
 * than silently returning wrong results.
 */

import { REQUIRED_INDEXES } from "../../../src/lib/backend/schemaContracts.js";

function duplicateKeyError(indexName, key) {
  const error = new Error(
    `E11000 duplicate key error collection: index: ${indexName} dup key: ${JSON.stringify(key)}`,
  );
  error.code = 11000;
  return error;
}

const TYPE_CHECKS = {
  string: (value) => typeof value === "string",
  int: (value) => Number.isInteger(value),
  bool: (value) => typeof value === "boolean",
  date: (value) => value instanceof Date,
};

function matchesCondition(value, condition) {
  if (condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date)) {
    for (const [operator, operand] of Object.entries(condition)) {
      switch (operator) {
        case "$in":
          if (!operand.includes(value)) return false;
          break;
        case "$nin":
          if (operand.includes(value)) return false;
          break;
        case "$exists":
          if ((value !== undefined) !== operand) return false;
          break;
        case "$ne":
          if (value === operand) return false;
          break;
        case "$gt":
          if (!(value > operand)) return false;
          break;
        case "$type": {
          const check = TYPE_CHECKS[operand];
          if (!check) throw new Error(`fakeMongo: unsupported $type "${operand}"`);
          if (!check(value)) return false;
          break;
        }
        default:
          throw new Error(`fakeMongo: unsupported operator "${operator}"`);
      }
    }
    return true;
  }

  if (value instanceof Date && condition instanceof Date) return value.getTime() === condition.getTime();
  return value === condition;
}

export function matchesFilter(doc, filter = {}) {
  for (const [field, condition] of Object.entries(filter)) {
    if (field === "$or") {
      if (!condition.some((clause) => matchesFilter(doc, clause))) return false;
      continue;
    }
    if (field === "$and") {
      if (!condition.every((clause) => matchesFilter(doc, clause))) return false;
      continue;
    }
    if (!matchesCondition(doc[field], condition)) return false;
  }
  return true;
}

/** Fields a filter pins to a literal value, used to seed an upserted doc. */
function literalsFrom(filter) {
  const seed = {};
  for (const [field, condition] of Object.entries(filter)) {
    if (field.startsWith("$")) continue;
    const isOperator =
      condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date);
    if (!isOperator) seed[field] = condition;
  }
  return seed;
}

class FakeCollection {
  constructor(name, indexes, faults) {
    this.name = name;
    this.indexes = indexes;
    this.faults = faults;
    this.docs = [];
    this.writes = 0;
  }

  /** Throws if a registered fault matches this write. */
  #maybeFail(operation) {
    this.writes += 1;
    for (const fault of this.faults) {
      if (fault.collection !== this.name) continue;
      if (fault.operation && fault.operation !== operation) continue;
      if (fault.afterWrites !== undefined && this.writes <= fault.afterWrites) continue;
      if (fault.remaining !== undefined) {
        if (fault.remaining <= 0) continue;
        fault.remaining -= 1;
      }
      throw fault.error ?? new Error(`fakeMongo: injected ${operation} failure on ${this.name}`);
    }
  }

  #assertUnique(candidate, existing) {
    for (const index of this.indexes) {
      if (!index.options?.unique) continue;

      const partial = index.options.partialFilterExpression;
      if (partial && !matchesFilter(candidate, partial)) continue;

      const fields = Object.keys(index.keys);
      const key = Object.fromEntries(fields.map((field) => [field, candidate[field]]));

      const clash = this.docs.some((doc) => {
        if (doc === existing) return false;
        if (partial && !matchesFilter(doc, partial)) return false;
        return fields.every((field) => doc[field] === candidate[field]);
      });

      if (clash) throw duplicateKeyError(index.name, key);
    }
  }

  async findOne(filter = {}) {
    return this.docs.find((doc) => matchesFilter(doc, filter)) ?? null;
  }

  async insertOne(doc) {
    this.#maybeFail("insertOne");
    if (doc._id !== undefined && this.docs.some((existing) => existing._id === doc._id)) {
      throw duplicateKeyError(`${this.name}_id_`, { _id: doc._id });
    }
    this.#assertUnique(doc, null);
    this.docs.push({ ...doc });
    return { insertedId: doc._id };
  }

  async updateOne(filter, update, options = {}) {
    this.#maybeFail("updateOne");

    const existing = this.docs.find((doc) => matchesFilter(doc, filter));

    if (!existing && !options.upsert) return { matchedCount: 0, modifiedCount: 0 };

    if (!existing) {
      const candidate = {
        ...literalsFrom(filter),
        ...(update.$setOnInsert || {}),
        ...(update.$set || {}),
      };
      for (const [field, value] of Object.entries(update.$inc || {})) {
        candidate[field] = (candidate[field] || 0) + value;
      }
      this.#assertUnique(candidate, null);
      this.docs.push(candidate);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }

    // $setOnInsert is deliberately ignored on an existing document, which is
    // where the previous double diverged from Mongo most visibly.
    const candidate = { ...existing, ...(update.$set || {}) };
    for (const [field, value] of Object.entries(update.$inc || {})) {
      candidate[field] = (candidate[field] || 0) + value;
    }
    this.#assertUnique(candidate, existing);
    Object.assign(existing, update.$set || {});
    for (const [field, value] of Object.entries(update.$inc || {})) {
      existing[field] = (existing[field] || 0) + value;
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(filter) {
    this.#maybeFail("deleteOne");
    const index = this.docs.findIndex((doc) => matchesFilter(doc, filter));
    if (index === -1) return { deletedCount: 0 };
    this.docs.splice(index, 1);
    return { deletedCount: 1 };
  }

  async deleteMany(filter) {
    this.#maybeFail("deleteMany");
    const before = this.docs.length;
    this.docs = this.docs.filter((doc) => !matchesFilter(doc, filter));
    return { deletedCount: before - this.docs.length };
  }

  async updateMany(filter, update) {
    this.#maybeFail("updateMany");
    let matchedCount = 0;
    let modifiedCount = 0;
    for (const existing of this.docs) {
      if (!matchesFilter(existing, filter)) continue;
      matchedCount += 1;
      Object.assign(existing, update.$set || {});
      for (const field of Object.keys(update.$unset || {})) {
        delete existing[field];
      }
      modifiedCount += 1;
    }
    return { matchedCount, modifiedCount };
  }

  async countDocuments(filter = {}) {
    return this.docs.filter((doc) => matchesFilter(doc, filter)).length;
  }

  async createIndexes(models) {
    for (const model of models) {
      if (this.indexes.some((index) => index.name === model.name)) continue;
      this.indexes.push({
        name: model.name,
        keys: model.key,
        options: {
          unique: model.unique,
          partialFilterExpression: model.partialFilterExpression,
        },
      });
    }
    return models.map((model) => model.name);
  }

  async createIndex(keys, options = {}) {
    await this.createIndexes([{ key: keys, ...options }]);
    return options.name;
  }

  find(filter = {}) {
    let results = this.docs.filter((doc) => matchesFilter(doc, filter));
    const cursor = {
      sort(spec) {
        const entries = Object.entries(spec);
        results = [...results].sort((left, right) => {
          for (const [field, direction] of entries) {
            if (left[field] === right[field]) continue;
            return left[field] > right[field] ? direction : -direction;
          }
          return 0;
        });
        return cursor;
      },
      limit(count) {
        results = results.slice(0, count);
        return cursor;
      },
      async toArray() {
        return results.map((doc) => ({ ...doc }));
      },
      async *[Symbol.asyncIterator]() {
        for (const doc of results) yield { ...doc };
      },
    };
    return cursor;
  }
}

/**
 * @param {object} [options]
 * @param {Array<object>} [options.faults] write faults, e.g.
 *   `{ collection: "purchases", operation: "updateOne", remaining: 1 }`
 * @param {boolean} [options.transactions] expose a client so the indexer takes
 *   its transactional path. Sessions are a no-op here; the point is to exercise
 *   the code path, not to model isolation.
 */
export function createFakeDb({ faults = [], transactions = false } = {}) {
  const collections = new Map();

  const db = {
    faults,
    collection(name) {
      if (!collections.has(name)) {
        collections.set(name, new FakeCollection(name, REQUIRED_INDEXES[name] ?? [], faults));
      }
      return collections.get(name);
    },
    async createCollection(name) {
      this.collection(name);
      return { collectionName: name };
    },
    listCollections(filter = {}) {
      const names = [...collections.keys()].filter((name) => !filter.name || filter.name === name);
      return {
        async toArray() {
          return names.map((name) => ({ name }));
        },
      };
    },
    async command() {
      return { ok: 1 };
    },
    /** Test-only: raw documents for assertions. */
    dump(name) {
      return (collections.get(name)?.docs ?? []).map((doc) => ({ ...doc }));
    },
    clearFaults() {
      faults.length = 0;
    },
  };

  if (transactions) {
    db.client = {
      startSession() {
        return {
          async withTransaction(fn) {
            return fn();
          },
          async endSession() {},
        };
      },
    };
  }

  return db;
}
