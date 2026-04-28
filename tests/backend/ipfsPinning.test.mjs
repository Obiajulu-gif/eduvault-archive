import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf-8");
}

describe("IPFS pinning reconciliation - code structure", () => {
  it("provides retry, audit, and garbage collection helpers", () => {
    const content = readRepoFile("src/lib/ipfsPinning.js");

    for (const exp of [
      "retryPinataCall",
      "uploadFileToIpfs",
      "uploadJsonToIpfs",
      "getPinStatus",
      "unpinCid",
      "recordIpfsUpload",
      "markUploadsRegistered",
      "reconcileIpfsPins",
      "extractCid",
    ]) {
      assert.ok(content.includes(`export`) && content.includes(exp), `should export ${exp}`);
    }

    assert.ok(content.includes("maxRetries"), "should bound Pinata retry attempts");
    assert.ok(content.includes("/data/pinList"), "should audit active Pinata pins");
    assert.ok(content.includes("/pinning/unpin/"), "should unpin garbage-collected CIDs");
  });

  it("tracks IPFS uploads in schema contracts", () => {
    const content = readRepoFile("src/lib/backend/schemaContracts.js");

    assert.ok(content.includes('ipfsUploads: "ipfs_uploads"'), "should define ipfs uploads collection");
    assert.ok(content.includes("{ keys: { cid: 1 }, options: { unique: true } }"), "should index upload CIDs");
    assert.ok(content.includes("{ keys: { status: 1, createdAt: 1 } }"), "should index stale upload cleanup");
  });

  it("routes upload and material creation through IPFS tracking helpers", () => {
    const uploadRoute = readRepoFile("src/app/api/upload/route.js");
    const materialsRoute = readRepoFile("src/app/api/materials/route.js");
    const validation = readRepoFile("src/lib/api/validation.js");

    assert.ok(uploadRoute.includes("uploadFileToIpfs"), "upload route should use retrying file upload");
    assert.ok(uploadRoute.includes("uploadJsonToIpfs"), "upload route should use retrying JSON upload");
    assert.ok(uploadRoute.includes("recordIpfsUpload"), "upload route should track uploaded CIDs");
    assert.ok(materialsRoute.includes("markUploadsRegistered"), "material route should link tracked uploads");
    assert.ok(validation.includes("metadataUrl"), "material validation should preserve metadata CIDs");
  });

  it("workflow reconciliation endpoint runs IPFS reconciliation", () => {
    const content = readRepoFile("src/app/api/workflows/reconcile/route.js");

    assert.ok(content.includes("reconcileIpfsPins"), "reconcile route should run IPFS audit and GC");
    assert.ok(content.includes("dryRun"), "reconcile route should support dry runs");
    assert.ok(content.includes("gcOlderThanHours"), "reconcile route should allow GC age control");
  });
});
