import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import RevisionHistoryPanel from "../RevisionHistoryPanel";

describe("RevisionHistoryPanel", () => {
  it("shows initial version message when history is empty", () => {
    render(<RevisionHistoryPanel history={[]} currentVersion={1} />);
    expect(screen.getByText(/No past edits recorded/)).toBeInTheDocument();
  });

  it("shows current version badge", () => {
    render(<RevisionHistoryPanel history={[]} currentVersion={3} />);
    expect(screen.getByText("v3 (Current)")).toBeInTheDocument();
  });

  it("renders history entries", () => {
    const history = [
      { version: 2, updatedAt: "2024-02-01T00:00:00Z", changeReason: "Fixed typos" },
      { version: 1, updatedAt: "2024-01-01T00:00:00Z" },
    ];
    render(<RevisionHistoryPanel history={history} currentVersion={3} />);
    expect(screen.getByText("v3 (Current)")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText(/Fixed typos/)).toBeInTheDocument();
  });

  it("shows modified fields when changes present", () => {
    const history = [{
      version: 1,
      updatedAt: "2024-01-01T00:00:00Z",
      changes: { title: { from: "Old", to: "New" } },
    }];
    render(<RevisionHistoryPanel history={history} currentVersion={2} />);
    expect(screen.getByText(/Modified:/)).toBeInTheDocument();
    expect(screen.getByText(/title/)).toBeInTheDocument();
  });
});
