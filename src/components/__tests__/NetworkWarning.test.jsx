import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NetworkWarning from "../NetworkWarning";
import { classifyLatency } from "@/lib/stellar/horizonClient";

describe("classifyLatency", () => {
  it("classifies per the documented thresholds", () => {
    expect(classifyLatency(0)).toBe("green");
    expect(classifyLatency(299)).toBe("green");
    expect(classifyLatency(300)).toBe("yellow");
    expect(classifyLatency(800)).toBe("yellow");
    expect(classifyLatency(801)).toBe("red");
    expect(classifyLatency(null)).toBe("red");
    expect(classifyLatency(NaN)).toBe("red");
  });
});

describe("NetworkWarning", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a green banner for a fast node", async () => {
    const measure = vi
      .fn()
      .mockResolvedValue({ url: "https://h", latencyMs: 120, status: "green" });
    render(<NetworkWarning measure={measure} />);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Stellar network healthy (120ms)"),
    );
  });

  it("renders a slow warning for a yellow node", async () => {
    const measure = vi
      .fn()
      .mockResolvedValue({ url: "https://h", latencyMs: 550, status: "yellow" });
    render(<NetworkWarning measure={measure} />);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Stellar network is slow (550ms)",
      ),
    );
  });

  it("renders a fallback message when the connection drops", async () => {
    const measure = vi
      .fn()
      .mockResolvedValue({ url: "https://h", latencyMs: null, status: "red" });
    render(<NetworkWarning measure={measure} />);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Stellar RPC node unreachable",
      ),
    );
  });

  it("re-measures on the poll interval", async () => {
    vi.useFakeTimers();
    const measure = vi
      .fn()
      .mockResolvedValue({ url: "https://h", latencyMs: 100, status: "green" });
    render(<NetworkWarning measure={measure} pollIntervalMs={30_000} />);

    await act(async () => {});
    expect(measure).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(measure).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(measure).toHaveBeenCalledTimes(3);
  });
});
