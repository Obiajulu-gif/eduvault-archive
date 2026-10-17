/**
 * Explainable risk scoring for suspicious high-impact actions (#1021).
 *
 * This module evaluates actions (purchases, withdrawals, bulk-exports, admin
 * mutations, etc.) against a set of configurable signal functions and produces
 * a scored, human-readable explanation of why an action is considered risky.
 *
 * Design goals:
 *  - Every score is a deterministic function of the context object supplied by
 *    the caller — no hidden global state beyond the registered signal set.
 *  - Each contributing signal is recorded individually so the explanation can
 *    surface exactly which signals fired, their individual weight contribution,
 *    and the rationale a human reviewer would read.
 *  - The scorer is pure and synchronous; async context enrichment (DB lookups,
 *    IP reputation, etc.) happens in the adapter layer before calling `score`.
 *  - Integration with the existing audit ledger and telemetry is explicit:
 *    callers decide whether to persist and/or gate, keeping this module free of
 *    I/O coupling.
 *
 * Typical usage:
 *
 *   import { createRiskScorer, HIGH_IMPACT_ACTIONS, RISK_LEVELS } from "@/lib/security/riskScoring";
 *
 *   const scorer = createRiskScorer();
 *
 *   const result = scorer.score(HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE, {
 *     amountUsd: 480,
 *     actorAccountAgeDays: 1,
 *     actorPreviousPurchases: 0,
 *     newDevice: true,
 *   });
 *
 *   if (result.level === RISK_LEVELS.HIGH) {
 *     // gate, flag for review, or step-up auth
 *   }
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Stable identifiers for every high-impact action the scorer knows about.
 * Adding a new action here triggers a docs-only deploy; the signal registry
 * decides which signals apply to each action.
 */
export const HIGH_IMPACT_ACTIONS = Object.freeze({
  PURCHASE_HIGH_VALUE:    "purchase.high_value",
  PURCHASE_BULK:          "purchase.bulk",
  WALLET_WITHDRAWAL:      "wallet.withdrawal",
  MATERIAL_BULK_DELETE:   "material.bulk_delete",
  PROFILE_WALLET_CHANGE:  "profile.wallet_change",
  ADMIN_ROLE_GRANT:       "admin.role_grant",
  ADMIN_BULK_MUTATION:    "admin.bulk_mutation",
  CREATOR_MASS_PUBLISH:   "creator.mass_publish",
  REFUND_BULK:            "refund.bulk",
  DATA_EXPORT:            "data.export",
});

/**
 * Risk level thresholds.  Callers branch on these constants rather than
 * comparing raw numeric scores so a threshold change is a single-line edit.
 */
export const RISK_LEVELS = Object.freeze({
  LOW:      "low",      // score < 0.35
  MEDIUM:   "medium",   // 0.35 ≤ score < 0.65
  HIGH:     "high",     // 0.65 ≤ score < 0.85
  CRITICAL: "critical", // score ≥ 0.85
});

/** Default numeric bounds that map a [0,1] score to a risk level. */
export const DEFAULT_THRESHOLDS = Object.freeze({
  medium:   0.35,
  high:     0.65,
  critical: 0.85,
});

/**
 * Recommended gate behaviours by level.  The caller enforces these; the scorer
 * only recommends.
 */
export const GATE_ACTIONS = Object.freeze({
  [RISK_LEVELS.LOW]:      "allow",
  [RISK_LEVELS.MEDIUM]:   "flag",      // log + soft-flag for async review
  [RISK_LEVELS.HIGH]:     "step_up",   // require additional verification
  [RISK_LEVELS.CRITICAL]: "block",     // reject the action outright
});

// ---------------------------------------------------------------------------
// Built-in signals
// ---------------------------------------------------------------------------

/**
 * Each signal is a plain object:
 *
 *   id          – stable identifier (never rename without a migration note)
 *   weight      – maximum contribution to the [0,1] score (all weights must
 *                 sum to ≤ 1.0 within any evaluated action; the scorer
 *                 normalises if they exceed it)
 *   actions     – Set of HIGH_IMPACT_ACTIONS this signal applies to, or null
 *                 for "applies to all"
 *   evaluate(ctx) → number in [0,1]   (1 = full weight triggered)
 *   explain(ctx, contribution) → string  (human-readable rationale)
 */

