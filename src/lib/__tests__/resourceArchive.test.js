import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveResource,
  getArchivedIds,
  isArchived,
  restoreResource,
} from "../resourceArchive";
import { installLocalStorageStub } from "../../../test/mocks/local-storage";

describe("resourceArchive (Issue #560)", () => {
  beforeEach(() => {
    installLocalStorageStub();
    vi.restoreAllMocks();
  });

  it("starts with nothing archived", () => {
    expect(getArchivedIds()).toEqual([]);
    expect(isArchived("mat-1")).toBe(false);
  });

  it("archives and restores a resource optimistically and updates store", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, archived: true }),
    });

    await archiveResource("mat-1");
    expect(isArchived("mat-1")).toBe(true);
    expect(getArchivedIds()).toEqual(["mat-1"]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, archived: false }),
    });

    await restoreResource("mat-1");
    expect(isArchived("mat-1")).toBe(false);
    expect(getArchivedIds()).toEqual([]);
  });

  it("does not duplicate an already-archived id", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, archived: true }),
    });

    await archiveResource("mat-1");
    await archiveResource("mat-1");
    expect(getArchivedIds()).toEqual(["mat-1"]);
  });

  it("preserves other archived ids on restore", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    await archiveResource("mat-1");
    await archiveResource("mat-2");
    await archiveResource("mat-3");
    await restoreResource("mat-2");
    expect(getArchivedIds()).toEqual(["mat-1", "mat-3"]);
  });

  it("persists optimistic state to localStorage", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, archived: true }),
    });

    await archiveResource("mat-1");
    const raw = window.localStorage.getItem("eduvault.archivedResources");
    expect(JSON.parse(raw)).toEqual(["mat-1"]);
  });

  it("rolls back optimistic update when API call fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(archiveResource("mat-failed")).rejects.toThrow();
    expect(isArchived("mat-failed")).toBe(false);
  });

  it("ignores falsy ids", async () => {
    await archiveResource("");
    await archiveResource(null);
    expect(getArchivedIds()).toEqual([]);
  });
});
