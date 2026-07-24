import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHECKOUT_INTENT_ERROR_CODES,
  assertCheckoutIntentMatches,
  assertMaterialStillMatchesIntent,
  atomicUnitsToDecimal,
  createSignedCheckoutIntent,
  decimalToAtomicUnits,
  verifySignedCheckoutIntent,
} from "../../src/lib/checkout/intent.js";

process.env.CHECKOUT_INTENT_SECRET = "test-checkout-intent-secret";

const baseMaterial = {
  id: "mat-1",
  title: "Calculus Notes",
  price: "12.3456789",
  creatorAddress: "GCREATOR",
  status: "active",
};

function createIntent(overrides = {}) {
  return createSignedCheckoutIntent({
    buyerAddress: "GBUYER",
    materialId: "mat-1",
    material: baseMaterial,
    materialVersion: "v1",
    manifestDigest: "sha256:abc",
    network: "TESTNET",
    contractId: "CPURCHASE",
    asset: { code: "USDC", contract: "CASSET" },
    platformFeeBps: 250,
    now: new Date("2026-07-20T10:00:00.000Z"),
    expiresAt: new Date("2026-07-20T10:30:00.000Z"),
    ...overrides,
  });
}

test("checkout intent binds canonical terms with a valid signature", () => {
  const intent = createIntent();

  assert.equal(verifySignedCheckoutIntent(intent), true);
  assert.equal(intent.terms.buyer, "gbuyer");
  assert.equal(intent.terms.amount.units, "123456789");
  assert.equal(intent.terms.feeBreakdown.platformFeeUnits, "3086419");
});

test("checkout intent rejects tampered amount terms", () => {
  const intent = createIntent();
  intent.terms.amount.units = "1";

  assert.throws(
    () => verifySignedCheckoutIntent(intent),
    (error) => error.code === CHECKOUT_INTENT_ERROR_CODES.TAMPERED,
  );
});

test("checkout intent rejects cross-wallet and wrong-network use", () => {
  const intent = createIntent();

  assert.throws(
    () =>
      assertCheckoutIntentMatches({
        intent,
        buyerAddress: "GOTHER",
        materialId: "mat-1",
        network: "TESTNET",
        contractId: "CPURCHASE",
      }),
    (error) => error.code === CHECKOUT_INTENT_ERROR_CODES.WRONG_BUYER,
  );

  assert.throws(
    () =>
      assertCheckoutIntentMatches({
        intent,
        buyerAddress: "GBUYER",
        materialId: "mat-1",
        network: "PUBLIC",
        contractId: "CPURCHASE",
      }),
    (error) => error.code === CHECKOUT_INTENT_ERROR_CODES.WRONG_NETWORK,
  );
});

test("checkout intent enforces expiry boundaries", () => {
  const intent = createIntent();

  assert.doesNotThrow(() =>
    assertCheckoutIntentMatches({
      intent,
      buyerAddress: "GBUYER",
      materialId: "mat-1",
      network: "TESTNET",
      contractId: "CPURCHASE",
      now: new Date("2026-07-20T10:29:59.000Z"),
    }),
  );

  assert.throws(
    () =>
      assertCheckoutIntentMatches({
        intent,
        buyerAddress: "GBUYER",
        materialId: "mat-1",
        network: "TESTNET",
        contractId: "CPURCHASE",
        now: new Date("2026-07-20T10:30:00.000Z"),
      }),
    (error) => error.code === CHECKOUT_INTENT_ERROR_CODES.EXPIRED,
  );
});

test("checkout intent detects material price or version changes", () => {
  const intent = createIntent();

  assert.doesNotThrow(() =>
    assertMaterialStillMatchesIntent({
      intent,
      material: baseMaterial,
      materialVersion: "v1",
      manifestDigest: "sha256:abc",
    }),
  );

  assert.throws(
    () =>
      assertMaterialStillMatchesIntent({
        intent,
        material: { ...baseMaterial, price: "13.0000000" },
        materialVersion: "v1",
        manifestDigest: "sha256:abc",
      }),
    (error) => error.code === CHECKOUT_INTENT_ERROR_CODES.CHANGED,
  );

  assert.throws(
    () =>
      assertMaterialStillMatchesIntent({
        intent,
        material: baseMaterial,
        materialVersion: "v2",
        manifestDigest: "sha256:def",
      }),
    (error) => error.code === CHECKOUT_INTENT_ERROR_CODES.CHANGED,
  );
});

test("atomic unit conversion is deterministic and rejects excess precision", () => {
  assert.equal(decimalToAtomicUnits("0.0000001").toString(), "1");
  assert.equal(atomicUnitsToDecimal("123456789"), "12.3456789");
  assert.throws(() => decimalToAtomicUnits("1.00000001"));
});
