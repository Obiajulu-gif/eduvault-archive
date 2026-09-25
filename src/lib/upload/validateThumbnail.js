export const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
export const ALLOWED_THUMBNAIL_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

export const THUMBNAIL_SIZE_ERROR =
  "Thumbnail size exceeds the 5MB limit. Please select a smaller image.";
export const THUMBNAIL_TYPE_ERROR =
  "Unsupported thumbnail type. Please upload a JPG, PNG, or WEBP image.";

/**
 * Validate a thumbnail image file against the shared 5MB size limit and
 * allowed image extensions.
 *
 * A missing file is valid — thumbnails are optional in every upload flow.
 *
 * @param {File | null | undefined} file
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateThumbnail(file) {
  if (!file) return { ok: true };

  if (file.size > MAX_THUMBNAIL_BYTES) {
    return { ok: false, error: THUMBNAIL_SIZE_ERROR };
  }

  const name = file.name || "";
  const dotIndex = name.lastIndexOf(".");
  const extension = dotIndex === -1 ? "" : name.slice(dotIndex).toLowerCase();
  if (!ALLOWED_THUMBNAIL_EXTENSIONS.includes(extension)) {
    return { ok: false, error: THUMBNAIL_TYPE_ERROR };
  }

  return { ok: true };
}
