// @vitest-environment node
import { describe, it, expect } from "vitest";
import { generatePreview, FLAGS } from "../previewSandbox/previewers/structuralPreview.mjs";
import { buildZip, SYMLINK_EXTERNAL_ATTR } from "./helpers/zipFixture.js";

const zipMime = "application/zip";

describe("structuralPreview — archives", () => {
  it("lists entries and flags a macro without inflating data", () => {
    const d = generatePreview({
      input: buildZip([
        { name: "notes.txt", data: "x".repeat(500) },
        { name: "word/vbaProject.bin", data: "m" },
      ]),
      mimeType: zipMime,
    });
    expect(d.kind).toBe("archive");
    expect(d.entryCount).toBe(2);
    expect(d.entries.map((e) => e.name)).toEqual(["notes.txt", "word/vbaProject.bin"]);
    expect(d.flags).toContain("macro");
    expect(d.flags).not.toContain("zip-bomb");
  });

  it("flags a zip bomb from the declared ratio (never decompresses)", () => {
    const d = generatePreview({
      input: buildZip([{ name: "b", data: "a".repeat(20), deflate: true, forceUncompressed: 90_000_000 }]),
      mimeType: zipMime,
    });
    expect(d.flags).toContain("zip-bomb");
  });

  it("flags path traversal and absolute paths", () => {
    expect(generatePreview({ input: buildZip([{ name: "../../etc/passwd", data: "x" }]), mimeType: zipMime }).flags).toContain("path-traversal");
    expect(generatePreview({ input: buildZip([{ name: "/etc/shadow", data: "x" }]), mimeType: zipMime }).flags).toContain("path-traversal");
    expect(generatePreview({ input: buildZip([{ name: "a\\b.txt", data: "x" }]), mimeType: zipMime }).flags).toContain("path-traversal");
  });

  it("flags symlink entries", () => {
    const d = generatePreview({
      input: buildZip([{ name: "link", data: "/etc/passwd", externalAttr: SYMLINK_EXTERNAL_ATTR }]),
      mimeType: zipMime,
    });
    expect(d.flags).toContain("symlink-entry");
  });

  it("flags overlapping local-header offsets as a bomb tell", () => {
    const d = generatePreview({
      input: buildZip([
        { name: "x", data: "1", overrideLocalOffset: 0 },
        { name: "y", data: "2", overrideLocalOffset: 0 },
      ]),
      mimeType: zipMime,
    });
    expect(d.flags).toEqual(expect.arrayContaining(["overlapping-entries", "zip-bomb"]));
  });

  it("flags encryption, executables and nested archives", () => {
    expect(generatePreview({ input: buildZip([{ name: "e", data: "z", bitFlag: 1 }]), mimeType: zipMime }).flags).toContain("encrypted");
    expect(generatePreview({ input: buildZip([{ name: "run.exe", data: "z" }]), mimeType: zipMime }).flags).toContain("executable-entry");
    expect(generatePreview({ input: buildZip([{ name: "inner.zip", data: "z" }]), mimeType: zipMime }).flags).toContain("nested-archive");
  });

  it("caps the entry count and marks the central directory truncated", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ name: `f${i}`, data: "" }));
    const d = generatePreview({ input: buildZip(many), mimeType: zipMime, limits: { maxEntries: 100 } });
    expect(d.entryCount).toBe(100);
    expect(d.flags).toContain("too-many-entries");
    expect(d.entries.length).toBeLessThanOrEqual(64);
  });

  it("reports a truncated archive index instead of throwing", () => {
    const good = buildZip([{ name: "a", data: "x" }]);
    const d = generatePreview({ input: good.subarray(0, good.length - 10), mimeType: zipMime });
    expect(d.flags).toEqual(expect.arrayContaining(["parse-error"]));
  });
});

describe("structuralPreview — polyglots", () => {
  it("detects a ZIP embedded in a file that presents as a PDF (PDF+ZIP polyglot)", () => {
    const z = buildZip([{ name: "a", data: "x" }], { prepend: Buffer.from("%PDF-1.5\n%mock\n") });
    const d = generatePreview({ input: z, mimeType: "application/pdf" });
    expect(d.sniffedType).toBe("pdf");
    expect(d.polyglot).toBe(true);
    expect(d.flags).toContain("embedded-archive");
  });

  it("detects a ZIP end-of-central-directory appended to an image (GIFAR-style)", () => {
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20, 1), buildZip([{ name: "a", data: "x" }])]);
    const d = generatePreview({ input: gif, mimeType: "image/gif" });
    expect(d.polyglot).toBe(true);
    expect(d.flags).toContain("embedded-archive");
  });

  it("detects a %PDF marker not at offset 0 in a non-PDF file", () => {
    const d = generatePreview({ input: Buffer.concat([Buffer.from("junk padding "), Buffer.from("%PDF-1.7\n")]), mimeType: "text/plain" });
    expect(d.flags).toEqual(expect.arrayContaining(["embedded-pdf", "polyglot"]));
    expect(d.polyglot).toBe(true);
  });
});

describe("structuralPreview — text", () => {
  it("returns a sanitized head with script/js sequences defanged", () => {
    const d = generatePreview({ input: Buffer.from("hello\n<script>alert(1)</script>\njavascript:evil"), mimeType: "text/plain" });
    expect(d.kind).toBe("text");
    expect(d.textHead).not.toMatch(/<script/i);
    expect(d.textHead).not.toMatch(/javascript:/i);
    expect(d.textHead).toContain("hello");
  });

  it("marks truncation past the head cap", () => {
    const d = generatePreview({ input: Buffer.from("a".repeat(5000)), mimeType: "text/plain", limits: { textHeadBytes: 100 } });
    expect(d.truncated).toBe(true);
    expect(d.textHead.length).toBeLessThanOrEqual(100);
  });
});

it("every emitted flag is in the fixed FLAGS enum", () => {
  const samples = [
    generatePreview({ input: buildZip([{ name: "../x", data: "a", bitFlag: 1 }]), mimeType: zipMime }),
    generatePreview({ input: Buffer.from("plain text"), mimeType: "text/plain" }),
  ];
  for (const d of samples) for (const f of d.flags) expect(FLAGS).toContain(f);
});
