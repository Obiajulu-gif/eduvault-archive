import { useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import useEarningsData from "../hooks/useEarningsData";
import "./EarningsAnalytics.css";

/**
 * EarningsAnalytics – component that renders interval selectors and an earnings chart.
 * Uses recharts (npm dependency) instead of CDN-loaded Chart.js.
 */
export default function EarningsAnalytics() {
  const intervals = [
    { label: "7 Days", value: "7d" },
    { label: "30 Days", value: "30d" },
    { label: "Year‑to‑Date", value: "ytd" },
  ];
  const [selected, setSelected] = useState("7d");
  const data = useEarningsData(selected);

  return (
    <section className="earnings-analytics">
      <div
        className="interval-selector"
        role="radiogroup"
        aria-label="Time interval"
      >
        {intervals.map((i) => (
          <button
            key={i.value}
            className={`interval-btn ${selected === i.value ? "active" : ""}`}
            onClick={() => setSelected(i.value)}
            aria-pressed={selected === i.value}
          >
            {i.label}
          </button>
        ))}
      </div>
      <Chart data={data} />
    </section>
  );
}

/**
 * Chart – renders a line chart using recharts.
 * Re-renders naturally with React when data changes (no manual destroy/recreate needed).
 */
function Chart({ data }) {
  return (
    <ResponsiveContainer
      width="100%"
      height={400}
      className="earnings-chart-container"
    >
      <LineChart data={data} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="date" />
        <YAxis
          label={{ value: "Amount (USD)", angle: -90, position: "insideLeft" }}
        />
        <Tooltip />
        <Legend />
        <Line
          type="monotone"
          dataKey="earnings"
          name="Earnings"
          stroke="#4caf50"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="gas"
          name="Gas Costs"
          stroke="#ff9800"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="royalties"
          name="Royalties"
          stroke="#2196f3"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="net"
          name="Net"
          stroke="#9c27b0"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
