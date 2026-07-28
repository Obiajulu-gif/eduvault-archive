import { describe, it, expect } from "vitest";
import { xdr, nativeToScVal, Address, Keypair } from "@stellar/stellar-sdk";
import { parseContractEvent } from "../eventParser.js";

function toBase64(scVal) {
  return scVal.toXDR("base64");
}

function symbolTopic(name) {
  return toBase64(nativeToScVal(name, { type: "symbol" }));
}

function u64Topic(value) {
  return toBase64(nativeToScVal(BigInt(value), { type: "u64" }));
}

function bytesTopic(buffer) {
  return toBase64(nativeToScVal(buffer, { type: "bytes" }));
}

function addressTopic(strkey) {
  return toBase64(new Address(strkey).toScVal());
}

function vecValue(scVals) {
  return toBase64(xdr.ScVal.scvVec(scVals));
}

describe("parseContractEvent", () => {
  it("decodes a purchase.completed event into the shape applyIndexedEvent expects", () => {
    const buyer = Keypair.random().publicKey();
    const seller = Keypair.random().publicKey();
    const asset = Keypair.random().publicKey();
    const materialId = Buffer.alloc(32, 7);

    const rawEvent = {
      id: "0000000123456789-0000000001",
      ledger: 123456,
      txHash: "abcd1234ef",
      ledgerClosedAt: "2026-07-25T00:00:00Z",
      contractId: "CCONTRACTID000000000000000000000000000000000000000000",
      topic: [
        symbolTopic("purchase"),
        symbolTopic("completed"),
        u64Topic(42),
        bytesTopic(materialId),
        addressTopic(buyer),
      ],
      value: vecValue([
        new Address(seller).toScVal(),
        new Address(asset).toScVal(),
        nativeToScVal(5_000_000n, { type: "i128" }),
        nativeToScVal(50_000n, { type: "i128" }),
        nativeToScVal(4_950_000n, { type: "i128" }),
        xdr.ScVal.scvBool(true),
        nativeToScVal(Buffer.alloc(16, 9), { type: "bytes" }),
      ]),
    };

    const parsed = parseContractEvent(rawEvent);

    expect(parsed).toMatchObject({
      type: "purchase.completed",
      purchaseId: "42",
      materialId: materialId.toString("hex"),
      buyerAddress: buyer,
      sellerAddress: seller,
      asset,
      amount: "5000000",
      id: rawEvent.id,
      ledger: 123456,
      transactionHash: "abcd1234ef",
      contractId: rawEvent.contractId,
      timestamp: "2026-07-25T00:00:00Z",
    });
  });

  it("decodes a material.registered event", () => {
    const creator = Keypair.random().publicKey();
    const materialId = Buffer.alloc(32, 3);

    const rawEvent = {
      id: "0000000123456789-0000000002",
      ledger: 123457,
      txHash: "beef0000",
      ledgerClosedAt: "2026-07-25T00:05:00Z",
      topic: [
        symbolTopic("material"),
        symbolTopic("registered"),
        bytesTopic(materialId),
        addressTopic(creator),
      ],
      value: vecValue([
        nativeToScVal("ipfs://eduvault/material/1", { type: "string" }),
        nativeToScVal(Buffer.alloc(32, 1), { type: "bytes" }),
        nativeToScVal(Buffer.alloc(32, 2), { type: "bytes" }),
        nativeToScVal(0, { type: "u32" }),
        xdr.ScVal.scvVec([]),
        xdr.ScVal.scvVec([]),
      ]),
    };

    const parsed = parseContractEvent(rawEvent);

    expect(parsed).toMatchObject({
      type: "material.registered",
      materialId: materialId.toString("hex"),
      creatorAddress: creator,
      ledger: 123457,
      transactionHash: "beef0000",
    });
  });

  it("returns null for an unrecognized topic instead of throwing", () => {
    const rawEvent = {
      id: "0000000123456789-0000000003",
      ledger: 1,
      txHash: "x",
      topic: [symbolTopic("some_other"), symbolTopic("event_kind")],
      value: vecValue([]),
    };

    expect(parseContractEvent(rawEvent)).toBeNull();
  });

  it("returns null for malformed/undecodable XDR instead of throwing", () => {
    const rawEvent = {
      id: "0000000123456789-0000000004",
      ledger: 1,
      txHash: "x",
      topic: ["not-valid-base64-xdr!!"],
      value: vecValue([]),
    };

    expect(parseContractEvent(rawEvent)).toBeNull();
  });

  it("returns null for a null/undefined event", () => {
    expect(parseContractEvent(null)).toBeNull();
    expect(parseContractEvent(undefined)).toBeNull();
  });
});
