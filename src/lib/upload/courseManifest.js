/**
 * Build and validate the durable manifest for a multi-file course upload.
 *
 * This module is deliberately storage-agnostic: the upload route can persist
 * each file independently and retry only entries that failed. A course is
 * publishable only when every entry has a verified storage reference.
 */

export const COURSE_FILE_STATES = Object.freeze([
  "pending",
  "uploading",
  "verifying",
  "verified",
  "failed",
]);

export function createCourseManifest(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("course_requires_file");
  }

  const seen = new Set();
  const entries = files.map((file, index) => {
    const name = String(file?.name || "").trim();
    const size = Number(file?.size);
    if (!name || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("invalid_course_file");
    }
    const path = String(file?.path || name).trim();
    if (!path || seen.has(path)) {
      throw new Error("duplicate_course_file");
    }
    seen.add(path);
    return {
      id: String(file?.id || `module-${index + 1}`),
      order: index,
      path,
      name,
      size,
      status: "pending",
      storageKey: null,
      errorCode: null,
    };
  });

  return {
    version: 1,
    type: "course",
    status: "incomplete",
    files: entries,
    totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
  };
}

export function updateCourseFile(manifest, fileId, update) {
  const files = manifest.files.map((file) =>
    file.id === fileId ? { ...file, ...update } : file,
  );
  if (files.every((file) => file.status === "verified" && file.storageKey)) {
    return { ...manifest, files, status: "ready" };
  }
  return { ...manifest, files, status: "incomplete" };
}

export function retryableCourseFiles(manifest) {
  return manifest.files.filter((file) => file.status === "failed");
}

export function canPublishCourse(manifest) {
  return (
    manifest?.status === "ready" &&
    manifest.files.length > 0 &&
    manifest.files.every((file) => file.status === "verified" && file.storageKey)
  );
}
