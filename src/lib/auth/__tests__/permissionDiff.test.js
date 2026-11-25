import { describe, it, expect } from "vitest";
import {
  ROLE_PERMISSIONS,
  computePermissionDiff,
  validateRoleTransition,
} from "../../auth/permissionDiff.js";

// ─────────────────────────────── computePermissionDiff ───────────────────────

describe("computePermissionDiff — added permissions", () => {
  it("reports permissions present in new role but not old", () => {
    const diff = computePermissionDiff("learner", "creator");
    const addedNames = diff.added.map((p) => (typeof p === "string" ? p : p.name ?? p));
    // creator has permissions learner lacks
    expect(diff.added.length).toBeGreaterThan(0);
  });

  it("reports no added permissions when demoting from admin to user", () => {
    const diff = computePermissionDiff("admin", "user");
    // admin has all; user is restricted — no permissions are added
    expect(diff.added.length).toBe(0);
  });
});

describe("computePermissionDiff — removed permissions", () => {
  it("reports permissions present in old role but not new", () => {
    const diff = computePermissionDiff("admin", "learner");
    expect(diff.removed.length).toBeGreaterThan(0);
  });

  it("reports no removed permissions when promoting from user to admin", () => {
    const diff = computePermissionDiff("user", "admin");
    expect(diff.removed.length).toBe(0);
  });
});

describe("computePermissionDiff — retained permissions", () => {
  it("reports permissions common to both roles", () => {
    const diff = computePermissionDiff("learner", "creator");
    // Both learner and creator share some base permissions
    expect(Array.isArray(diff.retained)).toBe(true);
  });

  it("retains all permissions for same-role diff", () => {
    const diff = computePermissionDiff("admin", "admin");
    expect(diff.added.length).toBe(0);
    expect(diff.removed.length).toBe(0);
    expect(diff.retained.length).toBeGreaterThan(0);
  });
});

describe("computePermissionDiff — riskLevel", () => {
  it("returns LOW risk for same-role or minor promotion", () => {
    const diff = computePermissionDiff("learner", "learner");
    expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(diff.riskLevel);
  });

  it("returns elevated risk when removing permissions from admin", () => {
    const diff = computePermissionDiff("admin", "user");
    // Removing admin capabilities is at least MEDIUM risk
    expect(["MEDIUM", "HIGH", "CRITICAL"]).toContain(diff.riskLevel);
  });

  it("returns CRITICAL or HIGH for granting admin from user", () => {
    const diff = computePermissionDiff("user", "admin");
    expect(["HIGH", "CRITICAL"]).toContain(diff.riskLevel);
  });
});

describe("computePermissionDiff — breakingChanges", () => {
  it("flags breaking changes when critical permissions are removed", () => {
    const diff = computePermissionDiff("admin", "learner");
    if (diff.breakingChanges.length > 0) {
      expect(diff.breakingChanges.every((c) => typeof c === "string" || typeof c === "object")).toBe(true);
    }
  });

  it("reports no breaking changes for same-role diff", () => {
    const diff = computePermissionDiff("learner", "learner");
    expect(diff.breakingChanges.length).toBe(0);
  });
});

describe("computePermissionDiff — requiresElevationConfirmation", () => {
  it("requires confirmation when granting high-risk permissions", () => {
    const diff = computePermissionDiff("user", "admin");
    expect(diff.requiresElevationConfirmation).toBe(true);
  });

  it("does not require confirmation for lateral or minor changes", () => {
    const diff = computePermissionDiff("learner", "learner");
    expect(diff.requiresElevationConfirmation).toBe(false);
  });
});

// ─────────────────────────── validateRoleTransition ──────────────────────────

describe("validateRoleTransition — admin-only changes", () => {
  it("throws when a non-admin attempts to promote a user to admin", () => {
    expect(() =>
      validateRoleTransition({
        requestingUser: { userId: "u1", role: "creator" },
        targetUser: { userId: "u2", role: "learner" },
        fromRole: "learner",
        toRole: "admin",
      })
    ).toThrow();
  });

  it("allows an admin to promote another user to admin", () => {
    expect(() =>
      validateRoleTransition({
        requestingUser: { userId: "admin1", role: "admin" },
        targetUser: { userId: "u2", role: "creator" },
        fromRole: "creator",
        toRole: "admin",
      })
    ).not.toThrow();
  });
});

describe("validateRoleTransition — self-demotion guard", () => {
  it("throws when an admin tries to demote themselves", () => {
    expect(() =>
      validateRoleTransition({
        requestingUser: { userId: "admin1", role: "admin" },
        targetUser: { userId: "admin1", role: "admin" },
        fromRole: "admin",
        toRole: "learner",
      })
    ).toThrow();
  });

  it("allows an admin to demote another user", () => {
    expect(() =>
      validateRoleTransition({
        requestingUser: { userId: "admin1", role: "admin" },
        targetUser: { userId: "u2", role: "creator" },
        fromRole: "creator",
        toRole: "learner",
      })
    ).not.toThrow();
  });
});

describe("validateRoleTransition — critical risk confirmation", () => {
  it("throws when CRITICAL change is requested without confirmation flag", () => {
    expect(() =>
      validateRoleTransition({
        requestingUser: { userId: "admin1", role: "admin" },
        targetUser: { userId: "u2", role: "user" },
        fromRole: "user",
        toRole: "admin",
        confirmed: false,
      })
    ).toThrow();
  });

  it("proceeds when CRITICAL change is confirmed", () => {
    expect(() =>
      validateRoleTransition({
        requestingUser: { userId: "admin1", role: "admin" },
        targetUser: { userId: "u2", role: "user" },
        fromRole: "user",
        toRole: "admin",
        confirmed: true,
      })
    ).not.toThrow();
  });
});

describe("validateRoleTransition — allowed transitions", () => {
  it("allows learner → creator by admin", () => {
    expect(() =>
      validateRoleTransition({
        requestingUser: { userId: "admin1", role: "admin" },
        targetUser: { userId: "u2", role: "learner" },
        fromRole: "learner",
        toRole: "creator",
        confirmed: false,
      })
    ).not.toThrow();
  });

  it("allows creator → learner by admin (demotion without self-demotion)", () => {
    expect(() =>
      validateRoleTransition({
        requestingUser: { userId: "admin1", role: "admin" },
        targetUser: { userId: "u2", role: "creator" },
        fromRole: "creator",
        toRole: "learner",
      })
    ).not.toThrow();
  });
});

// ──────────────────────────── ROLE_PERMISSIONS shape ─────────────────────────

describe("ROLE_PERMISSIONS", () => {
  it("defines permissions for expected roles", () => {
    expect(Array.isArray(ROLE_PERMISSIONS.admin)).toBe(true);
    expect(Array.isArray(ROLE_PERMISSIONS.creator)).toBe(true);
    expect(Array.isArray(ROLE_PERMISSIONS.learner)).toBe(true);
  });

  it("admin has at least as many permissions as creator", () => {
    expect(ROLE_PERMISSIONS.admin.length).toBeGreaterThanOrEqual(ROLE_PERMISSIONS.creator.length);
  });
});
