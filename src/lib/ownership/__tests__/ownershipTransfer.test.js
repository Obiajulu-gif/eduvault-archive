import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCEPT_LEASE_MS,
  DEFAULT_TRANSFER_TTL_MS,
  MIN_TRANSFER_TTL_MS,
  TransferState,
  acceptTransfer,
  cancelTransfer,
  declineTransfer,
  initiateTransfer,
  listTransfersForUser,
  recoverStuckTransfers,
} from "../ownershipTransfer.js";
import { createFakeDb } from "./fakeDb.js";

const OWNER = "GOWNER000000000000000000000000000000000000000000000000AA";
const RECIPIENT = "GRECIPIENT0000000000000000000000000000000000000000000BB";
const STRANGER = "GSTRANGER00000000000000000000000000000000000000000000CC";
const T0 = new Date("2026-10-23T12:00:00Z");
const after = (ms) => new Date(T0.getTime() + ms);

let db;

function seedMaterial(overrides = {}) {
  db.seed("materials", { _id: "m1", userAddress: OWNER, title: "Calculus", version: 1, ...overrides });
}

async function propose(overrides = {}) {
  return initiateTransfer(db, { materialId: "m1", actorAddress: OWNER, toAddress: RECIPIENT, now: T0, ...overrides });
}

async function expectCode(promise, code, reason) {
  const error = await promise.then(
    () => null,
    (e) => e
  );
  expect(error, "expected a rejection").not.toBeNull();
  expect(error.code).toBe(code);
  if (reason) expect(error.details.reason).toBe(reason);
}

beforeEach(() => {
  db = createFakeDb();
  seedMaterial();
});

describe("initiateTransfer", () => {
  it("creates a pending transfer without changing the owner", async () => {
    const { transfer, replayed } = await propose();
    expect(replayed).toBe(false);
    expect(transfer.state).toBe(TransferState.PENDING);
    expect(transfer.expiresAt.getTime()).toBe(T0.getTime() + DEFAULT_TRANSFER_TTL_MS);
    expect(db.get("materials", "m1").userAddress).toBe(OWNER);
  });

  it("is idempotent for an identical live proposal", async () => {
    const first = await propose();
    const second = await propose({ now: after(1000) });
    expect(second.replayed).toBe(true);
    expect(second.transfer._id).toBe(first.transfer._id);
  });

  it("rejects a competing proposal to a different recipient", async () => {
    await propose();
    await expectCode(propose({ toAddress: STRANGER }), "CONFLICT_IN_PROGRESS", "transfer_in_progress");
  });

  it("maps a lost insert race on the unique index to a conflict", async () => {
    db.failNext("ownership_transfers", "insertOne", Object.assign(new Error("dup"), { code: 11000 }));
    await expectCode(propose(), "CONFLICT_IN_PROGRESS");
  });

  it("only lets the owner propose", async () => {
    await expectCode(propose({ actorAddress: STRANGER }), "AUTH_FORBIDDEN", "not_owner");
  });

  it("validates input", async () => {
    await expectCode(propose({ toAddress: OWNER.toLowerCase() }), "VALIDATION_FAILED", "self_transfer");
    await expectCode(propose({ toAddress: "" }), "VALIDATION_FIELD");
    await expectCode(propose({ ttlMs: MIN_TRANSFER_TTL_MS - 1 }), "VALIDATION_FIELD");
    await expectCode(propose({ materialId: "" }), "VALIDATION_FIELD");
  });

  it("returns not found for an unknown material", async () => {
    await expectCode(propose({ materialId: "nope" }), "NOT_FOUND_MATERIAL");
  });

  it.each([
    [{ isDeleted: true }, "material_deleted"],
    [{ status: "suspended" }, "material_suspended"],
    [{ status: "quarantined" }, "material_quarantined"],
  ])("refuses to transfer a restricted material %j", async (patch, reason) => {
    seedMaterial(patch);
    await expectCode(propose(), "CONFLICT_STATE", reason);
  });

  it("allows a new proposal once the previous one expired", async () => {
    const first = await propose();
    const next = await propose({ toAddress: STRANGER, now: after(DEFAULT_TRANSFER_TTL_MS + 1) });
    expect(next.replayed).toBe(false);
    expect(next.transfer._id).not.toBe(first.transfer._id);
    expect(db.get("ownership_transfers", first.transfer._id).state).toBe(TransferState.EXPIRED);
  });
});

