import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const stub = (code) => `data:text/javascript,${encodeURIComponent(code.trim())}`;

const modules = {
  "next/server": stub(`
    export const NextResponse = {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      },
    };
  `),
  "@/lib/api/auth": stub(`
    export async function getUserFromCookie() {
      return globalThis.__checkoutTest.user ?? null;
    }
  `),
  "@/lib/mongodb": stub(`
    export async function getDb() {
      return globalThis.__checkoutTest.db;
    }
    export default { db: () => globalThis.__checkoutTest.db };
  `),
  "@/lib/checkout/taxEstimator": stub(`
    export async function applyTaxToCheckout(input) {
      return globalThis.__checkoutTest.applyTax(input);
    }
  `),
  "@/lib/checkout/discountVerifier": stub(`
    export async function findMaterial(id) {
      return globalThis.__checkoutTest.findMaterial(id);
    }
    export async function verifyDiscount(code, materialId) {
      return globalThis.__checkoutTest.verifyDiscount(code, materialId);
    }
  `),
  "@/lib/stellar/horizonClient": stub(`
    export async function checkBuyerTrustline(...args) {
      return globalThis.__checkoutTest.checkBuyerTrustline(...args);
    }
  `),
  "@/lib/stellar/checkoutService": stub(`
    export function verifyWalletAddressMatch(input) {
      return globalThis.__checkoutTest.verifyWalletAddressMatch(input);
    }
  `),
  "@/lib/logger": stub(`
    export default {
      warn() {},
      error() {},
      info() {},
    };
  `),
  "@/lib/api/audit": stub(`
    export function auditLog(entry) {
      globalThis.__checkoutTest.audits.push(entry);
    }
  `),
};

