import { describe, expect, it } from "vitest"
import { hashChunk, validateUploadSpec } from "./uploadSessions"

const digest = "a".repeat(64)
describe("upload session integrity", () => {
  it("hashes repeated chunks deterministically", () => {
    expect(hashChunk(Buffer.from("chunk"))).toBe("6c87f68371b28954707ebb92afee7ccffb74c6f71ec8fea8a98cf6104289585b")
    expect(hashChunk(Buffer.from("chunk"))).toBe(hashChunk(Buffer.from("chunk")))
  })

  it("accepts multi-GB metadata without buffering a file", () => {
    expect(() => validateUploadSpec({
      fileName: "archive.zip", mimeType: "application/zip",
      size: 3 * 1024 * 1024 * 1024, sha256: digest,
    })).not.toThrow()
  })

  it("rejects oversized and malformed specifications", () => {
    expect(() => validateUploadSpec({ fileName: "x", mimeType: "text/plain", size: 6 * 1024 ** 3, sha256: digest })).toThrow(/5GB/)
    expect(() => validateUploadSpec({ fileName: "x", mimeType: "text/plain", size: 1, sha256: "bad" })).toThrow(/sha256/)
  })
})