describe("acceptTransfer", () => {
  it("moves ownership to the recipient and records the previous owner", async () => {
    const { transfer } = await propose();
    const result = await acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(1000) });
    expect(result.transfer.state).toBe(TransferState.ACCEPTED);
    const material = db.get("materials", "m1");
    expect(material.userAddress).toBe(RECIPIENT);
    expect(material.previousOwnerAddress).toBe(OWNER);
    expect(material.ownershipTransferId).toBe(transfer._id);
    expect(material.version).toBe(2);
    expect(result.transfer.history.map((h) => h.action)).toEqual(["initiated", "accepting", "accepted"]);
  });

  it("matches the recipient address case-insensitively", async () => {
    const { transfer } = await propose();
    const result = await acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT.toLowerCase(), now: after(1000) });
    expect(result.transfer.state).toBe(TransferState.ACCEPTED);
  });

  it("is a no-op replay when accepted twice, and does not bump the version again", async () => {
    const { transfer } = await propose();
    await acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(1000) });
    const again = await acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(2000) });
    expect(again.replayed).toBe(true);
    expect(db.get("materials", "m1").version).toBe(2);
  });

  it("forbids the owner and hides the transfer from strangers", async () => {
    const { transfer } = await propose();
    await expectCode(acceptTransfer(db, { transferId: transfer._id, actorAddress: OWNER }), "AUTH_FORBIDDEN", "wrong_party");
    await expectCode(acceptTransfer(db, { transferId: transfer._id, actorAddress: STRANGER }), "NOT_FOUND");
    expect(db.get("materials", "m1").userAddress).toBe(OWNER);
  });

  it("rejects an unknown transfer", async () => {
    await expectCode(acceptTransfer(db, { transferId: "missing", actorAddress: RECIPIENT }), "NOT_FOUND");
  });

  it("refuses an expired offer and marks it expired", async () => {
    const { transfer } = await propose();
    await expectCode(
      acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(DEFAULT_TRANSFER_TTL_MS) }),
      "CONFLICT_STATE",
      "transfer_expired"
    );
    expect(db.get("ownership_transfers", transfer._id).state).toBe(TransferState.EXPIRED);
    expect(db.get("materials", "m1").userAddress).toBe(OWNER);
  });

  it("refuses a declined or cancelled offer", async () => {
    const { transfer } = await propose();
    await declineTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(1) });
    await expectCode(acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(2) }), "CONFLICT_STATE", "transfer_not_pending");
  });

  it("fails the transfer when the owner changed after the offer", async () => {
    const { transfer } = await propose();
    seedMaterial({ userAddress: STRANGER });
    await expectCode(acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(1000) }), "CONFLICT_STATE", "owner_changed");
    expect(db.get("ownership_transfers", transfer._id).state).toBe(TransferState.FAILED);
    expect(db.get("materials", "m1").userAddress).toBe(STRANGER);
  });

  it("fails the transfer when the material was deleted after the offer", async () => {
    const { transfer } = await propose();
    seedMaterial({ isDeleted: true });
    await expectCode(acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(1000) }), "CONFLICT_STATE", "owner_changed");
    expect(db.get("materials", "m1").userAddress).toBe(OWNER);
  });

  it("lets only one of two concurrent accepts win", async () => {
    const { transfer } = await propose();
    const results = await Promise.allSettled([
      acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(1000) }),
      acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(1000) }),
    ]);
    // Both end with the owner swapped exactly once; the loser either replays or is told it is in progress.
    expect(db.get("materials", "m1").version).toBe(2);
    expect(db.get("ownership_transfers", transfer._id).state).toBe(TransferState.ACCEPTED);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });

  it("rolls the claim back so the recipient can retry after a failed owner swap", async () => {
    const { transfer } = await propose();
    const now = after(1000);
    // First findOneAndUpdate (the claim) succeeds; the owner swap then throws.
    let calls = 0;
    const originalCollection = db.collection;
    db.collection = (name) => {
      const c = originalCollection(name);
      if (name !== "materials") return c;
      return {
        ...c,
        findOneAndUpdate: async (...args) => {
          if (calls++ === 0) throw new Error("mongo unavailable");
          return c.findOneAndUpdate(...args);
        },
      };
    };
    await expect(acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now })).rejects.toThrow("mongo unavailable");
    expect(db.get("materials", "m1").userAddress).toBe(OWNER);
    expect(db.get("ownership_transfers", transfer._id).state).toBe(TransferState.PENDING);

    const retry = await acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(2000) });
    expect(retry.transfer.state).toBe(TransferState.ACCEPTED);
    expect(db.get("materials", "m1").userAddress).toBe(RECIPIENT);
  });
});

