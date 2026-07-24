/**
 * Provider-agnostic metrics registry for EduVault (#20).
 *
 * In-memory counters/histograms, exposed via /api/metrics in Prometheus
 * text format. Provider-agnostic: swapping to a real OTel metrics exporter
 * later means changing this file only, not every call site.
 *
 * Cardinality is capped per metric name (acceptance criterion: "metric
 * cardinality limits") so a bug can't accidentally explode memory by
 * generating unbounded label combinations (e.g. using a wallet address
 * or txHash as a label instead of an attribute).
 */

const MAX_LABEL_COMBINATIONS_PER_METRIC = 200;

const counters = new Map(); // metricName -> Map<labelKey, value>
const histograms = new Map(); // metricName -> Map<labelKey, number[]>
const gauges = new Map(); // metricName -> Map<labelKey, value>

function labelKey(labels = {}) {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}="${String(labels[k]).slice(0, 64)}"`).join(",");
}

function guardCardinality(store, metricName) {
  const series = store.get(metricName);
  if (series && series.size >= MAX_LABEL_COMBINATIONS_PER_METRIC) {
    return false; // drop the sample rather than grow unbounded
  }
  return true;
}

export function incrementCounter(metricName, labels = {}, value = 1) {
  if (!counters.has(metricName)) counters.set(metricName, new Map());
  const store = counters.get(metricName);
  const key = labelKey(labels);
  if (!store.has(key) && !guardCardinality(counters, metricName)) return;
  store.set(key, (store.get(key) || 0) + value);
}

/** Gauges overwrite (not accumulate) — for point-in-time values like
 *  "indexer ledger lag" or "entitlement cache freshness". */
export function setGauge(metricName, labels = {}, value) {
  if (!gauges.has(metricName)) gauges.set(metricName, new Map());
  const store = gauges.get(metricName);
  const key = labelKey(labels);
  if (!store.has(key) && !guardCardinality(gauges, metricName)) return;
  store.set(key, value);
}
 


export function recordHistogram(metricName, labels = {}, value) {
  if (!histograms.has(metricName)) histograms.set(metricName, new Map());
  const store = histograms.get(metricName);
  const key = labelKey(labels);
  if (!store.has(key) && !guardCardinality(histograms, metricName)) return;
  if (!store.has(key)) store.set(key, []);
  const arr = store.get(key);
  arr.push(value);
  if (arr.length > 1000) arr.shift(); // bound memory for long-running processes
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Snapshot for tests / debugging (not the wire format). */
export function getMetricsSnapshot() {
  const snapshot = { counters: {}, histograms: {}, gauges: {} };
  for (const [name, series] of gauges.entries()) {
    snapshot.gauges[name] = Object.fromEntries(series);
  }
  for (const [name, series] of counters.entries()) {
    snapshot.counters[name] = Object.fromEntries(series);
  }
  for (const [name, series] of histograms.entries()) {
    snapshot.histograms[name] = {};
    for (const [key, values] of series.entries()) {
      const sorted = [...values].sort((a, b) => a - b);
      snapshot.histograms[name][key] = {
        count: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
      };
    }
  }
  return snapshot;
}

/** Reset all metrics — used by tests between assertions. */
export function resetMetrics() {
  counters.clear();
  histograms.clear();
  gauges.clear();
}

/** Prometheus text exposition format for the /api/metrics endpoint. */
export function toPrometheusFormat() {
  const lines = [];
  for (const [name, series] of counters.entries()) {
    lines.push(`# TYPE ${name} counter`);
    for (const [key, value] of series.entries()) {
      lines.push(key ? `${name}{${key}} ${value}` : `${name} ${value}`);
    }
  }
  for (const [name, series] of gauges.entries()) {
    lines.push(`# TYPE ${name} gauge`);
    for (const [key, value] of series.entries()) {
      lines.push(key ? `${name}{${key}} ${value}` : `${name} ${value}`);
    }
  }
  for (const [name, series] of counters.entries()) {
    lines.push(`# TYPE ${name} counter`);
    for (const [key, value] of series.entries()) {
      lines.push(key ? `${name}{${key}} ${value}` : `${name} ${value}`);
    }
  }
  for (const [name, series] of histograms.entries()) {
    lines.push(`# TYPE ${name} summary`);
    for (const [key, values] of series.entries()) {
      const sorted = [...values].sort((a, b) => a - b);
      const labelPrefix = key ? `${key},` : "";
      lines.push(`${name}{${labelPrefix}quantile="0.5"} ${percentile(sorted, 50)}`);
      lines.push(`${name}{${labelPrefix}quantile="0.95"} ${percentile(sorted, 95)}`);
      lines.push(`${name}{${labelPrefix}quantile="0.99"} ${percentile(sorted, 99)}`);
      lines.push(`${name}_count{${key || ""}} ${sorted.length}`);
    }
  }
  return lines.join("\n") + "\n";
}
