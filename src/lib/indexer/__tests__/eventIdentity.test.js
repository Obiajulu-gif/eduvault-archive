import { describe, it, expect, vi } from "vitest";
import {
  deriveEventId,
  deriveEventIdFromEvent,
  computeQuarantineKey,
  isLegacyFallbackId,
  isCanonicalEventId,
  planEventIdRewrite,
} from "../eventIdentity.js";

const PUBLIC = "Public Global Stellar Network ; September 2015";
const CONTRACT = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";

// A well-formed Soroban RPC `getEvents` event: <19-char TOID>-<10-char event index>.
function rpcEvent(overrides = {}) {
  return {
    id: "0016010972359577600-0000000001",
    ledger: 3727254,
    txHash: "b7d3f2c1a09e8d7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a39281706f5e4",
    operationIndex: 0,
    contractId: CONTRACT,
    network: PUBLIC,
    type: "purchase.completed",
    ...overrides,
  };
}

describe("deriveEventId", () => {
  it("is deterministic — same input, byte-identical id across calls", () => {
    const input = {
      network: PUBLIC,
      contractId: CONTRACT,
      ledger: 100,
      transactionHash: "abc",
      operationIndex: 2,
      eventPosition: "0016010972359577600-0000000003",
    };
    const a = deriveEventId(input);
    const b = deriveEventId({ ...input });
    expect(a.id).toBe(b.id);
    expect(a).toEqual(b);
  });

  it("does not depend on input-object key order", () => {
    const forward = deriveEventId({
      network: PUBLIC,
      contractId: CONTRACT,
      ledger: 100,
      transactionHash: "abc",
      operationIndex: 2,
      eventPosition: "pos-1",
    });
    const shuffled = deriveEventId({
      eventPosition: "pos-1",
      operationIndex: 2,
      transactionHash: "abc",
      ledger: 100,
      contractId: CONTRACT,
      network: PUBLIC,
    });
    expect(shuffled.id).toBe(forward.id);
  });

  it("produces the canonical evt_v1_ form when fully qualified", () => {
    const { id, sufficient, derivation } = deriveEventId({
      network: PUBLIC,
      contractId: CONTRACT,
      ledger: 100,
      transactionHash: "abc",
      operationIndex: 0,
      eventPosition: "pos-1",
    });
    expect(sufficient).toBe(true);
    expect(derivation).toBe("canonical");
    expect(id).toMatch(/^evt_v1_[0-9a-f]{64}$/);
    expect(isCanonicalEventId(id)).toBe(true);
  });

  it("rejects an event with no event position as insufficiently identified", () => {
    const result = deriveEventId({
      network: PUBLIC,
      contractId: CONTRACT,
      ledger: 100,
      transactionHash: "abc",
      operationIndex: 0,
    });
    expect(result.sufficient).toBe(false);
    expect(result.id).toBeNull();
    expect(result.reason).toMatch(/event position/);
  });

  it("degrades to a deterministic position-only id when context is incomplete", () => {
    const result = deriveEventId({ eventPosition: "op-toid-1", contractId: CONTRACT });
    expect(result.sufficient).toBe(true);
    expect(result.derivation).toBe("position-only");
    expect(result.id).toMatch(/^evt_v1_[0-9a-f]{64}$/);
    // ...and stable
    expect(deriveEventId({ contractId: CONTRACT, eventPosition: "op-toid-1" }).id).toBe(result.id);
  });

  it("canonical and position-only derivations never coincide", () => {
    const pos = "0016010972359577600-0000000001";
    const canonical = deriveEventId({
      network: PUBLIC,
      contractId: CONTRACT,
      ledger: 100,
      transactionHash: "abc",
      operationIndex: 0,
      eventPosition: pos,
    });
    const positionOnly = deriveEventId({ network: PUBLIC, contractId: CONTRACT, eventPosition: pos });
    expect(canonical.id).not.toBe(positionOnly.id);
  });

  describe("distinct events within one transaction cannot collide (AC2)", () => {
    const base = {
      network: PUBLIC,
      contractId: CONTRACT,
      ledger: 3727254,
      transactionHash: "b7d3f2c1a09e8d7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a39281706f5e4",
      operationIndex: 0,
      eventPosition: "0016010972359577600-0000000001",
    };

    it("differ by operation index", () => {
      const a = deriveEventId({ ...base, operationIndex: 0 });
      const b = deriveEventId({ ...base, operationIndex: 1 });
      expect(a.id).not.toBe(b.id);
    });

    it("differ by event position (event index within the same operation)", () => {
      const a = deriveEventId({ ...base, eventPosition: "0016010972359577600-0000000001" });
      const b = deriveEventId({ ...base, eventPosition: "0016010972359577600-0000000002" });
      expect(a.id).not.toBe(b.id);
    });

    it("differ by network (shared multi-network database)", () => {
      const a = deriveEventId({ ...base, network: PUBLIC });
      const b = deriveEventId({ ...base, network: "Test SDF Network ; September 2015" });
      expect(a.id).not.toBe(b.id);
    });
  });
});

