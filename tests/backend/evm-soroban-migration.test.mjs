import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { EvmEntitlementProvider } from "../../src/lib/entitlement/providers/EvmEntitlementProvider.js";
import { SorobanEntitlementProvider } from "../../src/lib/entitlement/providers/SorobanEntitlementProvider.js";
import { DualReadEntitlementProvider } from "../../src/lib/entitlement/providers/DualReadEntitlementProvider.js";
import { getEntitlementProvider } from "../../src/lib/entitlement/factory.js";

function createMockPurchasesDb(purchases = [], materials = []) {
  const purchaseDocs = JSON.parse(JSON.stringify(purchases));
  const materialDocs = JSON.parse(JSON.stringify(materials));

  return {
    collection(name) {
      if (name === "purchases") {
        return {
          async findOne(query) {
            return purchaseDocs.find(p => {
              if (query.buyerAddress && p.buyerAddress.toLowerCase() !== query.buyerAddress.toLowerCase()) return false;
              if (query.materialId && p.materialId !== query.materialId) return false;
              if (query.chain && query.chain.$in && !query.chain.$in.includes(p.chain)) return false;
              if (query.status && query.status.$in) {
                const statusList = query.status.$in.map(s => String(s).toLowerCase());
                if (!statusList.includes(String(p.status).toLowerCase())) return false;
              }
              return true;
            }) || null;
          }
        };
      }
      if (name === "materials") {
        return {
          async findOne(query) {
            return materialDocs.find(m => String(m._id || m.materialId) === String(query._id || query.materialId)) || null;
          }
        };
      }
      return {
        async findOne() { return null; }
      };
    }
  };
}

describe("EVM to Soroban Entitlement Migration - Issue #756", () => {
  describe("Provider Registration and Chain Resolution", () => {
    test("factory resolves providers accurately for chains", () => {
      const evm = getEntitlementProvider("evm");
      assert.equal(evm.getChainType(), "evm");

      const soroban = getEntitlementProvider("soroban");
      assert.equal(soroban.getChainType(), "soroban");

      const stellar = getEntitlementProvider("stellar");
      assert.equal(stellar.getChainType(), "soroban");

      const dual = getEntitlementProvider("dual-read");
      assert.equal(dual.getChainType(), "dual-read");
    });
  });

  describe("Dual-Read Entitlement Verification Path", () => {
    test("honors legacy EVM purchase without requiring on-chain migration", async () => {
      const legacyEvmPurchaser = "0x71c8418c2431ecb1077ed2200f5def739ac4c0ab";
      const legacyMaterialId = "mat-legacy-001";

      const db = createMockPurchasesDb(
        [
          {
            _id: "purch-evm-1",
            materialId: legacyMaterialId,
            buyerAddress: legacyEvmPurchaser,
            chain: "evm",
            status: "COMPLETED",
            transactionHash: "0xabc1234567890def",
            purchasedAt: new Date("2025-01-15T10:00:00Z"),
          }
        ],
        [
          {
            _id: legacyMaterialId,
            title: "Intro to Cryptography (Legacy Listing)",
            price: 10,
            userAddress: "0xcreator_evm",
            createdAt: new Date("2024-12-01T00:00:00Z"),
          }
        ]
      );

      const evmProvider = new EvmEntitlementProvider();
      const sorobanProvider = new SorobanEntitlementProvider();
      const dualProvider = new DualReadEntitlementProvider({
        primaryProvider: sorobanProvider,
        legacyProvider: evmProvider,
      });

      const result = await dualProvider.checkAccess({
        walletAddress: legacyEvmPurchaser,
        materialId: legacyMaterialId,
        db,
      });

      assert.equal(result.hasAccess, true);
      assert.equal(result.compatibilityPath, "evm-legacy");
      assert.equal(result.state, "FINALIZED");
    });

    test("honors new Soroban purchases via primary provider", async () => {
      const stellarBuyer = "GBZXN7PIRZGNMHGA72W2M2UMQLTVVCZBVKU6QYAS5ENMZOWPY2UE63EB";
      const materialId = "mat-stellar-002";

      const db = createMockPurchasesDb(
        [
          {
            _id: "purch-soroban-1",
            materialId,
            buyerAddress: stellarBuyer,
            chain: "soroban",
            status: "COMPLETED",
            transactionHash: "stellar-tx-hash-001",
            purchasedAt: new Date("2026-03-01T12:00:00Z"),
          }
        ],
        [
          {
            _id: materialId,
            title: "Stellar Smart Contracts with Rust",
            price: 20,
            userAddress: "GCREATOR_STELLAR",
            createdAt: new Date("2026-02-15T00:00:00Z"),
          }
        ]
      );

      const evmProvider = new EvmEntitlementProvider();
      const sorobanProvider = new SorobanEntitlementProvider();
      const dualProvider = new DualReadEntitlementProvider({
        primaryProvider: sorobanProvider,
        legacyProvider: evmProvider,
      });

      const result = await dualProvider.checkAccess({
        walletAddress: stellarBuyer,
        materialId,
        db,
      });

      assert.equal(result.hasAccess, true);
      assert.equal(result.compatibilityPath, "soroban-primary");
      assert.equal(result.state, "FINALIZED");
    });

    test("denies access to unlicensed buyer across both chains", async () => {
      const nonBuyer = "0x9999999999999999999999999999999999999999";
      const materialId = "mat-001";
      const db = createMockPurchasesDb([], []);

      const evmProvider = new EvmEntitlementProvider();
      const sorobanProvider = new SorobanEntitlementProvider();
      const dualProvider = new DualReadEntitlementProvider({
        primaryProvider: sorobanProvider,
        legacyProvider: evmProvider,
      });

      const result = await dualProvider.checkAccess({
        walletAddress: nonBuyer,
        materialId,
        db,
      });

      assert.equal(result.hasAccess, false);
      assert.equal(result.state, "UNLICENSED");
    });

    test("denies access and honors revocation for refunded EVM purchases", async () => {
      const refundedBuyer = "0x8888888888888888888888888888888888888888";
      const materialId = "mat-refunded";

      const db = createMockPurchasesDb([
        {
          _id: "purch-refund-1",
          materialId,
          buyerAddress: refundedBuyer,
          chain: "evm",
          status: "COMPLETED",
          settlementState: "Refunded",
        }
      ]);

      const evmProvider = new EvmEntitlementProvider();
      const sorobanProvider = new SorobanEntitlementProvider();
      const dualProvider = new DualReadEntitlementProvider({
        primaryProvider: sorobanProvider,
        legacyProvider: evmProvider,
      });

      const result = await dualProvider.checkAccess({
        walletAddress: refundedBuyer,
        materialId,
        db,
      });

      assert.equal(result.hasAccess, false);
      assert.equal(result.state, "REVOKED");
    });

    test("handles case-insensitive address comparisons for EVM addresses", async () => {
      const lowerAddress = "0xabcdef1234567890abcdef1234567890abcdef12";
      const mixedAddress = "0xABCDEF1234567890AbCdEf1234567890aBcDeF12";
      const materialId = "mat-case-check";

      const db = createMockPurchasesDb([
        {
          _id: "purch-case-1",
          materialId,
          buyerAddress: lowerAddress,
          chain: "evm",
          status: "COMPLETED",
        }
      ]);

      const evmProvider = new EvmEntitlementProvider();
      const result = await evmProvider.checkAccess({
        walletAddress: mixedAddress,
        materialId,
        db,
      });

      assert.equal(result.hasAccess, true);
      assert.equal(result.state, "FINALIZED");
    });
  });
});