const BUILT_IN_SIGNALS = [
  // --- Account age ----------------------------------------------------------
  {
    id: "new_account",
    weight: 0.20,
    actions: null, // applies to all
    evaluate(ctx) {
      const days = Number(ctx.actorAccountAgeDays ?? ctx.accountAgeDays ?? Infinity);
      if (days <= 1)  return 1.0;
      if (days <= 7)  return 0.7;
      if (days <= 30) return 0.3;
      return 0;
    },
    explain(ctx, contribution) {
      const days = Number(ctx.actorAccountAgeDays ?? ctx.accountAgeDays ?? "unknown");
      return `Account is ${days === Infinity ? "unknown age" : `${days} day(s) old`} — new accounts carry elevated risk (contributed ${fmt(contribution)}).`;
    },
  },

  // --- High transaction value -----------------------------------------------
  {
    id: "high_value_transaction",
    weight: 0.25,
    actions: new Set([
      HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE,
      HIGH_IMPACT_ACTIONS.WALLET_WITHDRAWAL,
      HIGH_IMPACT_ACTIONS.PURCHASE_BULK,
    ]),
    evaluate(ctx) {
      const amount = Number(ctx.amountUsd ?? ctx.amount ?? 0);
      if (amount >= 1000) return 1.0;
      if (amount >= 500)  return 0.75;
      if (amount >= 200)  return 0.45;
      if (amount >= 100)  return 0.20;
      return 0;
    },
    explain(ctx, contribution) {
      const amount = ctx.amountUsd ?? ctx.amount ?? 0;
      return `Transaction value of $${Number(amount).toFixed(2)} exceeds normal thresholds (contributed ${fmt(contribution)}).`;
    },
  },

  // --- No prior purchases (first-time buyer doing high-value action) ---------
  {
    id: "no_purchase_history",
    weight: 0.15,
    actions: new Set([
      HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE,
      HIGH_IMPACT_ACTIONS.PURCHASE_BULK,
      HIGH_IMPACT_ACTIONS.WALLET_WITHDRAWAL,
    ]),
    evaluate(ctx) {
      const prior = Number(ctx.actorPreviousPurchases ?? ctx.previousPurchases ?? 0);
      return prior === 0 ? 1.0 : prior < 3 ? 0.4 : 0;
    },
    explain(ctx, contribution) {
      const prior = ctx.actorPreviousPurchases ?? ctx.previousPurchases ?? 0;
      return `Actor has ${prior} prior purchase(s) — limited history increases risk for high-value actions (contributed ${fmt(contribution)}).`;
    },
  },

  // --- New / unrecognised device --------------------------------------------
  {
    id: "new_device",
    weight: 0.15,
    actions: null,
    evaluate(ctx) {
      if (ctx.newDevice === true)       return 1.0;
      if (ctx.deviceSeenCount === 0)    return 1.0;
      if (ctx.deviceSeenCount === 1)    return 0.5;
      return 0;
    },
    explain(ctx, contribution) {
      return `Action originates from a new or unrecognised device (contributed ${fmt(contribution)}).`;
    },
  },

  // --- Velocity: many actions in a short window ----------------------------
  {
    id: "high_velocity",
    weight: 0.20,
    actions: null,
    evaluate(ctx) {
      const count = Number(ctx.actorActionCountLastHour ?? ctx.recentActionCount ?? 0);
      if (count >= 20) return 1.0;
      if (count >= 10) return 0.6;
      if (count >= 5)  return 0.25;
      return 0;
    },
    explain(ctx, contribution) {
      const count = ctx.actorActionCountLastHour ?? ctx.recentActionCount ?? 0;
      return `Actor performed ${count} action(s) in the last hour — elevated velocity is a suspicious indicator (contributed ${fmt(contribution)}).`;
    },
  },

  // --- Geographic / IP anomaly ---------------------------------------------
  {
    id: "geo_anomaly",
    weight: 0.15,
    actions: null,
    evaluate(ctx) {
      if (ctx.geoAnomaly === true)           return 1.0;
      if (ctx.countryChangedSinceLastLogin)  return 0.8;
      if (ctx.vpnDetected === true)          return 0.4;
      return 0;
    },
    explain(ctx, contribution) {
      const reasons = [];
      if (ctx.geoAnomaly)                 reasons.push("geographic anomaly detected");
      if (ctx.countryChangedSinceLastLogin) reasons.push("country changed since last login");
      if (ctx.vpnDetected)                reasons.push("VPN detected");
      return `IP/geo risk: ${reasons.length ? reasons.join(", ") : "anomaly"} (contributed ${fmt(contribution)}).`;
    },
  },

  // --- Privileged / admin actions ------------------------------------------
  {
    id: "privileged_action",
    weight: 0.25,
    actions: new Set([
      HIGH_IMPACT_ACTIONS.ADMIN_ROLE_GRANT,
      HIGH_IMPACT_ACTIONS.ADMIN_BULK_MUTATION,
      HIGH_IMPACT_ACTIONS.MATERIAL_BULK_DELETE,
      HIGH_IMPACT_ACTIONS.CREATOR_MASS_PUBLISH,
      HIGH_IMPACT_ACTIONS.REFUND_BULK,
      HIGH_IMPACT_ACTIONS.DATA_EXPORT,
    ]),
    evaluate(ctx) {
      // Base risk for any privileged action; boosted by scope
      const itemCount = Number(ctx.itemCount ?? ctx.affectedCount ?? 1);
      if (itemCount >= 100) return 1.0;
      if (itemCount >= 20)  return 0.75;
      if (itemCount >= 5)   return 0.40;
      return 0.20; // baseline: the action itself is inherently elevated
    },
    explain(ctx, contribution) {
      const count = ctx.itemCount ?? ctx.affectedCount ?? 1;
      return `Privileged action affecting ${count} item(s) — administrative and bulk mutations carry intrinsic risk (contributed ${fmt(contribution)}).`;
    },
  },

  // --- Wallet address changed recently -------------------------------------
  {
    id: "wallet_recently_changed",
    weight: 0.15,
    actions: new Set([
      HIGH_IMPACT_ACTIONS.WALLET_WITHDRAWAL,
      HIGH_IMPACT_ACTIONS.PURCHASE_HIGH_VALUE,
      HIGH_IMPACT_ACTIONS.PROFILE_WALLET_CHANGE,
    ]),
    evaluate(ctx) {
      const changedHrsAgo = Number(ctx.walletChangedHoursAgo ?? ctx.walletAgeHours ?? Infinity);
      if (changedHrsAgo <= 1)  return 1.0;
      if (changedHrsAgo <= 24) return 0.6;
      if (changedHrsAgo <= 72) return 0.25;
      return 0;
    },
    explain(ctx, contribution) {
      const hrs = ctx.walletChangedHoursAgo ?? ctx.walletAgeHours;
      return `Wallet address changed ${hrs != null ? `${hrs} hour(s)` : "recently"} before this action — a common indicator of account takeover (contributed ${fmt(contribution)}).`;
    },
  },

  // --- Session freshness ---------------------------------------------------
  {
    id: "old_session",
    weight: 0.10,
    actions: new Set([
      HIGH_IMPACT_ACTIONS.WALLET_WITHDRAWAL,
      HIGH_IMPACT_ACTIONS.ADMIN_ROLE_GRANT,
      HIGH_IMPACT_ACTIONS.ADMIN_BULK_MUTATION,
    ]),
    evaluate(ctx) {
      const ageMin = Number(ctx.sessionAgeMinutes ?? 0);
      if (ageMin >= 240) return 0.6;  // session > 4 h
      if (ageMin >= 60)  return 0.25;
      return 0;
    },
    explain(ctx, contribution) {
      const min = ctx.sessionAgeMinutes ?? 0;
      return `Session is ${min} minute(s) old — stale sessions raise the risk of replay or hijack (contributed ${fmt(contribution)}).`;
    },
  },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function fmt(n) {
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * Resolve a numeric score → RISK_LEVELS string given a threshold map.
 */
function resolveLevel(score, thresholds) {
  if (score >= thresholds.critical) return RISK_LEVELS.CRITICAL;
  if (score >= thresholds.high)     return RISK_LEVELS.HIGH;
  if (score >= thresholds.medium)   return RISK_LEVELS.MEDIUM;
  return RISK_LEVELS.LOW;
}

/**
 * Clamp a value to [min, max].
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// Scorer factory
// ---------------------------------------------------------------------------

/**
 * Create a stateless risk scorer.
 *
 * @param {object} [options]
 * @param {typeof DEFAULT_THRESHOLDS} [options.thresholds] - Override level
 *   boundaries.
 * @param {Array}  [options.extraSignals] - Additional custom signal objects
 *   following the same interface as BUILT_IN_SIGNALS entries.
 *
 * @returns {{ score, listSignals, policyVersion }}
 */
export function createRiskScorer(options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  const signals = [...BUILT_IN_SIGNALS, ...(options.extraSignals || [])];

  // Validate custom signals at construction time so errors surface early.
  for (const sig of signals) {
    if (typeof sig.id !== "string" || !sig.id) throw new Error(`Signal missing id: ${JSON.stringify(sig)}`);
    if (typeof sig.weight !== "number" || sig.weight <= 0) throw new Error(`Signal ${sig.id} has invalid weight`);
    if (typeof sig.evaluate !== "function") throw new Error(`Signal ${sig.id} missing evaluate()`);
    if (typeof sig.explain !== "function") throw new Error(`Signal ${sig.id} missing explain()`);
  }

  /**
   * A stable fingerprint of the current policy (signals + thresholds).
   * Stored alongside persisted risk decisions so a future audit can tell
   * whether the scoring logic has changed.
   */
  const policyVersion = crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        signals: signals.map((s) => ({ id: s.id, weight: s.weight })),
        thresholds,
      })
    )
    .digest("hex")
    .slice(0, 12);

  /**
   * Score a single high-impact action.
   *
   * @param {string} action - One of HIGH_IMPACT_ACTIONS values.
   * @param {object} ctx    - Arbitrary context object (enriched by caller).
   *
   * @returns {RiskScoreResult}
   */
  function score(action, ctx = {}) {
    if (typeof action !== "string" || !action) {
      throw new TypeError("action must be a non-empty string");
    }
    if (typeof ctx !== "object" || ctx === null) {
      throw new TypeError("ctx must be an object");
    }

    const applicableSignals = signals.filter(
      (sig) => sig.actions === null || sig.actions.has(action)
    );

    // Normalise weights so they cannot collectively exceed 1.0
    const totalWeight = applicableSignals.reduce((sum, sig) => sum + sig.weight, 0);
    const normFactor  = totalWeight > 1.0 ? 1.0 / totalWeight : 1.0;

    const contributors = [];
    let rawScore = 0;

    for (const sig of applicableSignals) {
      const raw = clamp(sig.evaluate(ctx), 0, 1);
      if (raw === 0) continue; // signal did not fire

      const contribution = raw * sig.weight * normFactor;
      rawScore += contribution;

      contributors.push({
        signalId:     sig.id,
        weight:       sig.weight,
        rawValue:     raw,
        contribution: contribution,
        rationale:    sig.explain(ctx, contribution),
      });
    }

    const finalScore = clamp(rawScore, 0, 1);
    const level      = resolveLevel(finalScore, thresholds);

    return {
      action,
      score:          finalScore,
      level,
      gate:           GATE_ACTIONS[level],
      contributors,
      /** Plain-English summary of the top signals for human reviewers. */
      explanation:    buildExplanation(action, finalScore, level, contributors),
      policyVersion,
      evaluatedAt:    new Date().toISOString(),
    };
  }

  /**
   * List all registered signals (useful for documentation and admin UI).
   */
  function listSignals() {
    return signals.map((sig) => ({
      id:      sig.id,
      weight:  sig.weight,
      actions: sig.actions ? [...sig.actions] : null,
    }));
  }

  return Object.freeze({ score, listSignals, policyVersion });
}

