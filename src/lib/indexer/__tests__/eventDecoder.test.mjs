import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";

import { Keypair, Networks, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { decodeContractEvent } from "../eventDecoder.js";

const REGISTRY_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAREGI";
const PURCHASE_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPRCH";

const MANIFEST = {
  [Networks.TESTNET]: {
    materialRegistry: REGISTRY_ID,
    purchaseManager: PURCHASE_ID,
  },
};

function symbolTopicXdr(value) {
  return nativeToScVal(value, { type: "symbol" }).toXDR("base64");
}

function bytes32TopicXdr(hex) {
  return nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" }).toXDR("base64");
}

function vecDataXdr(scVals) {
  return xdr.ScVal.scvVec(scVals).toXDR("base64");
}

function scBytes32(hex) {
  return nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
}

function scString(s) {
  return nativeToScVal(s, { type: "string" });
}

function scAddress(strkey) {
  return nativeToScVal(strkey, { type: "address" });
}

function scBool(b) {
  return nativeToScVal(b, { type: "bool" });
}

function scI128(n) {
  return nativeToScVal(n, { type: "i128" });
}

function scU32(n) {
  return nativeToScVal(n, { type: "u32" });
}

function scVoid() {
  return xdr.ScVal.scvVoid();
}

const materialId = randomBytes(32).toString("hex");
const creator = Keypair.random().publicKey();
const buyer = Keypair.random().publicKey();
const seller = Keypair.random().publicKey();
const asset = Keypair.random().publicKey();

function baseOptions(overrides = {}) {
  return { networkPassphrase: Networks.TESTNET, manifestOverrides: MANIFEST, ...overrides };
}

test("decodes a valid material.registered event", () => {
  const rawEvent = {
    contractId: REGISTRY_ID,
    ledger: 1000,
    txHash: "tx-abc",
    id: "1000-0",
    topic: [symbolTopicXdr("material"), symbolTopicXdr("registered")],
    value: vecDataXdr([
      scBytes32(materialId),
      scAddress(creator),
      scString("ipfs://metadata"),
      scBytes32(randomBytes(32).toString("hex")),
      scBytes32(randomBytes(32).toString("hex")),
      scVoid(), // status enum, passthrough
      xdr.ScVal.scvVec([]), // quotes, passthrough
      xdr.ScVal.scvVec([]), // payoutShares, passthrough
    ]),
  };

  const result = decodeContractEvent(rawEvent, baseOptions());
  assert.equal(result.ok, true);
  assert.equal(result.event.type, "material.registered");
  assert.equal(result.event.schemaVersion, 1);
  assert.equal(result.event.materialId, materialId);
  assert.equal(result.event.creator, creator);
  assert.equal(result.event.metadataUri, "ipfs://metadata");
  assert.equal(result.event.ledger, 1000);
  assert.equal(result.event.transactionHash, "tx-abc");
  assert.match(result.event.eventId, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.event.raw, rawEvent);
});

test("derives a deterministic event id from the network and chain position", () => {
  const rawEvent = {
    contractId: REGISTRY_ID,
    ledger: 1000,
    txHash: "tx-abc",
    id: "1000-0",
    topic: [symbolTopicXdr("material"), symbolTopicXdr("registered")],
    value: vecDataXdr([
      scBytes32(materialId), scAddress(creator), scString("ipfs://metadata"),
      scBytes32(randomBytes(32).toString("hex")),
      scBytes32(randomBytes(32).toString("hex")), scVoid(),
      xdr.ScVal.scvVec([]), xdr.ScVal.scvVec([]),
    ]),
  };
  const first = decodeContractEvent(rawEvent, baseOptions());
  const second = decodeContractEvent({ ...rawEvent }, baseOptions());
  assert.equal(first.event.eventId, second.event.eventId);
});

test("decodes a valid purchase.completed event with a large i128 amount", () => {
  const largeAmount = 123456789012345678901234n; // exceeds Number.MAX_SAFE_INTEGER
  const rawEvent = {
    contractId: PURCHASE_ID,
    ledger: 2000,
    txHash: "tx-def",
    topic: [
      symbolTopicXdr("purchase"),
      symbolTopicXdr("completed"),
    ],
    value: vecDataXdr([
      nativeToScVal(42, { type: "u64" }),
      scBytes32(materialId),
      scAddress(buyer),
      scAddress(seller),
      scAddress(asset),
      scI128(largeAmount),
      scI128(1000n),
      scI128(largeAmount - 1000n),
      scBool(true),
      nativeToScVal(Buffer.from("deadbeef", "hex"), { type: "bytes" }),
    ]),
  };

  const result = decodeContractEvent(rawEvent, baseOptions());
  assert.equal(result.ok, true);
  assert.equal(result.event.type, "purchase.completed");
  assert.equal(result.event.amount, largeAmount.toString());
  assert.equal(typeof result.event.amount, "string", "i128 must not be coerced to a lossy Number");
  assert.equal(result.event.buyerAddress, buyer);
  assert.equal(result.event.sellerAddress, seller);
  assert.equal(result.event.materialId, materialId);
  assert.equal(result.event.transactionId, "deadbeef");
});

test("rejects malformed topics (fewer than 2)", () => {
  const rawEvent = {
    contractId: REGISTRY_ID,
    topic: [symbolTopicXdr("material")],
    value: vecDataXdr([]),
  };
  const result = decodeContractEvent(rawEvent, baseOptions());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "malformed_topics");
});

