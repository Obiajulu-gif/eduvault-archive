import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { verifyDiscount } from "../../src/lib/checkout/discountVerifier.js";

function createMockCollection(data = []) {
  return {
    async findOne(query) {
      return data.find(item => {
        return Object.entries(query).every(([k, v]) => {
          if (v === null || v === undefined) return item[k] === v;
          return String(item[k]).toLowerCase() === String(v).toLowerCase();
        });
      }) || null;
    }
  };
}

function createMockDb({ discountCodes = [], materials = [] } = {}) {
  const collections = {
    discount_codes: createMockCollection(discountCodes),
    materials: createMockCollection(materials),
  };
  return {
    collection(name) {
      return collections[name] || createMockCollection([]);
    }
  };
}

describe("discountVerifier utility", () => {
  const mockMaterials = [
    {
      _id: "material-1",
      title: "Calculus Notes",
      price: 10,
      userAddress: "GCREATOR1",
    },
    {
      _id: "material-2",
      title: "Physics Exercises",
      price: 15,
      userAddress: "GCREATOR2",
    }
  ];

  test("verifies a valid discount code successfully", async () => {
    const db = createMockDb({
      discountCodes: [
        {
          code: "SAVE20",
          percentage: 20,
          expiresAt: new Date(Date.now() + 100000),
          usageLimit: 100,
          usageCount: 5,
        }
      ],
      materials: mockMaterials,
    });

    const result = await verifyDiscount("SAVE20", "material-1", db);
    assert.equal(result.valid, true);
    assert.equal(result.discountAmountPercent, 20);
  });

  test("fails for non-existent discount code", async () => {
    const db = createMockDb({
      discountCodes: [],
      materials: mockMaterials,
    });

    const result = await verifyDiscount("INVALID_CODE", "material-1", db);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "Discount code not found");
  });

  test("fails for expired discount code", async () => {
    const db = createMockDb({
      discountCodes: [
        {
          code: "EXPIRED10",
          percentage: 10,
          expiresAt: new Date(Date.now() - 10000),
        }
      ],
      materials: mockMaterials,
    });

    const result = await verifyDiscount("EXPIRED10", "material-1", db);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "Discount code expired");
  });

  test("fails when usage limit is reached", async () => {
    const db = createMockDb({
      discountCodes: [
        {
          code: "LIMIT50",
          percentage: 50,
          usageLimit: 10,
          usageCount: 10,
        }
      ],
      materials: mockMaterials,
    });

    const result = await verifyDiscount("LIMIT50", "material-1", db);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "Discount code usage limit reached");
  });

  test("fails when creator restriction does not match", async () => {
    const db = createMockDb({
      discountCodes: [
        {
          code: "CREATORONLY",
          percentage: 15,
          creatorAddress: "GCREATOR2", // Only valid for GCREATOR2's materials
        }
      ],
      materials: mockMaterials,
    });

    // material-1 is created by GCREATOR1, so this should fail
    const result1 = await verifyDiscount("CREATORONLY", "material-1", db);
    assert.equal(result1.valid, false);
    assert.equal(result1.reason, "Discount code not valid for this creator's materials");

    // material-2 is created by GCREATOR2, so this should succeed
    const result2 = await verifyDiscount("CREATORONLY", "material-2", db);
    assert.equal(result2.valid, true);
  });

  test("fails when material restriction does not match", async () => {
    const db = createMockDb({
      discountCodes: [
        {
          code: "SPECIFICMAT",
          percentage: 30,
          materialId: "material-2", // Only valid for material-2
        }
      ],
      materials: mockMaterials,
    });

    const result1 = await verifyDiscount("SPECIFICMAT", "material-1", db);
    assert.equal(result1.valid, false);
    assert.equal(result1.reason, "Discount code not valid for this material");

    const result2 = await verifyDiscount("SPECIFICMAT", "material-2", db);
    assert.equal(result2.valid, true);
  });
});
