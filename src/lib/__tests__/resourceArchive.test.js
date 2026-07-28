import { beforeEach, describe, expect, it } from "vitest";
import {
  archiveResource,
  getArchivedIds,
  isArchived,
  restoreResource,
} from "../resourceArchive";
import { installLocalStorageStub } from "../../../test/mocks/local-storage";

describe("resourceArchive", () => {
  beforeEach(() => {
    installLocalStorageStub();
  });

  it("starts with nothing archived", () => {
    expect(getArchivedIds()).toEqual([]);
    expect(isArchived("mat-1")).toBe(false);
  });

  it("archives and restores a resource", () => {
    archiveResource("mat-1");
    expect(isArchived("mat-1")).toBe(true);
    expect(getArchivedIds()).toEqual(["mat-1"]);

    restoreResource("mat-1");
    expect(isArchived("mat-1")).toBe(false);
    expect(getArchivedIds()).toEqual([]);
  });

  it("does not duplicate an already-archived id", () => {
    archiveResource("mat-1");
    archiveResource("mat-1");
    expect(getArchivedIds()).toEqual(["mat-1"]);
  });

  it("preserves other archived ids on restore", () => {
    archiveResource("mat-1");
    archiveResource("mat-2");
    archiveResource("mat-3");
    restoreResource("mat-2");
    expect(getArchivedIds()).toEqual(["mat-1", "mat-3"]);
  });

  it("persists state to localStorage", () => {
    archiveResource("mat-1");
    const raw = window.localStorage.getItem("eduvault.archivedResources");
    expect(JSON.parse(raw)).toEqual(["mat-1"]);
  });

  it("survives corrupted storage contents", () => {
    window.localStorage.setItem("eduvault.archivedResources", "not-json{");
    expect(getArchivedIds()).toEqual([]);
    archiveResource("mat-1");
    expect(getArchivedIds()).toEqual(["mat-1"]);
  });

  it("ignores falsy ids", () => {
    archiveResource("");
    archiveResource(null);
    expect(getArchivedIds()).toEqual([]);
  });
});
