import sharp from "sharp";

export const MAX_THUMBNAIL_PIXELS = 25_000_000;
export const MAX_THUMBNAIL_WIDTH = 1600;
export const MAX_THUMBNAIL_HEIGHT = 1200;
export const THUMBNAIL_OUTPUT_TYPE = "image/webp";

export class ThumbnailProcessingError extends Error {
  constructor(message, code = "invalid_thumbnail") {
    super(message);
    this.name = "ThumbnailProcessingError";
    this.code = code;
  }
}

/**
 * Decode and normalize an untrusted thumbnail before it reaches storage.
 * Sharp's decoded-pixel limit protects the process from decompression bombs;
 * re-encoding also removes the original format and metadata.
 */
export async function processThumbnail(file) {
  if (!file) return null;

  const name = String(file.name || "").toLowerCase();
  if (file.type === "image/svg+xml" || name.endsWith(".svg")) {
    throw new ThumbnailProcessingError("SVG thumbnails are not supported.", "svg_rejected");
  }

  let input;
  try {
    input = Buffer.from(await file.arrayBuffer());
  } catch {
    throw new ThumbnailProcessingError("Thumbnail could not be read.", "thumbnail_read_failed");
  }

  try {
    const source = sharp(input, {
      failOn: "error",
      limitInputPixels: MAX_THUMBNAIL_PIXELS,
    });
    const metadata = await source.metadata();

    if (!metadata.width || !metadata.height) {
      throw new ThumbnailProcessingError("Thumbnail dimensions could not be determined.", "invalid_dimensions");
    }
    if (metadata.width * metadata.height > MAX_THUMBNAIL_PIXELS) {
      throw new ThumbnailProcessingError("Thumbnail dimensions exceed the safe pixel limit.", "dimensions_too_large");
    }
    if (!["jpeg", "png", "webp"].includes(metadata.format)) {
      throw new ThumbnailProcessingError("Unsupported thumbnail image format.", "unsupported_format");
    }

    const output = await source
      .rotate()
      .resize({
        width: MAX_THUMBNAIL_WIDTH,
        height: MAX_THUMBNAIL_HEIGHT,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();

    return new File([output], "thumbnail.webp", { type: THUMBNAIL_OUTPUT_TYPE });
  } catch (error) {
    if (error instanceof ThumbnailProcessingError) throw error;
    throw new ThumbnailProcessingError("Thumbnail is malformed or could not be processed.", "invalid_thumbnail");
  }
}
