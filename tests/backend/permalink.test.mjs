/**
 * Tests for safe public permalink behavior — Issue #895
 *
 * Covers rename, archive, restore, delete/restrict, and unauthorized access.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  PERMALINK_STATUS,
  buildPermalinkPath,
  resolveCanonicalPermalink,
  resolvePermalinkRedirect,
  isRecordAccessible,
  checkPermalinkAccess,
  resolvePermalink,
} from "../../src/lib/permalink.js";

describe("Permalink — Canonical URL (#895)", () => {
  test("builds canonical path from material _id", () => {
    const material = { _id: "abc123", title: "Test Material" };
    assert.equal(buildPermalinkPath(material), "/marketplace/abc123");
  });

  test("returns null for material without _id", () => {
    assert.equal(buildPermalinkPath(null), null);
    assert.equal(buildPermalinkPath({}), null);
  });

  test("resolves canonical permalink", () => {
    const material = { _id: "abc123", title: "Test" };
    const result = resolveCanonicalPermalink(material);
    assert.equal(result.url, "/marketplace/abc123");
    assert.equal(result.materialId, "abc123");
  });
});

describe("Permalink — Rename Redirect (#895)", () => {
  test("redirects when slug changes", () => {
    const material = { _id: "abc123", title: "New Title", slug: "new-title" };
    const result = resolvePermalinkRedirect(material, "old-title");
    assert.equal(result.needsRedirect, true);
    assert.equal(result.canonicalUrl, "/marketplace/abc123");
  });

  test("no redirect when slug is the same", () => {
    const material = { _id: "abc123", title: "Same Title", slug: "same-title" };
    const result = resolvePermalinkRedirect(material, "same-title");
    assert.equal(result.needsRedirect, false);
  });

  test("no redirect when no old slug provided", () => {
    const material = { _id: "abc123", title: "Test" };
    const result = resolvePermalinkRedirect(material, null);
    assert.equal(result.needsRedirect, false);
  });
});

describe("Permalink — Archive (#895)", () => {
  test("archived material is not accessible", () => {
    const material = { _id: "abc123", archived: true };
    const result = isRecordAccessible(material);
    assert.equal(result.accessible, false);
    assert.equal(result.status, PERMALINK_STATUS.GONE);
  });

  test("restored material is accessible", () => {
    const material = { _id: "abc123", archived: false };
    const result = isRecordAccessible(material);
    assert.equal(result.accessible, true);
    assert.equal(result.status, PERMALINK_STATUS.OK);
  });

  test("archived material returns 403 for non-owner", () => {
    const material = { _id: "abc123", archived: true, visibility: "public" };
    const result = checkPermalinkAccess(material, "other-user");
    assert.equal(result.allowed, false);
    assert.equal(result.status, PERMALINK_STATUS.GONE);
  });
});

describe("Permalink — Delete/Restrict (#895)", () => {
  test("deleted material returns 404", () => {
    const material = { _id: "abc123", isDeleted: true };
    const result = checkPermalinkAccess(material, "anyone");
    assert.equal(result.allowed, false);
    assert.equal(result.status, PERMALINK_STATUS.NOT_FOUND);
  });

  test("private material returns 403 for unauthorized user", () => {
    const material = { _id: "abc123", visibility: "private", userAddress: "owner" };
    const result = checkPermalinkAccess(material, "intruder");
    assert.equal(result.allowed, false);
    assert.equal(result.status, PERMALINK_STATUS.FORBIDDEN);
  });

  test("private material allows owner access", () => {
    const material = { _id: "abc123", visibility: "private", userAddress: "owner" };
    const result = checkPermalinkAccess(material, "owner");
    assert.equal(result.allowed, true);
    assert.equal(result.status, PERMALINK_STATUS.OK);
  });

  test("public material allows anyone", () => {
    const material = { _id: "abc123", visibility: "public" };
    const result = checkPermalinkAccess(material, "anyone");
    assert.equal(result.allowed, true);
    assert.equal(result.status, PERMALINK_STATUS.OK);
  });
});

describe("Permalink — Unauthorized Access (#895)", () => {
  test("null material returns 404", () => {
    const result = checkPermalinkAccess(null, "anyone");
    assert.equal(result.allowed, false);
    assert.equal(result.status, PERMALINK_STATUS.NOT_FOUND);
  });

  test("private material blocks null requester", () => {
    const material = { _id: "abc123", visibility: "private", userAddress: "owner" };
    const result = checkPermalinkAccess(material, null);
    assert.equal(result.allowed, false);
    assert.equal(result.status, PERMALINK_STATUS.FORBIDDEN);
  });

  test("does not leak storageKey in public response", () => {
    const material = { _id: "abc123", visibility: "public", storageKey: "secret-key" };
    const result = resolvePermalink(material, { requesterAddress: "anyone" });
    assert.equal(result.status, PERMALINK_STATUS.OK);
    assert.equal(result.material.storageKey, undefined);
  });
});

describe("Permalink — Full Resolution (#895)", () => {
  test("returns redirect for renamed material with old slug", () => {
    const material = { _id: "abc123", title: "New", slug: "new", visibility: "public" };
    const result = resolvePermalink(material, { oldSlug: "old", requesterAddress: "anyone" });
    assert.equal(result.status, PERMALINK_STATUS.REDIRECT);
    assert.equal(result.redirectUrl, "/marketplace/abc123");
  });

  test("returns OK for canonical access", () => {
    const material = { _id: "abc123", title: "Test", visibility: "public" };
    const result = resolvePermalink(material, { requesterAddress: "anyone" });
    assert.equal(result.status, PERMALINK_STATUS.OK);
    assert.equal(result.redirectUrl, "/marketplace/abc123");
  });

  test("returns GONE for archived material", () => {
    const material = { _id: "abc123", archived: true, visibility: "public" };
    const result = resolvePermalink(material, { requesterAddress: "anyone" });
    assert.equal(result.status, PERMALINK_STATUS.GONE);
  });
});
