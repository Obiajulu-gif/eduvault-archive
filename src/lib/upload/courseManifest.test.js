import { describe, expect, it } from "vitest";
import {
  canPublishCourse,
  createCourseManifest,
  retryableCourseFiles,
  updateCourseFile,
} from "./courseManifest";

describe("course upload manifest", () => {
  it("tracks ordered modules and blocks partial publication", () => {
    let manifest = createCourseManifest([
      { name: "intro.pdf", path: "01/intro.pdf", size: 10 },
      { name: "lesson.pdf", path: "02/lesson.pdf", size: 20 },
    ]);
    manifest = updateCourseFile(manifest, "module-1", {
      status: "verified",
      storageKey: "cid-intro",
    });
    expect(manifest.status).toBe("incomplete");
    expect(canPublishCourse(manifest)).toBe(false);

    manifest = updateCourseFile(manifest, "module-2", {
      status: "failed",
      errorCode: "scan_failed",
    });
    expect(retryableCourseFiles(manifest).map((file) => file.id)).toEqual(["module-2"]);
  });

  it("becomes publishable only after every module is verified", () => {
    let manifest = createCourseManifest([{ name: "lesson.pdf", size: 5 }]);
    manifest = updateCourseFile(manifest, "module-1", {
      status: "verified",
      storageKey: "cid-lesson",
    });
    expect(canPublishCourse(manifest)).toBe(true);
  });

  it("rejects duplicate paths", () => {
    expect(() =>
      createCourseManifest([
        { name: "a.pdf", path: "lesson.pdf", size: 1 },
        { name: "b.pdf", path: "lesson.pdf", size: 1 },
      ]),
    ).toThrow("duplicate_course_file");
  });
});
