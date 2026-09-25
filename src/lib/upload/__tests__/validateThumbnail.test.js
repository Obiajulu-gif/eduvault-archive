import { describe, it, expect } from "vitest";

import {
  validateThumbnail,
  MAX_THUMBNAIL_BYTES,
  THUMBNAIL_SIZE_ERROR,
  THUMBNAIL_TYPE_ERROR,
} from "../validateThumbnail";
import sharp from "sharp";
import { processThumbnail, ThumbnailProcessingError } from "../processThumbnail";

function fakeFile(name, size) {
  return { name, size };
}

describe("validateThumbnail", () => {
  it("accepts a missing file (thumbnails are optional)", () => {
    expect(validateThumbnail(null)).toEqual({ ok: true });
    expect(validateThumbnail(undefined)).toEqual({ ok: true });
  });

  it.each(["photo.jpg", "photo.jpeg", "photo.png", "photo.webp", "PHOTO.PNG"])(
    "accepts %s within the size limit",
    (name) => {
      expect(validateThumbnail(fakeFile(name, 1024))).toEqual({ ok: true });
    },
  );

  it("accepts a file exactly at the 5MB limit", () => {
    expect(validateThumbnail(fakeFile("edge.png", MAX_THUMBNAIL_BYTES))).toEqual({ ok: true });
  });

  it("rejects a file just over the 5MB limit", () => {
    const result = validateThumbnail(fakeFile("big.png", MAX_THUMBNAIL_BYTES + 1));
    expect(result.ok).toBe(false);
    expect(result.error).toBe(THUMBNAIL_SIZE_ERROR);
  });

  it.each(["animation.gif", "vector.svg", "raw.bmp", "document.pdf"])(
    "rejects unsupported type %s",
    (name) => {
      const result = validateThumbnail(fakeFile(name, 1024));
      expect(result.ok).toBe(false);
      expect(result.error).toBe(THUMBNAIL_TYPE_ERROR);
    },
  );

  it("rejects a file with no extension", () => {
    const result = validateThumbnail(fakeFile("noextension", 1024));
    expect(result.ok).toBe(false);
    expect(result.error).toBe(THUMBNAIL_TYPE_ERROR);
  });

  it("checks size before type so oversized images report the size error", () => {
    const result = validateThumbnail(fakeFile("big.gif", MAX_THUMBNAIL_BYTES + 1));
    expect(result.error).toBe(THUMBNAIL_SIZE_ERROR);
  });
});

describe("processThumbnail (#762)", () => {
  it("re-encodes images as bounded WebP without metadata", async () => {
    const input = await sharp({
      create: { width: 40, height: 20, channels: 3, background: "red" },
    }).png().withMetadata({ exif: { IFD0: { Artist: "untrusted" } } }).toBuffer();

    const output = await processThumbnail(new File([input], "cover.png", { type: "image/png" }));
    const metadata = await sharp(Buffer.from(await output.arrayBuffer())).metadata();

    expect(output.type).toBe("image/webp");
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(40);
    expect(metadata.height).toBe(20);
    expect(metadata.exif).toBeUndefined();
  });

  it("rejects SVG and corrupt image bytes with controlled errors", async () => {
    await expect(processThumbnail(new File(["<svg></svg>"], "cover.svg", { type: "image/svg+xml" })))
      .rejects.toMatchObject({ code: "svg_rejected" });
    await expect(processThumbnail(new File(["not an image"], "cover.png", { type: "image/png" })))
      .rejects.toBeInstanceOf(ThumbnailProcessingError);
  });
});
