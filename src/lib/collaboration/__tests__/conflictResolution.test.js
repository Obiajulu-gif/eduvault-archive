import { describe, it, expect } from "vitest";
import {
  ConflictStrategy,
  ConflictResolutionStatus,
  ConcurrentEditConflictError,
  StaleVersionError,
  compareVersionVectors,
  mergeVersionVectors,
  incrementVersionVector,
  computeFieldDiff,
  detectFieldConflicts,
  applyDiff,
  threeWayMerge,
  resolveEdit,
} from "../conflictResolution.js";

// ───────────────────────────── Version vectors ─────────────────────────────

describe("compareVersionVectors", () => {
  it("returns 'equal' for identical vectors", () => {
    expect(compareVersionVectors({ A: 1, B: 2 }, { A: 1, B: 2 })).toBe("equal");
  });

  it("returns 'equal' for two empty vectors", () => {
    expect(compareVersionVectors({}, {})).toBe("equal");
  });

  it("returns 'ahead' when a strictly dominates b", () => {
    expect(compareVersionVectors({ A: 2 }, { A: 1 })).toBe("ahead");
  });

  it("returns 'behind' when b strictly dominates a", () => {
    expect(compareVersionVectors({ A: 1 }, { A: 2 })).toBe("behind");
  });

  it("returns 'concurrent' when neither dominates", () => {
    expect(compareVersionVectors({ A: 2, B: 1 }, { A: 1, B: 3 })).toBe("concurrent");
  });

  it("treats missing keys as 0", () => {
    expect(compareVersionVectors({ A: 1 }, { B: 1 })).toBe("concurrent");
  });
});

describe("mergeVersionVectors", () => {
  it("takes the max at each key", () => {
    const result = mergeVersionVectors({ A: 2, B: 1 }, { A: 1, B: 3, C: 5 });
    expect(result).toEqual({ A: 2, B: 3, C: 5 });
  });
});

describe("incrementVersionVector", () => {
  it("increments the given node's clock", () => {
    const v = incrementVersionVector({ A: 1 }, "A");
    expect(v.A).toBe(2);
  });

  it("initialises missing node to 1", () => {
    const v = incrementVersionVector({}, "X");
    expect(v.X).toBe(1);
  });
});

// ───────────────────────────── Field diff ──────────────────────────────────

describe("computeFieldDiff", () => {
  it("detects changed fields", () => {
    const diff = computeFieldDiff({ title: "Old", body: "Same" }, { title: "New", body: "Same" });
    expect(diff.title).toEqual({ from: "Old", to: "New" });
    expect(diff.body).toBeUndefined();
  });

  it("detects added fields", () => {
    const diff = computeFieldDiff({}, { newField: "value" });
    expect(diff.newField).toEqual({ from: undefined, to: "value" });
  });

  it("detects removed fields", () => {
    const diff = computeFieldDiff({ removed: "yes" }, {});
    expect(diff.removed).toEqual({ from: "yes", to: undefined });
  });

  it("returns empty diff for identical objects", () => {
    expect(computeFieldDiff({ a: 1 }, { a: 1 })).toEqual({});
  });
});

describe("detectFieldConflicts", () => {
  it("flags fields changed differently in both diffs", () => {
    const diffA = { title: { from: "Base", to: "A's title" } };
    const diffB = { title: { from: "Base", to: "B's title" } };
    const conflicts = detectFieldConflicts(diffA, diffB);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe("title");
  });

  it("does not flag fields changed to the same value", () => {
    const diffA = { title: { from: "Base", to: "Same" } };
    const diffB = { title: { from: "Base", to: "Same" } };
    expect(detectFieldConflicts(diffA, diffB)).toHaveLength(0);
  });

  it("does not flag fields changed by only one side", () => {
    const diffA = { title: { from: "Base", to: "A" } };
    const diffB = { body: { from: "Old", to: "New" } };
    expect(detectFieldConflicts(diffA, diffB)).toHaveLength(0);
  });
});

describe("applyDiff", () => {
  it("applies changes to base", () => {
    const result = applyDiff({ a: 1, b: 2 }, { b: { from: 2, to: 99 } });
    expect(result).toEqual({ a: 1, b: 99 });
  });

  it("deletes fields whose to value is undefined", () => {
    const result = applyDiff({ a: 1, b: 2 }, { b: { from: 2, to: undefined } });
    expect(result.b).toBeUndefined();
    expect(result.a).toBe(1);
  });
});

// ───────────────────────────── Three-way merge ─────────────────────────────

