/**
 * Tests for the explainable risk scoring module (#1021).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createRiskScorer,
  defaultRiskScorer,
  scoreAction,
  HIGH_IMPACT_ACTIONS,
  RISK_LEVELS,
  GATE_ACTIONS,
  DEFAULT_THRESHOLDS,
  assertRiskScoringAuthorized,
  RiskScoringAuthorizationError,
} from "../src/lib/security/riskScoring.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lowRiskCtx() {
  return {
    actorAccountAgeDays: 365,
    actorPreviousPurchases: 50,
    newDevice: false,
    deviceSeenCount: 10,
    actorActionCountLastHour: 1,
    geoAnomaly: false,
    vpnDetected: false,
    walletChangedHoursAgo: 720,
    sessionAgeMinutes: 5,
    amountUsd: 10,
    itemCount: 1,
  };
}

// ---------------------------------------------------------------------------
// Basic scoring
// ---------------------------------------------------------------------------

describe("createRiskScorer — construction", () => {
  it("returns a frozen scorer with expected interface", () => {
    const scorer = createRiskScorer();
    assert.equal(typeof scorer.score, "function");
    assert.equal(typeof scorer.listSignals, "function");
    assert.equal(typeof scorer.policyVersion, "string");
    assert.ok(scorer.policyVersion.length > 0);
  });

  it("rejects an extra signal missing an id", () => {
    assert.throws(
      () => createRiskScorer({ extraSignals: [{ weight: 0.1, evaluate: () => 0, explain: () => "" }] }),
      /Signal missing id/
    );
  });

  it("rejects an extra signal with zero weight", () => {
    assert.throws(
      () => createRiskScorer({ extraSignals: [{ id: "x", weight: 0, evaluate: () => 0, explain: () => "" }] }),
      /invalid weight/
    );
  });
});

describe("scoreAction — low-risk context", () => {
  it("returns a low-risk result for a healthy account doing a small purchase", () => {
    const result = scoreAction(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE, lowRiskCtx());
    assert.equal(result.action, HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE);
    assert.ok(result.score >= 0 && result.score <= 1, "score must be in [0,1]");
    assert.equal(result.level, RISK_LEVELS.LOW);
    assert.equal(result.gate, GATE_ACTIONS[RISK_LEVELS.LOW]);
  });
});

describe("scoreAction — high-risk signals", () => {
  it("flags a new account doing a high-value purchase as HIGH or CRITICAL", () => {
    const result = scoreAction(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE, {
      actorAccountAgeDays: 0,
      actorPreviousPurchases: 0,
      newDevice: true,
      actorActionCountLastHour: 15,
      amountUsd: 900,
    });
    assert.ok(
      result.level === RISK_LEVELS.HIGH || result.level === RISK_LEVELS.CRITICAL,
      `expected HIGH or CRITICAL, got ${result.level} (score=${result.score})`
    );
    assert.ok(result.contributors.length > 0);
  });

  it("flags bulk admin mutation as at least MEDIUM risk", () => {
    const result = scoreAction(HIGH_IMPACT_ACTIONS.ADMIN_BULK_MUTATION, {
      actorAccountAgeDays: 365,
      itemCount: 50,
    });
    assert.ok(
      result.level !== RISK_LEVELS.LOW,
      `expected at least MEDIUM, got ${result.level}`
    );
  });

  it("fires geo_anomaly signal when geoAnomaly=true", () => {
    const result = scoreAction(HIGH_IMPACT_ACTIONS.WALLET_WITHDRAWAL, {
      ...lowRiskCtx(),
      geoAnomaly: true,
    });
    const geoSignal = result.contributors.find((c) => c.signalId === "geo_anomaly");
    assert.ok(geoSignal, "geo_anomaly signal should have fired");
    assert.ok(geoSignal.contribution > 0);
  });

  it("fires wallet_recently_changed when walletChangedHoursAgo is recent", () => {
    const result = scoreAction(HIGH_IMPACT_ACTIONS.WALLET_WITHDRAWAL, {
      ...lowRiskCtx(),
      walletChangedHoursAgo: 0.5,
    });
    const sig = result.contributors.find((c) => c.signalId === "wallet_recently_changed");
    assert.ok(sig, "wallet_recently_changed should have fired");
    assert.equal(sig.rawValue, 1.0);
  });
});

// ---------------------------------------------------------------------------
// Explanation
// ---------------------------------------------------------------------------

describe("scoreAction — explanation", () => {
  it("explanation is a non-empty string", () => {
    const result = scoreAction(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE, lowRiskCtx());
    assert.equal(typeof result.explanation, "string");
    assert.ok(result.explanation.length > 0);
  });

  it("explanation mentions the action name", () => {
    const result = scoreAction(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE, {
      actorAccountAgeDays: 0,
      amountUsd: 999,
    });
    assert.ok(
      result.explanation.includes(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE),
      "explanation should include the action name"
    );
  });

  it("explanation names the top-contributing signal", () => {
    const result = scoreAction(HIGH_IMPACT_ACTIONS.ADMIN_BULK_MUTATION, {
      itemCount: 200,
      actorAccountAgeDays: 30,
    });
    const topSignalId = result.contributors.sort((a, b) => b.contribution - a.contribution)[0]?.signalId;
    assert.ok(topSignalId, "should have at least one contributor");
    assert.ok(
      result.explanation.includes(topSignalId),
      `explanation should include top signal id "${topSignalId}"`
    );
  });
});

// ---------------------------------------------------------------------------
// policyVersion
// ---------------------------------------------------------------------------

describe("policyVersion", () => {
  it("is stable across calls with the same config", () => {
    const a = createRiskScorer();
    const b = createRiskScorer();
    assert.equal(a.policyVersion, b.policyVersion);
  });

  it("changes when thresholds are overridden", () => {
    const a = createRiskScorer();
    const b = createRiskScorer({ thresholds: { medium: 0.40, high: 0.70, critical: 0.90 } });
    assert.notEqual(a.policyVersion, b.policyVersion);
  });

  it("changes when extra signals are added", () => {
    const base = createRiskScorer();
    const custom = createRiskScorer({
      extraSignals: [{
        id: "custom_signal",
        weight: 0.05,
        actions: null,
        evaluate: () => 0,
        explain: () => "custom",
      }],
    });
    assert.notEqual(base.policyVersion, custom.policyVersion);
  });
});

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

describe("listSignals", () => {
  it("returns an array of signal descriptors", () => {
    const scorer = createRiskScorer();
    const signals = scorer.listSignals();
    assert.ok(Array.isArray(signals));
    assert.ok(signals.length > 0);
    for (const s of signals) {
      assert.equal(typeof s.id, "string");
      assert.ok(s.weight > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Custom thresholds
// ---------------------------------------------------------------------------

describe("custom thresholds", () => {
  it("applies custom critical threshold", () => {
    const scorer = createRiskScorer({ thresholds: { medium: 0.01, high: 0.02, critical: 0.03 } });
    const result = scorer.score(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE, {
      actorAccountAgeDays: 0,
      amountUsd: 1000,
      newDevice: true,
    });
    assert.equal(result.level, RISK_LEVELS.CRITICAL);
  });
});

// ---------------------------------------------------------------------------
// Score bounds
// ---------------------------------------------------------------------------

describe("score bounds", () => {
  it("score is always in [0, 1] regardless of context", () => {
    const extremeCtx = {
      actorAccountAgeDays: 0,
      amountUsd: 999999,
      newDevice: true,
      actorActionCountLastHour: 1000,
      geoAnomaly: true,
      walletChangedHoursAgo: 0,
      sessionAgeMinutes: 500,
      itemCount: 10000,
      actorPreviousPurchases: 0,
    };
    for (const action of Object.values(HIGH_IMPACT_ACTIONS)) {
      const result = scoreAction(action, extremeCtx);
      assert.ok(result.score >= 0 && result.score <= 1, `Score out of range for ${action}: ${result.score}`);
    }
  });

  it("score is 0 for a context with all signals dormant", () => {
    // Only non-applicable signals or zero-evaluating signals
    const result = scoreAction(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE, {
      actorAccountAgeDays: 365,
      amountUsd: 5,
      actorPreviousPurchases: 100,
      newDevice: false,
      deviceSeenCount: 20,
      actorActionCountLastHour: 0,
      geoAnomaly: false,
      vpnDetected: false,
      walletChangedHoursAgo: 999,
      sessionAgeMinutes: 2,
      itemCount: 1,
    });
    assert.equal(result.level, RISK_LEVELS.LOW);
    assert.equal(result.gate, GATE_ACTIONS[RISK_LEVELS.LOW]);
  });
});

// ---------------------------------------------------------------------------
// Normal, Failure, Retry, and Authorization paths (#1155)
// ---------------------------------------------------------------------------

describe("riskScoring — failure paths", () => {
  it("rejects non-string or empty action with TypeError", () => {
    assert.throws(() => scoreAction(null, {}), TypeError);
    assert.throws(() => scoreAction("", {}), TypeError);
    assert.throws(() => scoreAction(123, {}), TypeError);
  });

  it("rejects non-object context with TypeError", () => {
    assert.throws(() => scoreAction(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE, null), TypeError);
    assert.throws(() => scoreAction(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE, "string-ctx"), TypeError);
  });

  it("gracefully catches throwing custom signal evaluate() without failing evaluation", () => {
    const scorer = createRiskScorer({
      extraSignals: [{
        id: "buggy_signal",
        weight: 0.1,
        actions: null,
        evaluate: () => { throw new Error("Database timeout in signal"); },
        explain: () => "Failed",
      }],
    });

    const result = scorer.score(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE, lowRiskCtx());
    assert.ok(result);
    assert.equal(result.level, RISK_LEVELS.LOW);
    const buggySig = result.contributors.find((c) => c.signalId === "buggy_signal");
    assert.ok(buggySig);
    assert.equal(buggySig.contribution, 0);
    assert.ok(buggySig.error.includes("Database timeout"));
  });
});

describe("riskScoring — retry paths", () => {
  it("marks low and medium risk actions as retryable", () => {
    const result = scoreAction(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE, lowRiskCtx());
    assert.equal(result.retryable, true);
    assert.equal(result.retryCount, 0);
  });

  it("marks critical risk actions as not retryable", () => {
    const extremeCtx = {
      actorAccountAgeDays: 0,
      amountUsd: 10000,
      actorPreviousPurchases: 0,
      newDevice: true,
      actorActionCountLastHour: 50,
      geoAnomaly: true,
      retryCount: 4,
    };
    const result = scoreAction(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE, extremeCtx);
    assert.equal(result.level, RISK_LEVELS.CRITICAL);
    assert.equal(result.retryable, false);
    assert.equal(result.retryCount, 4);
    assert.equal(result.gate, "block");
  });
});

describe("riskScoring — authorization paths", () => {
  it("assertRiskScoringAuthorized allows admin, operator, and service actors", () => {
    assert.doesNotThrow(() => assertRiskScoringAuthorized({ role: "admin" }));
    assert.doesNotThrow(() => assertRiskScoringAuthorized({ role: "operator" }));
    assert.doesNotThrow(() => assertRiskScoringAuthorized({ role: "service" }));
  });

  it("assertRiskScoringAuthorized rejects unauthenticated or unprivileged actors", () => {
    assert.throws(() => assertRiskScoringAuthorized(null), RiskScoringAuthorizationError);
    assert.throws(() => assertRiskScoringAuthorized({ role: "creator" }), RiskScoringAuthorizationError);
    assert.throws(() => assertRiskScoringAuthorized({ role: "student" }), RiskScoringAuthorizationError);
    assert.throws(() => assertRiskScoringAuthorized({ role: "viewer" }), RiskScoringAuthorizationError);
  });

  it("enforces actor authorization when options.actor is supplied", () => {
    assert.throws(
      () => scoreAction(HIGH_IMPACT_ACTIONS.ADMIN_ROLE_GRANT, {}, { actor: { role: "student" } }),
      RiskScoringAuthorizationError
    );

    const authorized = scoreAction(HIGH_IMPACT_ACTIONS.ADMIN_ROLE_GRANT, {}, { actor: { role: "admin" } });
    assert.ok(authorized);
    assert.equal(authorized.action, HIGH_IMPACT_ACTIONS.ADMIN_ROLE_GRANT);
  });
});
