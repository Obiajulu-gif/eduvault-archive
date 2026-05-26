import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProtectedDownloadError,
  resolveProtectedMaterialDownload,
} from "../../src/lib/api/protectedDownload.js";

function createCollection(initial = []) {
  const records = new Map(initial.map((doc) => [doc._id || doc.materialId, doc]));

  return {
    records,
    async findOne(query) {
      if (query.$or) {
        for (const clause of query.$or) {
          if (clause._id && records.has(String(clause._id))) {
            return records.get(String(clause._id));
          }
          if (clause.materialId) {
            for (const record of records.values()) {
              if (record.materialId === clause.materialId) {
                return record;
              }
            }
          }
        }
      }

      if (query.materialId) {
        for (const record of records.values()) {
          if (record.materialId === query.materialId) {
            return record;
          }
        }
      }

      if (query.buyerAddress) {
        for (const record of records.values()) {
          if (record.buyerAddress === query.buyerAddress) {
            return record;
          }
        }
      }

      return null;
    },
    async updateOne(query, update, options = {}) {
      const key = `${query.materialId}:${query.buyerAddress || ""}`;
      const current = records.get(key) || {};
      if (!records.has(key) && !options.upsert) return;
      records.set(key, {
        ...current,
        ...(update.$setOnInsert || {}),
        ...(update.$set || {}),
      });
    },
  };
}

function createDb({ materials = [], entitlements = [] } = {}) {
  const collections = new Map([
    ["materials", createCollection(materials)],
    ["entitlement_cache", createCollection(entitlements)],
  ]);

  return {
    collection(name) {
      if (!collections.has(name)) {
        collections.set(name, createCollection());
      }
      return collections.get(name);
    },
  };
}

test("resolveProtectedMaterialDownload allows active buyers from cache", async () => {
  const db = createDb({
    materials: [{ _id: "material-db-id", materialId: "material-chain-id", title: "Calculus Notes", price: 1200, fileUrl: "https://example.com/file.pdf" }],
    entitlements: [{
      materialId: "material-chain-id",
      buyerAddress: "0xbuyer",
      active: true,
      source: "stellar",
      updatedAt: new Date(),
    }],
  });

  const result = await resolveProtectedMaterialDownload({
    db,
    materialId: "material-db-id",
    buyerAddress: "0xBuyer",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.source, "stellar");
  assert.equal(result.material.title, "Calculus Notes");
});

test("resolveProtectedMaterialDownload rejects missing session identity", async () => {
  const db = createDb({
    materials: [{ _id: "material-db-id", materialId: "material-chain-id", title: "Calculus Notes", price: 1200, fileUrl: "https://example.com/file.pdf" }],
  });

  await assert.rejects(
    () =>
      resolveProtectedMaterialDownload({
        db,
        materialId: "material-db-id",
        buyerAddress: null,
      }),
    (error) => {
      assert.ok(error instanceof ProtectedDownloadError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "unauthenticated");
      return true;
    }
  );
});

test("resolveProtectedMaterialDownload rejects unknown materials", async () => {
  const db = createDb();

  await assert.rejects(
    () =>
      resolveProtectedMaterialDownload({
        db,
        materialId: "missing-id",
        buyerAddress: "0xbuyer",
      }),
    (error) => {
      assert.ok(error instanceof ProtectedDownloadError);
      assert.equal(error.status, 404);
      assert.equal(error.code, "material_not_found");
      return true;
    }
  );
});

test("resolveProtectedMaterialDownload falls back to chain verification when cache is missing", async () => {
  const db = createDb({
    materials: [{ _id: "material-db-id", materialId: "material-chain-id", title: "Calculus Notes", price: 1200, fileUrl: "https://example.com/file.pdf" }],
  });

  const result = await resolveProtectedMaterialDownload({
    db,
    materialId: "material-db-id",
    buyerAddress: "0xbuyer",
    verifyChainEntitlement: async ({ materialId, buyerAddress }) => ({
      status: "available",
      active: true,
      source: "chain",
      chainTxHash: `${materialId}:${buyerAddress}`,
    }),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.source, "chain");
});

test("resolveProtectedMaterialDownload reports stale cache when chain fallback is unavailable", async () => {
  const db = createDb({
    materials: [{ _id: "material-db-id", materialId: "material-chain-id", title: "Calculus Notes", price: 1200, fileUrl: "https://example.com/file.pdf" }],
    entitlements: [{
      materialId: "material-chain-id",
      buyerAddress: "0xbuyer",
      active: true,
      source: "stellar",
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    }],
  });

  await assert.rejects(
    () =>
      resolveProtectedMaterialDownload({
        db,
        materialId: "material-db-id",
        buyerAddress: "0xbuyer",
        verifyChainEntitlement: async () => ({ status: "unavailable" }),
      }),
    (error) => {
      assert.ok(error instanceof ProtectedDownloadError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "stale_entitlement");
      return true;
    }
  );
});

test("resolveProtectedMaterialDownload denies non-buyers after chain verification", async () => {
  const db = createDb({
    materials: [{ _id: "material-db-id", materialId: "material-chain-id", title: "Calculus Notes", price: 1200, fileUrl: "https://example.com/file.pdf" }],
  });

  await assert.rejects(
    () =>
      resolveProtectedMaterialDownload({
        db,
        materialId: "material-db-id",
        buyerAddress: "0xnotbuyer",
        verifyChainEntitlement: async () => ({
          status: "available",
          active: false,
          source: "chain",
        }),
      }),
    (error) => {
      assert.ok(error instanceof ProtectedDownloadError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "unauthorized");
      return true;
    }
  );
});
