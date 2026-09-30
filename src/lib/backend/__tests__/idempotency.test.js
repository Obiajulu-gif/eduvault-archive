import { describe, expect, it } from "vitest";
import {
  extractIdempotencyKey,
  getIdempotencyOutcome,
  hashPayload,
  withIdempotency,
} from "../idempotency.js";
import { AppError } from "@/lib/errors/AppError.js";

function makeDb() {
  const records = new Map();
  const collection = {
    findOne: async (query) => records.get(query._id) || null,
    insertOne: async (doc) => {
      if (records.has(doc._id)) {
        const error = new Error("duplicate");
        error.code = 11000;
        throw error;
      }
      records.set(doc._id, doc);
      return { insertedId: doc._id };
    },
    deleteOne: async (query) => {
      records.delete(query._id);
      return { deletedCount: 1 };
    },
  };
  return { collection: () => collection, store: records };
}

describe("idempotency", () => {
  it("runs the handler once and replays the stored result on retry after success", async () => {
    const db = makeDb();
    let callCount = 0;
    const handler = async () => {
      callCount += 1;
      return { id: "mat_1", created: true };
    };

    const first = await withIdempotency(db, "key-1", { title: "Notes" }, handler);
    expect(first.result).toEqual({ id: "mat_1", created: true });
    expect(first.replayed).toBe(false);
    expect(callCount).toBe(1);

    const second = await withIdempotency(db, "key-1", { title: "Notes" }, handler);
    expect(second.result).toEqual({ id: "mat_1", created: true });
    expect(second.replayed).toBe(true);
    expect(callCount).toBe(1);
  });

  it("allows retry after failure and does not persist a failed outcome as completed", async () => {
    const db = makeDb();
    let callCount = 0;
    const handler = async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("transient network error");
      return { id: "mat_2", created: true };
    };

    await expect(withIdempotency(db, "key-2", { title: "Draft" }, handler)).rejects.toThrow(
      "transient network error"
    );
    expect(callCount).toBe(1);

    const retry = await withIdempotency(db, "key-2", { title: "Draft" }, handler);
    expect(retry.result).toEqual({ id: "mat_2", created: true });
    expect(retry.replayed).toBe(false);
    expect(callCount).toBe(2);

    const stored = await getIdempotencyOutcome(db, "key-2");
    expect(stored.status).toBe("completed");
  });

  it("rejects key collision: same key with a different payload", async () => {
    const db = makeDb();
    const handler = async () => ({ id: "mat_3" });

    await withIdempotency(db, "key-3", { title: "Original" }, handler);

    await expect(
      withIdempotency(db, "key-3", { title: "Different" }, handler)
    ).rejects.toMatchObject({
      code: "CONFLICT_IDEMPOTENCY_KEY",
      status: 409,
    });
  });

  it("treats semantically identical payloads as the same request regardless of key order", async () => {
    const db = makeDb();
    let callCount = 0;
    const handler = async () => {
      callCount += 1;
      return { ok: true };
    };

    await withIdempotency(db, "key-4", { a: 1, b: { c: 2, d: 3 } }, handler);
    const replay = await withIdempotency(db, "key-4", { b: { d: 3, c: 2 }, a: 1 }, handler);
    expect(replay.replayed).toBe(true);
    expect(callCount).toBe(1);
  });

  it("allows reuse of expired keys", async () => {
    const db = makeDb();
    let callCount = 0;
    const handler = async () => {
      callCount += 1;
      return { attempt: callCount };
    };

    await withIdempotency(db, "key-5", { x: 1 }, handler, { ttlMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const retry = await withIdempotency(db, "key-5", { x: 1 }, handler, { ttlMs: 50 });
    expect(retry.replayed).toBe(false);
    expect(retry.result).toEqual({ attempt: 2 });
    expect(callCount).toBe(2);
  });

  it("returns null outcome for absent or expired keys", async () => {
    const db = makeDb();
    expect(await getIdempotencyOutcome(db, "missing")).toBeNull();

    db.store.set("expired-key", {
      _id: "expired-key",
      status: "completed",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await getIdempotencyOutcome(db, "expired-key")).toBeNull();
  });

  it("runs the handler without idempotency when no key is provided", async () => {
    const db = makeDb();
    let callCount = 0;
    const handler = async () => {
      callCount += 1;
      return { ok: true };
    };

    await withIdempotency(db, null, {}, handler);
    await withIdempotency(db, null, {}, handler);
    expect(callCount).toBe(2);
  });

  it("extracts the key from the idempotency-key header", () => {
    const headers = new Headers();
    headers.set("idempotency-key", "header-key-1");
    expect(extractIdempotencyKey({ headers })).toBe("header-key-1");
  });

  it("extracts the key from the body when no header is present", () => {
    const headers = new Headers();
    expect(extractIdempotencyKey({ headers, body: { idempotencyKey: "body-key-1" } })).toBe(
      "body-key-1"
    );
  });

  it("returns null when no key is supplied", () => {
    expect(extractIdempotencyKey({ headers: new Headers(), body: {} })).toBeNull();
    expect(extractIdempotencyKey({})).toBeNull();
  });

  it("produces stable hashes for identical payloads", () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });

  it("wraps collision errors as AppError with user-safe metadata", async () => {
    const db = makeDb();
    const handler = async () => ({ ok: true });
    await withIdempotency(db, "key-6", { v: 1 }, handler);

    try {
      await withIdempotency(db, "key-6", { v: 2 }, handler);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("CONFLICT_IDEMPOTENCY_KEY");
      expect(error.userMessage).toBeTruthy();
      expect(error.recovery).toBeTruthy();
    }
  });
});
