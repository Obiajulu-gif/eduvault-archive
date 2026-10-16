/**
 * Tests for configurable maintenance mode banners — Issue #891
 *
 * Covers active, expired, future, scoped, and unauthorized configuration changes.
 */

import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";

import {
  MAINTENANCE_SCOPES,
  configureMaintenanceBanner,
  enableMaintenanceBanner,
  disableMaintenanceBanner,
  getActiveMaintenanceBanners,
  isMaintenanceActive,
  getMaintenanceAuditLog,
  clearMaintenanceAuditLog,
  resetMaintenanceMode,
  getBanner,
  deleteMaintenanceBanner,
} from "../../src/lib/maintenanceMode.js";

beforeEach(() => {
  resetMaintenanceMode();
});

describe("Maintenance Mode — Active Banners (#891)", () => {
  test("active banner shows for matching scope", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Marketplace down",
      scope: "marketplace",
      startsAt: new Date(Date.now() - 1000),
      endsAt: new Date(Date.now() + 3600000),
      enabled: true,
    });
    const active = getActiveMaintenanceBanners("marketplace");
    assert.equal(active.length, 1);
    assert.equal(active[0].id, "m1");
  });

  test("isMaintenanceActive returns true for active scope", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Down",
      scope: "checkout",
      startsAt: new Date(Date.now() - 1000),
      endsAt: new Date(Date.now() + 3600000),
      enabled: true,
    });
    assert.equal(isMaintenanceActive("checkout"), true);
  });

  test("isMaintenanceActive returns false for inactive scope", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Down",
      scope: "checkout",
      startsAt: new Date(Date.now() - 1000),
      endsAt: new Date(Date.now() + 3600000),
      enabled: true,
    });
    assert.equal(isMaintenanceActive("upload"), false);
  });
});

describe("Maintenance Mode — Expired Banners (#891)", () => {
  test("expired banner stops showing automatically", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Expired",
      scope: "global",
      startsAt: new Date(Date.now() - 7200000),
      endsAt: new Date(Date.now() - 3600000),
      enabled: true,
    });
    const active = getActiveMaintenanceBanners();
    assert.equal(active.length, 0);
  });

  test("isMaintenanceActive returns false for expired banner", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Expired",
      scope: "global",
      startsAt: new Date(Date.now() - 7200000),
      endsAt: new Date(Date.now() - 3600000),
      enabled: true,
    });
    assert.equal(isMaintenanceActive("global"), false);
  });
});

describe("Maintenance Mode — Future Banners (#891)", () => {
  test("future banner does not show yet", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Coming soon",
      scope: "global",
      startsAt: new Date(Date.now() + 3600000),
      endsAt: new Date(Date.now() + 7200000),
      enabled: true,
    });
    const active = getActiveMaintenanceBanners();
    assert.equal(active.length, 0);
  });
});

describe("Maintenance Mode — Scoped Banners (#891)", () => {
  test("scoped banner only shows for its scope", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Upload down",
      scope: "upload",
      startsAt: new Date(Date.now() - 1000),
      endsAt: new Date(Date.now() + 3600000),
      enabled: true,
    });
    const uploadBanners = getActiveMaintenanceBanners("upload");
    const marketplaceBanners = getActiveMaintenanceBanners("marketplace");
    assert.equal(uploadBanners.length, 1);
    assert.equal(marketplaceBanners.length, 0);
  });

  test("global banner shows for all scopes", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Global down",
      scope: "global",
      startsAt: new Date(Date.now() - 1000),
      endsAt: new Date(Date.now() + 3600000),
      enabled: true,
    });
    const uploadBanners = getActiveMaintenanceBanners("upload");
    const checkoutBanners = getActiveMaintenanceBanners("checkout");
    assert.equal(uploadBanners.length, 1);
    assert.equal(checkoutBanners.length, 1);
  });
});

describe("Maintenance Mode — Unauthorized Changes (#891)", () => {
  test("enabling without actor throws", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Test",
      scope: "global",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600000),
      enabled: false,
    });
    assert.throws(() => enableMaintenanceBanner("m1"), /Actor is required/);
  });

  test("disabling without actor throws", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Test",
      scope: "global",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600000),
      enabled: true,
    });
    assert.throws(() => disableMaintenanceBanner("m1"), /Actor is required/);
  });

  test("deleting without actor throws", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Test",
      scope: "global",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600000),
      enabled: true,
    });
    assert.throws(() => deleteMaintenanceBanner("m1"), /Actor is required/);
  });

  test("invalid scope throws", () => {
    assert.throws(
      () => configureMaintenanceBanner({ id: "m1", message: "Test", scope: "invalid" }),
      /Invalid scope/
    );
  });
});

describe("Maintenance Mode — Audit Trail (#891)", () => {
  test("enable action is recorded in audit log", () => {
    clearMaintenanceAuditLog();
    configureMaintenanceBanner({
      id: "m1",
      message: "Test",
      scope: "global",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600000),
      enabled: false,
    });
    enableMaintenanceBanner("m1", "admin-user");
    const log = getMaintenanceAuditLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].action, "enabled");
    assert.equal(log[0].actor, "admin-user");
    assert.equal(log[0].bannerId, "m1");
  });

  test("disable action is recorded in audit log", () => {
    clearMaintenanceAuditLog();
    configureMaintenanceBanner({
      id: "m1",
      message: "Test",
      scope: "global",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600000),
      enabled: true,
    });
    disableMaintenanceBanner("m1", "admin-user");
    const log = getMaintenanceAuditLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].action, "disabled");
    assert.equal(log[0].actor, "admin-user");
  });

  test("audit log is capped at MAX_AUDIT_LOG", () => {
    clearMaintenanceAuditLog();
    for (let i = 0; i < 510; i++) {
      configureMaintenanceBanner({
        id: `m${i}`,
        message: "Test",
        scope: "global",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 3600000),
        enabled: false,
      });
      enableMaintenanceBanner(`m${i}`, "admin");
    }
    const log = getMaintenanceAuditLog();
    assert.ok(log.length <= 500);
  });
});

describe("Maintenance Mode — Enable/Disable Lifecycle (#891)", () => {
  test("disabled banner does not show as active", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Test",
      scope: "global",
      startsAt: new Date(Date.now() - 1000),
      endsAt: new Date(Date.now() + 3600000),
      enabled: false,
    });
    const active = getActiveMaintenanceBanners();
    assert.equal(active.length, 0);
  });

  test("enabling a banner makes it active", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Test",
      scope: "global",
      startsAt: new Date(Date.now() - 1000),
      endsAt: new Date(Date.now() + 3600000),
      enabled: false,
    });
    enableMaintenanceBanner("m1", "admin");
    const active = getActiveMaintenanceBanners();
    assert.equal(active.length, 1);
  });

  test("disabling a banner removes it from active", () => {
    configureMaintenanceBanner({
      id: "m1",
      message: "Test",
      scope: "global",
      startsAt: new Date(Date.now() - 1000),
      endsAt: new Date(Date.now() + 3600000),
      enabled: true,
    });
    disableMaintenanceBanner("m1", "admin");
    const active = getActiveMaintenanceBanners();
    assert.equal(active.length, 0);
  });
});
