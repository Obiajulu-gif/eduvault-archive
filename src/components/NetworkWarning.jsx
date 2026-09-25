"use client";

import { useEffect, useState } from "react";
import { measureHorizonLatency } from "@/lib/stellar/horizonClient";

const POLL_INTERVAL_MS = 30_000;

const STATUS_STYLES = {
  green: "bg-emerald-50 border-emerald-200 text-emerald-700",
  yellow: "bg-amber-50 border-amber-200 text-amber-700",
  red: "bg-red-50 border-red-200 text-red-700",
};

const DOT_STYLES = {
  green: "bg-emerald-500",
  yellow: "bg-amber-500",
  red: "bg-red-500",
};

function statusMessage(sample) {
  if (!sample) return "Checking Stellar network…";
  if (sample.latencyMs === null) {
    return "Stellar RPC node unreachable — transactions may fail. Retrying…";
  }
  if (sample.status === "green") return `Stellar network healthy (${sample.latencyMs}ms)`;
  if (sample.status === "yellow") {
    return `Stellar network is slow (${sample.latencyMs}ms) — transactions may take longer`;
  }
  return `Stellar network congested (${sample.latencyMs}ms) — signing may time out`;
}

/**
 * NetworkWarning — color-coded Stellar RPC latency indicator.
 *
 * Pings the configured Horizon node every 30 seconds and renders a
 * traffic-light banner: green (<300ms), yellow (300–800ms), red (>800ms
 * or unreachable). Shown in connection banners so users see congestion
 * before a signing flow times out on them.
 *
 * @param {{ measure?: typeof measureHorizonLatency, pollIntervalMs?: number }} props
 *   `measure` is injectable for testing.
 */
export default function NetworkWarning({
  measure = measureHorizonLatency,
  pollIntervalMs = POLL_INTERVAL_MS,
}) {
  const [sample, setSample] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      const result = await measure();
      if (!cancelled) setSample(result);
    }

    tick();
    const id = setInterval(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [measure, pollIntervalMs]);

  const status = sample?.status ?? "yellow";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      <span
        aria-hidden="true"
        className={`w-2 h-2 rounded-full ${DOT_STYLES[status]} ${
          status !== "green" ? "animate-pulse" : ""
        }`}
      />
      {statusMessage(sample)}
    </div>
  );
}
