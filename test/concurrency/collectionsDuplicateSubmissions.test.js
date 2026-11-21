// @vitest-environment node
/**
 * Duplicate-submission concurrency for POST /api/collections (#1150).
 *
 * The other duplicate-submission suites drive `withIdempotency` with a fake
 * database. This one drives the real route handler against the in-memory
 * MongoDB started by test/global-setup-outbox.js, because the guarantee here
 * comes from a real unique index, which a fake collection cannot model.
 *
 *   1. Normal: N concurrent creates with one idempotency key (body or header)
 *      store one collection; one 201, the rest 200 `duplicate: true`, one id.
 *   2. Keyless: creates without a key are not deduplicated.
 *   3. Failure + retry: a failed insert stores nothing; the retry with the same
 *      key creates exactly once and later retries replay it. A non-string key
 *      is rejected (400) because the unique index only covers string keys.
 *   4. Authorization: missing or forged sessions are rejected before any write,
 *      and a key is scoped to its creator, so another creator reusing it gets
 *      their own collection and never sees the first one.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { MongoClient } from "mongodb";
import jwt from "jsonwebtoken";

const { database } = vi.hoisted(() => ({ database: { db: null } }));

// The global setup mocks @/lib/mongodb with fixed fakes; use the real server.
vi.mock("@/lib/mongodb", () => ({ getDb: vi.fn(async () => database.db) }));
vi.mock("@/lib/api/hardening", () => ({
  withApiHardening: vi.fn((req, options, handler) => handler()),
}));

import { POST } from "@/app/api/collections/route";

const SECRET = "collections-duplicate-submission-secret";
const CONTENDERS = 8;

const cookieFor = (sub, secret = SECRET) => `auth_token=${jwt.sign({ sub }, secret)}`;

function post(body, { cookie, headers = {} } = {}) {
  return new Request("http://localhost/api/collections", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
  });
}

async function send(request) {
  const response = await POST(request);
  return { status: response.status, body: await response.json() };
}

let client;
let realDb;

/**
 * Wraps the collections collection so the first `contenders` findOne calls wait
 * for each other: every request passes the "already exists?" lookup before any
 * of them inserts, which forces the unique-index (E11000) path on every run.
 * `failInsertsOnce` makes the first insert fail like a dropped connection.
 */
function useCollections({ contenders = 0, failInsertsOnce = false } = {}) {
  let arrived = 0;
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  if (contenders === 0) open();
  let insertFailed = !failInsertsOnce;

  database.db = {
    collection(name) {
      const col = realDb.collection(name);
      return {
        createIndex: (...args) => col.createIndex(...args),
        findOne: async (...args) => {
          if (arrived < contenders) {
            arrived += 1;
            if (arrived === contenders) open();
            await gate;
          }
          return col.findOne(...args);
        },
        insertOne: async (...args) => {
          if (!insertFailed) {
            insertFailed = true;
            throw new Error("connection reset during insert");
          }
          return col.insertOne(...args);
        },
      };
    },
  };
}

const stored = () => realDb.collection("collections").find({}).toArray();

beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  realDb = client.db("collections_duplicate_submissions_test");
});

afterAll(async () => {
  await realDb.dropDatabase();
  await client.close();
});

beforeEach(async () => {
  await realDb.collection("collections").deleteMany({});
  useCollections();
});

describe("POST /api/collections duplicate submissions (#1150)", () => {
  it("normal: concurrent creates with one body key store exactly one collection", async () => {
    useCollections({ contenders: CONTENDERS });
    const cookie = cookieFor("creator-a");
    const results = await Promise.all(
      Array.from({ length: CONTENDERS }, () =>
        send(post({ title: "Algebra I", idempotencyKey: "key-1" }, { cookie })),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200 && r.body.duplicate === true)).toHaveLength(CONTENDERS - 1);
    expect(new Set(results.map((r) => String(r.body.id))).size).toBe(1);
    expect(await stored()).toHaveLength(1);
  });

  it("normal: the x-idempotency-key header deduplicates the same way", async () => {
    useCollections({ contenders: CONTENDERS });
    const cookie = cookieFor("creator-a");
    const results = await Promise.all(
      Array.from({ length: CONTENDERS }, () =>
        send(post({ title: "Geometry" }, { cookie, headers: { "x-idempotency-key": "hdr-1" } })),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => String(r.body.id))).size).toBe(1);
    expect(await stored()).toHaveLength(1);
  });

  it("keyless: creates without a key are never deduplicated", async () => {
    const cookie = cookieFor("creator-a");
    const first = await send(post({ title: "Notes 1" }, { cookie }));
    const second = await send(post({ title: "Notes 2" }, { cookie }));

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body.id).not.toBe(second.body.id);
    expect(await stored()).toHaveLength(2);
  });

  it("failure + retry: a failed insert stores nothing and the retry creates exactly once", async () => {
    useCollections({ failInsertsOnce: true });
    const cookie = cookieFor("creator-a");
    const submit = () => send(post({ title: "Calculus", idempotencyKey: "retry-1" }, { cookie }));

    const failed = await submit();
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "Server error" });
    expect(await stored()).toHaveLength(0);

    const retried = await submit();
    expect(retried.status).toBe(201);

    const replays = await Promise.all([submit(), submit(), submit()]);
    expect(replays.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(replays.every((r) => String(r.body.id) === String(retried.body.id))).toBe(true);
    expect(await stored()).toHaveLength(1);
  });

  it("failure: a non-string idempotency key is rejected before any write", async () => {
    const cookie = cookieFor("creator-a");
    const results = await Promise.all([
      send(post({ title: "Numeric key", idempotencyKey: 42 }, { cookie })),
      send(post({ title: "Object key", idempotencyKey: { $ne: null } }, { cookie })),
    ]);

    expect(results.map((r) => r.status)).toEqual([400, 400]);
    expect(await stored()).toHaveLength(0);
  });

  it("authorization: missing or forged sessions are rejected before any write", async () => {
    const body = { title: "Stolen", idempotencyKey: "auth-1" };
    const results = await Promise.all([
      send(post(body)),
      send(post(body, { cookie: cookieFor("creator-a", "not-the-server-secret") })),
      send(post(body, { cookie: "auth_token=not-a-jwt" })),
    ]);

    expect(results.map((r) => r.status)).toEqual([401, 401, 401]);
    expect(await stored()).toHaveLength(0);
  });

  it("authorization: an idempotency key is scoped to its creator", async () => {
    useCollections({ contenders: 2 });
    const [a, b] = await Promise.all([
      send(post({ title: "A's collection", idempotencyKey: "shared-key" }, { cookie: cookieFor("creator-a") })),
      send(post({ title: "B's collection", idempotencyKey: "shared-key" }, { cookie: cookieFor("creator-b") })),
    ]);

    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.title).toBe("B's collection");
    expect(b.body.creatorId).toBe("creator-b");
    expect(await stored()).toHaveLength(2);
  });
});
