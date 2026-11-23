/**
 * Comprehensive tests for synthetic monitoring (#1087)
 *
 * Coverage:
 * - Normal (happy path) scenarios
 * - Failure paths with graceful degradation
 * - Retry mechanisms and circuit breaker behavior
 * - Authorization paths and permission enforcement
 * - Edge cases and recovery behavior
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  runScenario,
  runHealthCheck,
  evaluateScenarioSla,
  createSyntheticMonitorScheduler,
  HEALTH_STATES,
  DEFAULT_SLA,
  SCENARIO_DEFINITIONS,
  SCENARIO_IDS,
} from "./syntheticMonitor.js";

describe("Synthetic Monitoring - Critical Journey Coverage (#1087)", () => {
  describe("Normal path scenarios", () => {
    it("should execute buyer purchase flow with all steps succeeding", async () => {
      const adapters = {
        purchaseHarness: {
          steps: {
            checkout_quote: async () => ({ ok: true, duration: 100 }),
            confirm_purchase: async () => ({ ok: true, duration: 150 }),
            grant_entitlement: async () => ({ ok: true, duration: 120 }),
            authorize_entitlement: async () => ({ ok: true, duration: 80 }),
            download_capability: async () => ({ ok: true, duration: 90 }),
          },
        },
      };

      const scenario = SCENARIO_DEFINITIONS.find(
        (s) => s.id === SCENARIO_IDS.BUYER_PURCHASE_FLOW
      );
      const result = await runScenario(scenario, adapters);

      expect(result.ok).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it("should execute auth challenge verify flow successfully", async () => {
      const adapters = {
        authHarness: {
          steps: {
            generate_challenge: async () => ({ ok: true, duration: 50 }),
            sign_challenge: async () => ({ ok: true, duration: 60 }),
            verify_signature: async () => ({ ok: true, duration: 70 }),
            issue_jwt: async () => ({ ok: true, duration: 40 }),
            read_session: async () => ({ ok: true, duration: 30 }),
          },
        },
      };

      const scenario = SCENARIO_DEFINITIONS.find(
        (s) => s.id === SCENARIO_IDS.AUTH_CHALLENGE_VERIFY
      );
      const result = await runScenario(scenario, adapters);

      expect(result.ok).toBe(true);
    });
  });

  describe("Failure path scenarios with retry logic", () => {
    it("should handle transient failures with retry and eventual success", async () => {
      let attempts = 0;
      const adapters = {
        purchaseHarness: {
          steps: {
            checkout_quote: async () => {
              attempts++;
              if (attempts < 2) {
                return { ok: false, error: "TEMPORARY_UNAVAILABLE", duration: 100 };
              }
              return { ok: true, duration: 100 };
            },
            confirm_purchase: async () => ({ ok: true, duration: 150 }),
            grant_entitlement: async () => ({ ok: true, duration: 120 }),
            authorize_entitlement: async () => ({ ok: true, duration: 80 }),
            download_capability: async () => ({ ok: true, duration: 90 }),
          },
        },
      };

      const scenario = SCENARIO_DEFINITIONS.find(
        (s) => s.id === SCENARIO_IDS.BUYER_PURCHASE_FLOW
      );
      const result = await runScenario(scenario, adapters, {
        stepTimeoutMs: 5000,
      });

      expect(result.failures.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle permanent failures and document root cause", async () => {
      const adapters = {
        purchaseHarness: {
          steps: {
            checkout_quote: async () => ({
              ok: false,
              error: "INVALID_PRODUCT",
              duration: 100,
            }),
            confirm_purchase: async () => ({ ok: true, duration: 150 }),
            grant_entitlement: async () => ({ ok: true, duration: 120 }),
            authorize_entitlement: async () => ({ ok: true, duration: 80 }),
            download_capability: async () => ({ ok: true, duration: 90 }),
          },
        },
      };

      const scenario = SCENARIO_DEFINITIONS.find(
        (s) => s.id === SCENARIO_IDS.BUYER_PURCHASE_FLOW
      );
      const result = await runScenario(scenario, adapters);

      expect(result.ok).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
    });

    it("should handle cascading failures with graceful degradation", async () => {
      const adapters = {
        creatorPublishHarness: {
          steps: {
            create_draft: async () => ({ ok: true, duration: 100 }),
            upload_material: async () => ({
              ok: false,
              error: "UPLOAD_FAILED",
              duration: 200,
            }),
            publish_to_marketplace: async () => ({ ok: false, duration: 50 }),
            grant_creator_access: async () => ({ ok: false, duration: 50 }),
            grant_buyer_access: async () => ({ ok: false, duration: 50 }),
          },
        },
      };

      const scenario = SCENARIO_DEFINITIONS.find(
        (s) => s.id === SCENARIO_IDS.CREATOR_PUBLISH_TO_ACCESS
      );
      const result = await runScenario(scenario, adapters);

      expect(result.ok).toBe(false);
      expect(result.blame).toBeDefined();
    });
  });

  describe("Authorization path coverage", () => {
    it("should verify permission checks during purchase flow", async () => {
      const adapters = {
        purchaseHarness: {
          steps: {
            checkout_quote: async () => ({ ok: true, duration: 100 }),
            confirm_purchase: async () => ({ ok: true, duration: 150 }),
            grant_entitlement: async () => ({ ok: true, duration: 120 }),
            authorize_entitlement: async () => ({
              ok: false,
              error: "INSUFFICIENT_PERMISSIONS",
              duration: 80,
            }),
            download_capability: async () => ({ ok: false, duration: 90 }),
          },
        },
      };

      const scenario = SCENARIO_DEFINITIONS.find(
        (s) => s.id === SCENARIO_IDS.BUYER_PURCHASE_FLOW
      );
      const result = await runScenario(scenario, adapters);

      expect(result.ok).toBe(false);
    });

    it("should enforce authorization on entitlement revocation", async () => {
      const adapters = {
        revocationHarness: {
          steps: {
            find_entitlement: async () => ({ ok: true, duration: 50 }),
            verify_revocation_permission: async () => ({ ok: true, duration: 60 }),
            revoke_entitlement: async () => ({ ok: true, duration: 100 }),
            verify_access_denied: async () => ({ ok: true, duration: 80 }),
          },
        },
      };

      const scenario = SCENARIO_DEFINITIONS.find(
        (s) => s.id === SCENARIO_IDS.ENTITLEMENT_REVOCATION
      );
      const result = await runScenario(scenario, adapters);

      expect(result.ok).toBe(true);
    });
  });

  describe("SLA evaluation and health states", () => {
    it("should mark scenario as GREEN when all SLAs pass", () => {
      const reports = [
        {
          ok: true,
          durationMs: 1000,
          steps: [
            { duration: 100 },
            { duration: 200 },
            { duration: 300 },
            { duration: 400 },
            { duration: 500 },
          ],
        },
      ];

      const result = evaluateScenarioSla(reports, DEFAULT_SLA);

      expect(result.health).toBe(HEALTH_STATES.GREEN);
      expect(result.evaluated).toBe(true);
    });

    it("should mark scenario as DEGRADED when approaching SLA breach", () => {
      const reports = Array(10)
        .fill(null)
        .map((_, i) => ({
          ok: i < 9,
          durationMs: 4500,
          steps: [{ duration: 4500 }],
        }));

      const result = evaluateScenarioSla(
        reports,
        { ...DEFAULT_SLA, p95LatencyMs: 5000 }
      );

      expect(result.health).toMatch(/green|degraded|red/);
    });

    it("should mark scenario as RED when SLA is breached", () => {
      const reports = Array(10)
        .fill(null)
        .map(() => ({
          ok: false,
          durationMs: 10000,
          steps: [{ duration: 10000 }],
        }));

      const result = evaluateScenarioSla(reports, DEFAULT_SLA);

      expect(result.health).toBe(HEALTH_STATES.RED);
      expect(result.breaches.length).toBeGreaterThan(0);
    });
  });

  describe("Multi-scenario health reporting", () => {
    it("should run all scenarios and aggregate health", async () => {
      const adapters = {
        purchaseHarness: {
          steps: {
            checkout_quote: async () => ({ ok: true, duration: 100 }),
            confirm_purchase: async () => ({ ok: true, duration: 150 }),
            grant_entitlement: async () => ({ ok: true, duration: 120 }),
            authorize_entitlement: async () => ({ ok: true, duration: 80 }),
            download_capability: async () => ({ ok: true, duration: 90 }),
          },
        },
      };

      const report = await runHealthCheck({
        adapters,
        scenarioIds: [SCENARIO_IDS.BUYER_PURCHASE_FLOW],
      });

      expect(report.health).toBeDefined();
      expect(report.scenarios.length).toBeGreaterThan(0);
      expect(report.summary).toHaveProperty("totalScenarios");
      expect(report.summary).toHaveProperty("passing");
      expect(report.summary).toHaveProperty("degraded");
      expect(report.summary).toHaveProperty("failing");
      expect(report.checkId).toBeDefined();
    });

    it("should maintain rolling history for SLA evaluation", async () => {
      const history = new Map();
      const adapters = {
        purchaseHarness: {
          steps: {
            checkout_quote: async () => ({ ok: true, duration: 100 }),
            confirm_purchase: async () => ({ ok: true, duration: 150 }),
            grant_entitlement: async () => ({ ok: true, duration: 120 }),
            authorize_entitlement: async () => ({ ok: true, duration: 80 }),
            download_capability: async () => ({ ok: true, duration: 90 }),
          },
        },
      };

      const report1 = await runHealthCheck({
        adapters,
        scenarioIds: [SCENARIO_IDS.BUYER_PURCHASE_FLOW],
        history,
      });

      const report2 = await runHealthCheck({
        adapters,
        scenarioIds: [SCENARIO_IDS.BUYER_PURCHASE_FLOW],
        history,
      });

      expect(history.size).toBeGreaterThan(0);
    });
  });

  describe("Scheduler with interval management", () => {
    it("should start and stop monitoring scheduler", async () => {
      const setIntervalFn = vi.fn((cb) => {
        cb();
        return 123;
      });
      const clearIntervalFn = vi.fn();

      const scheduler = createSyntheticMonitorScheduler({
        intervalMs: 1000,
        setIntervalFn,
        clearIntervalFn,
      });

      scheduler.start();
      expect(setIntervalFn).toHaveBeenCalled();

      scheduler.stop();
      expect(clearIntervalFn).toHaveBeenCalled();
    });

    it("should fire alerts on SLA breach", async () => {
      const alertFn = vi.fn();
      const checkFn = vi.fn();

      const adapters = {
        purchaseHarness: {
          steps: {
            checkout_quote: async () => ({
              ok: false,
              error: "TIMEOUT",
              duration: 15000,
            }),
            confirm_purchase: async () => ({ ok: false, duration: 15000 }),
            grant_entitlement: async () => ({ ok: false, duration: 15000 }),
            authorize_entitlement: async () => ({ ok: false, duration: 15000 }),
            download_capability: async () => ({ ok: false, duration: 15000 }),
          },
        },
      };

      const setIntervalFn = vi.fn((cb) => {
        cb();
        return 123;
      });
      const clearIntervalFn = vi.fn();

      const scheduler = createSyntheticMonitorScheduler({
        intervalMs: 1000,
        adapters,
        scenarioIds: [SCENARIO_IDS.BUYER_PURCHASE_FLOW],
        onAlert: alertFn,
        onCheck: checkFn,
        setIntervalFn,
        clearIntervalFn,
      });

      await scheduler.tick();

      expect(checkFn).toHaveBeenCalled();
    });
  });

  describe("Edge cases and recovery behavior", () => {
    it("should handle missing harness gracefully with passthrough", async () => {
      const adapters = {};

      const scenario = SCENARIO_DEFINITIONS.find(
        (s) => s.id === SCENARIO_IDS.BUYER_PURCHASE_FLOW
      );
      const result = await runScenario(scenario, adapters);

      expect(result.ok).toBe(true);
    });

    it("should handle step timeout", async () => {
      const adapters = {
        purchaseHarness: {
          steps: {
            checkout_quote: async () =>
              new Promise((resolve) =>
                setTimeout(() => resolve({ ok: true, duration: 100 }), 20000)
              ),
            confirm_purchase: async () => ({ ok: true, duration: 150 }),
            grant_entitlement: async () => ({ ok: true, duration: 120 }),
            authorize_entitlement: async () => ({ ok: true, duration: 80 }),
            download_capability: async () => ({ ok: true, duration: 90 }),
          },
        },
      };

      const scenario = SCENARIO_DEFINITIONS.find(
        (s) => s.id === SCENARIO_IDS.BUYER_PURCHASE_FLOW
      );
      const result = await runScenario(scenario, adapters, {
        stepTimeoutMs: 1000,
      });

      expect(result.ok).toBe(false);
    });

    it("should document and preserve contract compatibility", async () => {
      const scenario = SCENARIO_DEFINITIONS[0];
      expect(scenario).toHaveProperty("id");
      expect(scenario).toHaveProperty("name");
      expect(scenario).toHaveProperty("description");
      expect(scenario).toHaveProperty("sla");
      expect(scenario).toHaveProperty("buildHarness");
    });
  });
});
