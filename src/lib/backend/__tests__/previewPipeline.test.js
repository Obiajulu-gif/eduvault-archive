// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildZip } from "./helpers/zipFixture.js";

// The sandbox forks a real process; stub it so pipeline tests stay fast and can
// drive every branch (ok / failed / timeout / rejected-shaped output).
const sandboxMock = vi.hoisted(() => ({ runInPreviewSandbox: vi.fn() }));
vi.mock("../previewSandbox.js", () => sandboxMock);

const { runPreviewPipeline } = await import("../previewPipeline.js");

function fakeDb() {
  const cols = new Map();
  const touched = new Set();
  const match = (d, q) =>
    Object.entries(q).every(([k, v]) => {
      if (v && typeof v === "object" && "$nin" in v) return !v.$nin.includes(d?.[k]);
      return d?.[k] === v;
    });
  return {
    touched,
    collection(name) {
      touched.add(name);
      if (!cols.has(name)) cols.set(name, new Map());
      const data = cols.get(name);
      return {
        async findOne(q = {}) {
          for (const d of data.values()) if (match(d, q)) return d;
          return null;
        },
        async updateOne(q, upd, opts = {}) {
          for (const d of data.values())
            if (match(d, q)) {
              if (upd.$set) Object.assign(d, upd.$set);
              if (upd.$inc) for (const [k, n] of Object.entries(upd.$inc)) d[k] = (d[k] || 0) + n;
              return { matchedCount: 1 };
            }
          if (opts.upsert) {
            const d = { ...q };
            if (upd.$setOnInsert) Object.assign(d, upd.$setOnInsert);
            if (upd.$set) Object.assign(d, upd.$set);
            data.set(d.contentHash ?? data.size, d);
            return { upsertedCount: 1 };
          }
          return { matchedCount: 0 };
        },
        async findOneAndUpdate(q, upd) {
          for (const d of data.values())
            if (match(d, q)) {
              if (upd.$set) Object.assign(d, upd.$set);
              if (upd.$inc) for (const [k, n] of Object.entries(upd.$inc)) d[k] = (d[k] || 0) + n;
              return { value: d };
            }
          return { value: null };
        },
        _all: () => [...data.values()],
      };
    },
  };
}

const okResponse = (buf) => ({
  ok: true,
  status: 200,
  headers: { get: (h) => (h === "content-length" ? String(buf.length) : null) },
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
});

const goodDescriptor = {
  kind: "archive",
  declaredType: "application/zip",
  sniffedType: "zip",
  bytes: 42,
  polyglot: false,
  flags: ["zip-bomb"],
  entryCount: 1,
  totalDeclaredUncompressedBytes: 9e7,
  maxCompressionRatio: 1001,
  entries: [{ name: "b", size: 9e7, compressedSize: 10, ratio: 1001, method: 8 }],
};

beforeEach(() => sandboxMock.runInPreviewSandbox.mockReset());

describe("runPreviewPipeline", () => {
  it("stores a ready descriptor and its risk flags when the sandbox + validation pass", async () => {
    sandboxMock.runInPreviewSandbox.mockResolvedValue({ status: "ok", preview: goodDescriptor, previewerVersion: "structural-1" });
    const db = fakeDb();
    const res = await runPreviewPipeline({ db, contentHash: "QmOk", mimeType: "application/zip", fetchImpl: async () => okResponse(buildZip([{ name: "b", data: "x" }])) });

    expect(res.state).toBe("ready");
    const row = db.collection("material_previews")._all()[0];
    expect(row.state).toBe("ready");
    expect(row.descriptor.flags).toContain("zip-bomb");
    expect(row.previewerVersion).toBe("structural-1");
  });

  it("marks failed when the source cannot be fetched (sandbox never runs)", async () => {
    const db = fakeDb();
    const res = await runPreviewPipeline({ db, contentHash: "QmGone", fetchImpl: async () => ({ ok: false, status: 502 }) });
    expect(res.state).toBe("failed");
    expect(sandboxMock.runInPreviewSandbox).not.toHaveBeenCalled();
    expect(db.collection("material_previews")._all()[0].state).toBe("failed");
  });

  it("marks failed on a sandbox timeout", async () => {
    sandboxMock.runInPreviewSandbox.mockResolvedValue({ status: "timeout", reason: "exceeded 10000ms" });
    const db = fakeDb();
    const res = await runPreviewPipeline({ db, contentHash: "QmHang", fetchImpl: async () => okResponse(Buffer.from("x")) });
    expect(res.state).toBe("failed");
    expect(db.collection("material_previews")._all()[0].reason).toMatch(/10000ms/);
  });

  it("marks rejected when the descriptor fails independent validation", async () => {
    sandboxMock.runInPreviewSandbox.mockResolvedValue({
      status: "ok",
      preview: { ...goodDescriptor, flags: ["totally-made-up-flag"] },
      previewerVersion: "structural-1",
    });
    const db = fakeDb();
    const res = await runPreviewPipeline({ db, contentHash: "QmTampered", fetchImpl: async () => okResponse(Buffer.from("x")) });
    expect(res.state).toBe("rejected");
    expect(db.collection("material_previews")._all()[0].state).toBe("rejected");
  });

  it("marks rejected when the sandbox itself rejects the input", async () => {
    sandboxMock.runInPreviewSandbox.mockResolvedValue({ status: "rejected", reason: "input exceeds cap" });
    const db = fakeDb();
    const res = await runPreviewPipeline({ db, contentHash: "QmBig", fetchImpl: async () => okResponse(Buffer.from("x")) });
    expect(res.state).toBe("rejected");
  });

  it("fail-closed: only ever writes material_previews", async () => {
    const db = fakeDb();
    await runPreviewPipeline({ db, contentHash: "QmScope", fetchImpl: async () => ({ ok: false, status: 500 }) });
    expect([...db.touched]).toEqual(["material_previews"]);
  });

  it("is idempotent — a later failure does not downgrade a ready row", async () => {
    sandboxMock.runInPreviewSandbox.mockResolvedValue({ status: "ok", preview: goodDescriptor, previewerVersion: "structural-1" });
    const db = fakeDb();
    await runPreviewPipeline({ db, contentHash: "QmIdem", fetchImpl: async () => okResponse(Buffer.from("x")) });

    sandboxMock.runInPreviewSandbox.mockResolvedValue({ status: "failed", reason: "later crash" });
    const res2 = await runPreviewPipeline({ db, contentHash: "QmIdem", fetchImpl: async () => okResponse(Buffer.from("x")) });

    expect(res2.state).toBe("failed");
    expect(db.collection("material_previews")._all()[0].state).toBe("ready");
  });
});
