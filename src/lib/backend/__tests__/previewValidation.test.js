// @vitest-environment node
import { describe, it, expect } from "vitest";
import { validatePreviewOutput } from "../previewValidation.js";

const archive = () => ({
  kind: "archive",
  declaredType: "application/zip",
  sniffedType: "zip",
  bytes: 100,
  polyglot: false,
  flags: ["macro"],
  entryCount: 2,
  totalDeclaredUncompressedBytes: 50,
  maxCompressionRatio: 1,
  entries: [{ name: "a.txt", size: 20, compressedSize: 20, ratio: 1, method: 0 }],
});

describe("validatePreviewOutput", () => {
  it("accepts a well-formed archive descriptor", () => {
    const r = validatePreviewOutput(archive());
    expect(r.ok).toBe(true);
    expect(r.contentType).toBe("application/json");
  });

  it("rejects a non-object", () => {
    expect(validatePreviewOutput("nope").ok).toBe(false);
    expect(validatePreviewOutput(null).ok).toBe(false);
    expect(validatePreviewOutput([]).ok).toBe(false);
  });

  it("rejects an unknown flag", () => {
    expect(validatePreviewOutput({ ...archive(), flags: ["totally-made-up"] }).ok).toBe(false);
  });

  it("rejects an unexpected top-level key", () => {
    expect(validatePreviewOutput({ ...archive(), evil: "payload" }).ok).toBe(false);
  });

  it("rejects a script sequence smuggled into an entry name", () => {
    const d = archive();
    d.entries[0].name = "<script>fetch('//evil')</script>";
    expect(validatePreviewOutput(d).ok).toBe(false);
  });

  it("rejects control / bidi characters in strings", () => {
    const d = { kind: "text", declaredType: "text/plain", sniffedType: "text", bytes: 3, polyglot: false, flags: [], textHead: "a\x07b", truncated: false };
    expect(validatePreviewOutput(d).ok).toBe(false);
    d.textHead = "a\u202Eb";
    expect(validatePreviewOutput(d).ok).toBe(false);
  });

  it("rejects too many listed entries and an oversized descriptor", () => {
    const many = { ...archive(), entries: Array.from({ length: 200 }, () => ({ name: "x", size: 1, compressedSize: 1, ratio: 1, method: 0 })) };
    expect(validatePreviewOutput(many).ok).toBe(false);
    const huge = { ...archive(), declaredType: "x".repeat(300) };
    expect(validatePreviewOutput(huge).ok).toBe(false);
  });

  it("rejects an invalid kind or sniffedType", () => {
    expect(validatePreviewOutput({ ...archive(), kind: "iframe" }).ok).toBe(false);
    expect(validatePreviewOutput({ ...archive(), sniffedType: "svg" }).ok).toBe(false);
  });

  it("rejects a bad pdfVersion", () => {
    expect(validatePreviewOutput({ kind: "document", declaredType: "application/pdf", sniffedType: "pdf", bytes: 10, polyglot: false, flags: [], pdfVersion: "13.37; drop table", headerAtOffsetZero: true }).ok).toBe(false);
  });

  it("rejects non-integer / negative numeric fields", () => {
    expect(validatePreviewOutput({ ...archive(), entryCount: -5 }).ok).toBe(false);
    expect(validatePreviewOutput({ ...archive(), bytes: Number.NaN }).ok).toBe(false);
  });
});