// ---------------------------------------------------------------------------
// Explanation builder
// ---------------------------------------------------------------------------

function buildExplanation(action, score, level, contributors) {
  if (contributors.length === 0) {
    return `No risk signals fired for action "${action}". Score: ${fmt(score)} (${level}).`;
  }

  const top = [...contributors]
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3);

  const lines = [
    `Action "${action}" received a risk score of ${fmt(score)} — classified as ${level.toUpperCase()}.`,
    `Top contributing signals:`,
    ...top.map((c, i) => `  ${i + 1}. [${c.signalId}] ${c.rationale}`),
  ];

  if (contributors.length > 3) {
    lines.push(`  … and ${contributors.length - 3} additional signal(s).`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Default singleton (convenience export)
// ---------------------------------------------------------------------------

export const defaultRiskScorer = createRiskScorer();

/**
 * Convenience wrapper — scores an action and returns the full result.
 * Uses the module-level default scorer.
 *
 * @param {string} action
 * @param {object} ctx
 * @returns {RiskScoreResult}
 */
export function scoreAction(action, ctx = {}) {
  return defaultRiskScorer.score(action, ctx);
}

/**
 * @typedef {Object} RiskScoreResult
 * @property {string} action        - The action that was scored.
 * @property {number} score         - Final aggregated score in [0, 1].
 * @property {string} level         - One of RISK_LEVELS.
 * @property {string} gate          - Recommended gate action.
 * @property {Array}  contributors  - Signals that fired with individual
 *   contributions and rationale.
 * @property {string} explanation   - Human-readable explanation for reviewers.
 * @property {string} policyVersion - Fingerprint of scoring policy used.
 * @property {string} evaluatedAt   - ISO timestamp.
 */
