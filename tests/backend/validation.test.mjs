import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MATERIAL_FILE_MAX_BYTES,
  MATERIAL_VISIBILITY_VALUES,
  sanitizeObject,
  validateMaterialCreatePayload,
  validateMaterialPayload,
  validateMaterialUpdatePayload,
  validateProfilePayload,
} from "../../src/lib/api/validation.js";

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

test("validateMaterialCreatePayload normalizes listing payloads", () => {
  const material = validateMaterialCreatePayload({
    title: "  Calculus Notes  ",
    description: "  Covers limits and derivatives.  ",
    usageRights: "  Standard License  ",
    fileUrl: " https://example.com/files/notes.pdf ",
    thumbnailUrl: " https://example.com/thumb.jpg ",
    price: "1200.50",
    visibility: "PUBLIC",
    fileType: "application/pdf",
    fileSize: 1024,
    thumbnailType: "image/jpeg",
    thumbnailSize: 512,
    materialId: "mat-001",
    chainTxHash: "0xabc123",
  });

  assert.equal(material.title, "Calculus Notes");
  assert.equal(material.description, "Covers limits and derivatives.");
  assert.equal(material.usageRights, "Standard License");
  assert.equal(material.fileUrl, "https://example.com/files/notes.pdf");
  assert.equal(material.thumbnailUrl, "https://example.com/thumb.jpg");
  assert.equal(material.price, 1200.5);
  assert.equal(material.visibility, "public");
  assert.equal(material.fileType, "application/pdf");
  assert.equal(material.fileSize, 1024);
  assert.equal(material.thumbnailType, "image/jpeg");
  assert.equal(material.thumbnailSize, 512);
  assert.equal(material.materialId, "mat-001");
});

test("validateMaterialUpdatePayload normalizes partial updates", () => {
  const material = validateMaterialUpdatePayload({
    visibility: " Unlisted ",
    price: "0",
    description: "  Updated summary  ",
  });

  assert.deepEqual(material, {
    visibility: "unlisted",
    price: 0,
    description: "Updated summary",
  });
});

test("validateMaterialPayload rejects invalid price and unknown visibility", () => {
  assert.throws(
    () =>
      validateMaterialCreatePayload({
        title: "Notes",
        fileUrl: "ipfs://file",
        price: -1,
      }),
    (error) => {
      assert.equal(error.name, "ValidationError");
      assert.equal(error.details.errors[0].field, "price");
      return true;
    }
  );
  assert.throws(
    () =>
      validateMaterialCreatePayload({
        title: "Notes",
        fileUrl: "ipfs://file",
        visibility: "everyone",
      }),
    (error) => {
      assert.equal(error.name, "ValidationError");
      assert.equal(error.details.errors[0].field, "visibility");
      return true;
    }
  );
});

test("validateMaterialPayload rejects invalid URLs, file types, and oversized files", () => {
  assert.throws(
    () =>
      validateMaterialCreatePayload({
        title: "Notes",
        fileUrl: "notaurl",
        visibility: "public",
      }),
    (error) => {
      assert.equal(error.details.errors[0].field, "fileUrl");
      return true;
    }
  );

  assert.throws(
    () =>
      validateMaterialCreatePayload({
        title: "Notes",
        fileUrl: "https://example.com/file.pdf",
        visibility: "public",
        fileType: "application/x-msdownload",
        fileSize: 1024,
      }),
    (error) => {
      assert.equal(error.details.errors[0].field, "fileType");
      return true;
    }
  );

  assert.throws(
    () =>
      validateMaterialCreatePayload({
        title: "Notes",
        fileUrl: "https://example.com/file.pdf",
        visibility: "public",
        fileType: "application/pdf",
        fileSize: MATERIAL_FILE_MAX_BYTES + 1,
      }),
    (error) => {
      assert.equal(error.details.errors[0].field, "fileSize");
      return true;
    }
  );
});

test("sanitizeObject strips control characters from stored metadata", () => {
  assert.deepEqual(sanitizeObject({ title: "  Math\u0000 Notes " }), { title: "Math Notes" });
});

test("material visibility values stay constrained to supported states", () => {
  assert.deepEqual(MATERIAL_VISIBILITY_VALUES, ["private", "public", "unlisted"]);
  assert.equal(validateMaterialPayload({ title: "Notes", fileUrl: "https://example.com/file.pdf" }).visibility, "private");
});