test("rejects a non-Symbol leading topic (e.g. topics in the wrong position)", () => {
  const rawEvent = {
    contractId: REGISTRY_ID,
    // materialId placed where the event-name Symbol should be — simulates
    // duplicate/reordered topic positions.
    topic: [bytes32TopicXdr(materialId), symbolTopicXdr("registered")],
    value: vecDataXdr([]),
  };
  const result = decodeContractEvent(rawEvent, baseOptions());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "malformed_topics");
});

test("rejects an unknown event name without throwing", () => {
  const rawEvent = {
    contractId: REGISTRY_ID,
    topic: [symbolTopicXdr("material"), symbolTopicXdr("teleported")],
    value: vecDataXdr([]),
  };
  const result = decodeContractEvent(rawEvent, baseOptions());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown_event");
});

test("rejects an event from a contract id not in the allowlisted manifest", () => {
  const rawEvent = {
    contractId: "CSOMEUNKNOWNCONTRACTIDNOTINMANIFEST00000000000000000000",
    topic: [symbolTopicXdr("material"), symbolTopicXdr("registered")],
    value: vecDataXdr([]),
  };
  const result = decodeContractEvent(rawEvent, baseOptions());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unlisted_contract");
});

test("rejects an event whose network passphrase isn't allowlisted", () => {
  const rawEvent = {
    contractId: REGISTRY_ID,
    topic: [symbolTopicXdr("material"), symbolTopicXdr("registered")],
    value: vecDataXdr([]),
  };
  // REGISTRY_ID is only allowlisted under TESTNET in MANIFEST.
  const result = decodeContractEvent(rawEvent, baseOptions({ networkPassphrase: Networks.PUBLIC }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unlisted_contract");
});

test("rejects a known topic pair emitted by the wrong contract kind", () => {
  const rawEvent = {
    // purchase.completed topics, but from the material-registry contract id.
    contractId: REGISTRY_ID,
    topic: [symbolTopicXdr("purchase"), symbolTopicXdr("completed")],
    value: vecDataXdr([]),
  };
  const result = decodeContractEvent(rawEvent, baseOptions());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unlisted_contract");
});

test("rejects malformed data (too few vec elements)", () => {
  const rawEvent = {
    contractId: REGISTRY_ID,
    topic: [symbolTopicXdr("material"), symbolTopicXdr("registered")],
    value: vecDataXdr([scBytes32(materialId), scAddress(creator)]), // missing required fields
  };
  const result = decodeContractEvent(rawEvent, baseOptions());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "malformed_data");
});

test("rejects malformed data (wrong type for a byte32 field)", () => {
  const rawEvent = {
    contractId: REGISTRY_ID,
    topic: [symbolTopicXdr("material"), symbolTopicXdr("registered")],
    value: vecDataXdr([
      scString("not-bytes"), // materialId should be 32 bytes, not a string
      scAddress(creator),
      scString("ipfs://x"),
      scBytes32(randomBytes(32).toString("hex")),
      scBytes32(randomBytes(32).toString("hex")),
      scVoid(),
      xdr.ScVal.scvVec([]),
      xdr.ScVal.scvVec([]),
    ]),
  };
  const result = decodeContractEvent(rawEvent, baseOptions());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "malformed_data");
});

test("tolerates an additive trailing field (backward-compatible schema evolution)", () => {
  const rawEvent = {
    contractId: REGISTRY_ID,
    topic: [symbolTopicXdr("material"), symbolTopicXdr("registered")],
    value: vecDataXdr([
      scBytes32(materialId),
      scAddress(creator),
      scString("ipfs://metadata"),
      scBytes32(randomBytes(32).toString("hex")),
      scBytes32(randomBytes(32).toString("hex")),
      scVoid(),
      xdr.ScVal.scvVec([]),
      xdr.ScVal.scvVec([]),
      scU32(999), // hypothetical new field appended on-chain; decoder doesn't know it yet
    ]),
  };
  const result = decodeContractEvent(rawEvent, baseOptions());
  assert.equal(result.ok, true);
  assert.equal(result.event.materialId, materialId);
});

test("rejects malformed topic XDR without throwing", () => {
  const rawEvent = {
    contractId: REGISTRY_ID,
    topic: ["not-valid-base64-xdr!!", symbolTopicXdr("registered")],
    value: vecDataXdr([]),
  };
  assert.doesNotThrow(() => decodeContractEvent(rawEvent, baseOptions()));
  const result = decodeContractEvent(rawEvent, baseOptions());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "malformed_topics");
});