describe("deriveEventIdFromEvent", () => {
  it("maps a raw Soroban RPC event (txHash, id) onto the canonical derivation", () => {
    const result = deriveEventIdFromEvent(rpcEvent());
    expect(result.sufficient).toBe(true);
    expect(result.derivation).toBe("canonical");
  });

  it("is identical whether the event carries transactionHash or txHash", () => {
    const withTxHash = deriveEventIdFromEvent(rpcEvent({ txHash: "deadbeef" }));
    const withTransactionHash = deriveEventIdFromEvent(
      rpcEvent({ txHash: undefined, transactionHash: "deadbeef" }),
    );
    expect(withTxHash.id).toBe(withTransactionHash.id);
  });

  it("uses eventId when id is absent (dead-letter shape)", () => {
    const a = deriveEventIdFromEvent(rpcEvent({ id: undefined, eventId: "evt-99" }));
    const b = deriveEventIdFromEvent(rpcEvent({ id: "evt-99" }));
    expect(a.id).toBe(b.id);
  });

  it("simulates a second process — a freshly-loaded module derives the same id", async () => {
    const first = deriveEventIdFromEvent(rpcEvent());
    vi.resetModules();
    const fresh = await import("../eventIdentity.js");
    const second = fresh.deriveEventIdFromEvent(rpcEvent());
    expect(second.id).toBe(first.id);
    expect(fresh.deriveEventIdFromEvent).not.toBe(deriveEventIdFromEvent);
  });
});

describe("computeQuarantineKey", () => {
  it("is stable for the same raw event and source", () => {
    const raw = { ledger: 1, topic: ["a", "b"] };
    expect(computeQuarantineKey({ source: "stellar", rawEvent: raw })).toBe(
      computeQuarantineKey({ source: "stellar", rawEvent: raw }),
    );
  });

  it("differs for two different raw payloads (no clobber between distinct rejects)", () => {
    const a = computeQuarantineKey({ source: "stellar", rawEvent: { ledger: 1, value: "x" } });
    const b = computeQuarantineKey({ source: "stellar", rawEvent: { ledger: 1, value: "y" } });
    expect(a).not.toBe(b);
  });

  it("is namespaced", () => {
    expect(computeQuarantineKey({ source: "s", rawEvent: {} })).toMatch(/^quarantine:[0-9a-f]{64}$/);
  });
});

describe("isLegacyFallbackId", () => {
  it("matches the pre-#630 :unknown: dead-letter shape", () => {
    expect(isLegacyFallbackId("stellar:unknown:12345:ab12cd")).toBe(true);
    expect(isLegacyFallbackId("recovery:unknown:?:xyz")).toBe(true);
  });

  it("does not match a canonical id or a bare Soroban id", () => {
    expect(isLegacyFallbackId("evt_v1_" + "0".repeat(64))).toBe(false);
    expect(isLegacyFallbackId("0016010972359577600-0000000001")).toBe(false);
    expect(isLegacyFallbackId(undefined)).toBe(false);
  });
});

describe("planEventIdRewrite", () => {
  const network = PUBLIC;

  it("plans a legacy :unknown: row for rewrite to its canonical id", () => {
    const rawEvent = rpcEvent();
    const plan = planEventIdRewrite({ currentId: "stellar:unknown:3727254:ab12cd", rawEvent, network });
    expect(plan.status).toBe("rewrite");
    expect(plan.canonicalId).toBe(deriveEventIdFromEvent({ ...rawEvent, network }).id);
    expect(plan.reason).toMatch(/Math\.random/);
  });

  it("plans a bare-Soroban-id row for rewrite", () => {
    const rawEvent = rpcEvent();
    const plan = planEventIdRewrite({ currentId: rawEvent.id, rawEvent, network });
    expect(plan.status).toBe("rewrite");
  });

  it("plans an already-canonical row as unchanged", () => {
    const rawEvent = rpcEvent();
    const canonicalId = deriveEventIdFromEvent({ ...rawEvent, network }).id;
    const plan = planEventIdRewrite({ currentId: canonicalId, rawEvent, network });
    expect(plan.status).toBe("unchanged");
    expect(plan.canonicalId).toBe(canonicalId);
  });

  it("plans a row whose raw event has no position as quarantine", () => {
    const plan = planEventIdRewrite({
      currentId: "stellar:unknown:1:zz",
      rawEvent: { ledger: 1, txHash: "abc", operationIndex: 0 },
      network,
    });
    expect(plan.status).toBe("quarantine");
    expect(plan.canonicalId).toBeNull();
  });

  it("plans a row with no stored raw event as quarantine", () => {
    const plan = planEventIdRewrite({ currentId: "x", rawEvent: null, network });
    expect(plan.status).toBe("quarantine");
    expect(plan.reason).toMatch(/no stored raw event/);
  });
});
