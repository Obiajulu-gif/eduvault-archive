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

  it("decodes an escrow.released event with material_id in the data vec", () => {
    const asset = Keypair.random().publicKey();
    const materialId = Buffer.alloc(32, 5);

    const rawEvent = {
      id: "0000000123456789-0000000005",
      ledger: 123458,
      txHash: "cafe0000",
      topic: [symbolTopic("escrow"), symbolTopic("released"), u64Topic(7)],
      value: vecValue([
        nativeToScVal(materialId, { type: "bytes" }),
        new Address(asset).toScVal(),
        nativeToScVal(2_000_000n, { type: "i128" }),
      ]),
    };

    const parsed = parseContractEvent(rawEvent);

    expect(parsed).toMatchObject({
      type: "escrow.released",
      purchaseId: "7",
      materialId: materialId.toString("hex"),
      asset,
      amount: "2000000",
    });
  });

  it("decodes a dispute.resolved event with its resolution variant", () => {
    const materialId = Buffer.alloc(32, 6);

    const rawEvent = {
      id: "0000000123456789-0000000006",
      ledger: 123459,
      txHash: "deadbeef",
      topic: [symbolTopic("dispute"), symbolTopic("resolved"), u64Topic(8), bytesTopic(materialId)],
      value: vecValue([
        nativeToScVal("RefundBuyer", { type: "symbol" }),
        nativeToScVal(123459, { type: "u32" }),
      ]),
    };

    const parsed = parseContractEvent(rawEvent);

    expect(parsed).toMatchObject({
      type: "dispute.resolved",
      purchaseId: "8",
      materialId: materialId.toString("hex"),
      resolution: "RefundBuyer",
      resolvedLedger: 123459,
    });
  });

  it("decodes scholarship events including a null expires_at option", () => {
    const learner = Keypair.random().publicKey();

    const rawEvent = {
      id: "0000000123456789-0000000007",
      ledger: 123460,
      txHash: "feed0000",
      topic: [
        symbolTopic("scholarship"),
        symbolTopic("credits_issued"),
        u64Topic(3),
        addressTopic(learner),
      ],
      value: vecValue([
        new Address(Keypair.random().publicKey()).toScVal(),
        nativeToScVal(500n, { type: "i128" }),
        xdr.ScVal.scvVoid(),
      ]),
    };

    const parsed = parseContractEvent(rawEvent);

    expect(parsed).toMatchObject({
      type: "scholarship.credits_issued",
      grantId: "3",
      learner,
      amount: "500",
      expiresAt: null,
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