describe("threeWayMerge", () => {
  const base = { title: "Base Title", body: "Base Body", tags: ["v1"] };

  it("merges non-overlapping changes", () => {
    const editA = { ...base, title: "A's Title" };
    const editB = { ...base, body: "B's Body" };
    const { status, merged } = threeWayMerge(base, editA, editB);
    expect(status).toBe(ConflictResolutionStatus.MERGED);
    expect(merged.title).toBe("A's Title");
    expect(merged.body).toBe("B's Body");
  });

  it("reports CONFLICT when both sides change the same field differently", () => {
    const editA = { ...base, title: "A's Title" };
    const editB = { ...base, title: "B's Title" };
    const { status, conflicts } = threeWayMerge(base, editA, editB);
    expect(status).toBe(ConflictResolutionStatus.CONFLICT);
    expect(conflicts[0].field).toBe("title");
  });

  it("merges when both sides make the identical change", () => {
    const editA = { ...base, title: "Same" };
    const editB = { ...base, title: "Same" };
    const { status, merged } = threeWayMerge(base, editA, editB);
    expect(status).toBe(ConflictResolutionStatus.MERGED);
    expect(merged.title).toBe("Same");
  });
});

// ───────────────────────────── resolveEdit ─────────────────────────────────

describe("resolveEdit — fast path (no concurrency)", () => {
  const current = { title: "Doc", body: "Content", _versionVector: { editor1: 1 } };

  it("applies edit directly when base vector equals current", () => {
    const { status, document } = resolveEdit({
      current,
      incomingEdit: { title: "Updated Doc", body: "Content", _baseVersionVector: { editor1: 1 } },
      editorId: "editor2",
    });
    expect(status).toBe(ConflictResolutionStatus.MERGED);
    expect(document.title).toBe("Updated Doc");
    expect(document._versionVector.editor2).toBe(1);
  });

  it("applies edit when base vector is behind current (sequential)", () => {
    const current2 = { ...current, _versionVector: { editor1: 3 } };
    const { status } = resolveEdit({
      current: current2,
      incomingEdit: { title: "New", _baseVersionVector: { editor1: 2 } },
      editorId: "editor3",
    });
    expect(status).toBe(ConflictResolutionStatus.MERGED);
  });
});

describe("resolveEdit — concurrent (THREE_WAY_MERGE)", () => {
  it("merges non-conflicting concurrent edits", () => {
    const current = {
      title: "Original",
      body: "Original body",
      _versionVector: { A: 1, B: 2 },
    };
    const incomingEdit = {
      title: "Updated by C",
      body: "Original body",
      _baseVersionVector: { A: 1, B: 1 }, // concurrent: B advanced from 1→2 since edit started
    };
    const { status, document } = resolveEdit({ current, incomingEdit, editorId: "C" });
    expect(status).toBe(ConflictResolutionStatus.MERGED);
    expect(document.title).toBe("Updated by C");
  });

  it("reports CONFLICT when concurrent edits change the same field", () => {
    const current = {
      title: "Changed by current",
      _versionVector: { A: 2, B: 1 },
    };
    const incomingEdit = {
      title: "Changed by incoming",
      _baseVersionVector: { A: 1, B: 2 }, // concurrent
    };
    const { status, conflicts } = resolveEdit({ current, incomingEdit, editorId: "C" });
    expect(status).toBe(ConflictResolutionStatus.CONFLICT);
    expect(conflicts.length).toBeGreaterThan(0);
  });
});

describe("resolveEdit — LAST_WRITE_WINS strategy", () => {
  it("overwrites concurrent changes with incoming edit", () => {
    const current = {
      title: "Current",
      _versionVector: { A: 2, B: 1 },
    };
    const incomingEdit = {
      title: "Incoming wins",
      _baseVersionVector: { A: 1, B: 2 },
    };
    const { status, document } = resolveEdit({
      current,
      incomingEdit,
      editorId: "B",
      strategy: ConflictStrategy.LAST_WRITE_WINS,
    });
    expect(status).toBe(ConflictResolutionStatus.MERGED);
    expect(document.title).toBe("Incoming wins");
  });
});

describe("resolveEdit — REJECT strategy", () => {
  it("rejects concurrent edits", () => {
    const current = { title: "Current", _versionVector: { A: 2 } };
    const incomingEdit = { title: "Rejected", _baseVersionVector: { B: 2 } };
    const { status } = resolveEdit({
      current,
      incomingEdit,
      editorId: "B",
      strategy: ConflictStrategy.REJECT,
    });
    expect(status).toBe(ConflictResolutionStatus.REJECTED);
  });
});