const srcRoot = path.resolve("src");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.prototype.hasOwnProperty.call(modules, specifier)) {
      return { url: modules[specifier], shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const relative = specifier.slice(2);
      const candidates = [relative, `${relative}.js`, path.join(relative, "index.js")];
      for (const candidate of candidates) {
        const absolute = path.join(srcRoot, candidate);
        if (existsSync(absolute)) {
          return { url: pathToFileURL(absolute).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const initiateRoute = await import("../../src/app/api/checkout/initiate/route.js");
const verifyRoute = await import("../../src/app/api/checkout/verify/route.js");
const refundRoute = await import("../../src/app/api/checkout/refund/route.js");
const promoRoute = await import("../../src/app/api/checkout/verify-promo/route.js");

function createDb(state) {
  return {
    collection(name) {
      return {
        async insertOne(doc) {
          const entry = { name, doc };
          state.inserted.push(entry);
          return { insertedId: `inserted-${state.inserted.length}` };
        },
        async findOne(query) {
          if (name === "promo_codes") {
            state.promoQuery = query;
            return state.promo;
          }
          if (name === "purchases") {
            state.purchaseQuery = query;
            return state.purchase;
          }
          return null;
        },
      };
    },
  };
}

function makeRequest(path, { method = "POST", body, headers = {} } = {}) {
  const init = {
    method,
    headers: { "content-type": "application/json", ...headers },
  };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

async function jsonOf(response) {
  return response.json();
}

beforeEach(() => {
  const state = {
    user: { sub: "user-1", walletAddress: "GABC" },
    audits: [],
    inserted: [],
    trustlineCalls: [],
    taxCalls: [],
    promo: null,
    purchase: null,
    promoQuery: null,
    purchaseQuery: null,
  };
  state.db = createDb(state);
  state.findMaterial = async () => ({ price: 20 });
  state.verifyDiscount = async () => ({ valid: false });
  state.checkBuyerTrustline = async (...args) => {
    state.trustlineCalls.push(args);
    return { hasTrustline: true };
  };
  state.applyTax = async (input) => {
    state.taxCalls.push(input);
    return {
      taxAmount: 1,
      taxRateBps: 500,
      totalAmount: input.amount + 1,
      geolocation: { country: input.buyerCountry || "US" },
    };
  };
  state.verifyWalletAddressMatch = ({ sessionAddress, payloadAddress }) => {
    const valid = sessionAddress.trim().toUpperCase() === payloadAddress.trim().toUpperCase();
    return {
      valid,
      reason: valid ? undefined : "address mismatch",
      warnings: valid ? 0 : 1,
      clearSession: false,
    };
  };
  globalThis.__checkoutTest = state;
});

describe("checkout routes", () => {
  describe("POST /api/checkout/initiate", () => {
    it("requires authentication", async () => {
      globalThis.__checkoutTest.user = null;
      const response = await initiateRoute.POST(
        makeRequest("/api/checkout/initiate", { body: { materialId: "m1", amount: 20, asset: "USDC" } })
      );
      assert.equal(response.status, 401);
      assert.deepEqual(await jsonOf(response), { error: "Unauthorized" });
    });

    it("rejects missing fields and invalid amounts", async () => {
      const missingMaterial = await initiateRoute.POST(
        makeRequest("/api/checkout/initiate", { body: { amount: 20, asset: "USDC" } })
      );
      assert.equal(missingMaterial.status, 400);
      assert.deepEqual(await jsonOf(missingMaterial), { error: "Missing materialId" });

      const invalidAmount = await initiateRoute.POST(
        makeRequest("/api/checkout/initiate", { body: { materialId: "m1", amount: 0, asset: "USDC" } })
      );
      assert.equal(invalidAmount.status, 400);
      assert.deepEqual(await jsonOf(invalidAmount), { error: "Invalid amount" });

      const missingAsset = await initiateRoute.POST(
        makeRequest("/api/checkout/initiate", { body: { materialId: "m1", amount: 20 } })
      );
      assert.equal(missingAsset.status, 400);
      assert.deepEqual(await jsonOf(missingAsset), { error: "Missing asset" });
    });

    it("creates an intent using the server price and mocked Horizon trustline", async () => {
      const response = await initiateRoute.POST(
        makeRequest("/api/checkout/initiate", {
          body: {
            materialId: "m1",
            amount: 999,
            asset: { code: "USDC", issuer: "GISSUER" },
            buyerCountry: "NG",
          },
        })
      );

      assert.equal(response.status, 201);
      const body = await jsonOf(response);
      assert.equal(body.success, true);
      assert.deepEqual(globalThis.__checkoutTest.trustlineCalls[0], [
        "GABC",
        "USDC",
        "GISSUER",
      ]);
      assert.equal(globalThis.__checkoutTest.taxCalls[0].amount, 20);
      assert.equal(globalThis.__checkoutTest.inserted.length, 1);
      assert.equal(globalThis.__checkoutTest.inserted[0].doc.originalAmount, 20);
      assert.equal(body.checkout.originalAmount, 20);
    });

    it("applies a valid discount", async () => {
      globalThis.__checkoutTest.verifyDiscount = async () => ({
        valid: true,
        discountAmountPercent: 25,
      });

      const response = await initiateRoute.POST(
        makeRequest("/api/checkout/initiate", {
          body: { materialId: "m1", amount: 20, asset: "USDC", discountCode: "SAVE25" },
        })
      );

      assert.equal(response.status, 201);
      assert.equal(globalThis.__checkoutTest.taxCalls[0].amount, 15);
      assert.equal(globalThis.__checkoutTest.inserted[0].doc.discountPercentage, 25);
      assert.equal(globalThis.__checkoutTest.inserted[0].doc.discountAmount, 5);
    });

    it("rejects a buyer with no Horizon trustline", async () => {
      globalThis.__checkoutTest.checkBuyerTrustline = async () => ({
        hasTrustline: false,
        instructions: { message: "Add a trustline", steps: ["step one"] },
      });

      const response = await initiateRoute.POST(
        makeRequest("/api/checkout/initiate", {
          body: { materialId: "m1", amount: 20, asset: "USDC" },
        })
      );

      assert.equal(response.status, 400);
      assert.equal((await jsonOf(response)).error, "missing_trustline");
      assert.equal(globalThis.__checkoutTest.inserted.length, 0);
    });
  });

  describe("GET /api/checkout/initiate", () => {
    it("estimates tax without authentication", async () => {
      globalThis.__checkoutTest.user = null;
      const response = await initiateRoute.GET(
        makeRequest("/api/checkout/initiate?amount=10&asset=USDC&buyerCountry=US", { method: "GET" })
      );
      assert.equal(response.status, 200);
      assert.equal((await jsonOf(response)).success, true);
      assert.equal(globalThis.__checkoutTest.taxCalls[0].amount, 10);
    });

    it("rejects an invalid amount", async () => {
      const response = await initiateRoute.GET(
        makeRequest("/api/checkout/initiate?amount=abc", { method: "GET" })
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await jsonOf(response), { error: "Invalid amount" });
    });
  });

  describe("POST /api/checkout/verify", () => {
    it("requires authentication", async () => {
      globalThis.__checkoutTest.user = null;
      const response = await verifyRoute.POST(
        makeRequest("/api/checkout/verify", { body: { payloadAddress: "GABC" } })
      );
      assert.equal(response.status, 401);
    });

    it("validates the payload address", async () => {
      const response = await verifyRoute.POST(
        makeRequest("/api/checkout/verify", { body: {} })
      );
      assert.equal(response.status, 400);
      assert.equal((await jsonOf(response)).error, "Missing payloadAddress in request body");
    });

    it("accepts a matching address", async () => {
      const response = await verifyRoute.POST(
        makeRequest("/api/checkout/verify", { body: { payloadAddress: " gabc " } })
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await jsonOf(response), { valid: true, address: "GABC" });
    });

    it("rejects a mismatched address", async () => {
      const response = await verifyRoute.POST(
        makeRequest("/api/checkout/verify", { body: { payloadAddress: "GOTHER" } })
      );
      assert.equal(response.status, 403);
      assert.equal((await jsonOf(response)).warnings, 1);
    });

    it("handles duplicate and replayed verification requests idempotently", async () => {
      const request = () =>
        makeRequest("/api/checkout/verify", { body: { payloadAddress: "GABC" } });
      const firstResponse = await verifyRoute.POST(request());
      const first = await jsonOf(firstResponse);
      const replayResponse = await verifyRoute.POST(request());
      const replay = await jsonOf(replayResponse);

      assert.equal(firstResponse.status, 200);
      assert.equal(replayResponse.status, 200);
      assert.equal(first.valid, true);
      assert.equal(replay.valid, true);
      assert.equal(globalThis.__checkoutTest.inserted.length, 0);
    });
  });

  describe("POST /api/checkout/refund", () => {
    it("validates required fields", async () => {
      const response = await refundRoute.POST(
        makeRequest("/api/checkout/refund", { body: { transactionId: "tx1" } })
      );
      assert.equal(response.status, 400);
      assert.equal((await jsonOf(response)).error, "Missing transactionId or refundAmount");
    });

    it("approves a refund within the original purchase value", async () => {
      globalThis.__checkoutTest.purchase = { transactionHash: "tx1", amount: "10" };
      const response = await refundRoute.POST(
        makeRequest("/api/checkout/refund", {
          body: { transactionId: "tx1", refundAmount: "4" },
        })
      );
      assert.equal(response.status, 200);
      assert.equal((await jsonOf(response)).message, "Refund validated successfully");
      assert.deepEqual(globalThis.__checkoutTest.purchaseQuery, { transactionHash: "tx1" });
      assert.equal(globalThis.__checkoutTest.audits.at(-1).event, "refund_approved");
    });

    it("rejects an unknown transaction", async () => {
      const response = await refundRoute.POST(
        makeRequest("/api/checkout/refund", {
          body: { transactionId: "missing", refundAmount: "4" },
        })
      );
      assert.equal(response.status, 400);
      assert.equal((await jsonOf(response)).error, "Transaction not found");
    });

    it("rejects a refund above the original purchase value", async () => {
      globalThis.__checkoutTest.purchase = { transactionHash: "tx1", amount: "10" };
      const response = await refundRoute.POST(
        makeRequest("/api/checkout/refund", {
          body: { transactionId: "tx1", refundAmount: "20" },
        })
      );
      assert.equal(response.status, 400);
      assert.equal(
        (await jsonOf(response)).error,
        "Refund amount exceeds original purchase value"
      );
    });
  });

  describe("POST /api/checkout/verify-promo", () => {
    it("validates the promo code", async () => {
      const response = await promoRoute.POST(
        makeRequest("/api/checkout/verify-promo", { body: {} })
      );
      assert.equal(response.status, 400);
      assert.equal((await jsonOf(response)).error, "missing_code");
    });

    it("accepts a valid, unexpired code", async () => {
      globalThis.__checkoutTest.promo = {
        code: "SAVE20",
        discountPercent: 20,
        active: true,
      };
      const response = await promoRoute.POST(
        makeRequest("/api/checkout/verify-promo", { body: { code: " save20 " } })
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await jsonOf(response), {
        valid: true,
        code: "SAVE20",
        discountPercent: 20,
        discountLabel: "20% off",
        expiresAt: null,
        maxUses: null,
        usedCount: 0,
      });
      assert.deepEqual(globalThis.__checkoutTest.promoQuery, { code: "SAVE20" });
    });

    it("rejects an invalid code", async () => {
      const response = await promoRoute.POST(
        makeRequest("/api/checkout/verify-promo", { body: { code: "NOPE" } })
      );
      assert.equal(response.status, 200);
      assert.equal((await jsonOf(response)).error, "invalid_code");
    });

    it("rejects an expired code", async () => {
      globalThis.__checkoutTest.promo = {
        code: "OLD",
        discountPercent: 10,
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      };
      const response = await promoRoute.POST(
        makeRequest("/api/checkout/verify-promo", { body: { code: "OLD" } })
      );
      assert.equal(response.status, 200);
      assert.equal((await jsonOf(response)).error, "expired");
    });

    it("does not consume a code when the same verification is replayed", async () => {
      globalThis.__checkoutTest.promo = {
        code: "REPLAY",
        discountPercent: 10,
        usedCount: 0,
      };
      const request = () =>
        makeRequest("/api/checkout/verify-promo", { body: { code: "REPLAY" } });
      const firstResponse = await promoRoute.POST(request());
      const first = await jsonOf(firstResponse);
      const replayResponse = await promoRoute.POST(request());
      const replay = await jsonOf(replayResponse);

      assert.equal(first.valid, true);
      assert.equal(replay.valid, true);
      assert.equal(replay.usedCount, 0);
    });
  });
});