describe("declineTransfer / cancelTransfer", () => {
  it("lets the recipient decline and the owner cancel, both idempotently", async () => {
    const a = await propose();
    const declined = await declineTransfer(db, { transferId: a.transfer._id, actorAddress: RECIPIENT, now: after(1) });
    expect(declined.transfer.state).toBe(TransferState.DECLINED);
    expect((await declineTransfer(db, { transferId: a.transfer._id, actorAddress: RECIPIENT, now: after(2) })).replayed).toBe(true);

    const b = await propose({ now: after(3) });
    const cancelled = await cancelTransfer(db, { transferId: b.transfer._id, actorAddress: OWNER, now: after(4) });
    expect(cancelled.transfer.state).toBe(TransferState.CANCELLED);
    expect((await cancelTransfer(db, { transferId: b.transfer._id, actorAddress: OWNER, now: after(5) })).replayed).toBe(true);
    expect(db.get("materials", "m1").userAddress).toBe(OWNER);
  });

  it("enforces who may decline or cancel", async () => {
    const { transfer } = await propose();
    await expectCode(declineTransfer(db, { transferId: transfer._id, actorAddress: OWNER }), "AUTH_FORBIDDEN");
    await expectCode(cancelTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT }), "AUTH_FORBIDDEN");
    await expectCode(cancelTransfer(db, { transferId: transfer._id, actorAddress: STRANGER }), "NOT_FOUND");
  });

  it("lets an admin cancel on the owner's behalf", async () => {
    const { transfer } = await propose();
    const result = await cancelTransfer(db, { transferId: transfer._id, actorAddress: STRANGER, isAdmin: true, now: after(1) });
    expect(result.transfer.state).toBe(TransferState.CANCELLED);
  });

  it("cannot cancel after the recipient accepted", async () => {
    const { transfer } = await propose();
    await acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(1) });
    await expectCode(cancelTransfer(db, { transferId: transfer._id, actorAddress: OWNER, now: after(2) }), "CONFLICT_STATE");
  });
});

describe("recoverStuckTransfers", () => {
  async function strandAccepting() {
    const { transfer } = await propose();
    db.seed("ownership_transfers", {
      ...db.get("ownership_transfers", transfer._id),
      state: TransferState.ACCEPTING,
      leaseExpiresAt: after(ACCEPT_LEASE_MS),
    });
    return transfer;
  }

  it("expires overdue pending offers", async () => {
    const { transfer } = await propose();
    const summary = await recoverStuckTransfers(db, { now: after(DEFAULT_TRANSFER_TTL_MS + 1) });
    expect(summary.expired).toBe(1);
    expect(db.get("ownership_transfers", transfer._id).state).toBe(TransferState.EXPIRED);
  });

  it("rolls back an abandoned accept when the owner never changed", async () => {
    const transfer = await strandAccepting();
    expect(await recoverStuckTransfers(db, { now: after(ACCEPT_LEASE_MS - 1) })).toEqual({ expired: 0, completed: 0, rolledBack: 0 });
    const summary = await recoverStuckTransfers(db, { now: after(ACCEPT_LEASE_MS + 1) });
    expect(summary.rolledBack).toBe(1);
    expect(db.get("ownership_transfers", transfer._id).state).toBe(TransferState.PENDING);
    expect(db.get("materials", "m1").userAddress).toBe(OWNER);
  });

  it("completes an abandoned accept when the owner swap already landed", async () => {
    const transfer = await strandAccepting();
    seedMaterial({ userAddress: RECIPIENT, ownershipTransferId: transfer._id, ownershipTransferredAt: after(500) });
    const summary = await recoverStuckTransfers(db, { now: after(ACCEPT_LEASE_MS + 1) });
    expect(summary.completed).toBe(1);
    expect(db.get("ownership_transfers", transfer._id).state).toBe(TransferState.ACCEPTED);
  });

  it("does not steal a transfer from an unrelated new owner", async () => {
    const transfer = await strandAccepting();
    seedMaterial({ userAddress: STRANGER });
    await recoverStuckTransfers(db, { now: after(ACCEPT_LEASE_MS + 1) });
    expect(db.get("ownership_transfers", transfer._id).state).toBe(TransferState.PENDING);
    await expectCode(acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(ACCEPT_LEASE_MS + 2) }), "CONFLICT_STATE", "owner_changed");
  });

  it("lets a retried accept settle a stale lease on its own", async () => {
    const transfer = await strandAccepting();
    const result = await acceptTransfer(db, { transferId: transfer._id, actorAddress: RECIPIENT, now: after(ACCEPT_LEASE_MS + 1) });
    expect(result.transfer.state).toBe(TransferState.ACCEPTED);
    expect(db.get("materials", "m1").userAddress).toBe(RECIPIENT);
  });

  it("is safe to run repeatedly", async () => {
    await strandAccepting();
    const now = after(ACCEPT_LEASE_MS + 1);
    await recoverStuckTransfers(db, { now });
    expect(await recoverStuckTransfers(db, { now })).toEqual({ expired: 0, completed: 0, rolledBack: 0 });
  });
});

describe("listTransfersForUser", () => {
  it("lists sent and received transfers newest first and reports overdue offers as expired", async () => {
    const a = await propose();
    const rows = await listTransfersForUser(db, { address: RECIPIENT, now: after(DEFAULT_TRANSFER_TTL_MS + 1) });
    expect(rows.map((r) => r._id)).toEqual([a.transfer._id]);
    expect(rows[0].state).toBe(TransferState.EXPIRED);
    expect(await listTransfersForUser(db, { address: STRANGER, now: T0 })).toEqual([]);
  });
});
