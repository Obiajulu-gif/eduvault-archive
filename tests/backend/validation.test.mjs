import assert from "node:assert/strict";
import { test } from "node:test";

import {
  sanitizeObject,
  normalizeStringList,
  validateMaterialPayload,
  validateProfilePayload,
} from "../../src/lib/api/validation.js";
import { assertRuntimeEnv } from "../../src/lib/env.js";

test("validateProfilePayload normalizes and sanitizes profile input", () => {
  const profile = validateProfilePayload({
    fullName: "  Ada Creator  ",
    email: "ADA@EXAMPLE.COM ",
    walletAddress: "0x0000000000000000000000000000000000000001",
    bio: "hello\u0000world",
  });

  assert.equal(profile.fullName, "Ada Creator");
  assert.equal(profile.email, "ada@example.com");
  assert.equal(profile.bio, "helloworld");
  assert.equal(profile.walletAddressLower, "0x0000000000000000000000000000000000000001");
});

test("validateMaterialPayload rejects invalid price and unknown visibility", () => {
  assert.throws(
    () => validateMaterialPayload({ title: "Notes", fileUrl: "ipfs://file", price: -1 }),
    /Invalid price/
  );
  assert.throws(
    () =>
      validateMaterialPayload({
        title: "Notes",
        fileUrl: "ipfs://file",
        visibility: "everyone",
      }),
    /Invalid visibility/
  );
});

test("validateMaterialPayload preserves preview fields", () => {
  const material = validateMaterialPayload({
    title: "Notes",
    fileUrl: "ipfs://file",
    coverImageUrl: "https://example.com/cover.png",
    shortSummary: "  Useful summary  ",
    learningOutcomes: "Outcome 1\nOutcome 2,Outcome 3",
    tableOfContents: ["Intro", "Methods", "Conclusion"],
    sampleNotes: "First note,Second note",
  });

  assert.equal(material.coverImageUrl, "https://example.com/cover.png");
  assert.equal(material.shortSummary, "Useful summary");
  assert.deepEqual(material.learningOutcomes, ["Outcome 1", "Outcome 2", "Outcome 3"]);
  assert.deepEqual(material.tableOfContents, ["Intro", "Methods", "Conclusion"]);
  assert.deepEqual(material.sampleNotes, ["First note", "Second note"]);
  assert.equal(material.storageKey, "ipfs://file");
  assert.equal(material.fileUrl, "ipfs://file");
});

test("validateMaterialPayload normalizes derivedFrom (#888)", () => {
  const fromId = validateMaterialPayload({ title: "Notes", fileUrl: "ipfs://file", derivedFrom: "66f000000000000000000000" });
  assert.deepEqual(fromId.derivedFrom, { materialId: "66f000000000000000000000", externalId: null, relation: null });

  const fromObject = validateMaterialPayload({
    title: "Notes",
    fileUrl: "ipfs://file",
    derivedFrom: { externalId: "sis-1", relation: " adaptation " },
  });
  assert.deepEqual(fromObject.derivedFrom, { materialId: null, externalId: "sis-1", relation: "adaptation" });

  assert.throws(
    () => validateMaterialPayload({ title: "Notes", fileUrl: "ipfs://file", derivedFrom: {} }),
    /derivedFrom requires/
  );
  assert.equal(validateMaterialPayload({ title: "Notes", fileUrl: "ipfs://file" }).derivedFrom, null);
});

test("sanitizeObject strips control characters from stored metadata", () => {
  assert.deepEqual(sanitizeObject({ title: "  Math\u0000 Notes " }), { title: "Math Notes" });
});

test("normalizeStringList trims empty values and caps the list", () => {
  assert.deepEqual(
    normalizeStringList([" first ", "", "second", "third"], { maxItems: 2 }),
    ["first", "second"]
  );
});

test("assertRuntimeEnv skips placeholder checks in CI", () => {
  const restoreEnv = (key, value) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };

  const originalCi = process.env.CI;
  const originalEnv = process.env.NODE_ENV;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalMongoUri = process.env.MONGODB_URI;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalPinataJwt = process.env.PINATA_JWT;
  const originalGatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;

  process.env.CI = "true";
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_APP_URL = "";
  process.env.MONGODB_URI = "";
  process.env.JWT_SECRET = "";
  process.env.PINATA_JWT = "";
  process.env.NEXT_PUBLIC_GATEWAY_URL = "";

  assert.doesNotThrow(() => assertRuntimeEnv());

  restoreEnv("CI", originalCi);
  restoreEnv("NODE_ENV", originalEnv);
  restoreEnv("NEXT_PUBLIC_APP_URL", originalAppUrl);
  restoreEnv("MONGODB_URI", originalMongoUri);
  restoreEnv("JWT_SECRET", originalJwtSecret);
  restoreEnv("PINATA_JWT", originalPinataJwt);
  restoreEnv("NEXT_PUBLIC_GATEWAY_URL", originalGatewayUrl);
});
