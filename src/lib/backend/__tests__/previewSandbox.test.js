// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInPreviewSandbox } from "../previewSandbox.js";
import { buildZip } from "./helpers/zipFixture.js";

const LOCKDOWN = join(dirname(fileURLToPath(import.meta.url)), "..", "previewSandbox", "lockdown.mjs");

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "preview-sandbox-test-"));

  // Spins forever after receiving a job.
  writeFileSync(join(dir, "hang.mjs"), `process.once("message", () => { while (true) {} });\nsetTimeout(() => {}, 60000);\n`);

  // Fills the JS heap.
  writeFileSync(join(dir, "heap.mjs"), `process.once("message", () => { const a = []; while (true) a.push(new Array(200000).fill("xxxxxxxx")); });\nsetTimeout(() => {}, 60000);\n`);

  // Applies the real lockdown, then probes every egress + spawn vector.
  writeFileSync(
    join(dir, "probe.mjs"),
    `import { applyLockdown } from ${JSON.stringify(LOCKDOWN)};
applyLockdown();
process.once("message", async () => {
  const out = {};
  const t = async (k, fn) => { try { await fn(); out[k] = "REACHED"; } catch (e) { out[k] = e.code || String(e.message).slice(0, 40); } };
  await t("fetch", () => fetch("https://example.com/"));
  await t("net", async () => { const n = await import("node:net"); n.connect(80, "example.com"); });
  await t("http", async () => { const h = await import("node:http"); h.get("http://example.com/"); });
  await t("dns", async () => { const d = await import("node:dns/promises"); await d.lookup("example.com"); });
  await t("dgram", async () => { const d = await import("node:dgram"); d.createSocket("udp4"); });
  await t("spawn", async () => { const c = await import("node:child_process"); c.spawn("id"); });
  await t("fsWriteTmp", async () => { const f = await import("node:fs"); f.writeFileSync("/tmp/preview_sandbox_pwn", "x"); });
  await t("fsReadEtc", async () => { const f = await import("node:fs"); f.readFileSync("/etc/passwd"); });
  out.envKeys = Object.keys(process.env);
  process.send({ ok: true, preview: out });
  process.exit(0);
});
setTimeout(() => process.exit(0), 30000).unref();
`,
  );

  // Returns an oversized descriptor.
  writeFileSync(
    join(dir, "huge.mjs"),
    `process.once("message", () => { process.send({ ok: true, preview: { kind: "text", declaredType: "", sniffedType: "text", bytes: 1, polyglot: false, flags: [], junk: "x".repeat(200000) } }); process.exit(0); });\nsetTimeout(() => {}, 60000);\n`,
  );
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
    rmSync("/tmp/preview_sandbox_pwn", { force: true });
  } catch {
    /* ignore */
  }
});

describe("runInPreviewSandbox — happy path", () => {
  it("runs the structural previewer and returns a validated-shape descriptor", async () => {
    const r = await runInPreviewSandbox({ input: buildZip([{ name: "a.txt", data: "hi" }]), mimeType: "application/zip" });
    expect(r.status).toBe("ok");
    expect(r.preview.kind).toBe("archive");
    expect(r.previewerVersion).toBe("structural-1");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects input over the size cap without forking", async () => {
    const r = await runInPreviewSandbox({ input: Buffer.alloc(11 * 1024 * 1024, 1), limits: { maxInputBytes: 1024 } });
    expect(r.status).toBe("rejected");
  });

  it("fails an empty input", async () => {
    expect((await runInPreviewSandbox({ input: Buffer.alloc(0) })).status).toBe("failed");
  });
});

describe("runInPreviewSandbox — cannot hang, exhaust memory, or reach the network", () => {
  it("hard-kills a previewer that hangs, within the timeout", async () => {
    const start = Date.now();
    const r = await runInPreviewSandbox({ input: Buffer.from("x"), limits: { timeoutMs: 1200 }, childEntry: join(dir, "hang.mjs") });
    expect(r.status).toBe("timeout");
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("contains a previewer that exhausts the JS heap (host process survives)", async () => {
    const r = await runInPreviewSandbox({ input: Buffer.from("x"), limits: { timeoutMs: 3000, heapMb: 32 }, childEntry: join(dir, "heap.mjs") });
    // Either the heap cap aborts the child ("failed") or the wall-clock timeout
    // hard-kills it ("timeout") — both mean the run was contained.
    expect(["failed", "timeout"]).toContain(r.status);
    expect(process.memoryUsage()).toBeTruthy(); // this process is still alive
  });

  it("blocks every network egress and process-spawn vector inside the sandbox", async () => {
    const r = await runInPreviewSandbox({ input: Buffer.from("x"), limits: { timeoutMs: 4000 }, childEntry: join(dir, "probe.mjs") });
    expect(r.status).toBe("ok");
    const out = r.preview;
    expect(out.fetch).toBe("ERR_PREVIEW_SANDBOX_BLOCKED");
    for (const k of ["net", "http", "dns", "dgram", "spawn"]) {
      expect(out[k], `${k} must be blocked`).toBe("ERR_PREVIEW_SANDBOX_BLOCKED");
    }
    expect(out.fsWriteTmp).toBe("ERR_ACCESS_DENIED");
    expect(out.fsReadEtc).toBe("ERR_ACCESS_DENIED");
    expect(out.envKeys).toEqual([]); // no secret visible inside
  });

  it("does not create a file even when the previewer tries to write one", async () => {
    await runInPreviewSandbox({ input: Buffer.from("x"), limits: { timeoutMs: 4000 }, childEntry: join(dir, "probe.mjs") });
    const { existsSync } = await import("node:fs");
    expect(existsSync("/tmp/preview_sandbox_pwn")).toBe(false);
  });

  it("rejects an oversized descriptor from the sandbox", async () => {
    const r = await runInPreviewSandbox({ input: Buffer.from("x"), limits: { timeoutMs: 4000, maxOutputBytes: 1024 }, childEntry: join(dir, "huge.mjs") });
    expect(r.status).toBe("rejected");
  });
});
