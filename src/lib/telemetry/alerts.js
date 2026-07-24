/**
 * Alert rules mapped to documented SLOs (#20).
 * See docs/observability-slos.md for the SLO definitions and runbooks
 * these rules correspond to.
 *
 * Each rule is a pure function over a metrics snapshot so it can be
 * evaluated locally against fixtures in tests, without a live alerting
 * backend (acceptance criterion: "alert fixture evaluation").
 */

export const ALERT_RULES = [
  {
    name: "PurchaseLatencyHigh",
    severity: "warning",
    runbook: "docs/observability-slos.md#purchase-latency",
    description: "Purchase p95 latency exceeds the SLO threshold.",
    evaluate(snapshot) {
      const series = snapshot.histograms?.purchase_latency_ms || {};
      return Object.entries(series)
        .filter(([, stats]) => stats.p95 > 8000)
        .map(([labels, stats]) => ({ labels, p95: stats.p95 }));
    },
  },
  {
    name: "PurchaseSuccessRateLow",
    severity: "critical",
    runbook: "docs/observability-slos.md#purchase-success-rate",
    description: "Purchase success rate has dropped below the SLO.",
    evaluate(snapshot) {
      const counters = snapshot.counters?.purchase_total || {};
      const success = counters['outcome="success"'] || 0;
      const failed = counters['outcome="failed"'] || 0;
      const total = success + failed;
      if (total < 5) return []; // not enough samples to page on
      const rate = success / total;
      return rate < 0.95 ? [{ successRate: rate, total }] : [];
    },
  },
  {
    name: "IndexerLedgerLagHigh",
    severity: "critical",
    runbook: "docs/observability-slos.md#indexer-lag",
    description: "The indexer is falling behind the chain.",
    evaluate(snapshot) {
      const series = snapshot.gauges?.indexer_ledger_lag || {};
      return Object.entries(series)
        .filter(([, lag]) => lag > 50)
        .map(([labels, lag]) => ({ labels, lag }));
    },
  },
  {
    name: "DeadLetterBacklogGrowing",
    severity: "warning",
    runbook: "docs/observability-slos.md#dead-letter-backlog",
    description: "Unresolved dead-letter events are accumulating.",
    evaluate(snapshot) {
      const series = snapshot.gauges?.indexer_dead_letter_count || {};
      return Object.entries(series)
        .filter(([, count]) => count > 25)
        .map(([labels, count]) => ({ labels, count }));
    },
  },
  {
    name: "RpcErrorRateHigh",
    severity: "critical",
    runbook: "docs/observability-slos.md#rpc-errors",
    description: "Stellar RPC error rate is elevated.",
    evaluate(snapshot) {
      const series = snapshot.counters?.rpc_errors_total || {};
      const total = Object.values(series).reduce((sum, v) => sum + v, 0);
      return total > 10 ? [{ total }] : [];
    },
  },
];

/**
 * Evaluate all alert rules against a metrics snapshot.
 * Returns only rules that fired, with their firing instances attached.
 */
export function evaluateAlerts(snapshot) {
  const fired = [];
  for (const rule of ALERT_RULES) {
    const instances = rule.evaluate(snapshot);
    if (instances.length > 0) {
      fired.push({
        name: rule.name,
        severity: rule.severity,
        runbook: rule.runbook,
        description: rule.description,
        instances,
      });
    }
  }
  return fired;
}